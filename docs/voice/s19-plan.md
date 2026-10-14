# S19 plan: hear a session's replies on the phone

## Verified in code (read, not guessed)
- Every finished turn becomes `reply` + `finished` events in `server/turn-events.ts`, published by `publishVoice`
  (index.server.ts) to the hub and `jarvis.event()`, which steps them into every router's Voice loop.
- The loop (`shared/voice-loop.ts`, `reply` case) speaks a reply ONLY for the target. A reply from any other session
  is dropped; such a session only gets a queued "X finished" notice. This is the gap.
- A line the loop speaks reaches the phone: `jarvisConnection.say()` emits a `voice-line` timeline item
  (`{ lineId, text }`) when `voice.phoneAudio` is on; the renderer plays it once per `lineId` (S7 path).
- The Speak pill (`server/speak-replies.ts`) plays on the Mac. `index.server.ts` speaks it there AND filters the
  reply out of the hub, always, even when the phone is active.
- `phoneActive` is `jarvisConnection.isActive(Date.now())`; `phoneAudio` is already kept current in index.server.ts.

## Smallest design
1. `VoiceEvent` reply gains optional `watched: true` ("a session you asked to hear"). In the loop, a watched reply
   from a non-target is spoken as `<short name>: <first paragraph, <=300 chars>` (same `spokenLine`/`shortName`),
   queued in a new `heard` list while talking/confirming/speaking, flushed with the notices as ONE merged line
   (replies first, then the notice line). A watched reply from the target behaves as a normal target reply.
2. New pure `speakRoute({ pill, phoneActive, phoneAudio })` in `server/speak-replies.ts`: "phone" only when the
   session is on the pill AND phoneActive AND phoneAudio; "mac" when on the pill otherwise; "none" off the pill.
3. `index.server.ts` turn-end: "phone" -> publish the reply with `watched: true`, Mac pill NOT called; "mac" ->
   unchanged. So a reply is spoken on exactly one device. No new RPC, no Paseo change, no new setting.
- Fallback: if "phone" is picked but every phone loop is asleep (`jarvis.listening()` false), the loop would drop the reply, so the Mac pill plays it instead (still one device).
- Pill modes (short/medium/full) only apply to the Mac; on the phone every reply is the short line.

## Guess (unverified)
- That a real phone plays the `voice-line` (S7 hand check still pending).
- `phoneActive` is true only while Jarvis was used in the last 10 minutes; a reply in a stale window goes to the Mac.
- Small race: if the phone goes inactive between the turn end and the drawer's poll, the drawer may stay quiet.

## Tests (node:test)
- voice-loop: watched non-target reply speaks `<name>: line`; unwatched non-target still silent; queued while
  talking/confirming; several merge into one line with notices; capped 300 chars, markdown stripped; sleep clears;
  sleep clears the queue. The `finished` notice is dropped for a watched reply, at the source (turn-events), so it is said once.
- speak-replies: `speakRoute` table.
- jarvis-router: event from a watched reply returns the line for the router.
- index.server: pill session, phone active + phoneAudio -> a `voice-line`, Mac plays nothing; phone off -> Mac
  plays, no hub reply; off-pill session unchanged.

Out of scope: "Ask Jarvis for status".
