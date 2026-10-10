# Voice bridge

Talk to Paseo sessions hands-free from an Android phone. Tasker speaks the oldest waiting item (a
blocked permission or an agent's reply) with Android text to speech, listens until you say "roger",
and posts what you said back to the plugin. The mic is off while the agent works.

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

- `GET /voice/next` returns `{ id, kind, text }` for the oldest waiting item, or `204` when none is
  waiting. `kind` is `ask` (a blocked request) or `reply` (an agent finished a turn).
- `POST /voice/answer` with `{ id, reply, hold }` returns `{ said }`, a short line to speak back.
  - With `hold: true` the reply is buffered until a chunk ends with "roger"; until then it returns
    `{ listen: true }`. On "roger" the chunks are joined and answered as one message. "Roger" alone
    with nothing buffered returns `{ said: "I didn't catch that." }`.
  - Without `hold` a trailing "roger" is stripped, so "yes roger" approves.
  - With no `id` and nothing waiting, the reply goes to the agent you last answered, so you can start
    a new request. A bare "yes" or "no" is not sent. Otherwise `404`.

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

## Tasker (Android)

The phone must be on the same Tailscale network.

Task **Voice answer**:

1. HTTP Request: GET `http://100.x.y.z:4777/voice/next`, header `Authorization:Bearer <token>`.
2. If `%http_response_code` != 200, Stop.
3. Variable Set `%vtext` to `%http_data.text`, `%vid` to `%http_data.id`, `%vkind` to
   `%http_data.kind` (`ask` or `reply`, if you want a different tone per kind).
4. Say `%vtext`.
5. Variable Set `%tries` to 0.
6. Get Voice (timeout 8s). Variable Add `%tries` 1.
7. HTTP Request: POST `http://100.x.y.z:4777/voice/answer`, same header, body
   `{"id":"%vid","reply":"%gv_heard","hold":true}`, content type `application/json`.
8. If `%http_data.listen` ~ true and `%tries` < 10, Goto action 6. If it is still listening after
   that, Stop.
9. Say `%http_data.said`.
10. Goto action 1. The mic stays off until the agent's next reply or request is waiting.

To start a request with nothing waiting, run a copy of the task from action 5 with `%vid` empty
(body `{"reply":"%gv_heard","hold":true}`); it goes to the agent you last answered.

Profiles that run it:

- Event → Notification, owner application **Paseo** (fires when a session needs you or replies).
- Time, every 2 minutes (catches anything the notification missed).

End every message with "roger". Pauses are fine: each Get Voice chunk is buffered until then.

## Limits

- Only the request title and command, or the clipped reply, are spoken. Google speech recognition hears your reply.
  Don't speak Confidential details.
- Requests resolved elsewhere (in the Paseo app) drop from the queue. The queue, the held chunks
  and the followed agents are in memory and empty on a plugin reload.
