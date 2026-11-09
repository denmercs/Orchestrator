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

## Voice helper on Cursor

Checked live against Paseo 0.11.2: a `cursor/composer-2.5` agent in Ask mode refused a file write (nothing written, no permission request) but still ran read-only tools, a glob search and a shell `ls`. Cursor has no equivalent of Claude's `--tools ""`, so `voice.provider: "cursor"` is accepted but not supported yet, and the voice helper is only tool-free on Claude.

Follow-ups:

1. Re-probe through the SDK (`paseo.agents.create` with the real `VOICE_HELPER_SYSTEM_PROMPT` and `cwd`); the Paseo MCP `create_agent` takes no system prompt, options or cwd, so the first probe could not.
2. Ask for a way to start a Cursor agent with no tools (a tool allow-list, or a mode that blocks reads and shell).
3. Time Composer 2.5 against the 8 s `INTERPRET_TIMEOUT_MS` and the summariser's 3 s `SUMMARY_FALLBACK_MS` once that holds, and time Sonnet 5.5 on both.

## Embedding Paseo's chat

Checked against `@getpaseo/plugin` 0.11.1 (`dist/client/contracts.d.ts`): the client API has `navigation.openAgent`, `openWorkspace` and `openBrowser`, screens, panels, composer pills and timeline transformers, but no component or surface that renders an agent's live chat inside a plugin view. So the dashboard's Sulti strip shows the latest reply, sends typed text through the Sulti router, and links out with "Open in Paseo chat".

Asks, so the strip could host the chat itself:

1. A `PluginAgentChat` client component that renders an agent's live chat (timeline plus composer) for a given `agentId`.
2. Or an agent-chat panel that a screen can host, with the same props.
