import assert from "node:assert/strict";
import { test } from "node:test";
import { branchName, cleanSubject, initialsFrom, prHeadline, prTitle } from "./naming";

test("initialsFrom: the setting wins, lowercased and letters only", () => {
  assert.equal(initialsFrom({ setting: " D.M ", email: "jane.doe@example.com" }), "dm");
});

test("initialsFrom: an empty setting falls through to the email", () => {
  assert.equal(initialsFrom({ setting: "  ", email: "dennis.mercado@lifeway.com" }), "dm");
});

test("initialsFrom: a three-part email local part gives three letters", () => {
  assert.equal(initialsFrom({ email: "Mary-Ann_Smith@example.com" }), "mas");
});

test("initialsFrom: skips a noreply address and uses the username", () => {
  assert.equal(
    initialsFrom({ email: "12239322+denmercs@users.noreply.github.com", username: "dennis_mercado" }),
    "dm",
  );
});

test("initialsFrom: a single token is not guessed at", () => {
  assert.equal(initialsFrom({ email: "jsmith@example.com", username: "denmercs" }), null);
});

test("initialsFrom: parts with digits or more than three parts do not count", () => {
  assert.equal(initialsFrom({ email: "dennis.m2@example.com", username: "a.b.c.d" }), null);
});

test("initialsFrom: nothing found gives null", () => {
  assert.equal(initialsFrom({}), null);
});

test("branchName: initials, Jira key lowercased, title slug", () => {
  assert.equal(
    branchName({ initials: "dm", key: "DCD-123", title: "Split the initiative board" }),
    "dm/dcd-123/split-the-initiative-board",
  );
});

test("branchName: no key gives initials and slug", () => {
  assert.equal(branchName({ initials: "dm", title: "Split the initiative board" }), "dm/split-the-initiative-board");
});

test("branchName: no initials gives no prefix", () => {
  assert.equal(branchName({ initials: null, key: "DCD-123", title: "Add search" }), "dcd-123/add-search");
  assert.equal(branchName({ initials: null, title: "Add search!" }), "add-search");
});

test("branchName: slug is cut at 48 chars without a trailing dash", () => {
  const slug = branchName({ initials: null, title: "a".repeat(47) + " bcd" });
  assert.equal(slug, "a".repeat(47));
});

test("cleanSubject: keeps the first non-empty line, trimmed", () => {
  assert.equal(cleanSubject("\n  Add search box  \nmore detail"), "Add search box");
});

test("cleanSubject: strips a leading story id or Jira key", () => {
  assert.equal(cleanSubject("S17: Add search"), "Add search");
  assert.equal(cleanSubject("ABC-123: Add search"), "Add search");
  assert.equal(cleanSubject("ABC-123 | Add search"), "Add search");
});

test("cleanSubject: strips a list bullet and wrapping quotes or backticks", () => {
  assert.equal(cleanSubject("- Add search"), "Add search");
  assert.equal(cleanSubject("* S17: Add search"), "Add search");
  assert.equal(cleanSubject('"Add search"'), "Add search");
  assert.equal(cleanSubject("`Add search`"), "Add search");
});

test("cleanSubject: cuts at a word boundary at 72 chars", () => {
  const text = "word ".repeat(20).trim(); // 99 chars
  const out = cleanSubject(text);
  assert.ok(out && out.length <= 72);
  assert.equal(out, "word ".repeat(14).trim()); // 69 chars
});

test("cleanSubject: empty text gives null", () => {
  assert.equal(cleanSubject(""), null);
  assert.equal(cleanSubject("  \n \n"), null);
  assert.equal(cleanSubject("S17: "), null);
});

test("prTitle: story title alone, or Jira key and title", () => {
  assert.equal(prTitle({ id: "S1", title: "Add search", jira: false }), "Add search");
  assert.equal(prTitle({ id: "DCD-1", title: "Add search", jira: true }), "DCD-1 | Add search");
});

test("prHeadline: Story or Jira line", () => {
  assert.equal(prHeadline({ id: "S1", title: "Add search", jira: false }), "Story: S1 — Add search");
  assert.equal(prHeadline({ id: "DCD-1", title: "Add search", jira: true }), "Jira: DCD-1 — Add search");
});
