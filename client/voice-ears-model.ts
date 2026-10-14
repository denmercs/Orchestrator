// The gate in front of the wake model: asleep (or paused) it only ever listens for the wake word; awake, an energy
// VAD turns speech into one utterance. Pure: no audio APIs, so client/voice-ears.ts binds it to the real mic.
export const SAMPLE_RATE = 16000;
export const PRE_ROLL_MS = 300;
export const SILENCE_END_MS = 800;
export const MAX_UTTERANCE_MS = 30_000;
export const ENERGY_THRESHOLD = 0.02;

export type EarsEvent = { type: "wake" } | { type: "speechStart" } | { type: "utterance"; pcm: Int16Array };

export type WakeDetector = { pushFrame(frame: Float32Array): Promise<boolean> };

function rms(frame: Float32Array): number {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length);
}

function toPcm16(frames: Float32Array[]): Int16Array {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const frame of frames) for (const sample of frame) out[o++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
  return out;
}

export function createEarsModel(wake: WakeDetector) {
  let awake = false;
  let paused = false;
  let talking = false;
  let preRoll: Float32Array[] = [];
  let captured: Float32Array[] = [];
  let silenceMs = 0;
  let speechMs = 0;

  const reset = () => {
    talking = false;
    captured = [];
    silenceMs = 0;
    speechMs = 0;
  };

  return {
    setAwake(value: boolean) {
      awake = value;
      if (!value) reset();
    },
    setPaused(value: boolean) {
      paused = value;
      if (value) {
        preRoll = [];
        reset();
      }
    },
    async pushFrame(frame: Float32Array): Promise<EarsEvent | null> {
      if (paused) return null;
      if (!awake) return (await wake.pushFrame(frame)) ? { type: "wake" } : null;

      const frameMs = (frame.length / SAMPLE_RATE) * 1000;
      const loud = rms(frame) >= ENERGY_THRESHOLD;

      if (!talking) {
        if (!loud) {
          preRoll.push(frame);
          const maxFrames = Math.ceil(PRE_ROLL_MS / frameMs);
          if (preRoll.length > maxFrames) preRoll = preRoll.slice(-maxFrames);
          return null;
        }
        talking = true;
        captured = [...preRoll, frame];
        preRoll = [];
        silenceMs = 0;
        speechMs = frameMs;
        return { type: "speechStart" };
      }

      captured.push(frame);
      speechMs += frameMs;
      silenceMs = loud ? 0 : silenceMs + frameMs;
      if (silenceMs >= SILENCE_END_MS || speechMs >= MAX_UTTERANCE_MS) {
        const pcm = toPcm16(captured);
        reset();
        return { type: "utterance", pcm };
      }
      return null;
    },
  };
}

// Mono 16-bit PCM WAV, base64-encoded, for the existing transcribe RPC.
export function encodeWav(pcm: Int16Array, sampleRate: number = SAMPLE_RATE): string {
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  let offset = 0;
  const writeString = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset++, s.charCodeAt(i));
  };
  writeString("RIFF");
  view.setUint32(offset, 36 + dataSize, true);
  offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2; // PCM
  view.setUint16(offset, 1, true);
  offset += 2; // mono
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * 2, true);
  offset += 4; // byte rate
  view.setUint16(offset, 2, true);
  offset += 2; // block align
  view.setUint16(offset, 16, true);
  offset += 2; // bits per sample
  writeString("data");
  view.setUint32(offset, dataSize, true);
  offset += 4;
  for (const sample of pcm) {
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
