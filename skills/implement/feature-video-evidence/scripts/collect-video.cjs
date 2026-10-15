#!/usr/bin/env node
/**
 * Copy the newest Playwright (or Cypress) video into .harness/evidence/.
 *
 * Usage:
 *   node .claude/skills/feature-video-evidence/scripts/collect-video.cjs [root] --slug <kebab-name> [--from <dir>]
 *   node .claude/skills/feature-video-evidence/scripts/collect-video.cjs --help
 * (fallback: ~/.claude/skills/feature-video-evidence/scripts/collect-video.cjs)
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string[]} argv
 * @returns {{ positional: string[], flags: Record<string, string | boolean> }}
 */
function parseArgs(argv) {
	/** @type {string[]} */
	const positional = [];
	/** @type {Record<string, string | boolean>} */
	const flags = {};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith('--')) {
			const eq = arg.indexOf('=');
			if (eq !== -1) {
				flags[arg.slice(2, eq)] = arg.slice(eq + 1);
			} else {
				const key = arg.slice(2);
				const next = argv[i + 1];
				if (next !== undefined && !next.startsWith('--')) {
					flags[key] = next;
					i++;
				} else {
					flags[key] = true;
				}
			}
		} else {
			positional.push(arg);
		}
	}

	return { positional, flags };
}

/**
 * @param {string} value
 * @returns {string}
 */
function slugify(value) {
	const slug = String(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slug || 'feature';
}

/**
 * @param {string} dir
 * @param {{ path: string, mtime: number }[]} acc
 * @returns {{ path: string, mtime: number }[]}
 */
function walkVideos(dir, acc) {
	if (!fs.existsSync(dir)) {
		return acc;
	}

	const stat = fs.statSync(dir);
	if (stat.isFile()) {
		if (/\.(webm|mp4)$/i.test(dir)) {
			acc.push({ path: dir, mtime: stat.mtimeMs });
		}
		return acc;
	}

	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			walkVideos(full, acc);
			continue;
		}
		if (/\.(webm|mp4)$/i.test(entry.name)) {
			acc.push({ path: full, mtime: fs.statSync(full).mtimeMs });
		}
	}

	return acc;
}

function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	if (flags.help === true || flags.h === true) {
		console.log(
			'Usage: collect-video.cjs [root] --slug <kebab-name> [--from <dir>]\n\n' +
				'Copies the newest .webm/.mp4 under test-results (or --from) to <root>/.harness/evidence/<slug>.<ext>.\n' +
				'Prints the relative destination path. Exits 1 when no clip is found.',
		);
		return;
	}
	const root = path.resolve(positional[0] ?? process.cwd());
	const slug = slugify(typeof flags.slug === 'string' ? flags.slug : 'feature');
	const from = typeof flags.from === 'string' ? path.resolve(root, flags.from) : null;

	const searchRoots = from
		? [from]
		: [
				path.join(root, 'test-results'),
				path.join(root, 'e2e', 'test-results'),
				path.join(root, 'tests', 'e2e', 'test-results'),
				path.join(root, 'cypress', 'videos'),
			];

	/** @type {{ path: string, mtime: number }[]} */
	const found = [];
	for (const dir of searchRoots) {
		walkVideos(dir, found);
	}

	found.sort((a, b) => b.mtime - a.mtime);

	if (found.length === 0) {
		console.error(
			'collect-video: no .webm/.mp4 found under test-results (or --from). Run the @evidence spec first.',
		);
		process.exit(1);
	}

	const src = found[0].path;
	const destDir = path.join(root, '.harness', 'evidence');
	fs.mkdirSync(destDir, { recursive: true });
	const dest = path.join(destDir, `${slug}${path.extname(src).toLowerCase()}`);
	fs.copyFileSync(src, dest);
	console.log(path.relative(root, dest));
}

main();
