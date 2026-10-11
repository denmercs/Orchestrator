import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resultFile, takeStartFile, tickStartFile } from "./start-file";

const schema = z.object({ repo: z.string(), initiative: z.string() });
const startFile = () => join(mkdtempSync(join(tmpdir(), "start-file-")), "loop-start.json");
const readResult = (file: string) => JSON.parse(readFileSync(resultFile(file), "utf8"));

test("takeStartFile: checks the body against the schema it is given", () => {
  const file = startFile();
  writeFileSync(file, JSON.stringify({ repo: "/repo", initiative: "demo" }));
  assert.deepEqual(takeStartFile(file, schema), { ok: true, input: { repo: "/repo", initiative: "demo" } });
  writeFileSync(file, JSON.stringify({ repo: "/repo" }));
  assert.equal(takeStartFile(file, schema)?.ok, false);
  assert.equal(existsSync(file), false);
  assert.match(readResult(file).error, /initiative/);
});

test("tickStartFile: starts once with the parsed input; the start's own fields win over ok", async () => {
  const file = startFile();
  writeFileSync(file, JSON.stringify({ repo: "/repo", initiative: "demo" }));
  const started: unknown[] = [];
  const start = async (input: z.infer<typeof schema>) => (started.push(input), { ok: false, error: "busy" });
  await tickStartFile(file, schema, () => false, start);
  assert.deepEqual(started, []);
  await tickStartFile(file, schema, () => true, start);
  await tickStartFile(file, schema, () => true, start);
  assert.deepEqual(started, [{ repo: "/repo", initiative: "demo" }]);
  assert.deepEqual({ ...readResult(file), at: undefined }, { at: undefined, ok: false, error: "busy" });
});
