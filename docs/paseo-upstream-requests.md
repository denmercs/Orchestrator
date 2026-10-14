# Paseo upstream requests for voice

Checked against Paseo 0.11.2. A plugin cannot start or stop voice mode, mute or stop Paseo's recorder, or read whether
voice or the mic is on. The only indirect signals are the `agent.session_open` refresh hook (reason `refresh`), the `paseo`
MCP server on a voice-on session, and the `<spoken-input>` wrapper on what it heard. The drawer uses them for a labelled
best guess ("Voice on (best guess)") and nothing more. "Ignore me" drops what Paseo heard on our side; it does not stop
Paseo's recorder.

Asks, so the drawer can control voice for real:

1. `voice.stop()` and `voice.start()` plugin APIs, to turn voice mode off and on for an agent.
2. `voice.setMuted(bool)`, to mute Paseo's recorder without ending voice mode.
3. `voice.getState()` and a subscribe, returning on/off and muted, so the drawer need not guess.
4. A daemon message to stop voice for an agent.
5. An MCP tool such as `stop_listening` on the `paseo` server, so a session can end its own recording.
