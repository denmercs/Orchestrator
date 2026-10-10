import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { fileObservations, mergeCorrections, observationsAsOf, renderTopCorrections } from "../shared/corrections";
import type { Classify, Filing, Observation } from "../shared/corrections";
import { formatNote, noteId, parseNote, writeNote } from "../shared/memory";
import type { Note } from "../shared/memory";
import { readAreaNames, seedNotes } from "../shared/repo-facts";
import type { Commit, Snapshot, SourceFile } from "../shared/repo-facts";
import { defaultApiKey, haikuClassifier } from "./correction-classifier";
import { collectObservations } from "./correction-sources";

// Reads a repo as of one commit, never the working tree: uncommitted edits and later commits seed nothing.

const execFileAsync = promisify(execFile);

const MAX_FILE_BYTES = 200 * 1024;
const MAX_COMMITS = 1000;
const WINDOW_MONTHS = 12;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  return stdout;
}

const utcDay = (iso: string) => new Date(iso).toISOString().slice(0, 10);

// Blob texts through one `git cat-file --batch`. Output per blob: "<oid> blob <size>\n<bytes>\n".
function catBlobs(cwd: string, specs: string[]): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], { cwd });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited ${code}`));
      const out = Buffer.concat(chunks);
      const blobs: Buffer[] = [];
      let at = 0;
      for (let i = 0; i < specs.length; i++) {
        const eol = out.indexOf(10, at);
        const size = Number(out.subarray(at, eol).toString("utf8").split(" ")[2]);
        blobs.push(out.subarray(eol + 1, eol + 1 + size));
        at = eol + 1 + size + 1;
      }
      resolve(blobs);
    });
    child.stdin.end(specs.map((s) => `${s}\n`).join(""));
  });
}

function textOf(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  const text = bytes.toString("utf8");
  return text.includes("\uFFFD") ? null : text;
}

async function filesAt(root: string, sha: string): Promise<SourceFile[]> {
  // Regular files only (no symlinks or submodules), small enough to be source.
  const listing = await git(root, ["ls-tree", "-r", "-l", "-z", sha]);
  const paths: string[] = [];
  for (const entry of listing.split("\0")) {
    const m = /^100\d+ blob \S+\s+(\d+)\t(.+)$/s.exec(entry);
    if (m && Number(m[1]) <= MAX_FILE_BYTES && !m[2].includes("\n")) paths.push(m[2]);
  }
  const blobs = await catBlobs(root, paths.map((p) => `${sha}:${p}`));
  const files: SourceFile[] = [];
  paths.forEach((path, i) => {
    const text = textOf(blobs[i]);
    if (text !== null) files.push({ path, text });
  });
  return files;
}

// Non-merge commits from `sha` back, within 12 months of its date and at most 1,000 of them.
async function historyAt(root: string, sha: string, committed: string): Promise<Commit[]> {
  const since = new Date(committed);
  since.setUTCMonth(since.getUTCMonth() - WINDOW_MONTHS);
  const out = await git(root, [
    "log", "--no-merges", "--name-only", `--max-count=${MAX_COMMITS}`, `--since=${since.toISOString()}`,
    "--format=%x1e%H%x1f%s%x1f%cI", sha,
  ]);
  const commits: Commit[] = [];
  for (const block of out.split("\x1e").slice(1)) {
    const [head, ...rest] = block.split("\n");
    const [csha, subject, date] = head.split("\x1f");
    commits.push({ sha: csha, subject, date, files: rest.filter((l) => l !== "") });
  }
  return commits;
}

function frontmatter(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*?)\s*$/.exec(line);
    if (kv) fields.set(kv[1], kv[2].replace(/^["']|["']$/g, ""));
  }
  return fields;
}

// architecture.md files under .harness/initiatives that are on disk but not tracked at the commit.
// Walked with readdir because .harness is usually gitignored. Kept when locked and `updated` <= asOf's day.
function untrackedDocs(root: string, tracked: Set<string>, asOf?: string): SourceFile[] {
  const base = join(root, ".harness", "initiatives");
  if (!existsSync(base)) return [];
  const limit = asOf === undefined ? null : utcDay(asOf);
  const docs: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "architecture.md") {
        const path = relative(root, full).split("\\").join("/");
        if (tracked.has(path)) continue;
        const text = readFileSync(full, "utf8");
        const fm = frontmatter(text);
        if (fm.get("status") !== "agreed") continue;
        const updated = fm.get("updated") ?? "";
        if (limit !== null && !(updated !== "" && updated <= limit)) continue;
        docs.push({ path, text });
      }
    }
  };
  walk(base);
  return docs;
}

/**
 * The repo as of one commit. No `asOf`: HEAD. With `asOf`: the first-parent commit that
 * `git rev-list -1 --first-parent --before=<asOf>` finds, which includes a commit dated exactly asOf
 * (a date-only asOf is read by git in local time). When no commit qualifies the snapshot is empty,
 * with `verifiedAt` the asOf day (or 1970-01-01 without one).
 */
export async function snapshot(root: string, opts: { asOf?: string } = {}): Promise<Snapshot> {
  const { asOf } = opts;
  // Only "no such commit" means an empty repo; any other git failure (not a repo, bad asOf) propagates.
  const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).then((s) => s.trim(), (e: { code?: number }) => {
    if (e.code === 1) return "";
    throw e;
  });
  const sha = head === "" || asOf === undefined ? head : (await git(root, ["rev-list", "-1", "--first-parent", `--before=${asOf}`, "HEAD"])).trim();
  if (sha === "") return { files: [], commits: [], harnessDocs: [], verifiedAt: asOf === undefined ? "1970-01-01" : utcDay(asOf) };

  const committed = (await git(root, ["show", "-s", "--format=%cI", sha])).trim();
  const files = await filesAt(root, sha);
  const tracked = new Set((await git(root, ["ls-tree", "-r", "--name-only", "-z", sha])).split("\0"));
  return {
    files,
    commits: await historyAt(root, sha, committed),
    harnessDocs: untrackedDocs(root, tracked, asOf),
    verifiedAt: utcDay(committed),
  };
}

export type AnalyzeResult = {
  written: string[];
  removed: string[];
  skipped: string[];
  summary: string;
  spentUsd: number;
  stopped: "cap" | "error" | null;
};

export type AnalyzeOptions = {
  asOf?: string;
  excludeStory?: string;
  // Where `.harness/memory` is written. The repo (git history, old notes, filings cache) is still read from `root`.
  memoryRoot?: string;
  costCap?: number;
  classify?: Classify;
  // `warn` reports a source that could not be read; the run then removes no stale corrections.
  sources?: (warn: (message: string) => void) => Promise<Observation[]>;
  log?: (line: string) => void;
};

const DEFAULT_COST_CAP = 3;
const CACHE_FILE = ["memory", ".cache", "filings.jsonl"];

function readCache(file: string): Record<string, Filing> {
  const cache: Record<string, Filing> = {};
  if (!existsSync(file)) return cache;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const { key, filing } = JSON.parse(line) as { key: string; filing: Filing };
      if (key && filing) cache[key] = filing;
    } catch {
      // a torn line is just a cache miss
    }
  }
  return cache;
}

const topCorrectionsOf = (summary: string) => /^## Top corrections\n[\s\S]*?(?=^## |(?![\s\S]))/m.exec(summary)?.[0] ?? "";

/**
 * Seeds `.harness/memory` from the repo. Unchanged seeded notes are left byte for byte; a learned note at a produced
 * slug is never overwritten; seeded notes in areas/, decisions/ and notes/ that this run did not produce are removed.
 * After the facts, a corrections pass files observations (cost cap first in the log), writes seeded `corrections/` notes,
 * removes stale seeded ones (unless the run stopped early), and appends `## Top corrections` to SUMMARY.md.
 * Without `classify` and without an API key the pass is skipped.
 */
export async function analyze(root: string, opts: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const log = opts.log ?? (() => {});
  // A cap that is not a finite, non-negative number fails closed: nothing is spent.
  const requested = opts.costCap ?? DEFAULT_COST_CAP;
  const costCap = Number.isFinite(requested) && requested >= 0 ? requested : 0;
  log(`cost cap $${costCap.toFixed(2)}`);
  const outRoot = opts.memoryRoot ?? root;
  const memory = join(outRoot, ".harness", "memory");
  const summaryFile = join(memory, "SUMMARY.md");
  const oldSummary = existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "";
  const snap = await snapshot(root, { asOf: opts.asOf });
  snap.areaNames = readAreaNames(oldSummary);
  const { notes, summary: factsSummary } = seedNotes(snap);
  let summary = factsSummary;

  const result: AnalyzeResult = { written: [], removed: [], skipped: [], summary, spentUsd: 0, stopped: null };
  const produced = new Set<string>();
  for (const note of notes) {
    const id = noteId(note);
    produced.add(id);
    const file = join(memory, `${id}.md`);
    // A human's `approved:` stays on a note whose text did not change; changed text is written fresh.
    let current: string | null = null;
    if (existsSync(file)) {
      current = readFileSync(file, "utf8");
      try {
        const approved = parseNote(current, note.slug).extra.approved;
        if (approved !== undefined && note.extra.approved === undefined) {
          if (formatNote({ ...note, extra: { ...note.extra, approved } }) === current) {
            result.skipped.push(id);
            continue;
          }
        }
      } catch {
        // unreadable: writeNote leaves it alone
      }
    }
    if (current === formatNote(note)) result.skipped.push(id);
    else if (writeNote(outRoot, note, { seededOnly: true })) result.written.push(id);
    else result.skipped.push(id);
  }

  for (const folder of ["areas", "decisions", "notes"]) {
    const dir = join(memory, folder);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
      const id = `${folder}/${f.slice(0, -3)}`;
      if (produced.has(id)) continue;
      try {
        if (parseNote(readFileSync(join(dir, f), "utf8"), f.slice(0, -3)).status !== "seeded") continue;
      } catch {
        continue;
      }
      rmSync(join(dir, f));
      result.removed.push(id);
    }
  }

  const corrections = await correctionsPass(root, outRoot, notes, opts, costCap, log, result);
  summary = factsSummary + (corrections === null ? topCorrectionsOf(oldSummary) : `\n${renderTopCorrections(corrections)}`);
  result.summary = summary;
  if (summary !== oldSummary) {
    mkdirSync(memory, { recursive: true });
    writeFileSync(summaryFile, summary);
  }
  return result;
}

// The corrections pass. Returns the correction notes produced, or null when the pass was skipped. Never throws on classifier failures.
async function correctionsPass(
  root: string,
  outRoot: string,
  areaNotes: Note[],
  opts: AnalyzeOptions,
  costCap: number,
  log: (line: string) => void,
  result: AnalyzeResult,
): Promise<Note[] | null> {
  const memory = join(outRoot, ".harness", "memory");
  let classify = opts.classify;
  if (!classify) {
    if (!(await defaultApiKey())) {
      log("corrections skipped: no API key (set ANTHROPIC_API_KEY or the anthropic-api-key Keychain item)");
      return null;
    }
    classify = haikuClassifier({ fetch: globalThis.fetch, apiKey: defaultApiKey });
  }

  let all: Observation[];
  let partial = false;
  const warn = (message: string) => {
    partial = true;
    log(`corrections: ${message}`);
  };
  try {
    all = await (opts.sources ?? ((w) => collectObservations(root, { warn: w })))(warn);
  } catch (error) {
    log(`corrections skipped: could not read observations: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const observations = observationsAsOf(all, { asOf: opts.asOf, excludeStory: opts.excludeStory });

  const cacheFile = join(outRoot, ".harness", ...CACHE_FILE);
  const rootCacheFile = join(root, ".harness", ...CACHE_FILE);
  const areas = areaNotes.filter((n) => n.type === "area").map((n) => ({ id: n.slug, globs: n.globs }));
  // fileObservations logs the cap itself; analyze already did, first.
  const filing = await fileObservations(observations, {
    cache: { ...readCache(rootCacheFile), ...readCache(cacheFile) },
    classify,
    costCap,
    areas,
    log: (line) => {
      if (!line.startsWith("cost cap ")) log(line);
    },
  });
  result.spentUsd = filing.spentUsd;
  result.stopped = filing.stopped;

  const lines = Object.entries(filing.cache).map(([key, f]) => JSON.stringify({ key, filing: f }));
  if (lines.length > 0 && lines.length !== Object.keys(readCache(cacheFile)).length) {
    mkdirSync(join(memory, ".cache"), { recursive: true });
    writeFileSync(cacheFile, `${lines.join("\n")}\n`);
  }

  const corrections = mergeCorrections(filing.filed, new Map(observations.map((o) => [o.id, o])));
  const produced = new Set<string>();
  for (const note of corrections) {
    const id = noteId(note);
    produced.add(id);
    const file = join(memory, `${id}.md`);
    if (existsSync(file) && readFileSync(file, "utf8") === formatNote(note)) result.skipped.push(id);
    else if (writeNote(outRoot, note, { seededOnly: true })) result.written.push(id);
    else result.skipped.push(id);
  }

  // A partial run (cap, error or an unreadable source) has not seen everything, so it removes nothing.
  const base = join(memory, "corrections");
  if (filing.stopped === null && !partial && existsSync(base)) {
    for (const category of readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory())) {
      for (const f of readdirSync(join(base, category.name)).filter((n) => n.endsWith(".md")).sort()) {
        const id = `corrections/${category.name}/${f.slice(0, -3)}`;
        if (produced.has(id)) continue;
        try {
          if (parseNote(readFileSync(join(base, category.name, f), "utf8"), f.slice(0, -3)).status !== "seeded") continue;
        } catch {
          continue;
        }
        rmSync(join(base, category.name, f));
        result.removed.push(id);
      }
    }
  }
  return corrections;
}
