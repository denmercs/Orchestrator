# Voice bridge

Answer blocked Paseo sessions by voice from an Android phone. Tasker speaks the oldest pending
permission with Android text to speech, listens, and posts what you said back to the plugin.

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

- `GET /voice/next` returns `{ id, text }` for the oldest blocked request, or `204` when none is waiting.
- `POST /voice/answer` with `{ id, reply }` returns `{ said }`, a short line to speak back.

Replies:

- "yes", "ok", "go ahead" approve.
- "no", "deny", "stop" deny.
- Anything longer reaches the agent as an instruction, e.g. "no, use pnpm".
- A risky request (push, force, `rm -rf`, hard reset, merge, publish, `sudo`, piping to a shell,
  mode changes) is only approved by "confirm". A plain "yes" leaves it waiting.

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
- Time, every 2 minutes (catches anything the notification missed).

## Limits

- Only the request title and command are spoken. Google speech recognition hears your reply.
  Don't speak Confidential details.
- Requests resolved elsewhere (in the Paseo app) drop from the queue. The queue is in memory and
  empties on a plugin reload.
