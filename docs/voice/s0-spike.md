# S0 spike: can the Voice drawer work inside a Paseo plugin?

Run on 2026-10-11, M4 Max, Paseo desktop app. The throwaway plugin (`voice-spike`) was never committed and has been removed.
Raw numbers were in `/tmp/voice-s0/results.jsonl`. Every acceptance bullet is below with its answer.

## Results

- **Mic and live level: yes.** `getUserMedia` works from the plugin screen. macOS showed its microphone permission prompt. The level bar moved while talking.
- **Survives navigation: yes (user-reported).** The user kept the mic open, opened other sessions and saw it stay live. The logs do not prove the composer pill updated on another session, so "pill reads state" is the user's word, not a measured result.
- **Record 5 s and play back: yes.** An 80 KB clip, played back in the screen.
- **speechSynthesis voices: 180 voices, 41 English, no Premium, Enhanced or Siri voices.** Only the stock macOS voices show up. The best pick was Samantha, the default. The log does not record whether the test sentence played aloud.
- **Chatterbox Turbo, cloned from the friend's clip, warm worker on the plugin server:** first audio 3.6 s on the first sentence, then about 1.8 s warm (1.8 to 2.6 s across six runs). Load 14 s with models cached, 76 s on the first cold run. The user prefers it to Kokoro.
- **Kokoro v1.0 `am_michael`:** first audio 0.27 s on the first sentence, 0.23 s warm. Load 7 to 10 s.
- **steer, idle session: yes.** A turn started and the agent replied `idle-steer-ok`.
- **steer, busy session: yes, it did not cancel.** With a 60 s foreground python sleep running, the steer left it alone. The agent replied `slept`, then `busy-steer-ok`. Claude Code's Bash refuses a plain `sleep 90`, so the test used `python3 -c "import time; time.sleep(60)"`.
- **whisper.cpp:** `brew install whisper-cpp`, model `ggml-base.en.bin` (148 MB) in `~/.orchestrator/voice/models/`, `ffmpeg` to 16 kHz wav, `whisper-cli --prompt "merge Orchestrator Paseo"`. `base.en` took 0.4 to 3.3 s per clip through the plugin. On the recorded mic clip, `base.en` wrote "orchestra" for "orchestrator" from both the plugin and a terminal (0.47 s); `small.en` got "orchestrator" in 0.57 s from a terminal. On a `say` clip of the test sentence, `base.en` got "orchestrator" right. The vocabulary prompt helps but does not guarantee the word; the model size matters more.
- **openWakeWord "hey jarvis": yes.** The three models (melspectrogram, embedding, hey_jarvis) load in onnxruntime-web in 1.9 to 3.1 s. onnxruntime-web came from jsDelivr; the model files came through a server RPC (see lesson 4).

## Decisions

- **d2 confirmed:** local whisper.cpp on the plugin server is fast enough. Use `small.en`: it fixed the "orchestrator" mishear at about the same speed.
- **d3 confirmed:** the wake models load in the client in about 2 s.
- **d4 confirmed:** Chatterbox Turbo is the voice (the user prefers it); Kokoro `am_michael` stays as the fast fallback.
- **d6 confirmed on the user's report:** the mic stayed live across navigation. S2 should add a measured check of the Voice pill.
- **steer confirmed:** idle starts a turn, busy does not cancel.

## Lessons for S2, S4 and S5

1. Plugin RPCs time out at 30 s. The TTS workers must warm up when the plugin starts, and a speak call should answer "still loading" (the spike used 20 s) instead of hanging. The real Speaker must load at Paseo launch, which fits d7 (Jarvis on at launch).
2. Chatterbox needs `--with "setuptools<81"`: perth's watermarker breaks without `pkg_resources`.
3. A stuck Hugging Face download left 0-byte `.incomplete` files. The fix was reseeding from a warm cache. Plan for a cold-start path and a retry.
4. The client cannot fetch GitHub release assets (no CORS). The wake models came through a server RPC instead.
5. Plugin RPC method names must be lowercase or kebab-case. `voice-spike.wakeModel` made the plugin fail to load.
6. The Paseo daemon restarted once mid-test and killed the workers, so the Speaker needs to respawn them.
7. Paths that cost time: modules must live in `client/`, `server/` or `shared/`; both entry points must return a cleanup function; `uv` was found on the daemon's PATH (the run did not record whether `ffmpeg` and `whisper-cli` were); the CLI is `paseo plugin remove`, not `uninstall`.
