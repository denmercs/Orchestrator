// Browser-only adapters for the Voice runner: the mic (Recorder port) and the RPC transcriber. No node: imports.
import { transcribeVoice } from "../shared/voice-rpc";

export type VoiceClip = { audio: string; ms: number };

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the recording."));
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export function createVoiceMic() {
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let startedAt = 0;

  return {
    async open() {
      if (stream) return;
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("This app cannot reach a microphone (navigator.mediaDevices is missing).");
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    },
    close() {
      recorder = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    },
    start() {
      if (!stream) throw new Error("The microphone is not open. Turn voice on first.");
      chunks = [];
      const next = new MediaRecorder(stream);
      next.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder = next;
      startedAt = Date.now();
      next.start();
    },
    stop(): Promise<VoiceClip> {
      const active = recorder;
      if (!active) return Promise.reject(new Error("Not recording."));
      recorder = null;
      return new Promise<VoiceClip>((resolve, reject) => {
        active.onstop = () => {
          const ms = Date.now() - startedAt;
          blobToBase64(new Blob(chunks, { type: active.mimeType || "audio/webm" })).then(
            (audio) => resolve({ audio, ms }),
            reject,
          );
        };
        active.onerror = () => reject(new Error("The recording failed."));
        if (active.state === "inactive") active.onstop?.(new Event("stop"));
        else active.stop();
      });
    },
  };
}

/** The transcriber port: audio plus hint words over RPC to the plugin server. */
export function createVoiceTranscriber(rpc: (rpc: typeof transcribeVoice, input: { audio: string; hints: string[] }) => Promise<{ text: string }>) {
  return (audio: string, hints: string[]) => rpc(transcribeVoice, { audio, hints }).then((r) => r.text);
}
