# Voice bridge

Talk to Paseo sessions hands-free from an Android phone. Tasker speaks the oldest waiting item (a
blocked permission, an agent's reply, or a green story PR to merge) with Android text to speech, listens until you say "roger",
and posts what you said back to the plugin. The mic is off while the agent works.

## Mac

```sh
# Token Tasker sends. The bridge stays off until this exists.
security add-generic-password -U -a "$USER" -s orchestrator-voice-token -w "$(openssl rand -hex 24)"
# Address to listen on: a private address the phone can reach; never a public interface.
security add-generic-password -U -a "$USER" -s orchestrator-voice-bind -w "<mac-ip>"
paseo plugin reload orchestrator
```

Port `4777`. Read the token back with `security find-generic-password -s orchestrator-voice-token -w`.

## API

Both calls need `Authorization: Bearer <token>`.

- `GET /voice/next` returns `{ id, kind, text }` for the oldest waiting item, or `204` when none is
  waiting. `kind` is `ask` (a blocked request), `reply` (an agent finished a turn) or `merge` (a
  story PR ready to merge, offered only when no ask or reply is waiting).
- `POST /voice/answer` with `{ id, reply, hold }` returns `{ said }`, a short line to speak back.
  - With `hold: true` the reply is buffered until a chunk ends with "roger"; until then it returns
    `{ listen: true }`. On "roger" the chunks are joined and answered as one message. "Roger" alone
    with nothing buffered returns `{ said: "I didn't catch that." }`.
  - Without `hold` a trailing "roger" is stripped, so "yes roger" approves.
  - With no `id` and nothing waiting, "merge" or "skip" answers the PR waiting to merge, and
    anything else goes to the agent you last answered, so you can start a new request. A bare "yes"
    or "no" is not sent. Otherwise `404`.

Replies to an ask:

- "yes", "ok", "go ahead" approve.
- "no", "deny", "stop" deny.
- Anything longer reaches the agent as an instruction, e.g. "no, use pnpm".
- A risky request (push, force, `rm -rf`, hard reset, merge, publish, `sudo`, piping to a shell,
  mode changes) is only approved by "confirm". A plain "yes" leaves it waiting.

Replies to a reply are sent to that agent as a new message, and the bridge answers "Sent.".

Which replies are queued:

- Only agents you have answered by voice (an ask or a reply) are followed. Their last message is
  queued when a turn completes, clipped to about 600 characters with markdown marks removed.
- One reply per agent; a newer one replaces the older. A reply is dropped when its agent starts
  another turn, for example because you answered it in the Paseo app.

## Merge by voice

A story PR is offered once it is at the merge gate: open, with CI green, in a repo the initiative
loop has run in. Nobody has to say which PR. You hear a review first, then the question:

> Add voice merge, PR 95. CI is green. It lets you merge green story PRs by voice. Nothing looks
> off. Purpose: Merge green PRs by voice. Review passed after 2 rounds. 3 findings fixed.
> Follow-up: split the module. Say merge to merge it, or skip.

The review has two parts:

- Haiku's read of the diff: `gh pr diff` piped to the signed-in Claude Code CLI
  (`claude -p --model haiku`, no tools), two or three sentences on what it does and anything that
  looks off. It runs in the background; the PR is offered on the next poll after it finishes. If
  `claude` can't be found (set `CLAUDE_BIN` to its path) or the call fails, this part is left out.
- The loop's own review: the Purpose from the worktree's `.harness/pr-body.md`, the review rounds,
  and the fixed, still-open and follow-up lines under `## Review findings` in `.harness/state.md`,
  plus any CI fixes. With no worktree you hear "No review on record."

Replies:

- "merge" (or "merge it", "just merge it") merges it. "Yes" and "confirm" do not, so a misheard
  approval can't merge anything. A trailing "roger" is ignored.
- "skip", "no" or "not now" stops offering it for an hour.

Before merging, the plugin asks GitHub again. It merges only when every check passed, there are no
conflicts, it is not a draft, and GitHub reports it clean. Otherwise you hear why ("PR 95 has
conflicts with its base branch. Not merged.") and it stays open; there is no "merge anyway". The
merge uses a merge commit when the repo allows one, then squash, then rebase, pinned with
`--match-head-commit` to the head it just checked, so a later push can't be merged unseen. The
plugin runs `gh` as you; no agent merges. The loop records the merge on its next tick. The branch
is not deleted.

## Tasker (Android)

The phone must be on a private network that reaches the Mac.

Task **Voice answer**:

1. HTTP Request: GET `http://<mac-ip>:4777/voice/next`, header `Authorization:Bearer <token>`.
2. If `%http_response_code` != 200, Stop.
3. Variable Set `%vtext` to `%http_data.text`, `%vid` to `%http_data.id`, `%vkind` to
   `%http_data.kind` (`ask`, `reply` or `merge`, if you want a different tone per kind).
4. Say `%vtext`.
5. Variable Set `%tries` to 0.
6. Get Voice (timeout 8s). Variable Add `%tries` 1.
7. HTTP Request: POST `http://<mac-ip>:4777/voice/answer`, same header, body
   `{"id":"%vid","reply":"%gv_heard","hold":true}`, content type `application/json`.
8. If `%http_data.listen` ~ true and `%tries` < 10, Goto action 6. If it is still listening after
   that, Stop.
9. Say `%http_data.said`.
10. Goto action 1. The mic stays off until the agent's next reply or request is waiting.

To start a request with nothing waiting, run a copy of the task from action 5 with `%vid` empty
(body `{"reply":"%gv_heard","hold":true}`); it goes to the agent you last answered.

Profiles that run **Voice answer**:

- Event → Notification, owner application **Paseo** (fires when a session needs you or replies).
- Time, every 2 minutes (catches anything the notification missed, and PRs ready to merge, which
  don't raise a Paseo notification).

End every message with "roger". Pauses are fine: each Get Voice chunk is buffered until then.

## Limits

- Only the request title and command, or the clipped reply, are spoken. Google speech recognition hears your reply.
  Don't speak Confidential details.
- Requests resolved elsewhere (in the Paseo app) drop from the queue. The queue, the held chunks
  and the followed agents are in memory and empty on a plugin reload.
