import assert from "node:assert/strict";
import { test } from "node:test";
import { diffForAgent, parseDiff, trimDiff } from "./motion-diff";

const chunk = (path: string, status: "A" | "M" | "D", added: string[], removed: string[] = []) =>
  [
    `diff --git a/${path} b/${path}`,
    ...(status === "A" ? ["new file mode 100644"] : status === "D" ? ["deleted file mode 100644"] : []),
    "index 1111111..2222222 100644",
    `--- ${status === "A" ? "/dev/null" : `a/${path}`}`,
    `+++ ${status === "D" ? "/dev/null" : `b/${path}`}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ].join("\n");

const diff = [
  chunk("server/new.ts", "A", ["export function render(x: number) {", "  return x;", "}", "export const PAGE_CAP = 3;"]),
  chunk("server/old.ts", "M", ["const fresh = () => 1;"], ["function legacy() {", "--- not a header"]),
  chunk("server/gone.ts", "D", [], ["export class Gone {}"]),
  chunk("server/new.test.ts", "A", ['test("renders a page", () => {', '  it("inner", () => {});', "});"]),
].join("\n");

test("parseDiff gives each file its status, its +/- counts and lines", () => {
  const files = parseDiff(diff);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.added.length, f.removed.length]),
    [
      ["server/new.ts", "A", 4, 0],
      ["server/old.ts", "M", 1, 2],
      ["server/gone.ts", "D", 0, 1],
      ["server/new.test.ts", "A", 3, 0],
    ],
  );
  assert.deepEqual(files[1]!.removed, ["function legacy() {", "--- not a header"]);
  assert.ok(files[0]!.text.startsWith("diff --git a/server/new.ts"));
});

test("parseDiff finds added and removed function and export names, and added test names", () => {
  const [created, changed, gone, tests] = parseDiff(diff);
  assert.deepEqual(created!.addedNames, ["render", "PAGE_CAP"]);
  assert.deepEqual(changed!.addedNames, ["fresh"]);
  assert.deepEqual(changed!.removedNames, ["legacy"]);
  assert.deepEqual(gone!.removedNames, ["Gone"]);
  assert.deepEqual(tests!.addedTests, ["renders a page", "inner"]);
});

test("parseDiff reads a binary file and an empty diff", () => {
  assert.deepEqual(parseDiff(""), []);
  const binary = "diff --git a/img/logo.png b/img/logo.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/img/logo.png differ";
  const [file] = parseDiff(binary);
  assert.deepEqual([file!.path, file!.status, file!.added, file!.removed], ["img/logo.png", "A", [], []]);
});

const sized = (path: string, lines: number) => chunk(path, "A", Array.from({ length: lines }, (_, i) => `line ${i} of ${path}`));

test("trimDiff keeps everything under the cap", () => {
  const files = parseDiff(diff);
  assert.deepEqual(trimDiff(files, 1_000_000), { kept: files, cut: [] });
});

test("trimDiff cuts lockfiles and generated files, then tests, then the largest files, until it fits", () => {
  const files = parseDiff(
    [sized("package-lock.json", 50), sized("src/big.ts", 40), sized("src/small.ts", 5), sized("src/a.test.ts", 30), sized("src/mid.ts", 20)].join("\n"),
  );
  const size = (paths: string[]) => files.filter((f) => paths.includes(f.path)).reduce((n, f) => n + f.text.length, 0);

  const noLock = trimDiff(files, size(["src/big.ts", "src/small.ts", "src/a.test.ts", "src/mid.ts"]));
  assert.deepEqual(noLock.cut, [{ path: "package-lock.json", reason: "generated" }]);

  const noTests = trimDiff(files, size(["src/big.ts", "src/small.ts", "src/mid.ts"]));
  assert.deepEqual(noTests.cut.map((c) => c.reason), ["generated", "test"]);

  const largest = trimDiff(files, size(["src/small.ts", "src/mid.ts"]));
  assert.deepEqual(largest.cut, [
    { path: "package-lock.json", reason: "generated" },
    { path: "src/a.test.ts", reason: "test" },
    { path: "src/big.ts", reason: "size" },
  ]);
  assert.deepEqual(largest.kept.map((f) => f.path), ["src/small.ts", "src/mid.ts"]);
});

test("diffForAgent leads with a per-file summary, names the cut files and appends the kept diff", () => {
  const files = parseDiff(diff);
  const text = diffForAgent({ kept: files.slice(0, 3), cut: [{ path: "server/new.test.ts", reason: "test" }] }, files);
  assert.match(text, /^Files changed \(4\), lines \+8 -3:/);
  assert.ok(text.includes("A server/new.ts +4 -0; added: render, PAGE_CAP"));
  assert.ok(text.includes("M server/old.ts +1 -2; added: fresh; removed: legacy"));
  assert.ok(text.includes("A server/new.test.ts +3 -0; tests: renders a page, inner"));
  assert.ok(text.includes("Left out for size (not shown below): server/new.test.ts (test)"));
  assert.ok(text.includes(files[2]!.text));
  assert.ok(!text.includes(files[3]!.text));
});
