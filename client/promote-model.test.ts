import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialPromoteForm,
  promoteInput,
  setPromoteCarryContext,
  setPromoteKind,
  setPromoteTitle,
  setPromoteWorkspace,
  validatePromote,
} from "./promote-model";

test("initialPromoteForm defaults to the current workspace, an empty title, Story and carry on", () => {
  const form = initialPromoteForm({ defaultWorkspaceId: "w1" });
  assert.deepEqual(form, { workspaceId: "w1", title: "", kind: "story", carryContext: true });
});

test("initialPromoteForm pre-fills the title from /promote args, trimmed", () => {
  const form = initialPromoteForm({ defaultWorkspaceId: "w1", argsTitle: "  Fix the login bug  " });
  assert.equal(form.title, "Fix the login bug");
});

test("validatePromote fails when the title is empty or only whitespace", () => {
  const empty = initialPromoteForm({ defaultWorkspaceId: "w1" });
  assert.deepEqual(validatePromote(empty), { ok: false, field: "title", message: "Title is required." });
  const spaces = setPromoteTitle(empty, "   ");
  assert.deepEqual(validatePromote(spaces), { ok: false, field: "title", message: "Title is required." });
});

test("validatePromote fails when no workspace is picked", () => {
  const form = initialPromoteForm({ defaultWorkspaceId: "" });
  assert.deepEqual(validatePromote(form), { ok: false, field: "workspaceId", message: "Pick a workspace." });
});

test("validatePromote passes with a workspace and a non-empty title", () => {
  const form = setPromoteTitle(initialPromoteForm({ defaultWorkspaceId: "w1" }), "Ship PR 3");
  assert.deepEqual(validatePromote(form), { ok: true });
});

test("setPromoteKind toggles between Story and Bug without touching other fields", () => {
  const form = setPromoteTitle(initialPromoteForm({ defaultWorkspaceId: "w1" }), "X");
  const asBug = setPromoteKind(form, "bug");
  assert.equal(asBug.kind, "bug");
  assert.equal(asBug.title, "X");
  assert.equal(asBug.workspaceId, "w1");
  assert.equal(asBug.carryContext, true);
  assert.equal(setPromoteKind(asBug, "story").kind, "story");
});

test("setPromoteWorkspace changes the workspace without touching other fields", () => {
  const form = setPromoteTitle(initialPromoteForm({ defaultWorkspaceId: "w1" }), "X");
  const moved = setPromoteWorkspace(form, "w2");
  assert.equal(moved.workspaceId, "w2");
  assert.equal(moved.title, "X");
  assert.equal(moved.kind, "story");
  assert.equal(moved.carryContext, true);
});

test("setPromoteCarryContext toggles the carry flag without touching other fields", () => {
  const form = setPromoteTitle(initialPromoteForm({ defaultWorkspaceId: "w1" }), "X");
  const off = setPromoteCarryContext(form, false);
  assert.equal(off.carryContext, false);
  assert.equal(off.title, "X");
  assert.equal(off.workspaceId, "w1");
  assert.equal(off.kind, "story");
  assert.equal(setPromoteCarryContext(off, true).carryContext, true);
});

test("promoteInput returns the submit shape with the title trimmed and sourceAgentId from params", () => {
  const form = setPromoteTitle(initialPromoteForm({ defaultWorkspaceId: "w1" }), "  Promote me  ");
  assert.deepEqual(promoteInput(form, { sourceAgentId: "a1" }), {
    workspaceId: "w1",
    title: "Promote me",
    kind: "story",
    carryContext: true,
    sourceAgentId: "a1",
  });
});

test("promoteInput carries through the Bug kind", () => {
  const form = setPromoteKind(
    setPromoteTitle(initialPromoteForm({ defaultWorkspaceId: "w2" }), "Fix leak"),
    "bug",
  );
  assert.deepEqual(promoteInput(form, { sourceAgentId: "a1" }), {
    workspaceId: "w2",
    title: "Fix leak",
    kind: "bug",
    carryContext: true,
    sourceAgentId: "a1",
  });
});

test("promoteInput passes through carryContext false", () => {
  const form = setPromoteCarryContext(
    setPromoteTitle(initialPromoteForm({ defaultWorkspaceId: "w1" }), "No carry"),
    false,
  );
  assert.deepEqual(promoteInput(form, { sourceAgentId: "a1" }), {
    workspaceId: "w1",
    title: "No carry",
    kind: "story",
    carryContext: false,
    sourceAgentId: "a1",
  });
});

test("promoteInput sends sourceAgentId: null when there is no chat to carry; server short-circuits", () => {
  const form = setPromoteTitle(initialPromoteForm({ defaultWorkspaceId: "w1" }), "Fresh");
  const sent = promoteInput(form, { sourceAgentId: null });
  assert.equal(sent.sourceAgentId, null);
  // carryContext may still be true in the form; the server treats a null source as "nothing to carry"
  // and skips the compaction, so the flag is harmlessly carried through here.
  assert.equal(sent.carryContext, true);
});
