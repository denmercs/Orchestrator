#!/usr/bin/env node
"use strict";
// List open PRs waiting on your review, using plain `gh search prs`.
const { spawnSync } = require("node:child_process");

const USAGE = `Usage: list-prs.cjs [--repo owner/name]... [--limit N] [--json]

Lists open, non-draft PRs where your review is requested.
  --repo owner/name  Narrow to one repo (repeatable)
  --limit N          Max PRs to fetch (default 50)
  --json             Print the parsed gh result as JSON
  --help, -h         Show this help`;

const repos = [];
let limit = "50";
let asJson = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(0);
  } else if (a === "--json") asJson = true;
  else if (a === "--repo" && argv[i + 1]) repos.push(argv[++i]);
  else if (a === "--limit" && argv[i + 1]) limit = argv[++i];
  else {
    console.error(`Unknown argument: ${a}\n${USAGE}`);
    process.exit(2);
  }
}

const args = [
  "search", "prs", "--state=open", "--draft=false", "--review-requested=@me",
  "--json", "number,title,url,repository,author,updatedAt,isDraft",
  "--limit", limit,
];
for (const r of repos) args.push("--repo", r);

const result = spawnSync("gh", args, { encoding: "utf8" });
if (result.error || result.status !== 0) {
  const why = result.error ? `could not run gh (${result.error.message})` : result.stderr.trim() || `exit ${result.status}`;
  console.error(`list-prs: gh failed: ${why}`);
  process.exit(1);
}

let prs;
try {
  prs = JSON.parse(result.stdout || "[]");
} catch {
  console.error("list-prs: gh did not return JSON");
  process.exit(1);
}

if (asJson) console.log(JSON.stringify(prs, null, 2));
else for (const p of prs) console.log(`${p.repository?.nameWithOwner}#${p.number} · ${p.author?.login} · ${p.title}\n${p.url}`);
