#!/usr/bin/env node
/**
 * Structural lint for the living plan HTML files (architecture / UX / security posture).
 *
 * Usage:
 *   node .claude/skills/plan-html/scripts/validate-plan-html.cjs [/path/to/consumer-repo] \
 *     [--kind arch|ux|security|handoff] [--file .harness/architecture-plan.html] \
 *     [--mode structure|ready] [--strict-warn]
 *
 * --mode structure: chrome only (post-scaffold) — stubs and {{tokens}} allowed
 * --mode ready:     chrome + filled sections + conditional sections + fact cross-checks (default)
 *
 * Exit codes:
 *   0 — pass (warnings may print)
 *   1 — hard fail
 *   2 — warnings only, with --strict-warn
 *
 * Contract source: the HTML-REPORT.md of the arch-plan, ui-ux-planner, security-plan and code-handoff skills.
 * Regex-based structural lint, not an HTML parser: it checks the section/anchor/script
 * contract and cross-checks security facts against .harness/security-assess.json.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
	parseArgs,
	resolveConsumerRoot,
	harnessDir,
	assertOrExit,
} = require('./lib/cli.cjs');
const { resolvePlanHtmlPath } = require('./lib/plan-paths.cjs');

/**
 * @typedef {object} PlanKind
 * @property {string} file
 * @property {string} titlePrefix
 * @property {string[]} required   Sections the spec marks required unconditionally
 * @property {string[]} expected   Scaffold sections that only warn when absent
 * @property {boolean} wantsMermaid
 */

/** @type {Record<string, PlanKind>} */
const KINDS = {
	arch: {
		file: 'architecture-plan.html',
		titlePrefix: 'Architecture plan',
		required: ['current', 'target', 'decisions', 'stages', 'nongoals'],
		expected: ['locks', 'phase', 'finish-line'],
		wantsMermaid: true,
	},
	ux: {
		file: 'ux-plan.html',
		titlePrefix: 'UX plan',
		required: ['job', 'journeys', 'surfaces', 'states', 'handoff'],
		expected: ['phase', 'locks', 'decisions', 'a11y', 'open', 'nongoals'],
		wantsMermaid: false,
	},
	security: {
		file: 'security-posture.html',
		titlePrefix: 'Security posture',
		required: [
			'surfaces',
			'cves',
			'current',
			'target',
			'decisions',
			'stages',
			'nongoals',
			'gate',
		],
		expected: ['locks', 'phase'],
		wantsMermaid: false,
	},
	handoff: {
		file: 'code-handoff.html',
		titlePrefix: 'Code handoff',
		required: ['intent', 'decisions', 'map', 'hotspots', 'tests', 'verify'],
		expected: ['frontend', 'backend', 'out'],
		wantsMermaid: false,
	},
};

const ALLOWED_SCRIPT_SRC = [
	/cdn\.tailwindcss\.com/,
	/cdn\.jsdelivr\.net\/npm\/mermaid/,
];

/** Prefixes that look like issue keys but are not. */
const NOT_ISSUE_KEYS = new Set([
	'UTF',
	'ISO',
	'SHA',
	'RFC',
	'CVE',
	'WCAG',
	'ARIA',
	'TLS',
	'AES',
	'PHP',
	'WP',
	'ES',
	'HTTP',
	'CSS',
]);

/** Invented-metric patterns the HTML-REPORT specs forbid. */
const BANNED_METRICS = [
	{ re: /pen-?test\s+score/i, label: 'pen-test score' },
	{
		re: /\b(readiness|maturity|posture|security)\s+(score|grade|rating)\b/i,
		label: 'security score/grade/rating',
	},
	{
		re: /\b(readiness|maturity|posture|secure)\b[^.]{0,24}?\b\d{1,3}\s?%/i,
		label: 'posture percentage',
	},
	{ re: /\b[1-5]\s*\/\s*5\b/, label: '1–5 posture grade' },
];

/**
 * Drop script and style bodies so text checks never see Tailwind classes or JS.
 *
 * @param {string} html
 * @returns {string}
 */
function stripCodeBlocks(html) {
	return html
		.replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
}

/**
 * @param {string} html
 * @returns {string}
 */
function visibleText(html) {
	return stripCodeBlocks(html)
		.replace(/<!--[\s\S]*?-->/g, ' ')
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * @param {string} html
 * @returns {string[]}
 */
function collectIds(html) {
	/** @type {string[]} */
	const ids = [];
	const re = /\bid="([^"]+)"/g;
	let m;
	while ((m = re.exec(html)) !== null) {
		ids.push(m[1]);
	}
	return ids;
}

/**
 * In-page anchors from the first <nav> block.
 *
 * @param {string} html
 * @returns {string[]}
 */
function navAnchors(html) {
	const nav = html.match(/<nav\b[\s\S]*?<\/nav>/i);
	if (!nav) {
		return [];
	}
	/** @type {string[]} */
	const anchors = [];
	const re = /href="#([^"]+)"/g;
	let m;
	while ((m = re.exec(nav[0])) !== null) {
		anchors.push(m[1]);
	}
	return anchors;
}

/**
 * Map section id → raw inner HTML (opening tag through matching </section>).
 *
 * @param {string} html
 * @returns {Map<string, string>}
 */
function sectionBodies(html) {
	/** @type {Map<string, string>} */
	const bodies = new Map();
	const openRe = /<section\b[^>]*\bid="([^"]+)"[^>]*>/gi;
	let m;
	while ((m = openRe.exec(html)) !== null) {
		const id = m[1];
		const start = m.index + m[0].length;
		let depth = 1;
		let i = start;
		while (i < html.length && depth > 0) {
			const nextOpen = html.toLowerCase().indexOf('<section', i);
			const nextClose = html.toLowerCase().indexOf('</section>', i);
			if (nextClose === -1) {
				break;
			}
			if (nextOpen !== -1 && nextOpen < nextClose) {
				depth += 1;
				i = nextOpen + 8;
			} else {
				depth -= 1;
				if (depth === 0) {
					bodies.set(id, html.slice(start, nextClose));
					break;
				}
				i = nextClose + 10;
			}
		}
	}
	return bodies;
}

/**
 * @param {string} body
 * @returns {boolean}
 */
function isStub(body) {
	const text = visibleText(body).replace(/[…·—–\-.]/g, '').trim();
	return text.length === 0;
}

/**
 * @param {string} html
 * @returns {boolean}
 */
function hasIssueKeys(html) {
	if (/\bdata-(epic|story)="[^"]+"/i.test(html)) {
		return true;
	}
	const re = /\b([A-Z][A-Z0-9]{1,9})-\d+\b/g;
	let m;
	while ((m = re.exec(visibleText(html))) !== null) {
		if (!NOT_ISSUE_KEYS.has(m[1])) {
			return true;
		}
	}
	return false;
}

/**
 * Declared traffic light in the status section (emerald counts as green).
 *
 * @param {string} statusBody
 * @returns {'red' | 'amber' | 'green' | null}
 */
function declaredStatus(statusBody) {
	const m = visibleText(statusBody).match(/\b(red|amber|green|emerald)\b/i);
	if (!m) {
		return null;
	}
	const word = m[1].toLowerCase();
	return word === 'emerald' ? 'green' : /** @type {'red' | 'amber' | 'green'} */ (word);
}

/**
 * @param {string} html
 * @param {string} [kind]
 * @returns {string[]}
 */
function auditScripts(html, kind) {
	/** @type {string[]} */
	const errors = [];
	const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
	let m;
	while ((m = re.exec(html)) !== null) {
		const attrs = m[1];
		const body = m[2];
		const typeAttr = attrs.match(/\btype="([^"]+)"/i);
		if (typeAttr && /application\/json/i.test(typeAttr[1])) {
			continue;
		}
		const src = attrs.match(/\bsrc="([^"]+)"/i);
		if (src) {
			if (!ALLOWED_SCRIPT_SRC.some((re2) => re2.test(src[1]))) {
				errors.push(
					`Disallowed script src "${src[1]}" — only Tailwind CDN and Mermaid ESM are allowed`,
				);
			}
		} else if (/mermaid/i.test(body)) {
			continue;
		} else {
			errors.push(
				'Inline <script> is not the Mermaid initializer — living plan HTML must stay static',
			);
		}
	}
	return errors;
}

/**
 * Cross-check the assess snapshot and traffic light against security-assess.json.
 *
 * @param {Map<string, string>} bodies
 * @param {object} report
 * @returns {{ errors: string[]; warnings: string[] }}
 */
function auditAssessFacts(bodies, report) {
	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];

	const errorCount = Array.isArray(report.errors) ? report.errors.length : 0;
	const warningCount = Array.isArray(report.warnings) ? report.warnings.length : 0;
	const incomplete = report.completeness !== 'complete';

	const assessBody = bodies.get('assess');
	if (assessBody) {
		const stated = visibleText(assessBody).match(/ERROR[^0-9]{0,20}(\d{1,4})/i);
		if (stated && Number(stated[1]) !== errorCount) {
			errors.push(
				`#assess states ${stated[1]} ERROR findings but security-assess.json reports ${errorCount}`,
			);
		}
	}

	const statusBody = bodies.get('status');
	if (statusBody) {
		const declared = declaredStatus(statusBody);
		if (!declared) {
			warnings.push('#status has no red / amber / green chip');
		} else if (incomplete && declared !== 'red') {
			errors.push(
				`#status declares ${declared} but assess completeness is "${report.completeness}" — spec requires Red`,
			);
		} else if (errorCount > 0 && declared === 'green') {
			errors.push(
				`#status declares green with ${errorCount} ERROR finding(s) in security-assess.json`,
			);
		} else if (warningCount > 0 && declared === 'green') {
			warnings.push(
				`#status declares green with ${warningCount} open WARNING finding(s) — Amber may be honest`,
			);
		}
	}

	return { errors, warnings };
}

/**
 * @param {object} opts
 * @param {string} opts.html
 * @param {string} opts.kind
 * @param {string} [opts.mode]
 * @param {object | null} [opts.assessReport]
 * @returns {{ errors: string[]; warnings: string[] }}
 */
function validatePlanHtml({ html, kind, mode = 'ready', assessReport = null }) {
	const spec = KINDS[kind];
	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];
	const ready = mode === 'ready';

	if (!/^\s*<!doctype html>/i.test(html)) {
		errors.push('Missing <!doctype html>');
	}
	if (!/<html\b[^>]*\blang="/i.test(html)) {
		errors.push('Missing lang attribute on <html>');
	}

	const title = html.match(/<title>([\s\S]*?)<\/title>/i);
	if (!title) {
		errors.push('Missing <title>');
	} else if (!title[1].trim().startsWith(spec.titlePrefix)) {
		errors.push(`<title> should start with "${spec.titlePrefix}"`);
	}

	errors.push(...auditScripts(html, kind));

	if (!/<nav\b/i.test(html)) {
		errors.push('Missing sticky <nav>');
	}

	const ids = collectIds(html);
	const seen = new Set();
	for (const id of ids) {
		if (seen.has(id)) {
			errors.push(`Duplicate id="${id}"`);
		}
		seen.add(id);
	}

	const bodies = sectionBodies(html);
	const anchors = navAnchors(html);
	for (const anchor of anchors) {
		if (!seen.has(anchor)) {
			errors.push(`Nav links #${anchor} but no element carries that id`);
		}
	}
	for (const id of bodies.keys()) {
		if (!anchors.includes(id)) {
			warnings.push(`Section #${id} is not linked from the nav`);
		}
	}

	for (const id of spec.required) {
		if (!bodies.has(id)) {
			errors.push(`Missing required section: #${id}`);
		}
	}
	for (const id of spec.expected) {
		if (!bodies.has(id)) {
			warnings.push(`Missing expected section: #${id}`);
		}
	}

	if (spec.wantsMermaid && !/class="mermaid"/i.test(html)) {
		warnings.push('No Mermaid diagram found — Current | Target usually needs one');
	}
	if (kind === 'handoff' && ready && !/class="mermaid"/i.test(html)) {
		warnings.push('No Mermaid in #map — fine when a bullet map is clearer');
	}

	if (!ready) {
		return { errors, warnings };
	}

	if (/\{\{[^}]+\}\}/.test(html)) {
		errors.push('Unfilled {{template token}} left in the document');
	}

	for (const [id, body] of bodies) {
		if (isStub(body)) {
			errors.push(`Section #${id} is still a stub (no content)`);
		}
	}

	const keyed = hasIssueKeys(html);
	// Code handoff is a per-story brief — issue keys in the header are normal; no #phase.
	if (
		kind !== 'handoff' &&
		keyed &&
		!bodies.has('phase')
	) {
		errors.push('Issue keys present, so #phase is required');
	}
	if (kind === 'arch' && keyed && !bodies.has('finish-line')) {
		errors.push('Story keys present, so #finish-line is required');
	}
	if (kind === 'arch' && !bodies.has('locks')) {
		const decisions = bodies.get('decisions') ?? '';
		if (/\bresolved\b/i.test(decisions)) {
			errors.push('Decisions are resolved, so #locks (At a glance) is required');
		}
	}

	const text = visibleText(html);
	for (const { re, label } of BANNED_METRICS) {
		if (re.test(text)) {
			const message = `Invented metric (${label}) — the HTML-REPORT specs forbid scores, grades, and readiness percentages`;
			if (kind === 'security') {
				errors.push(message);
			} else {
				warnings.push(message);
			}
		}
	}

	if (kind === 'security') {
		if (assessReport) {
			if (!bodies.has('assess')) {
				errors.push('security-assess.json exists, so #assess is required');
			}
			if (!bodies.has('status')) {
				errors.push('security-assess.json exists, so #status is required');
			}
			const facts = auditAssessFacts(bodies, assessReport);
			errors.push(...facts.errors);
			warnings.push(...facts.warnings);
		} else if (bodies.has('assess') && !/not run/i.test(bodies.get('assess') ?? '')) {
			warnings.push(
				'#assess has content but no .harness/security-assess.json was found — show "Not run" or run security-assess.cjs',
			);
		}
	}

	return { errors, warnings };
}

/**
 * @param {string} consumerRoot
 * @param {string} kind
 * @param {string | undefined} [slug]
 * @returns {string}
 */
function defaultPlanPath(consumerRoot, kind, slug) {
	return resolvePlanHtmlPath(consumerRoot, kind, { slug });
}

/**
 * @param {string} file
 * @returns {string | null}
 */
function kindFromFilename(file) {
	const base = path.basename(file).toLowerCase();
	for (const [kind, spec] of Object.entries(KINDS)) {
		if (base === spec.file) {
			return kind;
		}
	}
	if (base.includes('architecture')) return 'arch';
	if (base.includes('ux')) return 'ux';
	if (base.includes('security')) return 'security';
	if (base.includes('code-handoff') || base.includes('handoff')) return 'handoff';
	return null;
}

/**
 * Warn when siblings look like timestamped copies instead of one rewritten file.
 *
 * @param {string} file
 * @returns {string[]}
 */
function auditLifecycle(file) {
	const dir = path.dirname(file);
	const base = path.basename(file, '.html');
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs
		.readdirSync(dir)
		.filter(
			(name) =>
				name !== `${base}.html` &&
				name.startsWith(`${base}-`) &&
				name.endsWith('.html') &&
				!name.includes('archive'),
		)
		.map(
			(name) =>
				`Sibling ${name} looks like a timestamped copy — the spec says rewrite ${base}.html in place (use *-archive-*.html for rejected forks)`,
		);
}

function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	const consumerRoot = resolveConsumerRoot(positional[0]);
	const mode = String(flags.mode ?? 'ready');
	assertOrExit(
		['structure', 'ready'].includes(mode),
		`Invalid --mode "${mode}". Use structure or ready.`,
	);

	/** @type {string | null} */
	let kind = typeof flags.kind === 'string' ? flags.kind : null;
	/** @type {string | null} */
	let file = typeof flags.file === 'string' ? path.resolve(consumerRoot, flags.file) : null;
	const slug = typeof flags.slug === 'string' ? flags.slug : undefined;

	if (!kind && file) {
		kind = kindFromFilename(file);
	}
	if (!kind) {
		const present = Object.keys(KINDS).filter((k) =>
			fs.existsSync(defaultPlanPath(consumerRoot, k, slug)),
		);
		assertOrExit(
			present.length === 1,
			present.length === 0
				? 'No living plan HTML found. Pass --kind arch|ux|security|handoff or --file <path>.'
				: `Multiple plan files found (${present.join(', ')}). Pass --kind to choose one.`,
		);
		kind = present[0];
	}
	assertOrExit(
		Object.prototype.hasOwnProperty.call(KINDS, kind),
		`Invalid --kind "${kind}". Use arch, ux, security, or handoff.`,
	);

	if (!file) {
		file = defaultPlanPath(consumerRoot, kind, slug);
	}
	if (!fs.existsSync(file)) {
		console.error(`Missing ${file}`);
		process.exit(1);
	}

	const html = fs.readFileSync(file, 'utf8');
	if (!html.trim()) {
		console.error(`${path.basename(file)} is empty`);
		process.exit(1);
	}

	/** @type {object | null} */
	let assessReport = null;
	const assessPath = path.join(harnessDir(consumerRoot), 'security-assess.json');
	if (kind === 'security' && fs.existsSync(assessPath)) {
		try {
			assessReport = JSON.parse(fs.readFileSync(assessPath, 'utf8'));
		} catch {
			assessReport = null;
		}
	}

	const { errors, warnings } = validatePlanHtml({ html, kind, mode, assessReport });
	warnings.push(...auditLifecycle(file));

	for (const w of warnings) {
		console.warn(`WARN: ${w}`);
	}

	if (errors.length > 0) {
		console.error(`validate-plan-html (${kind}/${mode}): FAILED`);
		for (const e of errors) {
			console.error(`  - ${e}`);
		}
		process.exit(1);
	}

	if (warnings.length > 0 && flags['strict-warn']) {
		console.error('validate-plan-html: warnings treated as failure (--strict-warn)');
		process.exit(2);
	}

	console.log(`validate-plan-html (${kind}/${mode}): OK`);
}

module.exports = {
	KINDS,
	validatePlanHtml,
	sectionBodies,
	navAnchors,
	visibleText,
	hasIssueKeys,
	declaredStatus,
	auditLifecycle,
};

if (require.main === module) {
	main();
}
