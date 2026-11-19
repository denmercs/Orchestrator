import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Ask } from "./claude-cli";
import { motionBrief } from "./motion-brief";

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

// main has strip.tsx with a portal overlay; the branch swaps it for a z-index and adds a lockfile.
const repo = () => {
  const worktree = tmp("motion-repo-");
  git(worktree, "init", "-q", "-b", "main");
  writeFileSync(join(worktree, "strip.tsx"), "export function Strip() {\n  return <Overlay portal />;\n}\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "base");
  git(worktree, "checkout", "-q", "-b", "feature");
  writeFileSync(join(worktree, "strip.tsx"), "export function Strip() {\n  return <div style={{ zIndex: 1000 }} />;\n}\n");
  writeFileSync(join(worktree, "yarn.lock"), "x".repeat(70_000) + "\n");
  git(worktree, "add", "-A");
  git(worktree, "commit", "-q", "-m", "work");
  return { worktree, head: git(worktree, "rev-parse", "HEAD") };
};

const scene = (name: string) => ({
  name,
  visual: 'The strip rises, tagged "z 1000".',
  labels: [{ text: "z 1000", code: ["zIndex: 1000"] }],
  beats: [{ caption: "The strip sits above every panel." }],
  decision: { text: "Raise the strip with a z-index.", refs: [{ file: "strip.tsx", side: "+", snippet: "zIndex: 1000" }] },
  instead_of: { text: "A portal overlay.", refs: [{ file: "strip.tsx", side: "-", snippet: "<Overlay portal />" }] },
  because: null,
});
const brief = { title: "Strip on top", subtitle: "One z-index", metaphor: "a stack of cards", scenes: ["A", "B", "C", "D", "E", "Collapse"].map(scene) };

const fakeAsk = (reply: string) => {
  const calls: { system: string; prompt: string }[] = [];
  const ask: Ask = async (system, prompt) => {
    calls.push({ system, prompt });
    return { text: reply, costUsd: 0 };
  };
  return { ask, calls };
};

test("motionBrief gives the writer only the trimmed diff, then writes motion.json and motion.md", async () => {
  const { worktree, head } = repo();
  const outDir = join(tmp("motion-out-"), "o");
  const { ask, calls } = fakeAsk("```json\n" + JSON.stringify(brief) + "\n```");
  const result = await motionBrief({ worktree, base: "main", head, outDir }, ask);

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.system, /instead_of/);
  assert.ok(calls[0]!.prompt.includes("+  return <div style={{ zIndex: 1000 }} />;"));
  assert.ok(calls[0]!.prompt.includes("Left out for size (not shown below): yarn.lock (generated)"));
  assert.ok(!calls[0]!.prompt.includes("xxxxxxxxxx"));

  assert.deepEqual(result.cut, [{ path: "yarn.lock", reason: "generated" }]);
  assert.deepEqual(result.problems, []);
  assert.equal(result.file, join(outDir, "motion.md"));
  assert.equal(readFileSync(result.file!, "utf8"), result.text);
  assert.match(result.text!, /^Make a 65-second animated explainer in 6 scenes/);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, "motion.json"), "utf8")), brief);
});

test("the same motion.json gives a byte-identical motion.md", async () => {
  const { worktree, head } = repo();
  const [a, b] = [join(tmp("out-a-"), "o"), join(tmp("out-b-"), "o")];
  await motionBrief({ worktree, base: "main", head, outDir: a }, fakeAsk(JSON.stringify(brief)).ask);
  await motionBrief({ worktree, base: "main", head, outDir: b }, fakeAsk(JSON.stringify(brief, null, 4)).ask);
  assert.equal(readFileSync(join(a, "motion.md"), "utf8"), readFileSync(join(b, "motion.md"), "utf8"));
});

test("fewer than 2 checked scenes writes motion.json but no motion.md, and removes an old one", async () => {
  const { worktree, head } = repo();
  const outDir = join(tmp("motion-out-"), "o");
  await motionBrief({ worktree, base: "main", head, outDir }, fakeAsk(JSON.stringify(brief)).ask);
  const invented = { ...brief, scenes: brief.scenes.map((s) => ({ ...s, decision: { text: "x", refs: [] } })) };
  const result = await motionBrief({ worktree, base: "main", head, outDir }, fakeAsk(JSON.stringify(invented)).ask);
  assert.equal(result.file, null);
  assert.equal(result.problems.at(-1), "No architectural decision in this diff.");
  assert.ok(existsSync(join(outDir, "motion.json")));
  assert.ok(!existsSync(join(outDir, "motion.md")));
});

test("a reply that isn't JSON or a writer that throws is a problem, not a throw", async () => {
  const { worktree, head } = repo();
  const outDir = join(tmp("motion-out-"), "o");
  const bad = await motionBrief({ worktree, base: "main", head, outDir }, fakeAsk("Sorry, no.").ask);
  assert.deepEqual([bad.file, bad.problems], [null, ["motion.json: the writer's reply is not valid JSON"]]);
  const failing: Ask = async () => {
    throw new Error("not logged in");
  };
  const thrown = await motionBrief({ worktree, base: "main", head, outDir }, failing);
  assert.deepEqual(thrown.problems, ["writer: not logged in"]);
});

test("an empty diff or a bad base never calls the writer", async () => {
  const { worktree, head } = repo();
  const { ask, calls } = fakeAsk(JSON.stringify(brief));
  const same = await motionBrief({ worktree, base: head, head, outDir: join(tmp("o-"), "o") }, ask);
  assert.deepEqual(same.problems, ["diff: no changes between the base and head"]);
  const gone = await motionBrief({ worktree, base: "no-such-ref", head, outDir: join(tmp("o-"), "o") }, ask);
  assert.match(gone.problems[0]!, /^base: /);
  assert.equal(calls.length, 0);
});

test("motionBrief throws for an outDir inside the worktree or a head that isn't a commit", async () => {
  const { worktree, head } = repo();
  const { ask } = fakeAsk(JSON.stringify(brief));
  await assert.rejects(motionBrief({ worktree, base: "main", head, outDir: join(worktree, "out") }, ask), /outDir/);
  await assert.rejects(motionBrief({ worktree, base: "main", head: "nope", outDir: join(tmp("o-"), "o") }, ask), /head/);
});
