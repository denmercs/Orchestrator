import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultTree, type LoopTree } from "../shared/loop-tree";
import { pipelineSettings } from "../shared/pipeline";
import { createLoopTrees } from "./loop-trees";

const config = pipelineSettings.schema.parse({});

function setup(options: { rename?: (from: string, to: string) => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loop-trees-"));
  const file = join(dir, "nested", "loop-trees.json");
  const store = createLoopTrees({ file, config: async () => config, ...options });
  return { dir, file, store };
}

const tweaked = (label: string): LoopTree => {
  const tree = defaultTree(config);
  return { ...tree, phases: tree.phases.map((p) => (p.id === "plan" ? { ...p, label } : p)) };
};

test("save then get round-trips per absolute repo path, and repos stay separate", async () => {
  const { store } = setup();
  const first = await store.get("/work/a");
  assert.deepEqual(first, { tree: defaultTree(config), saved: false, error: null });
  assert.deepEqual(await store.save("/work/a", tweaked("A plan")), { ok: true, error: null });
  assert.deepEqual(await store.save("/work/b", tweaked("B plan")), { ok: true, error: null });
  assert.equal((await store.get("/work/a")).tree.phases[0].label, "A plan");
  assert.equal((await store.get("/work/b")).saved, true);
  assert.equal((await store.get("/work/b")).tree.phases[0].label, "B plan");
  assert.equal((await store.get("/work/c")).saved, false);
});

test("a relative repo path is refused", async () => {
  const { store, file } = setup();
  const saved = await store.save("work/a", defaultTree(config));
  assert.equal(saved.ok, false);
  assert.match(saved.error ?? "", /"work\/a"/);
  assert.match((await store.get("work/a")).error ?? "", /absolute/);
  assert.throws(() => readFileSync(file), /ENOENT/);
});

test("save refuses an invalid tree and leaves the file alone", async () => {
  const { store, file } = setup();
  await store.save("/work/a", tweaked("kept"));
  const before = readFileSync(file, "utf8");
  const bad = { ...defaultTree(config), phases: [{ ...defaultTree(config).phases[0], onPass: "nowhere" }] };
  const result = await store.save("/work/a", bad);
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /"nowhere"/);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a failed rename leaves the old file intact and no temp file behind", async () => {
  const { store, file, dir } = setup({
    rename: async () => {
      throw new Error("disk said no");
    },
  });
  // Seed a file with a working store, then fail the next write.
  await createLoopTrees({ file, config: async () => config }).save("/work/a", tweaked("kept"));
  const before = readFileSync(file, "utf8");
  assert.equal((await store.save("/work/a", tweaked("lost"))).ok, false);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(readdirSync(join(dir, "nested")), ["loop-trees.json"]);
});

test("a corrupt file reads as the default with an error, and is never rewritten", async () => {
  const { store, file, dir } = setup();
  await store.save("/work/a", tweaked("kept"));
  writeFileSync(file, "{not json");
  const got = await store.get("/work/a");
  assert.deepEqual(got.tree, defaultTree(config));
  assert.equal(got.saved, false);
  assert.match(got.error ?? "", /loop-trees\.json/);
  const saved = await store.save("/work/a", tweaked("new"));
  assert.equal(saved.ok, false);
  assert.match(saved.error ?? "", /loop-trees\.json/);
  assert.equal(readFileSync(file, "utf8"), "{not json");
  assert.deepEqual(readdirSync(join(dir, "nested")), ["loop-trees.json"]);
  writeFileSync(file, "[1]");
  assert.match((await store.get("/work/a")).error ?? "", /loop-trees\.json/);
});

test("a bad entry for one repo reads as its default with an error and leaves other repos alone", async () => {
  const { store, file } = setup();
  await store.save("/work/a", tweaked("A plan"));
  const all = JSON.parse(readFileSync(file, "utf8"));
  all["/work/bad"] = { phases: [{ id: "x" }] };
  writeFileSync(file, JSON.stringify(all));
  const bad = await store.get("/work/bad");
  assert.deepEqual(bad.tree, defaultTree(config));
  assert.equal(bad.saved, false);
  assert.match(bad.error ?? "", /\/work\/bad/);
  assert.equal((await store.get("/work/a")).tree.phases[0].label, "A plan");
  // Saving a third repo keeps the bad entry as it was.
  await store.save("/work/c", tweaked("C plan"));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8"))["/work/bad"], { phases: [{ id: "x" }] });
});

test("reset drops the saved tree so the default comes back, and other repos keep theirs", async () => {
  const { store } = setup();
  await store.save("/work/a", tweaked("A plan"));
  await store.save("/work/b", tweaked("B plan"));
  assert.deepEqual(await store.reset("/work/a"), { ok: true, error: null });
  assert.equal((await store.get("/work/a")).saved, false);
  assert.equal((await store.get("/work/b")).tree.phases[0].label, "B plan");
  assert.deepEqual(await store.reset("/work/never"), { ok: true, error: null });
  assert.equal((await store.reset("rel")).ok, false);
});

test("export gives the tree as JSON text, the default when none is saved", async () => {
  const { store } = setup();
  assert.deepEqual(JSON.parse((await store.exportTree("/work/a")).text), defaultTree(config));
  await store.save("/work/a", tweaked("A plan"));
  assert.equal(JSON.parse((await store.exportTree("/work/a")).text).phases[0].label, "A plan");
});

test("import parses and validates text before saving, with readable errors", async () => {
  const { store } = setup();
  const text = JSON.stringify(tweaked("Imported"));
  assert.deepEqual(await store.importTree("/work/a", text), { ok: true, error: null });
  assert.equal((await store.get("/work/a")).tree.phases[0].label, "Imported");
  const broken = await store.importTree("/work/a", "{nope");
  assert.equal(broken.ok, false);
  assert.match(broken.error ?? "", /not valid JSON/);
  const invalid = await store.importTree("/work/a", JSON.stringify({ ...defaultTree(config), phases: [] }));
  assert.equal(invalid.ok, false);
  assert.match(invalid.error ?? "", /no phases/);
  assert.equal((await store.get("/work/a")).tree.phases[0].label, "Imported");
});

test("copy saves another repo's tree here, its computed default when it has none saved", async () => {
  const { store } = setup();
  await store.save("/work/a", tweaked("A plan"));
  assert.deepEqual(await store.copyTree("/work/a", "/work/b"), { ok: true, error: null });
  assert.equal((await store.get("/work/b")).tree.phases[0].label, "A plan");
  assert.equal((await store.get("/work/b")).saved, true);
  assert.deepEqual(await store.copyTree("/work/none", "/work/c"), { ok: true, error: null });
  const c = await store.get("/work/c");
  assert.equal(c.saved, true);
  assert.deepEqual(c.tree, defaultTree(config));
  assert.equal((await store.copyTree("rel", "/work/d")).ok, false);
});

test("repo paths are normalised before keying", async () => {
  const { store, file } = setup();
  await store.save("/work/a/", tweaked("A plan"));
  assert.equal((await store.get("/work/./a")).saved, true);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8"))), ["/work/a"]);
  await store.copyTree("/work/a/", "/work/b/");
  assert.equal((await store.get("/work/b")).saved, true);
  await store.reset("/work/a/");
  assert.equal((await store.get("/work/a")).saved, false);
});

test("saves made at once all land", async () => {
  const { store } = setup();
  const repos = Array.from({ length: 8 }, (_, i) => `/work/r${i}`);
  const results = await Promise.all(repos.map((repo) => store.save(repo, tweaked(repo))));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  for (const repo of repos) assert.equal((await store.get(repo)).tree.phases[0].label, repo);
});

test("a write failure comes back as a refusal, not a throw", async () => {
  const { store } = setup({
    rename: async () => {
      throw new Error("disk said no");
    },
  });
  const tree = tweaked("x");
  assert.deepEqual(await store.save("/work/a", tree), { ok: false, error: "Could not write the loop trees: disk said no" });
  assert.equal((await store.importTree("/work/a", JSON.stringify(tree))).ok, false);
  assert.equal((await store.copyTree("/work/a", "/work/b")).ok, false);
});
