# speak

Type to a session, hear it talk back in a cloned Chatterbox Turbo voice. Replaces the macOS `say` stopgap and
does not need Paseo voice mode (so the text box stays usable).

```
scripts/speak "hello"          # text as an argument
echo "hello" | scripts/speak   # or on stdin
scripts/speak --status         # warm | loading | off
scripts/speak --warm           # start the worker without speaking, so the first reply isn't a `say` fallback
scripts/speak --hush           # stop talking now: empty the queue, cut the clip, keep the worker loaded
scripts/speak --stop           # unload the worker (frees about 3 GB)
```

- `--warm` does nothing if the worker is already up or the venv or voice clip is missing. `--hush` talks to the
  worker over its socket; with no warm worker it stops the `say` fallback instead (`pkill -x say`).

## Speak replies pill

The Orchestrator plugin's composer pill "Speak" (top-level sessions only) uses these flags. Each press cycles
off → short → full → off. Switching it on runs `--warm`; each completed reply runs `speak` with the reply's first
non-code paragraph in short mode (markdown stripped, 300 characters), or in full mode every paragraph except code
fences and table rows, list markers dropped, 1500 characters (both from `shared/voice-lines.ts` `spokenLine`); the
next prompt on that session runs `--hush`. Switching it
off does not unload the worker, so use `--stop` for that. Canceled or failed turns and code-only replies stay silent.
The set of switched-on sessions lives in the daemon's memory, so a daemon restart turns them all off. Audio plays
on the Mac running the daemon (`afplay`), not on a phone or remote client. Errors at reply time go to
`paseo plugin logs orchestrator`; a missing script rejects the toggle, and Paseo shows the error toast.

- The first call starts a warm worker in the background and speaks that line with `say`. The model takes about
  15-30 s to load; after that calls return in 0.2 s and the first sentence is audible in about 2 s. Text plays
  sentence by sentence; calls queue.
- If the worker, venv or voice clip is missing or fails, `speak` uses `say`, so a reply is never silent.
- Playback runs at 1.1x (`afplay -r 1.1 -q 1`). Set `SPEAK_RATE=1.0` in the worker's environment for the model's own pace.
- Files live outside the repo in `~/.local/share/speak/`: `venv/` (Python 3.11 via uv, `chatterbox-tts`, `setuptools<81`
  for the watermarker), `voice/reference.wav` (10 s trim of the grokbot AI-voice clip; original kept beside it),
  `worker.log`, `speak.sock`.
- `speak_worker.py` is the warm worker. Rebuild the venv with
  `uv venv --python 3.11 ~/.local/share/speak/venv && uv pip install --python ~/.local/share/speak/venv/bin/python chatterbox-tts "setuptools<81"`.
- Jarvis (voice mode) speaks through this worker too when it is warm, so audio plays on the Mac, not the phone. When the
  worker is cold or loading, Jarvis uses Paseo's Kokoro `speak` for that reply and starts the worker for the next one.
- Does not touch `~/.paseo/config.json` or Paseo voice mode, which Jarvis falls back to (Kokoro).
