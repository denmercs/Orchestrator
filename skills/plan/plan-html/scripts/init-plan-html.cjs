#!/usr/bin/env node
/**
 * Scaffold Markdown source of truth + derived HTML for architecture / UX / security / handoff.
 *
 * Usage:
 *   node .claude/skills/plan-html/scripts/init-plan-html.cjs [/path/to/repo] \
 *     --kind arch|ux|security|handoff \
 *     [--slug ai-chatbot] \
 *     [--product "Demo Plugin"] [--task "DEMO-310 title"] \
 *     [--branch feature/x] [--base main] [--force]
 *
 * Writes .md (source of truth), runs render-plan-html.cjs to write the .html
 * (human view), then validates the structure.
 *
 * Path resolve: see lib/plan-paths.cjs (initiative pack preferred; harness root fallback).
 * Placeholders only, no AI prose. Refuses to overwrite an existing .md unless --force.
 *
 * Templates: scripts/templates/plan-{arch,ux,security,handoff}.md
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs, resolveConsumerRoot, assertOrExit } = require('./lib/cli.cjs');
const { resolvePlanHtmlPath, resolvePlanMdPath } = require('./lib/plan-paths.cjs');
const { applyMdTokens, mdTemplatePath, PLAN_MD_FILES } = require('./lib/plan-md.cjs');

const TEMPLATE_BY_KIND = {
	arch: 'plan-arch.md',
	ux: 'plan-ux.md',
	security: 'plan-security.md',
	handoff: 'plan-handoff.md',
};

/**
 * @param {string} consumerRoot
 * @param {string} kind
 * @param {string | undefined} slug
 * @returns {string}
 */
function defaultPlanPath(consumerRoot, kind, slug) {
	return resolvePlanHtmlPath(consumerRoot, kind, { slug });
}

/**
 * @param {string} consumerRoot
 * @param {string} kind
 * @param {string | undefined} slug
 * @returns {string}
 */
function defaultMdPath(consumerRoot, kind, slug) {
	return resolvePlanMdPath(consumerRoot, kind, { slug });
}

function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	const consumerRoot = resolveConsumerRoot(positional[0]);

	const kind = typeof flags.kind === 'string' ? flags.kind : '';
	assertOrExit(
		Object.prototype.hasOwnProperty.call(TEMPLATE_BY_KIND, kind),
		`Missing or invalid --kind. Use arch, ux, security, or handoff.`,
	);

	const templatePath = mdTemplatePath(__dirname, kind);
	assertOrExit(fs.existsSync(templatePath), `Missing template ${templatePath}`);

	const slug = typeof flags.slug === 'string' ? flags.slug : undefined;
	const mdPath = defaultMdPath(consumerRoot, kind, slug);
	const outPath = defaultPlanPath(consumerRoot, kind, slug);

	if (fs.existsSync(mdPath) && !flags.force) {
		console.error(`Refusing to overwrite ${mdPath} (use --force).`);
		process.exit(1);
	}

	const product =
		typeof flags.product === 'string' && flags.product.trim()
			? flags.product.trim()
			: path.basename(consumerRoot);
	const task =
		typeof flags.task === 'string' && flags.task.trim()
			? flags.task.trim()
			: kind === 'handoff'
				? 'Fill intent from .harness/state.md'
				: 'Draft plan';
	const branch =
		typeof flags.branch === 'string' && flags.branch.trim()
			? flags.branch.trim()
			: '(current)';
	const base =
		typeof flags.base === 'string' && flags.base.trim() ? flags.base.trim() : 'main';
	const updated = new Date().toISOString().slice(0, 10);

	const md = applyMdTokens(fs.readFileSync(templatePath, 'utf8'), {
		product,
		task,
		branch,
		base,
		updated,
		slug: slug || '',
	});

	fs.mkdirSync(path.dirname(mdPath), { recursive: true });
	fs.writeFileSync(mdPath, md, 'utf8');

	const renderTool = path.join(__dirname, 'render-plan-html.cjs');
	const renderResult = spawnSync(
		process.execPath,
		[
			renderTool,
			consumerRoot,
			'--kind',
			kind,
			'--file',
			mdPath,
			'--out',
			outPath,
			'--validate',
		],
		{ encoding: 'utf8' },
	);
	if (renderResult.stdout) {
		process.stdout.write(renderResult.stdout);
	}
	if (renderResult.stderr) {
		process.stderr.write(renderResult.stderr);
	}
	if (renderResult.status !== 0) {
		console.error(`init-plan-html: wrote ${mdPath} but render/validate failed`);
		process.exit(renderResult.status ?? 1);
	}

	console.log(mdPath);
	console.log(outPath);
}

module.exports = {
	TEMPLATE_BY_KIND,
	PLAN_MD_FILES,
	applyMdTokens,
	defaultPlanPath,
	defaultMdPath,
};

if (require.main === module) {
	main();
}
