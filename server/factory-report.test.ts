import assert from "node:assert/strict";
import { test } from "node:test";
import { report } from "./factory-phases";

// A port that records what it was sent and answers `answer` (a function throws when it is one).
function port(sent: string[], answer: unknown = true) {
  return async (line: string) => {
    sent.push(line);
    if (typeof answer === "function") throw answer();
    return answer;
  };
}

test("report sends a status line to Sulti and not to the manager", async () => {
  const status: string[] = [];
  const steer: string[] = [];
  await report({ status: port(status), steer: port(steer) }, "Slice s1 is ready for you.");
  assert.deepEqual(status, ["Slice s1 is ready for you."]);
  assert.deepEqual(steer, []);
});

test("report falls back to the manager when there is no status port", async () => {
  const steer: string[] = [];
  await report({ steer: port(steer) }, "Slice s1 merged.", "m1");
  assert.deepEqual(steer, ["Slice s1 merged."]);
});

test("report falls back to the manager when Sulti answers false or throws", async () => {
  for (const answer of [false, () => new Error("down")]) {
    const steer: string[] = [];
    await report({ status: port([], answer), steer: port(steer) }, "Slice s1 is ready for you.");
    assert.deepEqual(steer, ["Slice s1 is ready for you."]);
  }
});
