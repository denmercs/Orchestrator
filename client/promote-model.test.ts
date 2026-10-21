import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialPromoteForm,
  promoteInput,
  setPromoteKind,
  setPromoteTitle,
  setPromoteWorkspace,
  validatePromote,
} from "./promote-model";

test("initialPromoteForm defaults to the current workspace, an empty title and Story", () => {
  const form = initialPromoteForm({ defaultWorkspaceId: "w1" });
  assert.deepEqual(form, { workspaceId: "w1", title: "", kind: "story" });
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
  assert.equal(setPromoteKind(asBug, "story").kind, "story");
});

test("setPromoteWorkspace changes the workspace without touching other fields", () => {
  const form = setPromoteTitle(initialPromoteForm({ defaultWorkspaceId: "w1" }), "X");
  const moved = setPromoteWorkspace(form, "w2");
  assert.equal(moved.workspaceId, "w2");
  assert.equal(moved.title, "X");
  assert.equal(moved.kind, "story");
});

test("promoteInput returns the submit shape with the title trimmed", () => {
  const form = setPromoteTitle(initialPromoteForm({ defaultWorkspaceId: "w1" }), "  Promote me  ");
  assert.deepEqual(promoteInput(form), { workspaceId: "w1", title: "Promote me", kind: "story" });
});

test("promoteInput carries through the Bug kind", () => {
  const form = setPromoteKind(
    setPromoteTitle(initialPromoteForm({ defaultWorkspaceId: "w2" }), "Fix leak"),
    "bug",
  );
  assert.deepEqual(promoteInput(form), { workspaceId: "w2", title: "Fix leak", kind: "bug" });
});
