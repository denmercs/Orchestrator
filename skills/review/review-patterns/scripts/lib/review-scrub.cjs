/**
 * Scrub pull-request review text down to anonymous, portable signal, and gate
 * mined review principles before anyone sees them.
 *
 * Used by tools/mine-review-patterns.cjs. Pure functions — no I/O.
 */

const crypto = require('node:crypto');

/** Common words that happen to be first names or login fragments; never treated as names. */
const NAME_STOPLIST = new Set([
	'will', 'mark', 'bill', 'grant', 'max', 'art', 'ray', 'rich', 'jack', 'pat', 'sam',
	'dev', 'web', 'the', 'and', 'bot', 'admin', 'user', 'test', 'code', 'team', 'org',
	// Role words from automation logins (e.g. "*-pull-request-reviewer"); generic, not people.
	'agent', 'reviewer', 'review', 'pull', 'request', 'copilot', 'github', 'actions', 'app', 'apps',
]);

/** Ordered: code blocks first so nothing inside them is scanned as prose. */
const REDACTIONS = [
	[/```suggestion[\s\S]*?```/g, '[suggested change]'],
	[/```[\s\S]*?```/g, '[code block]'],
	[/!\[[^\]]*\]\([^)]*\)/g, '[image]'],
	[/<img\b[^>]*>/gi, '[image]'],
	[/<\/?[a-z][^>]*>/gi, ' '],
	[/\[([^\]]+)\]\((?:https?:)?\/\/[^)]+\)/g, '$1 [link]'],
	[/\b(?:https?|ftp):\/\/\S+/gi, '[link]'],
	[/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[email]'],
	[/(^|[^\w`])@[\w-]+(?:\/[\w-]+)?/g, '$1[someone]'],
	[/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g, '[ticket]'],
	[/(^|\s)#\d+\b/g, '$1[ref]'],
	[/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
	[/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, '[sha]'],
	[/\b(api[_-]?key|token|secret|password|passwd|bearer)\b(\s*[:=]\s*|\s+)\S+/gi, '$1 [redacted]'],
	[/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted]'],
];

/** Patterns that must never appear in a published principle. */
const LEAK_PATTERNS = [
	['link', /\b(?:https?|ftp):\/\/|\bwww\./i],
	['email', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/],
	['mention', /(^|[^\w`])@[\w-]+/],
	['ticket key', /\b[A-Z][A-Z0-9]{1,9}-\d+\b/],
	['ip address', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
	['commit sha', /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/],
	['secret-like string', /\b[A-Za-z0-9+/_-]{32,}/],
	['placeholder left in', /\[(?:someone|email|ticket|sha|ip|redacted|link|ref)\]/],
];

/**
 * @param {string} salt
 * @param {string} token
 */
function hashToken(salt, token) {
	return crypto.createHash('sha256').update(`${salt}:${token.toLowerCase()}`).digest('hex').slice(0, 16);
}

/**
 * Split logins and display names into tokens worth redacting.
 * @param {Iterable<string>} identities
 * @returns {string[]}
 */
function nameTokens(identities) {
	const out = new Set();
	for (const raw of identities) {
		if (!raw) continue;
		const whole = raw.toLowerCase().trim();
		if (whole.length >= 3) out.add(whole);
		for (const part of whole.split(/[\s._\-0-9]+/)) {
			if (part.length >= 3 && !NAME_STOPLIST.has(part)) out.add(part);
		}
	}
	return [...out].filter((t) => !NAME_STOPLIST.has(t)).sort((a, b) => b.length - a.length);
}

/**
 * @param {string} s
 */
function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove people, links, keys, secrets, and code from one review comment.
 * @param {string} text
 * @param {string[]} names output of nameTokens()
 * @param {string[]} [terms] extra terms to strip (org, repo, product words)
 */
function scrubText(text, names, terms = []) {
	let out = String(text || '');
	for (const [re, sub] of REDACTIONS) out = out.replace(re, /** @type {string} */ (sub));
	for (const name of names) {
		out = out.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, 'gi'), '[someone]');
	}
	for (const term of terms) {
		out = out.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'gi'), '[product]');
	}
	return out.replace(/\s+/g, ' ').trim();
}

/**
 * Reduce a file path to anonymous tags: extension plus coarse role.
 * @param {string | null | undefined} filePath
 */
function pathTags(filePath) {
	if (!filePath) return { ext: null, tags: [] };
	const p = filePath.toLowerCase();
	const m = /\.([a-z0-9]+)$/.exec(p);
	const ext = m ? m[1] : null;
	/** @type {string[]} */
	const tags = [];
	if (/(^|\/)(__tests__|tests?|specs?|e2e|cypress)\/|\.(test|spec|e2e)\./.test(p)) tags.push('test');
	if (/(^|\/)\.github\/|(^|\/)(ci|pipelines?)\/|jenkinsfile|\.gitlab-ci/.test(p)) tags.push('ci');
	if (/\.(css|scss|sass|less)$|styled|\.styles?\./.test(p)) tags.push('style');
	if (/\.(md|mdx|rst|txt)$/.test(p)) tags.push('docs');
	if (/\.(tsx|jsx|vue|svelte|brs|bs|xml|swift|kt)$|(^|\/)(components?|views?|screens?|pages?|ui)\//.test(p)) tags.push('ui');
	if (/(^|\/)(api|server|backend|routes?|controllers?|services?|handlers?)\/|\.(scala|go|java|py|rb|php)$/.test(p)) tags.push('backend');
	if (/(^|\/)(migrations?|schema|db|sql)\/|\.sql$/.test(p)) tags.push('data');
	if (/(^|\/)(config|\.config)\/|\.(ya?ml|toml|ini|env\.example)$|(^|\/)(package|tsconfig|project)\.json$|\.sbt$|dockerfile/.test(p)) tags.push('config');
	if (/(^|\/)(hooks?|state|store|redux|context)\//.test(p)) tags.push('state');
	return { ext, tags };
}

/**
 * Gate candidate principles: enough independent evidence, nothing identifying.
 *
 * @param {{ principles: Array<{ id: string, principle: string, why?: string, evidence: string[] }> }} candidates
 * @param {{ meta: { salt: string, nameHashes: string[], termHashes: string[] }, comments: Array<{ id: string, pr: string, reviewer: string, recent?: boolean }> }} corpus
 * @param {{ minPrs?: number, minReviewers?: number }} [opts]
 */
function checkPrinciples(candidates, corpus, opts = {}) {
	const minPrs = opts.minPrs ?? 3;
	const minReviewers = opts.minReviewers ?? 2;
	const byId = new Map(corpus.comments.map((c) => [c.id, c]));
	const nameHashes = new Set(corpus.meta.nameHashes);
	const termHashes = new Set(corpus.meta.termHashes);

	return candidates.principles.map((p) => {
		/** @type {string[]} */
		const problems = [];
		const evidence = Array.isArray(p.evidence) ? p.evidence : [];
		const found = evidence.map((id) => byId.get(id)).filter(Boolean);
		const missing = evidence.filter((id) => !byId.has(id));
		if (missing.length) problems.push(`unknown evidence ids: ${missing.join(', ')}`);

		const prs = new Set(found.map((c) => c && c.pr)).size;
		const reviewers = new Set(found.map((c) => c && c.reviewer)).size;
		if (prs < minPrs) problems.push(`seen in ${prs} PR(s), need ${minPrs}`);
		if (reviewers < minReviewers) problems.push(`raised by ${reviewers} reviewer(s), need ${minReviewers}`);

		const text = `${p.principle || ''}\n${p.why || ''}`;
		for (const [label, re] of LEAK_PATTERNS) {
			if (re.test(text)) problems.push(`contains a ${label}`);
		}
		const words = text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) || [];
		for (const w of new Set(words)) {
			const h = hashToken(corpus.meta.salt, w);
			if (nameHashes.has(h)) problems.push(`contains a person's name or login ("${w.slice(0, 1)}…")`);
			if (termHashes.has(h)) problems.push(`contains a repo/org term ("${w}")`);
		}
		const recent = found.some((c) => c && c.recent);
		const older = found.some((c) => c && c.recent === false);
		const age = recent && older ? 'recent + older' : recent ? 'recent' : older ? 'older only' : 'age unknown';
		return { id: p.id, ok: problems.length === 0, prs, reviewers, age, problems };
	});
}

module.exports = { scrubText, nameTokens, pathTags, hashToken, checkPrinciples };
