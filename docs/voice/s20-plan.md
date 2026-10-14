# S20 plan: ask Jarvis for status

Say "Jarvis, status" (or "what are the agents doing") and Voice speaks one short summary of the sessions. Same words on
the Mac drawer and the phone. This was out of scope in S19.

## Verified in code (read, not guessed)
- The Voice loop (`shared/voice-loop.ts`) is pure and only knows `{ id, name }` per session. It has no idea whether a
  session is running, idle or stuck. Status needs live agent state, so the loop cannot answer it alone.
- Live state exists on the server: `index.server.ts` lists agents with `agents.list` for Jarvis `sessions()`, and each
  agent carries `status` (running, initializing, idle, error, closed), `attentionReason` and `pendingPermissions`.
  `client/board-model.ts` (`phaseForAgent`, `hasPendingPermission`) already reads the same fields.
- Precedent for "words handled before the loop, server gathers data": the morning briefing. `isBriefGreeting` in
  `shared/morning-brief.ts`, `routeBrief` in `server/jarvis-router.ts`, the `voiceBrief` RPC, and `brief` port in
  `client/voice-runner.ts` (awake only, lines shown and spoken, the session never hears the words).
- Wording lives in `shared/voice-lines.ts`; session names come from `shortName` (`shared/voice-names.ts`).
- Voice's own sessions (Jarvis, the helper) are `blocked` and must be left out of the summary.

## Smallest design
1. New pure `shared/voice-status.ts`: `isStatusAsk(text)` (short phrases only, after the name, like the greeting
   check: "status", "give me a status", "what are the agents doing", "what's going on") and
   `statusLine(agents)`; wording constants go in `voice-lines.ts`.
2. `statusLine` rules: none running and none stuck -> "Nothing is running." Otherwise lead with what needs you
   (permission, error), then running, then idle count. Names via `shortName`, at most three named per group, the rest
   as a count ("and two more"). Whole line capped at 300 chars (same cap as a reply). Voice's own sessions excluded.
3. Server: a `status` port on the Jarvis router built from the same `agents.list` call `sessions()` uses. The router
   handles the ask ahead of the loop (like `routeBrief`), awake only; asleep it needs the name, as the greeting does.
4. Drawer: a `voiceStatus` RPC (same shape as `voiceBrief`) and a `status` port on the runner, tried right after the
   brief, awake only. The line is shown and spoken; the target never hears the words.
5. No new setting, no Paseo change, no reply memory.

## Guess (unverified)
- That `attentionReason` / `pendingPermissions` are filled for every provider (the board relies on them, but only
  checked for Claude sessions).
- That a stale `running` status after a crashed turn can occur; the summary would say "running" until Paseo corrects it.
- That a phone `voice-line` plays (S7 hand check still pending, same as S19).

## Tests (node:test), each RED first
shared/voice-status.test.ts
- RED: `isStatusAsk("Jarvis, status")` is true -> GREEN with the matcher. Also "what are the agents doing". Not
  matched: "the status of the build is red, fix it" (long, a request for the target), "good morning".
- RED: `statusLine([])` -> "Nothing is running." GREEN once the empty case exists.
- RED: two running, one waiting on permission -> names the waiting one first with "needs you", then "two running".
- RED: error session -> "<name> hit an error".
- RED: more than three in a group -> three names and "and N more"; the line is at most 300 chars.
- RED: closed and archived sessions and Voice's own (blocked) sessions are not counted.

server/jarvis-router.test.ts
- RED: awake, "Jarvis, status" -> spoken is the status line, no `send`, the target is not steered.
- RED: asleep and not named ("status") -> stays asleep, nothing spoken; "Jarvis, status" wakes and answers.
- RED: the `agents.list` call fails -> one spoken line "I couldn't read the sessions: <error>", no throw.
- RED: a long request containing "status" still goes to the loop as before.

client/voice-runner.test.ts
- RED: the `status` port returns lines -> they are spoken and shown, the session gets no steer; returns null ->
  normal loop path unchanged; asleep -> not called.

index.server.test.ts
- RED: `voiceStatus` RPC answers the line for a mix of running/permission/error agents from `agents.list`.

shared/no-node-imports.test.ts already guards that `voice-status.ts` stays free of node modules.

## Steps for Implement
1. voice-status.ts + tests (matcher, then line builder, one behavior at a time).
2. Router `status` port + tests.
3. `voiceStatus` RPC in `shared/voice-rpc.ts`, handler in `index.server.ts`, test.
4. Runner `status` port + drawer wiring in `client/voice-drawer.tsx` / `index.client.tsx`, test.
5. `npm test`, `npm run typecheck`. Update `CONTEXT.md` if "status" becomes a named concept.

## Open decision (needs the user)
What should "status" say? Default in this plan is option one.
1. Session states only: who is running, who needs you, who hit an error. (Smallest, no new data.)
2. Option one plus each running session's last one-line progress. (Needs the server to keep recent replies.)
3. Option one plus the initiative loop's story progress ("story 3 of 7"). (Pulls in the harness board.)

Out of scope: spoken status on a timer, per-session status ("status of planning"), history.
