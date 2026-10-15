#!/usr/bin/env node
/**
 * Security audit: a deterministic scan of a WordPress-style repo. Inventories
 * entrypoints, runs PHP pattern checks, fallow (frontend) and, with --deps,
 * composer and npm audits.
 *
 * Usage:
 *   node security-audit.cjs [/path/to/repo] [--base main] [--deps] [--json]
 *     [--out <file>]
 *
 * --out writes a Markdown report to that file and nowhere else.
 * --json prints the report as JSON instead of the summary.
 *
 * Exit codes:
 *   0 - no error findings
 *   1 - at least one error finding
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, resolveConsumerRoot, run, gitMergeBase } = require('./lib/cli.cjs');

const USAGE =
	'Usage: node security-audit.cjs [/path/to/repo] [--base main] [--deps] [--json] [--out <file>]';

const SKIP_DIR = new Set([
	'node_modules',
	'vendor',
	'.git',
	'.harness',
	'dist',
	'build',
	'coverage',
	'.next',
	'.turbo',
	'.cache',
]);

const SUPERGLOBAL_RE = /\$_(GET|POST|REQUEST|COOKIE)\s*\[/g;
const SANITIZE_HINT_RE =
	/\b(sanitize_|esc_|wp_unslash|absint|intval|floatval|wp_verify_nonce|check_ajax_referer|check_admin_referer|wp_kses)\w*/;

/**
 * @typedef {object} Finding
 * @property {'error' | 'warning'} severity
 * @property {string} id
 * @property {string} message
 * @property {string} [file]
 * @property {number} [line]
 */

/**
 * @typedef {object} Entrypoint
 * @property {string} kind
 * @property {string} file
 * @property {number} line
 * @property {string} detail
 * @property {boolean} [hasPermissionCallback]
 */

/**
 * @param {string} dir
 * @param {(file: string) => boolean} filter
 * @param {string[]} [acc]
 * @returns {string[]}
 */
function walkFiles(dir, filter, acc = []) {
	if (!fs.existsSync(dir)) {
		return acc;
	}
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return acc;
	}
	for (const ent of entries) {
		if (ent.name.startsWith('.') && ent.name !== '.php') {
			if (ent.isDirectory() && SKIP_DIR.has(ent.name)) {
				continue;
			}
			if (ent.isDirectory() && ent.name !== '.') {
				// skip other dotdirs
				if (ent.name !== '..') {
					continue;
				}
			}
		}
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			if (SKIP_DIR.has(ent.name)) {
				continue;
			}
			walkFiles(full, filter, acc);
		} else if (ent.isFile() && filter(full)) {
			acc.push(full);
		}
	}
	return acc;
}

/**
 * @param {string} consumerRoot
 * @returns {string[]}
 */
function listPhpFiles(consumerRoot) {
	return walkFiles(consumerRoot, (f) => f.endsWith('.php'));
}

/**
 * @param {string} consumerRoot
 * @returns {boolean}
 */
function hasFrontendSources(consumerRoot) {
	const hits = walkFiles(
		consumerRoot,
		(f) =>
			/\.(tsx?|jsx?|mjs|cjs)$/.test(f) &&
			!f.includes(`${path.sep}tests${path.sep}`) &&
			!f.includes(`${path.sep}e2e${path.sep}`),
	);
	return hits.length > 0;
}

/**
 * @param {string} consumerRoot
 * @param {string[]} phpFiles
 * @returns {{ entrypoints: Entrypoint[]; findings: Finding[] }}
 */
function scanPhpSecurity(consumerRoot, phpFiles) {
	/** @type {Entrypoint[]} */
	const entrypoints = [];
	/** @type {Finding[]} */
	const findings = [];

	for (const file of phpFiles) {
		const rel = path.relative(consumerRoot, file);
		let content;
		try {
			content = fs.readFileSync(file, 'utf8');
		} catch {
			continue;
		}
		const lines = content.split('\n');

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNo = i + 1;

			if (/register_rest_route\s*\(/.test(line)) {
				const window = lines.slice(i, Math.min(lines.length, i + 50)).join('\n');
				// WordPress style: 'permission_callback' => … (quote between key and =>)
				const hasPermissionCallback =
					/['"]?permission_callback['"]?\s*=>/.test(window);
				const detailMatch = line.match(/register_rest_route\s*\(\s*([^,]+)/);
				entrypoints.push({
					kind: 'rest',
					file: rel,
					line: lineNo,
					detail: (detailMatch?.[1] ?? 'register_rest_route').trim(),
					hasPermissionCallback,
				});
				if (!hasPermissionCallback) {
					findings.push({
						severity: 'error',
						id: 'rest-missing-permission-callback',
						message:
							'register_rest_route without permission_callback in following ~50 lines',
						file: rel,
						line: lineNo,
					});
				} else if (/['"]?permission_callback['"]?\s*=>\s*['"]?__return_true/.test(window)) {
					findings.push({
						severity: 'warning',
						id: 'rest-public-permission',
						message:
							'permission_callback is __return_true — confirm intentional public route',
						file: rel,
						line: lineNo,
					});
				}
			}

			const ajax = line.match(
				/add_action\s*\(\s*['"](wp_ajax(?:_nopriv)?_[^'"]+)['"]/,
			);
			if (ajax) {
				entrypoints.push({
					kind: ajax[1].includes('nopriv') ? 'ajax_nopriv' : 'ajax',
					file: rel,
					line: lineNo,
					detail: ajax[1],
				});
			}

			const adminPost = line.match(
				/add_action\s*\(\s*['"](admin_post(?:_nopriv)?_[^'"]+)['"]/,
			);
			if (adminPost) {
				entrypoints.push({
					kind: 'admin_post',
					file: rel,
					line: lineNo,
					detail: adminPost[1],
				});
			}

			// Flag eval() and bare assert(); skip $this->assert / private function assert helpers.
			if (
				/\beval\s*\(/.test(line) ||
				(/\bassert\s*\(/.test(line) &&
					!/->assert\s*\(/.test(line) &&
					!/function\s+assert\s*\(/.test(line))
			) {
				findings.push({
					severity: 'error',
					id: 'dangerous-eval-assert',
					message: 'Dangerous eval/assert usage',
					file: rel,
					line: lineNo,
				});
			}
			if (/create_function\s*\(/.test(line)) {
				findings.push({
					severity: 'error',
					id: 'dangerous-create-function',
					message: 'create_function is unsafe/deprecated',
					file: rel,
					line: lineNo,
				});
			}
			if (/extract\s*\(\s*\$_(GET|POST|REQUEST|COOKIE)/.test(line)) {
				findings.push({
					severity: 'error',
					id: 'dangerous-extract-superglobal',
					message: 'extract() on request superglobal',
					file: rel,
					line: lineNo,
				});
			}

			SUPERGLOBAL_RE.lastIndex = 0;
			if (SUPERGLOBAL_RE.test(line) && !SANITIZE_HINT_RE.test(line)) {
				findings.push({
					severity: 'error',
					id: 'unsanitized-superglobal',
					message:
						'Superglobal read without sanitize/nonce helper on the same line',
					file: rel,
					line: lineNo,
				});
			}

			if (
				/\$wpdb->(query|get_results|get_var|get_row|get_col)\s*\(/.test(line) &&
				/\$[a-zA-Z_]/.test(line) &&
				!/\$wpdb->prepare/.test(line) &&
				!/['"][^'"]*['"]\s*\)/.test(line.replace(/\$wpdb->\w+\s*\(\s*/, ''))
			) {
				// Heuristic: $wpdb->query(...$var...) without prepare on same line
				if (!/prepare\s*\(/.test(line)) {
					findings.push({
						severity: 'warning',
						id: 'wpdb-unprepared-heuristic',
						message:
							'$wpdb query with variables — confirm $wpdb->prepare or safe builder',
						file: rel,
						line: lineNo,
					});
				}
			}

			if (
				/\b(api[_-]?key|secret_key|private_key|auth_token|password)\b\s*[=:]\s*['"][^'"]{12,}['"]/i.test(
					line,
				) &&
				!/getenv|env\(|process\.env|defined\s*\(/.test(line)
			) {
				findings.push({
					severity: 'error',
					id: 'hardcoded-secret-heuristic',
					message: 'Possible hardcoded secret/token',
					file: rel,
					line: lineNo,
				});
			}
		}
	}

	return { entrypoints, findings };
}

/**
 * @param {string} consumerRoot
 * @param {string} base
 * @returns {Finding[]}
 */
function runFallowSecurity(consumerRoot, base) {
	/** @type {Finding[]} */
	const findings = [];
	const bin = path.join(consumerRoot, 'node_modules', '.bin', 'fallow');
	const hasLocal = fs.existsSync(bin);

	if (!hasLocal) {
		findings.push({
			severity: 'warning',
			id: 'fallow-not-installed',
			message:
				'fallow not found in node_modules/.bin — skip FE security candidates (optional: npm i -D fallow)',
		});
		return findings;
	}

	const result = run(consumerRoot, bin, [
		'security',
		'--format',
		'json',
		'--quiet',
		'--gate',
		'new',
		'--changed-since',
		base,
	]);
	if (result.status !== 0 && !result.stdout.trim()) {
		findings.push({
			severity: 'warning',
			id: 'fallow-failed',
			message: `fallow security exited ${result.status}: ${(result.stderr || result.stdout).slice(0, 200)}`,
		});
		return findings;
	}

	try {
		const json = JSON.parse(result.stdout || '{}');
		const list = Array.isArray(json.security_findings)
			? json.security_findings
			: Array.isArray(json.findings)
				? json.findings
				: [];
		for (const item of list) {
			findings.push({
				severity: 'error',
				id: `fallow:${item.category ?? item.kind ?? 'candidate'}`,
				message: String(item.evidence ?? item.message ?? item.kind ?? 'security candidate'),
				file: item.path ?? item.file,
				line: item.line,
			});
		}
		if (result.status !== 0 && list.length === 0) {
			findings.push({
				severity: 'error',
				id: 'fallow-gate-failed',
				message: `fallow security --gate new failed (exit ${result.status})`,
			});
		}
	} catch {
		if (result.status !== 0) {
			findings.push({
				severity: 'error',
				id: 'fallow-gate-failed',
				message: `fallow security --gate new failed (exit ${result.status})`,
			});
		}
	}

	return findings;
}

/**
 * @param {string} consumerRoot
 * @returns {Finding[]}
 */
function runDependencyAudits(consumerRoot) {
	/** @type {Finding[]} */
	const findings = [];

	if (fs.existsSync(path.join(consumerRoot, 'composer.lock'))) {
		const r = run(consumerRoot, 'composer', ['audit', '--format=json']);
		if (r.status !== 0) {
			findings.push({
				severity: 'error',
				id: 'composer-audit',
				message: 'composer audit reported issues (run composer audit for details)',
			});
		}
	}

	const pkgLock =
		fs.existsSync(path.join(consumerRoot, 'package-lock.json')) ||
		fs.existsSync(path.join(consumerRoot, 'yarn.lock')) ||
		fs.existsSync(path.join(consumerRoot, 'pnpm-lock.yaml'));
	if (pkgLock && fs.existsSync(path.join(consumerRoot, 'package.json'))) {
		const r = run(consumerRoot, 'npm', ['audit', '--json']);
		if (r.status !== 0) {
			try {
				const j = JSON.parse(r.stdout || '{}');
				const vulns = j.metadata?.vulnerabilities;
				const high = (vulns?.high ?? 0) + (vulns?.critical ?? 0);
				if (high > 0) {
					findings.push({
						severity: 'error',
						id: 'npm-audit-high',
						message: `npm audit: ${high} high/critical advisories`,
					});
				} else {
					findings.push({
						severity: 'warning',
						id: 'npm-audit',
						message: 'npm audit reported non-zero exit (review advisories)',
					});
				}
			} catch {
				findings.push({
					severity: 'warning',
					id: 'npm-audit',
					message: 'npm audit reported issues',
				});
			}
		}
	}

	return findings;
}

/**
 * @param {Finding[]} findings
 * @returns {{ errors: Finding[]; warnings: Finding[] }}
 */
function splitFindings(findings) {
	return {
		errors: findings.filter((f) => f.severity === 'error'),
		warnings: findings.filter((f) => f.severity === 'warning'),
	};
}

/**
 * @param {object} report
 * @returns {string}
 */
function formatAuditReport(report) {
	const { status, base, mergeBase, ranAt, entrypoints, errors, warnings } = report;

	/** @type {string[]} */
	const lines = [];
	lines.push('# Security audit');
	lines.push('');
	lines.push(`**Status:** ${status}`);
	lines.push(`**Ran at:** ${ranAt}`);
	lines.push(`**Base:** ${base} @ \`${mergeBase}\``);
	lines.push('');
	lines.push('## Summary');
	lines.push('');
	lines.push(`- Entrypoints inventoried: **${entrypoints.length}**`);
	lines.push(`- Errors: **${errors.length}**`);
	lines.push(`- Warnings: **${warnings.length}**`);
	lines.push('');
	if (entrypoints.length > 0) {
		lines.push('## Entrypoint inventory');
		lines.push('');
		for (const ep of entrypoints.slice(0, 80)) {
			const perm =
				ep.kind === 'rest'
					? ep.hasPermissionCallback
						? ' permission_callback=yes'
						: ' permission_callback=MISSING'
					: '';
			lines.push(`- \`${ep.kind}\` ${ep.file}:${ep.line} — ${ep.detail}${perm}`);
		}
		if (entrypoints.length > 80) {
			lines.push(`- … ${entrypoints.length - 80} more`);
		}
		lines.push('');
	}

	if (errors.length > 0) {
		lines.push('## Failures');
		lines.push('');
		for (const e of errors) {
			const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ''}` : '';
			lines.push(`- **${e.id}**${loc ? ` (\`${loc}\`)` : ''}: ${e.message}`);
		}
		lines.push('');
	}

	if (warnings.length > 0) {
		lines.push('## Warnings');
		lines.push('');
		for (const w of warnings) {
			const loc = w.file ? `${w.file}${w.line ? `:${w.line}` : ''}` : '';
			lines.push(`- **${w.id}**${loc ? ` (\`${loc}\`)` : ''}: ${w.message}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * @param {string} consumerRoot
 * @param {{ base?: string | boolean; deps?: boolean; json?: boolean; out?: string | boolean }} opts
 */
function runAudit(consumerRoot, opts) {
	const base = (typeof opts.base === 'string' && opts.base) || 'main';
	const mergeBase = gitMergeBase(consumerRoot, base);
	const phpFiles = listPhpFiles(consumerRoot);
	const { entrypoints, findings: phpFindings } = scanPhpSecurity(consumerRoot, phpFiles);

	/** @type {Finding[]} */
	const findings = [...phpFindings];

	const frontend = hasFrontendSources(consumerRoot);
	if (frontend) {
		findings.push(...runFallowSecurity(consumerRoot, mergeBase));
	}

	if (opts.deps) {
		findings.push(...runDependencyAudits(consumerRoot));
	}

	if (phpFiles.length === 0 && !frontend) {
		findings.push({
			severity: 'warning',
			id: 'no-surfaces',
			message: 'No PHP or frontend sources found - the audit has nothing to inventory',
		});
	}

	const { errors, warnings } = splitFindings(findings);
	const report = {
		status: errors.length === 0 ? 'PASS' : 'FAIL',
		base,
		mergeBase,
		ranAt: new Date().toISOString(),
		entrypoints,
		errors,
		warnings,
		phpFileCount: phpFiles.length,
	};

	if (typeof opts.out === 'string' && opts.out) {
		const outPath = path.resolve(opts.out);
		fs.mkdirSync(path.dirname(outPath), { recursive: true });
		fs.writeFileSync(outPath, `${formatAuditReport(report)}\n`, 'utf8');
	}

	if (opts.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`security-audit: ${report.status}`);
		console.log(`  PHP files: ${phpFiles.length}`);
		console.log(`  Entrypoints: ${entrypoints.length}`);
		console.log(`  Errors: ${errors.length}`);
		console.log(`  Warnings: ${warnings.length}`);
		for (const e of errors) {
			const loc = e.file ? `${e.file}${e.line ? `:${e.line}` : ''}` : '';
			console.error(`  ERROR [${e.id}] ${loc} ${e.message}`);
		}
		for (const w of warnings) {
			const loc = w.file ? `${w.file}${w.line ? `:${w.line}` : ''}` : '';
			console.warn(`  WARN [${w.id}] ${loc} ${w.message}`);
		}
	}

	if (errors.length > 0) {
		process.exit(1);
	}
}

function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	if (flags.help) {
		console.log(USAGE);
		return;
	}
	runAudit(resolveConsumerRoot(positional[0]), {
		base: flags.base,
		deps: Boolean(flags.deps),
		json: Boolean(flags.json),
		out: flags.out,
	});
}

if (require.main === module) {
	main();
}

module.exports = {
	scanPhpSecurity,
	splitFindings,
	formatAuditReport,
	listPhpFiles,
	runDependencyAudits,
};
