import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classify, countLines, globToRegExp, parseArgs, report, verdict } from "./count-lines.mjs";

test("test files, test folders and snapshots count as tests", () => {
  for (const path of [
    "src/cart.test.ts",
    "src/cart.spec.tsx",
    "src/__tests__/cart.ts",
    "src/__snapshots__/cart.test.ts.snap",
    "Button.snap",
    "tests/cart.ts",
    "app/test/helpers.rb",
    "e2e/checkout.ts",
    "src/__mocks__/api.ts",
    "cart_test.go",
    "pkg/test_cart.py",
    "src/CartTest.java",
    "CartTests.swift",
  ]) {
    assert.equal(classify(path), "tests", path);
  }
});

test("lockfiles and generated files are skipped", () => {
  for (const path of [
    "package-lock.json",
    "ios/Podfile.lock",
    "yarn.lock",
    "src/__generated__/schema.ts",
    "api/generated/client.ts",
    "src/types.generated.ts",
    "public/app.min.js",
  ]) {
    assert.equal(classify(path), "skipped", path);
  }
});

test("everything else is source", () => {
  assert.equal(classify("src/cart.ts"), "source");
  assert.equal(classify("src/testing/helpers.ts"), "source");
  assert.equal(classify("package.json"), "source");
  assert.equal(classify("src/Test.java"), "source");
  assert.equal(classify("src/latest.ts"), "source");
});

test("--skip globs match a file name anywhere, or a full path when they hold a slash", () => {
  assert.equal(classify("src/icons/star.svg", [globToRegExp("*.svg")]), "skipped");
  assert.equal(classify("fixtures/a/b.json", [globToRegExp("fixtures/**")]), "skipped");
  assert.equal(classify("src/fixtures/a.json", [globToRegExp("fixtures/**")]), "source");
  assert.equal(classify("docs/a/b/c.md", [globToRegExp("docs/**/*.md")]), "skipped");
  assert.equal(classify("docs/c.md", [globToRegExp("docs/**/*.md")]), "skipped");
  assert.equal(classify("a/b/x.json", [globToRegExp("**/x.json")]), "skipped");
  assert.equal(classify("src/a1.ts", [globToRegExp("a?.ts")]), "skipped");
  assert.equal(classify("src/a12.ts", [globToRegExp("a?.ts")]), "source");
  assert.equal(classify("src/aXsvg", [globToRegExp("*.svg")]), "source");
});

test("countLines adds added and deleted lines per kind and counts binary files as zero", () => {
  const numstat = [
    "120\t30\tsrc/cart.ts",
    "80\t0\tsrc/cart.test.ts",
    "900\t400\tpackage-lock.json",
    "-\t-\tassets/logo.png",
    "",
  ].join("\n");
  const counts = countLines(numstat);
  assert.equal(counts.source, 150);
  assert.equal(counts.tests, 80);
  assert.equal(counts.skipped, 1300);
  assert.deepEqual(
    counts.files.source.map((f) => f.path),
    ["src/cart.ts", "assets/logo.png"],
  );
});

test("countLines reads NUL-separated records with unquoted paths", () => {
  const counts = countLines("4\t1\tsrc/my file.ts\x005\t0\tdir/package-lock.json\x00");
  assert.equal(counts.source, 5);
  assert.equal(counts.skipped, 5);
});

test("verdict follows the 500 target and the 1,000 limit", () => {
  assert.match(verdict(500), /within 500/);
  assert.match(verdict(501), /over 500/);
  assert.match(verdict(1001), /over 1000.*split/);
});

test("report lists the totals, the verdict and the largest source files", () => {
  const out = report(countLines("10\t2\tsrc/a.ts\n3\t0\tsrc/a.test.ts\n"));
  assert.match(out, /source {2}12/);
  assert.match(out, /tests {3}3/);
  assert.match(out, /12\tsrc\/a\.ts/);
});

test("parseArgs takes base, an optional head and repeated --skip", () => {
  assert.deepEqual(parseArgs(["origin/main"]), { base: "origin/main", head: "HEAD", skip: [] });
  assert.deepEqual(parseArgs(["main", "feature", "--skip", "*.svg", "--skip", "docs/**"]), {
    base: "main",
    head: "feature",
    skip: ["*.svg", "docs/**"],
  });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(["main", "--skip"]), /needs a glob/);
  assert.deepEqual(parseArgs(["main", "--skip=*.svg"]).skip, ["*.svg"]);
  assert.throws(() => parseArgs(["main", "--skp", "x"]), /unknown option --skp/);
});

test("the command runs through a symlink to its folder", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "count-lines-"));
  try {
    const repo = join(dir, "repo");
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
    execFileSync("sh", ["-c", `printf 'a\\nb\\n' > "${repo}/a.ts" && printf 'x\\n' > "${repo}/a.test.ts"`]);
    git("add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "work");
    symlinkSync(here, join(dir, "link"));
    const out = execFileSync(process.execPath, [join(dir, "link", "count-lines.mjs"), "HEAD~1"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.match(out, /source {2}2/);
    assert.match(out, /tests {3}1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
