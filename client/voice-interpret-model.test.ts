import assert from "node:assert/strict";
import { test } from "node:test";
import type { InterpretOutcome } from "../shared/voice-interpreter";
import { HELPER_DEFAULT_ON, interpretRows, type InterpretEntry } from "./voice-interpret-model";

function entry(heard: string, outcome: InterpretOutcome): InterpretEntry {
  return { heard, outcome };
}

test("HELPER_DEFAULT_ON: the helper starts on", () => {
  assert.equal(HELPER_DEFAULT_ON, true);
});

test("interpretRows: empty history gives no rows", () => {
  assert.deepEqual(interpretRows([]), []);
});

test("interpretRows: cleaned text per result type, no note for helper rows", () => {
  const rows = interpretRows([
    entry("um send it", { via: "helper", result: { type: "send", text: "send it" } }),
    entry("delete uh the branch", { via: "helper", result: { type: "confirm", text: "delete the branch" } }),
    entry("go to review", { via: "helper", result: { type: "switch", name: "review" } }),
    entry("hmm", { via: "helper", result: { type: "drop" } }),
  ]);
  assert.deepEqual(
    rows.map(({ heard, cleaned, note }) => ({ heard, cleaned, note })),
    [
      { heard: "hmm", cleaned: "dropped", note: null },
      { heard: "go to review", cleaned: "switch to review", note: null },
      { heard: "delete uh the branch", cleaned: "delete the branch", note: null },
      { heard: "um send it", cleaned: "send it", note: null },
    ],
  );
});

test("interpretRows: fallbacks carry a note, switch-off pass-through does not", () => {
  const rows = interpretRows([
    entry("a", { via: "passThrough", reason: "timeout", result: { type: "send", text: "a" } }),
    entry("b", { via: "passThrough", reason: "error", result: { type: "send", text: "b" } }),
    entry("c", { via: "passThrough", result: { type: "send", text: "c" } }),
  ]);
  assert.deepEqual(rows.map((r) => [r.cleaned, r.note]), [
    ["c", null],
    ["b", "Helper failed, sent as heard"],
    ["a", "Helper timed out, sent as heard"],
  ]);
});

test("interpretRows: newest first, at most 5, keys stay stable as history grows", () => {
  const history = Array.from({ length: 7 }, (_, i) => entry(`h${i}`, { via: "helper", result: { type: "send", text: `t${i}` } }));
  const rows = interpretRows(history);
  assert.deepEqual(rows.map((r) => r.heard), ["h6", "h5", "h4", "h3", "h2"]);
  assert.equal(new Set(rows.map((r) => r.key)).size, 5);
  const longer = interpretRows([...history, entry("h7", { via: "helper", result: { type: "drop" } })]);
  assert.equal(longer.find((r) => r.heard === "h6")?.key, rows[0].key);
});
