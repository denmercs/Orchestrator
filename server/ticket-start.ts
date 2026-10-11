import { createTicketInitiative } from "./harness-layout";

type Issue = { issueType: string; summary: string; url: string };

export type TicketStartDeps = {
  readIssue: (key: string) => Promise<Issue | null | undefined>;
  startLoop: (input: {
    repo: string;
    initiative: string;
  }) => Promise<{ ok: boolean; error: string | null; started: { agentId: string }[] }>;
};

// Jira key → one-story initiative in `repo` with its loop on. The loop picks Plan or Diagnose
// from the story's track.
export async function startTicket(input: { repo: string; key: string }, deps: TicketStartDeps) {
  const key = input.key.trim().toUpperCase();
  const fail = (error: string) => ({ ok: false, error, initiative: null, track: null, agentId: null });
  try {
    const issue = await deps.readIssue(key);
    if (!issue) return fail(`Jira has no issue ${key}, or you can't see it.`);
    const created = await createTicketInitiative({ repo: input.repo, key, ...issue });
    if (!created.ok || !created.initiative) return fail(created.error ?? "Could not create the initiative.");
    const loop = await deps.startLoop({ repo: input.repo, initiative: created.initiative });
    if (!loop.ok) return fail(loop.error ?? "Could not start the loop.");
    return {
      ok: true,
      error: null,
      initiative: created.initiative,
      track: created.track,
      agentId: loop.started[0]?.agentId ?? null,
    };
  } catch (cause) {
    return fail(cause instanceof Error ? cause.message : String(cause));
  }
}
