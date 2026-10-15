#!/usr/bin/env node
/**
 * Resolve living plan paths for a consumer repo.
 *
 * Canonical layout (initiative pack). The harness owns initiative.md and epics/;
 * these scripts only add lens files:
 *   .harness/initiatives/<slug>/
 *     initiative.md
 *     epics/E<n>-<name>/{epic.md,stories/,state/}   ← plugin-created
 *     architecture-plan.md    ← lens source of truth (agent reads/writes)
 *     architecture-plan.html  ← derived via render-plan-html.cjs (human browser)
 *     ux-plan.md / ux-plan.html
 *     security-posture.md / security-posture.html
 *     assets/                 (optional)
 *     index.html              (optional lens hub)
 *
 * Legacy / simple repos may still keep a single plan at `.harness/<file>`.
 * Prefer Markdown SoT; HTML-only packs remain readable until migrated.
 *
 * Resolve order for arch | ux | security:
 *   1. Explicit --file / opts.file
 *   2. --slug → initiatives/<slug>/<file>
 *   3. Exactly one initiative pack under .harness/initiatives/
 *   4. Exactly one pack that already contains the file
 *   5. Legacy: .harness/<file>
 *
 * handoff stays harness-root.
 */

const fs = require('node:fs');
const path = require('node:path');
const { harnessDir } = require('./cli.cjs');
const { PLAN_MD_FILES } = require('./plan-md.cjs');

/** @type {Record<string, string>} */
const PLAN_FILES = {
	arch: 'architecture-plan.html',
	ux: 'ux-plan.html',
	security: 'security-posture.html',
	handoff: 'code-handoff.html',
};

/**
 * @param {string} consumerRoot
 * @returns {string[]}
 */
function listInitiativeSlugs(consumerRoot) {
	const base = path.join(harnessDir(consumerRoot), 'initiatives');
	if (!fs.existsSync(base)) {
		return [];
	}
	return fs
		.readdirSync(base, { withFileTypes: true })
		.filter((d) => d.isDirectory() && !d.name.startsWith('.'))
		.map((d) => d.name)
		.sort();
}

/**
 * @param {string} consumerRoot
 * @param {string} slug
 * @returns {string}
 */
function initiativePackDir(consumerRoot, slug) {
	if (!slug || slug === '.' || slug === '..' || /[\\/]/.test(slug)) {
		throw new Error(`Invalid --slug "${slug}": use a single folder name under .harness/initiatives/`);
	}
	return path.join(harnessDir(consumerRoot), 'initiatives', slug);
}

/**
 * True when the folder looks like an initiative pack (hub, product spec, or lens HTML).
 *
 * @param {string} dir
 * @returns {boolean}
 */
function isInitiativePackDir(dir) {
	if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
		return false;
	}
	const markers = [
		'initiative.md',
		'index.html',
		PLAN_FILES.arch,
		PLAN_FILES.ux,
		PLAN_FILES.security,
		PLAN_MD_FILES.arch,
		PLAN_MD_FILES.ux,
		PLAN_MD_FILES.security,
	];
	return markers.some((name) => fs.existsSync(path.join(dir, name)));
}

/**
 * Shared resolve for plan HTML or Markdown filenames.
 *
 * @param {string} consumerRoot
 * @param {string} kind
 * @param {Record<string, string>} fileMap
 * @param {{ file?: string; slug?: string }} [opts]
 * @returns {string}
 */
function resolvePlanPath(consumerRoot, kind, fileMap, opts = {}) {
	const fileName = fileMap[kind];
	if (!fileName) {
		throw new Error(`Unknown plan kind "${kind}"`);
	}

	if (opts.file) {
		return path.resolve(consumerRoot, opts.file);
	}

	// Handoff (and similar scratch) always at harness root.
	if (kind === 'handoff') {
		return path.join(harnessDir(consumerRoot), fileName);
	}

	if (opts.slug) {
		return path.join(initiativePackDir(consumerRoot, opts.slug), fileName);
	}

	const slugs = listInitiativeSlugs(consumerRoot);
	const packSlugs = slugs.filter((slug) =>
		isInitiativePackDir(initiativePackDir(consumerRoot, slug)),
	);

	if (packSlugs.length === 1) {
		return path.join(initiativePackDir(consumerRoot, packSlugs[0]), fileName);
	}

	const hits = packSlugs.filter((slug) =>
		fs.existsSync(path.join(initiativePackDir(consumerRoot, slug), fileName)),
	);
	if (hits.length === 1) {
		return path.join(initiativePackDir(consumerRoot, hits[0]), fileName);
	}

	return path.join(harnessDir(consumerRoot), fileName);
}

/**
 * @param {string} consumerRoot
 * @param {string} kind
 * @param {{ file?: string; slug?: string }} [opts]
 * @returns {string}
 */
function resolvePlanHtmlPath(consumerRoot, kind, opts = {}) {
	return resolvePlanPath(consumerRoot, kind, PLAN_FILES, opts);
}

/**
 * Markdown source of truth path (arch | ux | security | handoff).
 *
 * @param {string} consumerRoot
 * @param {string} kind
 * @param {{ file?: string; slug?: string }} [opts]
 * @returns {string}
 */
function resolvePlanMdPath(consumerRoot, kind, opts = {}) {
	return resolvePlanPath(consumerRoot, kind, PLAN_MD_FILES, opts);
}

/**
 * Default product-spec path for a new initiative.
 *
 * @param {string} slug
 * @returns {string}
 */
function defaultInitiativeSpecPath(slug) {
	return `.harness/initiatives/${slug}/initiative.md`;
}

module.exports = {
	PLAN_FILES,
	PLAN_MD_FILES,
	listInitiativeSlugs,
	initiativePackDir,
	isInitiativePackDir,
	resolvePlanHtmlPath,
	resolvePlanMdPath,
	defaultInitiativeSpecPath,
};
