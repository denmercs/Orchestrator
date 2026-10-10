import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Classify, Observation } from "../shared/corrections";
import { readAreaNames } from "../shared/repo-facts";
import { analyze, snapshot } from "./repo-analyzer";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "repo-analyzer-"));
  const run = (env: Record<string, string>, ...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } }).trim();
  const git = (...args: string[]) => run({}, ...args);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  const write = (path: string, text: string | Buffer) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (date: string, message: string) => {
    git("add", "-A");
    run({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, "commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, write, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const doc = (status: string, updated: string) => `---\nphase: x\nstatus: ${status}\nupdated: ${updated}\n---\n\n## decisions\n- keep it\n`;

test("snapshot reads the last commit at or before asOf, not the working tree", async () => {
  const { dir, write, commit, done } = repo();
  try {
    write(".gitignore", ".harness/\n");
    write("a.ts", "export const a = 1;\n");
    const first = commit("2024-01-10T12:00:00Z", "add a");
    write("a.ts", "export const a = 2;\n");
    write("b.ts", "export const b = 1;\n");
    write("img.bin", Buffer.from([0, 1, 2, 3]));
    const second = commit("2024-02-10T12:00:00Z", "fix a, add b");
    write("c.ts", "export const c = 1;\n");
    commit("2024-03-10T12:00:00Z", "add c");

    write("a.ts", "export const a = 99; // uncommitted\n");
    write("d.ts", "untracked\n");
    write(".harness/initiatives/early/architecture.md", doc("agreed", "2024-02-01"));
    write(".harness/initiatives/late/architecture.md", doc("agreed", "2024-03-01"));
    write(".harness/initiatives/draft/architecture.md", doc("draft", "2024-01-01"));

    // A commit exactly on the boundary counts.
    const snap = await snapshot(dir, { asOf: "2024-02-10T12:00:00Z" });
    assert.equal(snap.verifiedAt, "2024-02-10");
    assert.deepEqual(
      snap.files.map((f) => f.path).sort(),
      [".gitignore", "a.ts", "b.ts"],
    );
    assert.equal(snap.files.find((f) => f.path === "a.ts")?.text, "export const a = 2;\n");
    assert.deepEqual(
      snap.commits.map((c) => ({ sha: c.sha, subject: c.subject, files: [...c.files].sort() })),
      [
        { sha: second, subject: "fix a, add b", files: ["a.ts", "b.ts", "img.bin"] },
        { sha: first, subject: "add a", files: [".gitignore", "a.ts"] },
      ],
    );
    assert.equal(snap.commits[0].date.slice(0, 10), "2024-02-10");
    assert.deepEqual(snap.harnessDocs.map((d) => d.path), [".harness/initiatives/early/architecture.md"]);

    // No asOf: HEAD, so the later commit shows up and all agreed docs stay.
    const head = await snapshot(dir);
    assert.equal(head.verifiedAt, "2024-03-10");
    assert.ok(head.files.some((f) => f.path === "c.ts"));
    assert.equal(head.files.find((f) => f.path === "a.ts")?.text, "export const a = 2;\n");
    assert.deepEqual(head.harnessDocs.map((d) => d.path).sort(), [
      ".harness/initiatives/early/architecture.md",
      ".harness/initiatives/late/architecture.md",
    ]);

    // Nothing qualifies: an empty snapshot.
    const none = await snapshot(dir, { asOf: "2023-01-01T00:00:00Z" });
    assert.deepEqual([none.files, none.commits], [[], []]);
  } finally {
    done();
  }
});

function tree(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) Object.assign(out, tree(full, base));
    else out[full.slice(base.length + 1)] = readFileSync(full, "utf8");
  }
  return out;
}

test("analyze writes seeded notes, is a no-op the second time, and leaves learned notes and corrections alone", async () => {
  const { dir, write, commit, done } = repo();
  try {
    write(".gitignore", ".harness/\n");
    write("CONTEXT.md", "# Ctx\n\n## Widget\nA widget is a thing.\n\nWe never ship a widget without tests.\n");
    write("src/a.ts", 'import { b } from "./b";\nexport const a = b;\n');
    write("src/b.ts", "export const b = 1;\n");
    commit("2024-01-10T12:00:00Z", "add a and b");
    write("src/b.ts", "export const b = 2;\n");
    commit("2024-02-10T12:00:00Z", "change b");

    const mem = join(dir, ".harness", "memory");
    const first = await analyze(dir, { sources: async () => [] });
    assert.ok(first.written.length > 0);
    assert.ok(first.written.some((id) => id.startsWith("areas/")));
    assert.ok(first.written.some((id) => id.startsWith("decisions/")));
    assert.deepEqual(first.removed, []);
    assert.equal(readFileSync(join(mem, "SUMMARY.md"), "utf8"), first.summary);
    for (const id of first.written) assert.ok(existsSync(join(mem, `${id}.md`)), id);

    // A second run changes nothing.
    const before = tree(mem);
    const second = await analyze(dir, { sources: async () => [] });
    assert.deepEqual(second.written, []);
    assert.deepEqual(second.removed, []);
    assert.deepEqual(tree(mem), before);

    // A learned note at a produced slug survives; corrections are untouched; a stale seeded note goes.
    const learnedId = first.written.find((id) => id.startsWith("decisions/"))!;
    const learnedFile = join(mem, `${learnedId}.md`);
    const learned = readFileSync(learnedFile, "utf8").replace("status: seeded", "status: active");
    assert.notEqual(learned, readFileSync(learnedFile, "utf8"));
    writeFileSync(learnedFile, learned);
    write(".harness/memory/corrections/style/keep.md", "not even a note\n");
    write(".harness/memory/decisions/old-claim.md", readFileSync(learnedFile, "utf8").replace("status: active", "status: seeded"));
    const third = await analyze(dir, { sources: async () => [] });
    assert.deepEqual(third.removed, ["decisions/old-claim"]);
    assert.ok(third.skipped.includes(learnedId));
    assert.equal(readFileSync(learnedFile, "utf8"), learned);
    assert.equal(readFileSync(join(mem, "corrections/style/keep.md"), "utf8"), "not even a note\n");
    assert.ok(!existsSync(join(mem, "decisions/old-claim.md")));

    // Renaming an area in SUMMARY.md is applied on the next run.
    const areaId = first.written.find((id) => id.startsWith("areas/"))!.slice("areas/".length);
    const summaryFile = join(mem, "SUMMARY.md");
    writeFileSync(summaryFile, readFileSync(summaryFile, "utf8").replace(new RegExp(`^\\| ${areaId} \\| ${areaId} `, "m"), `| ${areaId} | renamed-area `));
    const fourth = await analyze(dir, { sources: async () => [] });
    assert.ok(fourth.written.includes("areas/renamed-area"));
    assert.ok(fourth.removed.includes(`areas/${areaId}`));
    assert.match(readFileSync(summaryFile, "utf8"), /renamed-area/);
  } finally {
    done();
  }
});

test("an approved seeded note survives a re-run byte for byte", async () => {
  const { dir, write, commit, done } = repo();
  try {
    write(".gitignore", ".harness/\n");
    write("CONTEXT.md", "# Ctx\n\n## Widget\nA widget lives in `src/a.ts`.\n");
    write("src/a.ts", "export const a = 1;\n");
    commit("2024-01-10T12:00:00Z", "add a");
    const first = await analyze(dir, { sources: async () => [] });
    const id = first.written.find((x) => x.startsWith("decisions/"))!;
    const file = join(dir, ".harness", "memory", `${id}.md`);
    const approved = readFileSync(file, "utf8").replace("---\n", "---\napproved: 2024-02-01\n").replace(/^---\napproved: 2024-02-01\n((?:.*\n)*?)---\n/, (_m, body) => `---\n${body}approved: 2024-02-01\n---\n`);
    writeFileSync(file, approved);
    const second = await analyze(dir, { sources: async () => [] });
    assert.ok(second.skipped.includes(id));
    assert.equal(readFileSync(file, "utf8"), approved);
  } finally {
    done();
  }
});

test("analyze on a non-git directory throws and leaves memory untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-analyzer-nogit-"));
  try {
    mkdirSync(join(dir, ".harness", "memory", "decisions"), { recursive: true });
    const note = join(dir, ".harness", "memory", "decisions", "x.md");
    const summary = join(dir, ".harness", "memory", "SUMMARY.md");
    writeFileSync(summary, "| id | name | globs | notes |\n|---|---|---|---|\n| a | b | c | 1 |\n");
    writeFileSync(note, "---\ntype: decision\nstatus: seeded\n---\nbody\n");
    await assert.rejects(analyze(dir, { sources: async () => [] }));
    assert.ok(existsSync(note));
    assert.match(readFileSync(summary, "utf8"), /\| a \| b \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("analyze files corrections: seeded with counts, learned kept, stale removed, summary section, warm cache on asOf", async () => {
  const { dir, write, commit, done } = repo();
  try {
    write(".gitignore", ".harness/\n");
    write("CONTEXT.md", "# Ctx\n\n## Widget\nA widget is a thing.\n");
    write("src/a.ts", "export const a = 1;\n");
    write(".harness/initiatives/x/stories/s1.md", "---\nid: s1\n---\n\n## Outcome\n- Review round 1: missing test\n");
    commit("2024-01-10T12:00:00Z", "add a");

    const obs = (id: string, story: string, date: string, text: string): Observation => ({ id, source: "finding", story, date, link: `https://x/${id}`, text });
    const observations = [
      obs("o1", "s1", "2024-01-05T00:00:00Z", "missing test for a"),
      obs("o2", "s2", "2024-01-06T00:00:00Z", "missing test for b"),
      obs("o3", "s3", "2024-06-01T00:00:00Z", "late finding"),
    ];
    const calls: string[][] = [];
    const classify: Classify = async (batch) => {
      calls.push(batch.map((o) => o.id));
      return { filings: batch.map((o) => ({ id: o.id, category: "testing", area: null, phrase: o.id === "o3" ? "late rule" : "add a test" })), costUsd: 0.01 };
    };
    const sources = async () => observations;
    const mem = join(dir, ".harness", "memory");
    write(".harness/memory/corrections/testing/learned-one.md", "---\ntype: correction\nstatus: active\ncategory: testing\ncount: 5\n---\nlearned\n");
    write(".harness/memory/corrections/testing/stale-one.md", "---\ntype: correction\nstatus: seeded\ncategory: testing\ncount: 1\n---\nstale\n");

    const lines: string[] = [];
    const first = await analyze(dir, { classify, sources, log: (l) => lines.push(l) });
    assert.equal(lines[0], "cost cap $3.00");
    assert.equal(first.stopped, null);
    assert.ok(Math.abs(first.spentUsd - 0.01) < 1e-9);
    assert.deepEqual(calls, [["o1", "o2", "o3"]]);
    const note = readFileSync(join(mem, "corrections/testing/add-a-test.md"), "utf8");
    assert.match(note, /status: seeded/);
    assert.match(note, /count: 2/);
    assert.ok(first.written.includes("corrections/testing/add-a-test"));
    assert.ok(existsSync(join(mem, "corrections/testing/late-rule.md")));
    assert.ok(readFileSync(join(mem, "corrections/testing/learned-one.md"), "utf8").includes("learned\n"));
    assert.match(readFileSync(join(mem, "corrections/testing/learned-one.md"), "utf8"), /status: active/);
    assert.ok(!existsSync(join(mem, "corrections/testing/stale-one.md")));
    assert.ok(first.removed.includes("corrections/testing/stale-one"));
    const summary = readFileSync(join(mem, "SUMMARY.md"), "utf8");
    assert.match(summary, /## Top corrections/);
    assert.match(summary, /add a test/);
    assert.equal(first.summary, summary);
    assert.ok(readFileSync(join(mem, ".cache", "filings.jsonl"), "utf8").length > 0);
    assert.ok(readAreaNames(summary).size > 0);

    // An asOf re-run drops the later observation and finds the rest in the cache: no classify calls.
    calls.length = 0;
    const again: string[] = [];
    const second = await analyze(dir, { asOf: "2024-02-01", classify, sources, log: (l) => again.push(l) });
    assert.deepEqual(calls, []);
    assert.equal(again[0], "cost cap $3.00");
    assert.equal(second.spentUsd, 0);
    assert.ok(!existsSync(join(mem, "corrections/testing/late-rule.md")));
    assert.match(readFileSync(join(mem, "corrections/testing/add-a-test.md"), "utf8"), /count: 2/);
  } finally {
    done();
  }
});

test("analyze keeps stale seeded corrections when a source reports a partial read, and fails closed on a NaN cap", async () => {
  const { dir, write, commit, done } = repo();
  try {
    write(".gitignore", ".harness/\n");
    write("src/a.ts", "export const a = 1;\n");
    commit("2024-01-10T12:00:00Z", "add a");
    write(".harness/memory/corrections/testing/stale-one.md", "---\ntype: correction\nstatus: seeded\ncategory: testing\ncount: 1\n---\nstale\n");
    const mem = join(dir, ".harness", "memory");
    let calls = 0;
    const classify: Classify = async () => {
      calls++;
      return { filings: [], costUsd: 0 };
    };
    const o: Observation = { id: "o1", source: "finding", story: "s1", date: "2024-01-05T00:00:00Z", link: "", text: "t" };

    const lines: string[] = [];
    const partial = await analyze(dir, {
      classify,
      sources: async (warn) => {
        warn("gh failed: not logged in");
        return [];
      },
      log: (l) => lines.push(l),
    });
    assert.ok(lines.some((l) => l.includes("gh failed: not logged in")));
    assert.ok(existsSync(join(mem, "corrections/testing/stale-one.md")));
    assert.deepEqual(partial.removed.filter((id) => id.startsWith("corrections/")), []);

    const capLines: string[] = [];
    const capped = await analyze(dir, { classify, sources: async () => [o], costCap: Number.NaN, log: (l) => capLines.push(l) });
    assert.equal(calls, 0);
    assert.equal(capLines[0], "cost cap $0.00");
    assert.equal(capped.stopped, "cap");
  } finally {
    done();
  }
});

test("analyze with memoryRoot writes notes there, reads the filings cache from root, and leaves root memory unchanged", async () => {
  const { dir, write, commit, done } = repo();
  const out = mkdtempSync(join(tmpdir(), "repo-analyzer-out-"));
  try {
    write(".gitignore", ".harness/\n");
    write("CONTEXT.md", "# Ctx\n\n## Widget\nA widget is a thing.\n");
    write("src/a.ts", "export const a = 1;\n");
    commit("2024-01-10T12:00:00Z", "add a");
    const o: Observation = { id: "o1", source: "finding", story: "s1", date: "2024-01-05T00:00:00Z", link: "https://x/o1", text: "missing test" };
    const calls: string[][] = [];
    const classify: Classify = async (batch) => {
      calls.push(batch.map((x) => x.id));
      return { filings: batch.map((x) => ({ id: x.id, category: "testing", area: null, phrase: "add a test" })), costUsd: 0.01 };
    };
    const sources = async () => [o];
    // Warm the repo's own cache and notes.
    await analyze(dir, { classify, sources });
    const rootMem = join(dir, ".harness", "memory");
    const before = tree(rootMem);
    assert.ok(Object.keys(before).length > 0);

    calls.length = 0;
    const result = await analyze(dir, { asOf: "2024-02-01", memoryRoot: out, classify, sources });
    assert.deepEqual(calls, []);
    assert.equal(result.spentUsd, 0);
    const outMem = join(out, ".harness", "memory");
    assert.ok(existsSync(join(outMem, "corrections/testing/add-a-test.md")));
    assert.ok(existsSync(join(outMem, "SUMMARY.md")));
    assert.ok(result.written.length > 0);
    assert.deepEqual(tree(rootMem), before);
  } finally {
    done();
    rmSync(out, { recursive: true, force: true });
  }
});
