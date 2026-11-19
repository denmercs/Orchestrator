import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { renderDebrief } from "./debrief-render";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

// main has a.ts (2 lines); the branch adds b.ts (3 lines).
const repo = () => {
  const worktree = tmp("debrief-repo-");
  git(worktree, "init", "-q", "-b", "main");
  writeFileSync(join(worktree, "a.ts"), "one\ntwo\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "base");
  git(worktree, "checkout", "-q", "-b", "feature");
  writeFileSync(join(worktree, "b.ts"), "x\ny\nz\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "work");
  return { worktree, head: git(worktree, "rev-parse", "HEAD") };
};

const notes = {
  version: 1,
  summary: "Adds b.",
  stops: [{ file: "b.ts", line: 2, why: "The new file." }],
  notes: [{ kind: "watch", file: "b.ts", line: 3, text: "Last line." }],
  boxes: [],
  built: [],
};
const notesIn = (dir: string, body: unknown = notes) => {
  const file = join(dir, "notes.json");
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
};

test("renderDebrief writes debrief.html into a new nested outDir and returns it with no problems", async () => {
  const { worktree, head } = repo();
  const outDir = join(tmp("debrief-out-"), "deep", "er");
  const result = await renderDebrief({ worktree, base: "main", head, notesFile: notesIn(tmp("n-")), outDir });
  assert.deepEqual(result, { file: join(outDir, "debrief.html"), problems: [] });
  const html = readFileSync(result.file, "utf8");
  for (const text of ["Adds b.", "feature", "main", head.slice(0, 7), "b.ts", 'id="gate"']) assert.ok(html.includes(text), text);
});

test("renderDebrief throws when outDir is the worktree, inside it, or reaches it through a symlink", async () => {
  const { worktree, head } = repo();
  const notesFile = notesIn(tmp("n-"));
  const link = join(tmp("link-"), "sneaky");
  symlinkSync(worktree, link);
  for (const outDir of [worktree, join(worktree, "out", "debrief"), join(worktree, "..out"), join(link, "out")]) {
    await assert.rejects(renderDebrief({ worktree, base: "main", head, notesFile, outDir }), /outDir/);
  }
  assert.throws(() => readFileSync(join(worktree, "out", "debrief", "debrief.html")));
  assert.throws(() => readFileSync(join(worktree, "..out", "debrief.html")));
});

test("renderDebrief throws when head is not a commit in the worktree", async () => {
  const { worktree } = repo();
  const outDir = join(tmp("debrief-out-"), "o");
  await assert.rejects(
    renderDebrief({ worktree, base: "main", head: "no-such-ref", notesFile: notesIn(tmp("n-")), outDir }),
    /head/,
  );
});

const render = async (notesFile: string, outDir = join(tmp("debrief-out-"), "o")) => {
  const { worktree, head } = repo();
  const result = await renderDebrief({ worktree, base: "main", head, notesFile, outDir });
  return { ...result, html: readFileSync(result.file, "utf8") };
};

test("a missing notes file, bad JSON and a schema failure are one problem each, and the page lists it", async () => {
  const dir = tmp("n-");
  for (const [notesFile, pattern] of [
    [join(dir, "missing.json"), /file not found/],
    [notesIn(tmp("n-"), "{ nope"), /not valid JSON/],
    [notesIn(tmp("n-"), { ...notes, version: 2 }), /version/],
  ] as const) {
    const { problems, html } = await render(notesFile);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /^notes\.json: /);
    assert.match(problems[0]!, pattern);
    assert.ok(html.includes(problems[0]!), "the page lists it");
    assert.ok(html.includes("No summary: see problems below."));
    assert.ok(html.includes("b.ts"), "the changed files still render");
  }
});

test("a bad entry is dropped with its own line and the rest renders", async () => {
  const bad = { kind: "decision", file: "b.ts", line: 1, text: "No rejected." };
  const past = { file: "b.ts", line: 4, why: "Past the end." };
  const { problems, html } = await render(notesIn(tmp("n-"), { ...notes, stops: [...notes.stops, past], notes: [bad, ...notes.notes] }));
  assert.equal(problems.length, 2);
  assert.match(problems[0]!, /^stops\[1\]: /);
  assert.match(problems[1]!, /^notes\[0\]: /);
  assert.ok(html.includes("Adds b."));
  assert.ok(html.includes(problems[0]!) && html.includes(problems[1]!));
});

test("a notes file that exists but can't be read is not reported as missing", async () => {
  const dir = tmp("n-"); // a directory where the file should be: EISDIR
  const { problems } = await render(dir);
  assert.deepEqual(problems, ["notes.json: couldn't be read"]);
});

test("a base with no shared history is a problem, not a throw", async () => {
  const { worktree, head } = repo();
  const { problems } = await renderDebrief({
    worktree, base: "no-such-ref", head, notesFile: notesIn(tmp("n-")), outDir: join(tmp("debrief-out-"), "o"),
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /^base: /);
});

test("two renders of the same inputs are byte-identical", async () => {
  const { worktree, head } = repo();
  const notesFile = notesIn(tmp("n-"));
  const [a, b] = [join(tmp("out-a-"), "o"), join(tmp("out-b-"), "o")];
  await renderDebrief({ worktree, base: "main", head, notesFile, outDir: a });
  await renderDebrief({ worktree, base: "main", head, notesFile, outDir: b });
  assert.equal(readFileSync(join(a, "debrief.html"), "utf8"), readFileSync(join(b, "debrief.html"), "utf8"));
});

test("the rendered page makes no network requests", async () => {
  const { html } = await render(notesIn(tmp("n-")));
  assert.doesNotMatch(html, /https?:/);
  assert.doesNotMatch(html, /\bsrc=/);
  assert.doesNotMatch(html, /<link/i);
});
