import { resolve } from "node:path";
import { createTicketInitiative, dirsIn, initiativesDir } from "./harness-layout";

type Issue = { issueType: string; summary: string; url: string };

export type TicketStartDeps = {
  readIssue: (key: string) => Promise<Issue | null | undefined>;
  startLoop: (input: {
    repo: string;
    initiative: string;
  }) => Promise<{ ok: boolean; error: string | null; started: { agentId: string }[] }>;
};

export type LocalTicketStartDeps = Pick<TicketStartDeps, "startLoop">;

// Scans a repo's initiatives area for `promote-<n>-...` folders and returns one more than
// the highest `<n>` it finds (one-based). A fresh repo gets 1. Deleted folders free their N.
export function nextPromoteNumber(repo: string) {
  const taken = dirsIn(initiativesDir(resolve(repo)))
    .map((name) => Number(/^promote-(\d+)-/i.exec(name)?.[1] ?? 0))
    .filter((n) => n > 0);
  return (taken.length ? Math.max(...taken) : 0) + 1;
}

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

// Chat-promoted scratch story: a one-story initiative in `repo` with no Jira ticket behind it.
// Mirrors `startTicket` but skips `readIssue` — the key is minted locally as `PROMOTE-<n>`,
// one higher than the highest existing `PROMOTE-N` in the repo's initiatives area.
export async function startLocalTicket(
  input: { repo: string; title: string; kind: "story" | "bug" },
  deps: LocalTicketStartDeps,
) {
  const fail = (error: string) => ({ ok: false, error, initiative: null, track: null, agentId: null });
  try {
    const title = input.title.trim();
    if (!title) return fail("Give the ticket a title.");
    const key = `PROMOTE-${nextPromoteNumber(input.repo)}`;
    const issueType = input.kind === "bug" ? "Bug" : "Story";
    const created = await createTicketInitiative({
      repo: input.repo,
      key,
      issueType,
      summary: title,
      url: "",
    });
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
