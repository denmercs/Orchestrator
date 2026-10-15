#!/usr/bin/env node
/**
 * Mine merged-PR review comments into an anonymous corpus, then gate the
 * review principles an agent distils from it.
 *
 * Usage:
 *   node scripts/mine-review-patterns.cjs mine --repo owner/name [--repo owner/name] \
 *     [--limit 150|all] [--term word] [--exclude-path prefix/] [--recent-months 12] \
 *     [--out .tmp/review-patterns/corpus.json]
 *   node scripts/mine-review-patterns.cjs check --candidates file.json \
 *     [--corpus .tmp/review-patterns/corpus.json] [--min-prs 3] [--min-reviewers 2]
 *
 * mine:  needs an authenticated `gh`. Keeps reviewer comments only (no bots, no
 *        PR-author replies). Logins, names, links, keys, SHAs, secrets and code
 *        are scrubbed before anything is written. Reviewers and PRs become
 *        per-run ids (r1, p1); the login map is never written. Paths become
 *        extension + role tags. --exclude-path drops PRs whose files all sit
 *        under a prefix, inline comments on it, and summaries of PRs mostly
 *        under it. Each comment is tagged recent (merged within
 *        --recent-months) or older. Output belongs in a gitignored scratch dir.
 * check: every principle needs >= min-prs PRs and >= min-reviewers reviewers of
 *        evidence, and must contain no name, login, link, key, or repo term.
 *        Exit 1 when any principle fails.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scrubText, nameTokens, pathTags, hashToken, checkPrinciples } = require('./lib/review-scrub.cjs');

const DEFAULT_OUT = path.join('.tmp', 'review-patterns', 'corpus.json');
const PAGE_SIZE = 25;

const QUERY = `
query($owner: String!, $name: String!, $cursor: String, $pageSize: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: MERGED, first: $pageSize, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        mergedAt
        author { __typename login ... on User { name } }
        files(first: 100) { nodes { path } }
        reviews(first: 40) {
          nodes {
            state
            body
            author { __typename login ... on User { name } }
            comments(first: 60) {
              nodes { body path outdated author { __typename login ... on User { name } } }
            }
          }
        }
      }
    }
  }
}`;

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
	const [command, ...rest] = argv;
	/** @type {{ command: string | undefined, repos: string[], terms: string[], excludePaths: string[], recentMonths: number, limit: number, out: string, corpus: string, candidates: string | null, minPrs: number, minReviewers: number }} */
	const args = {
		command,
		repos: [],
		terms: [],
		excludePaths: [],
		recentMonths: 12,
		limit: 150,
		out: DEFAULT_OUT,
		corpus: DEFAULT_OUT,
		candidates: null,
		minPrs: 3,
		minReviewers: 2,
	};
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i];
		const val = rest[i + 1];
		if (flag === '--repo' && val) (args.repos.push(val), i++);
		else if (flag === '--term' && val) (args.terms.push(val.toLowerCase()), i++);
		else if (flag === '--exclude-path' && val) (args.excludePaths.push(val), i++);
		else if (flag === '--recent-months' && val) (args.recentMonths = Number(val), i++);
		else if (flag === '--limit' && val) (args.limit = val === 'all' ? Infinity : Number(val), i++);
		else if (flag === '--out' && val) (args.out = val, i++);
		else if (flag === '--corpus' && val) (args.corpus = val, i++);
		else if (flag === '--candidates' && val) (args.candidates = val, i++);
		else if (flag === '--min-prs' && val) (args.minPrs = Number(val), i++);
		else if (flag === '--min-reviewers' && val) (args.minReviewers = Number(val), i++);
	}
	return args;
}

/**
 * @param {string} owner
 * @param {string} name
 * @param {string | null} cursor
 * @param {number} pageSize
 */
function fetchPage(owner, name, cursor, pageSize) {
	const ghArgs = ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pageSize=${pageSize}`];
	if (cursor) ghArgs.push('-f', `cursor=${cursor}`);
	const raw = execFileSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
	return JSON.parse(raw).data.repository.pullRequests;
}

/**
 * @param {{ __typename?: string, login?: string } | null | undefined} author
 */
function isHuman(author) {
	return Boolean(author && author.login && author.__typename !== 'Bot' && !/\[bot\]$|-bot$|^dependabot|^renovate/i.test(author.login));
}

/**
 * @param {ReturnType<typeof parseArgs>} args
 */
function mine(args) {
	if (!args.repos.length) throw new Error('mine: pass at least one --repo owner/name');

	/** @type {any[]} */
	const prs = [];
	for (const full of args.repos) {
		const [owner, name] = full.split('/');
		let cursor = null;
		let got = 0;
		while (got < args.limit) {
			const page = fetchPage(owner, name, cursor, Math.min(PAGE_SIZE, args.limit - got));
			for (const pr of page.nodes) prs.push({ repo: full, pr });
			got += page.nodes.length;
			process.stderr.write(`mine: ${full} ${got} PRs\r`);
			if (!page.pageInfo.hasNextPage) break;
			cursor = page.pageInfo.endCursor;
		}
		process.stderr.write('\n');
	}

	/** @type {Set<string>} */
	const identities = new Set();
	for (const { pr } of prs) {
		const people = [pr.author, ...pr.reviews.nodes.flatMap((r) => [r.author, ...r.comments.nodes.map((c) => c.author)])];
		for (const a of people) {
			if (a && a.login) identities.add(a.login);
			if (a && a.name) identities.add(a.name);
		}
	}
	const names = nameTokens(identities);
	const terms = new Set(args.terms);
	for (const full of args.repos) {
		for (const part of full.toLowerCase().split(/[/._-]+/)) if (part.length >= 4) terms.add(part);
	}

	const salt = crypto.randomBytes(16).toString('hex');
	/** @type {Map<string, string>} login → per-run id; never written */
	const reviewerIds = new Map();
	/** @type {Map<string, string>} */
	const sourceIds = new Map();
	/** @type {any[]} */
	const comments = [];
	let prIndex = 0;
	let skippedPrs = 0;
	let skippedComments = 0;
	const excluded = (/** @type {string | null | undefined} */ p) => Boolean(p) && args.excludePaths.some((x) => String(p).startsWith(x));
	const recentSince = new Date();
	recentSince.setMonth(recentSince.getMonth() - args.recentMonths);

	for (const { repo, pr } of prs) {
		if (!sourceIds.has(repo)) sourceIds.set(repo, String.fromCharCode(65 + sourceIds.size));
		const prId = `p${++prIndex}`;
		const files = pr.files ? pr.files.nodes.map((f) => f.path) : [];
		const excludedFiles = files.filter(excluded).length;
		if (files.length && excludedFiles === files.length) {
			skippedPrs++;
			continue;
		}
		const mostlyExcluded = files.length > 0 && excludedFiles / files.length > 0.5;
		const recent = Boolean(pr.mergedAt) && new Date(pr.mergedAt) >= recentSince;
		const authorLogin = pr.author && pr.author.login;
		for (const review of pr.reviews.nodes) {
			if (!isHuman(review.author) || review.author.login === authorLogin) continue;
			const login = review.author.login;
			if (!reviewerIds.has(login)) reviewerIds.set(login, `r${reviewerIds.size + 1}`);
			const base = { pr: prId, source: sourceIds.get(repo), reviewer: reviewerIds.get(login), state: review.state, recent };
			const body = scrubText(review.body, names, [...terms]);
			if (mostlyExcluded && body.length >= 3) skippedComments++;
			else if (body.length >= 3) comments.push({ id: `c${comments.length + 1}`, ...base, kind: 'summary', ext: null, tags: [], outdated: null, text: body });
			for (const c of review.comments.nodes) {
				if (!isHuman(c.author) || c.author.login === authorLogin) continue;
				if (excluded(c.path)) {
					skippedComments++;
					continue;
				}
				const text = scrubText(c.body, names, [...terms]);
				if (text.length < 3) continue;
				comments.push({ id: `c${comments.length + 1}`, ...base, kind: 'inline', ...pathTags(c.path), outdated: Boolean(c.outdated), text });
			}
		}
	}

	const corpus = {
		meta: {
			createdAt: new Date().toISOString(),
			sources: sourceIds.size,
			prs: prs.length - skippedPrs,
			excludedPrs: skippedPrs,
			excludedComments: skippedComments,
			recentMonths: args.recentMonths,
			reviewers: reviewerIds.size,
			comments: comments.length,
			salt,
			nameHashes: names.map((n) => hashToken(salt, n)),
			termHashes: [...terms].map((t) => hashToken(salt, t)),
		},
		comments,
	};
	fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
	fs.writeFileSync(args.out, JSON.stringify(corpus, null, '\t') + '\n', 'utf8');

	const byTag = {};
	for (const c of comments) for (const t of c.tags.length ? c.tags : [c.kind === 'summary' ? '(summary)' : '(untagged)']) byTag[t] = (byTag[t] || 0) + 1;
	const inline = comments.filter((c) => c.kind === 'inline');
	if (args.excludePaths.length) console.log(`mine: excluded ${skippedPrs} PRs and ${skippedComments} comments under ${args.excludePaths.join(', ')}`);
	console.log(`mine: recent (last ${args.recentMonths} months) comments: ${comments.filter((c) => c.recent).length} of ${comments.length}`);
	console.log(`mine: ${prs.length - skippedPrs} PRs · ${reviewerIds.size} reviewers · ${comments.length} comments (${inline.length} inline) → ${args.out}`);
	console.log(`mine: inline comments whose line later changed: ${inline.filter((c) => c.outdated).length}`);
	console.log(`mine: by tag ${JSON.stringify(byTag)}`);
}

/**
 * @param {ReturnType<typeof parseArgs>} args
 */
function check(args) {
	if (!args.candidates) throw new Error('check: pass --candidates file.json');
	const corpus = JSON.parse(fs.readFileSync(args.corpus, 'utf8'));
	const candidates = JSON.parse(fs.readFileSync(args.candidates, 'utf8'));
	const results = checkPrinciples(candidates, corpus, { minPrs: args.minPrs, minReviewers: args.minReviewers });
	for (const r of results) {
		const tally = `${r.prs} PRs · ${r.reviewers} reviewers · ${r.age}`;
		console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id} (${tally})${r.ok ? '' : ` — ${r.problems.join('; ')}`}`);
	}
	const failed = results.filter((r) => !r.ok).length;
	console.log(`check: ${results.length - failed}/${results.length} principles passed`);
	if (failed) process.exitCode = 1;
}

function printUsage() {
	const header = fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//)?.[1] ?? '';
	console.log(header.split('\n').map((l) => l.replace(/^ \* ?/, '')).join('\n').trim());
}

function main() {
	const argv = process.argv.slice(2);
	if (argv.includes('--help') || argv.includes('-h')) return printUsage();
	const args = parseArgs(argv);
	if (args.command === 'mine') return mine(args);
	if (args.command === 'check') return check(args);
	console.error('usage: mine-review-patterns.cjs <mine|check> [options] — see header');
	process.exitCode = 2;
}

try {
	main();
} catch (err) {
	console.error(`mine-review-patterns: ${/** @type {Error} */ (err).message}`);
	process.exitCode = 1;
}
