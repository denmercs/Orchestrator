import assert from "node:assert/strict";
import { test } from "node:test";
import type { DailyVerse } from "../shared/orchestration";
import { verseLine } from "./daily-verse-model";

function verse(rest: Partial<DailyVerse> = {}): DailyVerse {
  return {
    reference: "Hebrews 12:1",
    text: "Let us run with endurance the race that lies before us.",
    translation: "CSB",
    copyright: "Scripture quotations marked CSB have been taken from the Christian Standard Bible®.",
    ...rest,
  };
}

test("verseLine quotes the full text and joins reference and translation", () => {
  assert.deepEqual(verseLine(verse()), {
    quote: "“Let us run with endurance the race that lies before us.”",
    meta: "Hebrews 12:1 · CSB",
  });
});

test("verseLine shows the reference alone when there is no text", () => {
  assert.deepEqual(verseLine(verse({ text: null })), { quote: null, meta: "Hebrews 12:1" });
});

test("verseLine never includes the copyright line", () => {
  const line = verseLine(verse({ copyright: "COPYRIGHT-NOTICE" }));
  assert.ok(!`${line.quote}${line.meta}`.includes("COPYRIGHT-NOTICE"));
});
