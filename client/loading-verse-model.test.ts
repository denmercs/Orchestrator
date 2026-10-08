import assert from "node:assert/strict";
import { test } from "node:test";
import { LOADING_VERSES, loadingVerse } from "./loading-verse-model";

test("loadingVerse(0) is the first verse", () => {
  assert.deepEqual(loadingVerse(0), LOADING_VERSES[0]);
});

test("a seed of LOADING_VERSES.length wraps to the first verse", () => {
  assert.deepEqual(loadingVerse(LOADING_VERSES.length), LOADING_VERSES[0]);
});

test("a negative seed still returns a verse from the list", () => {
  assert.ok(LOADING_VERSES.includes(loadingVerse(-1)));
  assert.ok(LOADING_VERSES.includes(loadingVerse(-LOADING_VERSES.length - 3)));
});

test("a fractional seed still returns a verse from the list", () => {
  assert.ok(LOADING_VERSES.includes(loadingVerse(2.7)));
  assert.ok(LOADING_VERSES.includes(loadingVerse(-0.4)));
});

test("every verse has non-empty text and a reference", () => {
  assert.ok(LOADING_VERSES.length > 0);
  for (const verse of LOADING_VERSES) {
    assert.ok(verse.text.trim().length > 0);
    assert.ok(verse.reference.trim().length > 0);
  }
});
