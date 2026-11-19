import assert from "node:assert/strict";
import { test } from "node:test";
import { alsoReport, toHuman } from "./factory-report";

// A port that records its lines and answers with `result` (or throws it when it is an Error).
function port(result: unknown = true) {
  const lines: { line: string; mission?: string }[] = [];
  const send = async (line: string, mission?: string) => {
    lines.push({ line, mission });
    if (result instanceof Error) throw result;
    return result;
  };
  return { lines, send };
}

test("toHuman sends to Sulti and not the manager when Sulti takes the line", async () => {
  const sulti = port(true);
  const manager = port(true);
  assert.equal(await toHuman({ steer: manager.send, report: sulti.send })!("ready", "m1"), true);
  assert.deepEqual(sulti.lines, [{ line: "ready", mission: "m1" }]);
  assert.equal(manager.lines.length, 0);
});

for (const [name, result] of [
  ["resolves false (no live Sulti)", false],
  ["throws", new Error("down")],
] as const) {
  test(`toHuman falls back to the manager when the Sulti report ${name}`, async () => {
    const sulti = port(result);
    const manager = port("sent");
    assert.equal(await toHuman({ steer: manager.send, report: sulti.send })!("ready", "m1"), "sent");
    assert.deepEqual(manager.lines, [{ line: "ready", mission: "m1" }]);
  });
}

test("toHuman passes the manager's throw through on the fallback, as a plain steer did", async () => {
  const human = toHuman({ steer: port(new Error("manager down")).send, report: port(false).send })!;
  await assert.rejects(human("ready"), /manager down/);
});

test("toHuman is the manager steer itself without Sulti, false with Sulti alone declining, undefined with neither", async () => {
  const manager = port();
  assert.equal(toHuman({ steer: manager.send }), manager.send);
  assert.equal(await toHuman({ report: port(false).send })!("ready"), false);
  assert.equal(toHuman({}), undefined);
});

test("alsoReport sends Sulti a copy and swallows its throw", async () => {
  const sulti = port(true);
  await alsoReport({ report: sulti.send }, "blocked", "m1");
  assert.deepEqual(sulti.lines, [{ line: "blocked", mission: "m1" }]);
  await alsoReport({ report: port(new Error("down")).send }, "blocked");
  await alsoReport({}, "blocked");
});
