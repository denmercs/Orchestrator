#!/usr/bin/env python3
"""Warm Chatterbox Turbo worker for `scripts/speak`. Run with the speak venv's python.

Loads the model once, then listens on a unix socket. Each request is one JSON line {"text": "..."}; the
worker answers "ok" as soon as the text is queued. {"cmd": "hush"} empties the queue and stops the clip
that is playing, but keeps the model loaded. Text is split into sentences, so the first sentence
starts playing while the rest is still being synthesized.
"""
import json
import os
import queue
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time

HOME = os.path.expanduser("~/.local/share/speak")
SOCK = os.path.join(HOME, "speak.sock")
REFERENCE = os.path.join(HOME, "voice", "reference.wav")
MAX_CHARS = 220  # long sentences are split at commas/spaces so the first audio stays quick

requests: "queue.Queue[str]" = queue.Queue()
clips: "queue.Queue[tuple[int, str]]" = queue.Queue(maxsize=3)

# `hush` bumps the epoch: anything synthesized or queued under an older epoch is dropped, never played.
epoch = 0
player = None  # the running afplay, so `hush` can cut it off mid-clip
player_lock = threading.Lock()


def hush():
    global epoch
    with player_lock:
        epoch += 1
        if player is not None and player.poll() is None:
            player.kill()
    for q in (requests, clips):
        while True:
            try:
                item = q.get_nowait()
            except queue.Empty:
                break
            if q is clips:
                os.unlink(item[1])


def sentences(text: str):
    for part in re.split(r"(?<=[.!?])\s+|\n+", text.strip()):
        part = part.strip()
        while len(part) > MAX_CHARS:
            cut = max(part.rfind(", ", 0, MAX_CHARS), part.rfind(" ", 0, MAX_CHARS))
            cut = cut if cut > 40 else MAX_CHARS
            yield part[:cut].strip()
            part = part[cut:].lstrip(", ")
        if part:
            yield part


def load_model():
    import torch
    from chatterbox.tts_turbo import ChatterboxTurboTTS

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    try:
        model = ChatterboxTurboTTS.from_pretrained(device=device)
    except Exception:
        device = "cpu"
        model = ChatterboxTurboTTS.from_pretrained(device=device)
    model.prepare_conditionals(REFERENCE)
    return model, device


def synth_loop(model):
    import torchaudio

    while True:
        text = requests.get()
        mine = epoch
        began = time.time()
        for sentence in sentences(text):
            if epoch != mine:
                break
            try:
                wav = model.generate(sentence)
                print(f"synth {time.time() - began:.1f}s: {sentence[:40]!r}", flush=True)
            except Exception as error:  # speak the sentence with `say` rather than dropping it
                print(f"synth failed: {error}", file=sys.stderr, flush=True)
                if epoch == mine:
                    subprocess.run(["say", sentence])
                continue
            if epoch != mine:
                continue
            fd, path = tempfile.mkstemp(suffix=".wav", prefix="speak-")
            os.close(fd)
            torchaudio.save(path, wav, model.sr)
            clips.put((mine, path))


def play_loop():
    global player
    while True:
        clip_epoch, path = clips.get()
        with player_lock:
            if clip_epoch == epoch:
                player = subprocess.Popen(["afplay", path])
        if clip_epoch == epoch and player is not None:
            player.wait()
        os.unlink(path)


def main():
    started = time.time()
    model, device = load_model()
    print(f"speak worker ready on {device} in {time.time() - started:.1f}s", flush=True)
    threading.Thread(target=synth_loop, args=(model,), daemon=True).start()
    threading.Thread(target=play_loop, daemon=True).start()

    if os.path.exists(SOCK):
        os.unlink(SOCK)
    server = socket.socket(socket.AF_UNIX)
    server.bind(SOCK)
    os.chmod(SOCK, 0o600)
    server.listen(8)
    while True:
        conn, _ = server.accept()
        with conn:
            try:
                line = conn.makefile().readline()
                message = json.loads(line)
                if message.get("cmd") == "hush":
                    hush()
                elif message.get("text", "").strip():
                    requests.put(message["text"])
                conn.sendall(b"ok\n")
            except Exception as error:
                conn.sendall(f"error: {error}\n".encode())


if __name__ == "__main__":
    main()
