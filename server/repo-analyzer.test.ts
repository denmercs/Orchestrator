import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
    const first = await analyze(dir);
    assert.ok(first.written.length > 0);
    assert.ok(first.written.some((id) => id.startsWith("areas/")));
    assert.ok(first.written.some((id) => id.startsWith("decisions/")));
    assert.deepEqual(first.removed, []);
    assert.equal(readFileSync(join(mem, "SUMMARY.md"), "utf8"), first.summary);
    for (const id of first.written) assert.ok(existsSync(join(mem, `${id}.md`)), id);

    // A second run changes nothing.
    const before = tree(mem);
    const second = await analyze(dir);
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
    const third = await analyze(dir);
    assert.deepEqual(third.removed, ["decisions/old-claim"]);
    assert.ok(third.skipped.includes(learnedId));
    assert.equal(readFileSync(learnedFile, "utf8"), learned);
    assert.equal(readFileSync(join(mem, "corrections/style/keep.md"), "utf8"), "not even a note\n");
    assert.ok(!existsSync(join(mem, "decisions/old-claim.md")));

    // Renaming an area in SUMMARY.md is applied on the next run.
    const areaId = first.written.find((id) => id.startsWith("areas/"))!.slice("areas/".length);
    const summaryFile = join(mem, "SUMMARY.md");
    writeFileSync(summaryFile, readFileSync(summaryFile, "utf8").replace(new RegExp(`^\\| ${areaId} \\| ${areaId} `, "m"), `| ${areaId} | renamed-area `));
    const fourth = await analyze(dir);
    assert.ok(fourth.written.includes("areas/renamed-area"));
    assert.ok(fourth.removed.includes(`areas/${areaId}`));
    assert.match(readFileSync(summaryFile, "utf8"), /renamed-area/);
  } finally {
    done();
  }
});
