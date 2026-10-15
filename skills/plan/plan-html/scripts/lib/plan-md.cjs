/**
 * Markdown living-plan helpers: parse SoT .md, render section HTML, fill chrome templates.
 * Agents edit .md; humans open derived .html (via render-plan-html.cjs).
 */

const fs = require('node:fs');
const path = require('node:path');

/** @type {Record<string, string>} */
const PLAN_MD_FILES = {
	arch: 'architecture-plan.md',
	ux: 'ux-plan.md',
	security: 'security-posture.md',
	handoff: 'code-handoff.md',
};

/** Section id → h2 title (must match validate-plan-html / HTML-REPORT). */
/** @type {Record<string, Record<string, string>>} */
const SECTION_TITLES = {
	arch: {
		phase: 'Phase we are at',
		'finish-line': 'Start → finish',
		locks: 'At a glance',
		current: 'Current',
		target: 'Target',
		decisions: 'Decisions',
		stages: 'Stages',
		nongoals: 'Non-goals',
	},
	ux: {
		phase: 'Phase we are at',
		job: 'Job frame',
		locks: 'At a glance',
		journeys: 'Journeys',
		surfaces: 'Surfaces',
		states: 'States',
		decisions: 'Decisions',
		a11y: 'Accessibility',
		open: 'Open',
		nongoals: 'Non-goals',
		handoff: 'Handoff',
	},
	security: {
		phase: 'Phase we are at',
		locks: 'At a glance',
		surfaces: 'Surfaces',
		cves: 'CVEs',
		current: 'Current',
		target: 'Target',
		decisions: 'Decisions',
		stages: 'Stages',
		nongoals: 'Non-goals',
		gate: 'PR gate',
		assess: 'Assess',
		status: 'Status',
	},
	handoff: {
		intent: 'Intent',
		decisions: 'Decisions used',
		map: 'Change map',
		hotspots: 'Hotspots',
		frontend: 'Frontend',
		backend: 'Backend',
		tests: 'Tests and evidence',
		verify: 'What to verify (human)',
		out: 'Out of scope / follow-ups',
	},
};

/** Nav label overrides (href text). */
/** @type {Record<string, Record<string, string>>} */
const NAV_LABELS = {
	arch: {
		phase: 'Phase',
		'finish-line': 'Start → finish',
		locks: 'At a glance',
		current: 'Current',
		target: 'Target',
		decisions: 'Decisions',
		stages: 'Stages',
		nongoals: 'Non-goals',
	},
	ux: {
		phase: 'Phase',
		job: 'Job',
		locks: 'At a glance',
		journeys: 'Journeys',
		surfaces: 'Surfaces',
		states: 'States',
		decisions: 'Decisions',
		a11y: 'Accessibility',
		open: 'Open',
		nongoals: 'Non-goals',
		handoff: 'Handoff',
	},
	security: {
		phase: 'Phase',
		locks: 'At a glance',
		surfaces: 'Surfaces',
		cves: 'CVEs',
		current: 'Current',
		target: 'Target',
		decisions: 'Decisions',
		stages: 'Stages',
		nongoals: 'Non-goals',
		gate: 'Gate',
		assess: 'Assess',
		status: 'Status',
	},
	handoff: {
		intent: 'Intent',
		decisions: 'Decisions',
		map: 'Map',
		hotspots: 'Hotspots',
		frontend: 'Frontend',
		backend: 'Backend',
		tests: 'Tests',
		verify: 'Verify',
		out: 'Out of scope',
	},
};

/** Document h1 by kind. */
/** @type {Record<string, string>} */
const DOC_TITLES = {
	arch: 'Architecture plan',
	ux: 'UX plan',
	security: 'Security posture',
	handoff: 'Code handoff',
};

/**
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * @param {string} md
 * @returns {{ meta: Record<string, string>; body: string }}
 */
function parseFrontmatter(md) {
	const normalized = md.replace(/^\uFEFF/, '');
	if (!normalized.startsWith('---')) {
		return { meta: {}, body: normalized };
	}
	const end = normalized.indexOf('\n---', 3);
	if (end === -1) {
		return { meta: {}, body: normalized };
	}
	const raw = normalized.slice(3, end).trim();
	const body = normalized.slice(end + 4).replace(/^\n/, '');
	/** @type {Record<string, string>} */
	const meta = {};
	for (const line of raw.split('\n')) {
		const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!m) continue;
		let v = m[2].trim();
		if (
			(v.startsWith('"') && v.endsWith('"')) ||
			(v.startsWith("'") && v.endsWith("'"))
		) {
			v = v.slice(1, -1);
		}
		meta[m[1]] = v;
	}
	return { meta, body };
}

/**
 * Split body into ## section-id blocks (first heading level-2 wins as section id).
 *
 * @param {string} body
 * @returns {{ preamble: string; sections: Map<string, string> }}
 */
function splitSections(body) {
	const lines = body.split('\n');
	/** @type {Map<string, string>} */
	const sections = new Map();
	let preamble = '';
	/** @type {string | null} */
	let current = null;
	/** @type {string[]} */
	let buf = [];

	const flush = () => {
		if (current) {
			sections.set(current, buf.join('\n').trim());
		} else {
			preamble = buf.join('\n').trim();
		}
		buf = [];
	};

	for (const line of lines) {
		const m = line.match(/^##\s+([a-z0-9_-]+)\s*$/i);
		if (m) {
			flush();
			current = m[1].toLowerCase();
			continue;
		}
		buf.push(line);
	}
	flush();
	return { preamble, sections };
}

/**
 * Inline markdown → HTML (bold, italic, code, links).
 *
 * @param {string} text
 * @returns {string}
 */
function renderInline(text) {
	let s = escapeHtml(text);
	s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
	s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
	s = s.replace(
		/\[([^\]]+)\]\(([^)]+)\)/g,
		(_, label, href) => `<a class="underline" href="${escapeHtml(href)}">${label}</a>`,
	);
	return s;
}

/**
 * Detect stage / decision article headings: ### stage-S1 or ### d0
 *
 * @param {string} line
 * @returns {{ id: string; title: string } | null}
 */
function parseArticleHeading(line) {
	const m = line.match(/^###\s+(\S+)\s*(.*—\s*(.+))?$/);
	if (!m) return null;
	const idRaw = m[1].replace(/:$/, '');
	const id = idRaw.toLowerCase().startsWith('stage-')
		? idRaw
		: /^s\d+/i.test(idRaw)
			? `stage-${idRaw}`
			: idRaw;
	const title = (m[3] || m[2] || idRaw).replace(/^—\s*/, '').trim() || idRaw;
	return { id, title };
}

/**
 * Pull epic/story/status/title from leading meta lines; return rest.
 *
 * @param {string[]} lines
 * @returns {{ meta: Record<string, string>; rest: string[] }}
 */
function takeArticleMeta(lines) {
	/** @type {Record<string, string>} */
	const meta = {};
	let i = 0;
	while (i < lines.length) {
		const line = lines[i].trim();
		if (!line) {
			i += 1;
			continue;
		}
		const bullet = line.match(/^[-*]\s*(\w+)\s*:\s*(.+)$/i);
		const bold = line.match(/^\*\*(\w+)\*\*\s*:\s*(.+)$/i);
		const plain = line.match(/^(\w+)\s*:\s*(.+)$/i);
		const hit = bullet || bold || plain;
		if (hit && /^(epic|story|status|title|jira)$/i.test(hit[1])) {
			meta[hit[1].toLowerCase()] = hit[2].trim();
			i += 1;
			continue;
		}
		break;
	}
	return { meta, rest: lines.slice(i) };
}

/**
 * Render a markdown block (no ## section headers) to HTML.
 *
 * @param {string} md
 * @param {{ wrapArticles?: boolean }} [opts]
 * @returns {string}
 */
function renderMarkdownBlock(md, opts = {}) {
	const wrapArticles = Boolean(opts.wrapArticles);
	const lines = md.replace(/\r\n/g, '\n').split('\n');
	/** @type {string[]} */
	const out = [];
	let i = 0;

	const flushParagraph = (/** @type {string[]} */ paras) => {
		const text = paras.join(' ').trim();
		if (text) out.push(`<p>${renderInline(text)}</p>`);
		paras.length = 0;
	};

	while (i < lines.length) {
		const line = lines[i];

		// Fenced blocks
		const fence = line.match(/^```(\w*)\s*$/);
		if (fence) {
			const lang = fence[1].toLowerCase();
			i += 1;
			/** @type {string[]} */
			const body = [];
			while (i < lines.length && !/^```\s*$/.test(lines[i])) {
				body.push(lines[i]);
				i += 1;
			}
			i += 1; // closing fence
			const raw = body.join('\n');
			if (lang === 'mermaid') {
				out.push(`<pre class="mermaid">\n${raw}\n</pre>`);
			} else if (lang === 'html') {
				out.push(raw);
			} else {
				out.push(`<pre><code>${escapeHtml(raw)}</code></pre>`);
			}
			continue;
		}

		// Article heading under stages/decisions
		if (wrapArticles && line.startsWith('### ')) {
			const art = parseArticleHeading(line);
			i += 1;
			/** @type {string[]} */
			const artLines = [];
			while (i < lines.length && !lines[i].startsWith('### ') && !lines[i].startsWith('## ')) {
				artLines.push(lines[i]);
				i += 1;
			}
			const { meta, rest } = takeArticleMeta(artLines);
			const title = meta.title || art?.title || art?.id || 'item';
			const id = art?.id || title.toLowerCase().replace(/\s+/g, '-');
			const attrs = [
				`id="${escapeHtml(id)}"`,
				'class="border border-zinc-700 p-3 space-y-2"',
			];
			if (meta.epic) attrs.push(`data-epic="${escapeHtml(meta.epic)}"`);
			if (meta.story) attrs.push(`data-story="${escapeHtml(meta.story)}"`);
			const status = meta.status
				? `<span class="rounded bg-zinc-800 px-2 py-0.5 text-xs uppercase">${escapeHtml(meta.status)}</span>`
				: '';
			const link =
				meta.story || meta.jira
					? `<a class="font-mono underline" href="#">${escapeHtml(meta.story || meta.jira)}</a>`
					: '';
			const inner = renderMarkdownBlock(rest.join('\n'), { wrapArticles: false });
			out.push(
				`<article ${attrs.join(' ')}><strong>${renderInline(title)}</strong> ${link} ${status}${inner}</article>`,
			);
			continue;
		}

		// ATX headings
		const h = line.match(/^(#{1,4})\s+(.+)$/);
		if (h) {
			const level = Math.min(h[1].length + 1, 4); // bump: section already has h2
			out.push(`<h${level} class="font-serif text-xl text-zinc-50">${renderInline(h[2])}</h${level}>`);
			i += 1;
			continue;
		}

		// Table
		if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-/.test(lines[i + 1])) {
			/** @type {string[]} */
			const rows = [];
			while (i < lines.length && lines[i].includes('|')) {
				rows.push(lines[i]);
				i += 1;
			}
			if (rows.length >= 2) {
				const parseRow = (/** @type {string} */ r) =>
					r
						.replace(/^\|/, '')
						.replace(/\|$/, '')
						.split('|')
						.map((c) => c.trim());
				const header = parseRow(rows[0]);
				const bodyRows = rows.slice(2).map(parseRow);
				out.push('<table>');
				out.push(
					'<tr>' +
						header.map((c) => `<th>${renderInline(c)}</th>`).join('') +
						'</tr>',
				);
				for (const row of bodyRows) {
					out.push(
						'<tr>' + row.map((c) => `<td>${renderInline(c)}</td>`).join('') + '</tr>',
					);
				}
				out.push('</table>');
			}
			continue;
		}

		// Lists
		if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
			const ordered = /^\s*\d+\.\s+/.test(line);
			/** @type {string[]} */
			const items = [];
			while (
				i < lines.length &&
				(ordered ? /^\s*\d+\.\s+/.test(lines[i]) : /^\s*[-*]\s+/.test(lines[i]))
			) {
				items.push(lines[i].replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+\.\s+/, ''));
				i += 1;
			}
			const tag = ordered ? 'ol' : 'ul';
			out.push(
				`<${tag}>` +
					items.map((it) => `<li>${renderInline(it)}</li>`).join('') +
					`</${tag}>`,
			);
			continue;
		}

		// Blockquote / callout
		if (line.startsWith('> ')) {
			/** @type {string[]} */
			const quotes = [];
			while (i < lines.length && lines[i].startsWith('> ')) {
				quotes.push(lines[i].slice(2));
				i += 1;
			}
			out.push(
				`<p class="border-l-4 border-emerald-500 pl-3">${renderInline(quotes.join(' '))}</p>`,
			);
			continue;
		}

		// Blank
		if (!line.trim()) {
			i += 1;
			continue;
		}

		// Paragraph
		/** @type {string[]} */
		const paras = [];
		while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], wrapArticles)) {
			paras.push(lines[i]);
			i += 1;
		}
		flushParagraph(paras);
	}

	return out.join('\n');
}

/**
 * @param {string} line
 * @param {boolean} wrapArticles
 * @returns {boolean}
 */
function isBlockStart(line, wrapArticles) {
	if (/^```/.test(line)) return true;
	if (/^#{1,4}\s+/.test(line)) return true;
	if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) return true;
	if (line.includes('|')) return true;
	if (line.startsWith('> ')) return true;
	if (wrapArticles && line.startsWith('### ')) return true;
	return false;
}

/**
 * @param {string} kind
 * @param {Map<string, string>} sections
 * @returns {string}
 */
function renderSectionsHtml(kind, sections) {
	const titles = SECTION_TITLES[kind] || {};
	const order = Object.keys(titles);
	/** @type {string[]} */
	const parts = [];
	const seen = new Set();

	const renderOne = (/** @type {string} */ id, /** @type {string} */ body) => {
		const title = titles[id] || id;
		const wrapArticles = id === 'stages' || id === 'decisions';
		const inner =
			!body || body === '…' || body === '...'
				? '…'
				: renderMarkdownBlock(body, { wrapArticles });
		parts.push(
			`<section id="${escapeHtml(id)}"><h2 class="font-serif text-2xl text-zinc-50">${escapeHtml(title)}</h2>\n${inner}\n</section>`,
		);
		seen.add(id);
	};

	for (const id of order) {
		if (sections.has(id)) renderOne(id, sections.get(id) || '');
	}
	for (const [id, body] of sections) {
		if (!seen.has(id)) renderOne(id, body);
	}
	return parts.join('\n');
}

/**
 * Build sticky nav from section ids present (plus kind defaults).
 *
 * @param {string} kind
 * @param {string[]} sectionIds
 * @param {string} product
 * @returns {string}
 */
function renderNav(kind, sectionIds, product) {
	const labels = NAV_LABELS[kind] || {};
	const titles = SECTION_TITLES[kind] || {};
	const ids = sectionIds.length ? sectionIds : Object.keys(titles);
	const highlight =
		kind === 'arch'
			? 'finish-line'
			: kind === 'ux' || kind === 'handoff'
				? kind === 'handoff'
					? 'verify'
					: 'handoff'
				: kind === 'security'
					? 'gate'
					: ids[0];
	const links = ids
		.map((id) => {
			const label = labels[id] || titles[id] || id;
			const cls =
				id === highlight
					? 'font-medium text-sky-400'
					: 'hover:text-sky-300';
			return `<a href="#${escapeHtml(id)}" class="${cls}">${escapeHtml(label)}</a>`;
		})
		.join('\n\t\t\t');
	return `<nav class="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2 text-xs text-zinc-300">
			<span class="text-zinc-500">${escapeHtml(product)}</span>
			${links}
		</nav>`;
}

/**
 * @param {object} opts
 * @param {string} opts.kind
 * @param {Record<string, string>} opts.meta
 * @param {Map<string, string>} opts.sections
 * @param {string} [opts.mdPath]
 * @returns {string}
 */
function buildPlanHtml(opts) {
	const { kind, meta, sections } = opts;
	const product = meta.product || meta.slug || 'product';
	const task = meta.task || '';
	const status = meta.status || 'draft';
	const updated = meta.updated || new Date().toISOString().slice(0, 10);
	const jira = meta.jira_refreshed || meta.jiraRefreshed || '';
	const branch = meta.branch || '';
	const base = meta.base || '';
	const docTitle = DOC_TITLES[kind] || 'Plan';
	const wantsMermaid =
		kind === 'arch' ||
		kind === 'handoff' ||
		[...sections.values()].some((b) => /```mermaid/.test(b));

	const sectionIds = [...sections.keys()];
	const nav = renderNav(kind, sectionIds, product);
	const mainSections = renderSectionsHtml(kind, sections);
	const mdNote = opts.mdPath
		? `SoT: ${escapeHtml(opts.mdPath)} · derived HTML — do not hand-edit`
		: 'Markdown is source of truth · HTML is derived — do not hand-edit';

	let statusLine = `Status: ${escapeHtml(status)} · Updated ${escapeHtml(updated)}`;
	if (jira) statusLine += ` · Last Jira refreshed ${escapeHtml(jira)}`;
	if (kind === 'handoff' && (branch || base)) {
		statusLine = `Branch: ${escapeHtml(branch || '(current)')} · Base: ${escapeHtml(base || 'main')} · Updated ${escapeHtml(updated)}`;
	}

	const mermaidScript = wantsMermaid
		? `<script type="module">
			import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
			mermaid.initialize({ startOnLoad: true, theme: "dark", securityLevel: "loose" });
		</script>`
		: '';

	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<title>${escapeHtml(docTitle)} — ${escapeHtml(kind === 'handoff' ? task || product : product)}</title>
		<script src="https://cdn.tailwindcss.com"></script>
		${mermaidScript}
		<style>
			html { scroll-behavior: smooth; }
			section[id] { scroll-margin-top: 5rem; }
			a { color: #93c5fd; }
			a:hover { color: #bfdbfe; }
			table { border-collapse: collapse; width: 100%; }
			th, td { border: 1px solid #30363d; padding: 0.5rem 0.75rem; text-align: left; }
			th { background: #161b22; color: #8b949e; font-size: 0.75rem; }
			.diff-file {
				border: 1px solid #30363d; border-radius: 6px; overflow: hidden;
				background: #0d1117; margin-top: 0.75rem;
			}
			.diff-file__header {
				display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem;
				padding: 0.5rem 0.75rem; background: #161b22; border-bottom: 1px solid #30363d;
				font-size: 0.75rem; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
				color: #c9d1d9;
			}
			.diff-file__badge {
				font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.04em;
				color: #8b949e; border: 1px solid #30363d; border-radius: 999px;
				padding: 0.1rem 0.45rem; background: #0d1117;
			}
			.diff-file__meta { color: #8b949e; margin-left: auto; font-size: 0.7rem; }
			.diff-file__body {
				overflow-x: auto; margin: 0; padding: 0.35rem 0; font-size: 0.75rem;
				line-height: 1.45; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
			}
			.diff-line {
				display: grid; grid-template-columns: 3.25rem 1.25rem minmax(0, 1fr);
				white-space: pre; min-width: max-content; width: 100%;
			}
			.diff-line__num { text-align: right; padding: 0 0.75rem 0 0.5rem; color: #484f58; user-select: none; }
			.diff-line__mark { text-align: center; user-select: none; }
			.diff-line__code { padding-right: 1rem; color: #c9d1d9; }
			.diff-line--add { background: rgba(46, 160, 67, 0.15); }
			.diff-line--add .diff-line__mark { color: #3fb950; }
			.diff-line--add .diff-line__num { color: #3fb950; }
			.diff-line--del { background: rgba(248, 81, 73, 0.15); }
			.diff-line--del .diff-line__mark { color: #f85149; }
			.diff-line--del .diff-line__num { color: #f85149; }
			.diff-line--ctx .diff-line__mark { color: transparent; }
		</style>
	</head>
	<body class="bg-zinc-950 text-zinc-100 font-sans">
		${nav}
		<main class="max-w-5xl mx-auto px-6 py-10 space-y-14">
			<header>
				<p class="text-xs uppercase tracking-wider text-zinc-500">${escapeHtml(product)}</p>
				<h1 class="font-serif text-3xl text-zinc-50">${escapeHtml(docTitle)}</h1>
				<p class="text-sm text-zinc-400">${statusLine}</p>
				${task ? `<p class="text-zinc-200">${escapeHtml(task)}</p>` : ''}
			</header>
			${mainSections}
			<footer class="text-sm text-zinc-500">${mdNote}</footer>
		</main>
	</body>
</html>
`;
}

/**
 * @param {string} mdSource
 * @param {string} kind
 * @param {{ mdPath?: string }} [opts]
 * @returns {{ html: string; meta: Record<string, string>; sections: Map<string, string> }}
 */
function renderPlanMarkdown(mdSource, kind, opts = {}) {
	const { meta, body } = parseFrontmatter(mdSource);
	if (meta.kind && meta.kind !== kind) {
		// allow mismatch warning at call site; still render
	}
	const { sections } = splitSections(body);
	const html = buildPlanHtml({
		kind,
		meta,
		sections,
		mdPath: opts.mdPath,
	});
	return { html, meta, sections };
}

/**
 * @param {string} templateMd
 * @param {Record<string, string>} vars
 * @returns {string}
 */
function applyMdTokens(templateMd, vars) {
	return templateMd.replace(/\{\{(\w+)\}\}/g, (_, key) =>
		Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{{${key}}}`,
	);
}

/**
 * @param {string} scriptsDir
 * @param {string} kind
 * @returns {string}
 */
function mdTemplatePath(scriptsDir, kind) {
	const names = {
		arch: 'plan-arch.md',
		ux: 'plan-ux.md',
		security: 'plan-security.md',
		handoff: 'plan-handoff.md',
	};
	const name = names[kind];
	if (!name) throw new Error(`No MD template for kind ${kind}`);
	return path.join(scriptsDir, 'templates', name);
}

module.exports = {
	PLAN_MD_FILES,
	SECTION_TITLES,
	DOC_TITLES,
	parseFrontmatter,
	splitSections,
	renderMarkdownBlock,
	renderPlanMarkdown,
	buildPlanHtml,
	applyMdTokens,
	mdTemplatePath,
	escapeHtml,
};
