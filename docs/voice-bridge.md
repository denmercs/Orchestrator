# Voice bridge

Answer blocked Paseo sessions, and merge green story PRs, by voice from an Android phone. Tasker
speaks the oldest pending permission with Android text to speech, listens, and posts what you said
back to the plugin. When no agent is waiting, it reads out the next story PR ready to merge.

## Mac

```sh
# Token Tasker sends. The bridge stays off until this exists.
security add-generic-password -U -a "$USER" -s orchestrator-voice-token -w "$(openssl rand -hex 24)"
# Address to listen on. Use the Mac's Tailscale IP (`tailscale ip -4`); never a public interface.
security add-generic-password -U -a "$USER" -s orchestrator-voice-bind -w "100.x.y.z"
paseo plugin reload orchestrator
```

Port `4777`. Read the token back with `security find-generic-password -s orchestrator-voice-token -w`.

## API

Both calls need `Authorization: Bearer <token>`.

- `GET /voice/next` returns `{ id, text }` for the oldest blocked request, else the next PR ready to
  merge, or `204` when nothing is waiting.
- `POST /voice/answer` with `{ id, reply }` returns `{ said }`, a short line to speak back.

Replies:

- "yes", "ok", "go ahead" approve.
- "no", "deny", "stop" deny.
- Anything longer reaches the agent as an instruction, e.g. "no, use pnpm".
- A risky request (push, force, `rm -rf`, hard reset, merge, publish, `sudo`, piping to a shell,
  mode changes) is only approved by "confirm". A plain "yes" leaves it waiting.

## Merging

A story PR is offered once it is at the merge gate: open, with CI green, in a repo the initiative
loop has run in. You hear its review first, then the question:

> Add voice merge, PR 95. CI is green. Purpose: Merge green PRs by voice. Review passed after 2
> rounds. 3 findings fixed. Follow-up: split the module. Say merge to merge it, or skip.

The review comes from the story worktree's `.harness/pr-body.md` (Purpose) and `.harness/state.md`
(`## Review findings`), plus the story's review rounds and CI fixes. With no worktree you hear "No
review on record."

- "merge" (or "merge it") merges it. "Yes" and "confirm" do not.
- "skip", "no" or "not now" stops offering it for an hour.

Before merging, the plugin asks GitHub again. It merges only when every check passed, there are no
conflicts, the PR is not a draft and GitHub reports it clean. It then runs
`gh pr merge --merge --match-head-commit <sha>`, so a push made after the check can't be merged. If
anything fails you hear why ("PR 95 has conflicts with its base branch. Not merged.") and it stays
open. The plugin runs `gh` as you; no agent merges. The loop records the merge on its next tick.

## Tasker (Android)

The phone must be on the same Tailscale network.

Task **Voice answer**:

1. HTTP Request: GET `http://100.x.y.z:4777/voice/next`, header `Authorization:Bearer <token>`.
2. If `%http_response_code` != 200, Stop.
3. Variable Set `%ask` to `%http_data.text`, `%askid` to `%http_data.id`.
4. Say `%ask`.
5. Get Voice (timeout 8s).
6. HTTP Request: POST `http://100.x.y.z:4777/voice/answer`, same header, body
   `{"id":"%askid","reply":"%gv_heard"}`, content type `application/json`.
7. Say `%http_data.said`.
8. Goto action 1, so the next waiting request is read out.

Profiles that run it:

- Event → Notification, owner application **Paseo** (fires when a session needs you).
- Time, every 2 minutes (catches anything the notification missed, and PRs ready to merge, which
  don't raise a Paseo notification).

## Limits

- Only the request title and command are spoken. Google speech recognition hears your reply.
  Don't speak Confidential details.
- Requests resolved elsewhere (in the Paseo app) drop from the queue. The queue is in memory and
  empties on a plugin reload.
