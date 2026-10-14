# S21 plan: a measured check that the Voice pill and mic stay live across navigation

From `docs/voice/s0-spike.md` (d6): the mic staying live across navigation was only the user's report.

## Verified in code (read, not guessed)
- The voice runner and the mic/ears are created once in `index.client.tsx`, at plugin level, not inside the
  dashboard surface. The drawer only reads the runner (`useSyncExternalStore`), so closing or leaving the
  surface does not touch the mic. Only `runner.off()` or the mic toggle close it.
- The Voice pill is a composer pill, kept by `contributeSessionRolePills` (`client/session-role-pills.ts`),
  keyed by agent and workspace. Navigating to another session changes which composer is on screen; the pill
  must stay registered and keep reading runner state.
- No test covers `contributeSessionRolePills`.

## Smallest design
No product change. One new test file, `client/session-role-pills.test.ts`, with a fake Paseo client and a real
`createVoiceRunner` over fake ports. "Navigation" is simulated the ways the plugin can see it: the agent list
snapshot is delivered again, an agent moves workspace, a session is added or removed, the surface is unmounted
(nothing for the plugin to do).

## Tests (node:test), RED then GREEN, one at a time
1. A targetable session gets a Voice pill showing the runner's current label (`Voice · asleep`).
2. After a new snapshot (session list re-delivered), the pill is still there and the mic ears were not closed.
3. When the runner's mode changes after that snapshot, the existing pill's label updates (no re-registration).
4. When an agent moves to another workspace, the pill is removed from the old one and added to the new one,
   still showing the live state; the mic stays open.
5. Voice's own sessions get no pill; a removed session loses its pill, others keep theirs.
6. Teardown removes every pill and unsubscribes from the runner (a later runner change does nothing).

If a test passes at once (the behavior already holds) it is kept as a regression check; a real failure is fixed
in `session-role-pills.ts`.

## Guess (unverified)
- That Paseo keeps the plugin client alive when the user switches sessions. This test covers the plugin side
  only; the hand check on a real app is still the user's.
