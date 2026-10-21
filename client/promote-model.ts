// The Promote form, as data. Kept free of React and the Paseo client so it can be tested on its own.
// The slash command and the composer pill both open a Promote screen that drives this model and
// then calls `promoteSessionToStory` with the shape `promoteInput` returns.

export type PromoteKind = "story" | "bug";

export type PromoteForm = {
  workspaceId: string;
  title: string;
  kind: PromoteKind;
  // "Carry chat context": when true, the server compacts the originating chat into the story's
  // `.harness/context.md` so the planner reads it as background. Default on; irrelevant (and
  // forced off by the panel) when there is no `sourceAgentId` to carry from.
  carryContext: boolean;
};

export type PromoteValidation =
  | { ok: true }
  | { ok: false; field: "title" | "workspaceId"; message: string };

// Starting state for a fresh form. `argsTitle` pre-fills from `/promote <text>`; `defaultWorkspaceId`
// is the current workspace. Trimming the args is deliberate so leading or trailing spaces don't look
// typed.
export function initialPromoteForm(input: {
  defaultWorkspaceId: string;
  argsTitle?: string;
}): PromoteForm {
  return {
    workspaceId: input.defaultWorkspaceId,
    title: (input.argsTitle ?? "").trim(),
    kind: "story",
    carryContext: true,
  };
}

export function setPromoteTitle(form: PromoteForm, title: string): PromoteForm {
  return { ...form, title };
}

export function setPromoteWorkspace(form: PromoteForm, workspaceId: string): PromoteForm {
  return { ...form, workspaceId };
}

export function setPromoteKind(form: PromoteForm, kind: PromoteKind): PromoteForm {
  return { ...form, kind };
}

export function setPromoteCarryContext(form: PromoteForm, carryContext: boolean): PromoteForm {
  return { ...form, carryContext };
}

// Title is required and must be non-empty after trimming. Workspace must be picked. The pipeline
// (phase prompts, local-ticket key) handles the rest.
export function validatePromote(form: PromoteForm): PromoteValidation {
  if (!form.workspaceId) {
    return { ok: false, field: "workspaceId", message: "Pick a workspace." };
  }
  if (!form.title.trim()) {
    return { ok: false, field: "title", message: "Title is required." };
  }
  return { ok: true };
}

// What the submit sends. Matches the `promoteSessionToStory` input in `shared/promote.ts`.
// `sourceAgentId` rides from the form's params (the chat the user promoted from). When it is
// null, the server short-circuits the compaction regardless of `carryContext`.
export function promoteInput(
  form: PromoteForm,
  params: { sourceAgentId: string | null },
): {
  workspaceId: string;
  title: string;
  kind: PromoteKind;
  carryContext: boolean;
  sourceAgentId: string | null;
} {
  return {
    workspaceId: form.workspaceId,
    title: form.title.trim(),
    kind: form.kind,
    carryContext: form.carryContext,
    sourceAgentId: params.sourceAgentId,
  };
}
