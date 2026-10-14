// Browser glue for the hands-free mic: getUserMedia (echo cancellation on) -> a 16 kHz AudioContext -> an
// AudioWorklet chunking raw audio into 80 ms frames -> the pure wake and ears models. onnxruntime-web loads from
// jsDelivr, pinned to one version (the S0 spike's path); the three openWakeWord models come from the plugin server,
// since the client cannot fetch GitHub release assets directly (S0 lesson 4). No unit tests here, like
// voice-mic.ts's recorder half: it is all browser APIs.
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { NO_MIC_MESSAGE } from "../shared/voice-lines";
import { voiceWakeModel } from "../shared/voice-rpc";
import { hasMicApi } from "./voice-mic-model";
import { createEarsModel, SAMPLE_RATE, type EarsEvent } from "./voice-ears-model";
import { createWakeModel, SAMPLES_PER_FRAME, type WakeModelRunners } from "./voice-wake-model";

const ORT_VERSION = "1.19.2";
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
const MEL_BINS = 32;
const EMBEDDING_SIZE = 96;

// The minimal surface of onnxruntime-web this file needs. The real module attaches `ort` to `window` once the
// jsDelivr script tag loads; there is no npm dependency to type against.
type OrtSession = {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>;
  inputNames: string[];
  outputNames: string[];
};
type OrtModule = {
  env: { wasm: { wasmPaths: string } };
  InferenceSession: { create(buffer: ArrayBuffer): Promise<OrtSession> };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
};

let ortPromise: Promise<OrtModule> | null = null;

function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = new Promise<OrtModule>((resolve, reject) => {
      const existing = (window as unknown as { ort?: OrtModule }).ort;
      if (existing) {
        existing.env.wasm.wasmPaths = ORT_BASE;
        resolve(existing);
        return;
      }
      const script = document.createElement("script");
      script.src = `${ORT_BASE}ort.min.js`;
      script.onload = () => {
        const ort = (window as unknown as { ort?: OrtModule }).ort;
        if (!ort) {
          reject(new Error("onnxruntime-web did not attach to window."));
          return;
        }
        ort.env.wasm.wasmPaths = ORT_BASE;
        resolve(ort);
      };
      script.onerror = () => reject(new Error("Could not load onnxruntime-web from jsDelivr."));
      document.head.appendChild(script);
    });
  }
  return ortPromise;
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function loadSession(ort: OrtModule, rpc: PluginClientContext["rpc"], model: "melspectrogram" | "embedding" | "hey_jarvis"): Promise<OrtSession> {
  const { bytes } = await rpc(voiceWakeModel, { model });
  return ort.InferenceSession.create(base64ToBuffer(bytes));
}

async function runSession(ort: OrtModule, session: OrtSession, data: Float32Array, dims: number[]): Promise<Float32Array> {
  const tensor = new ort.Tensor("float32", data, dims);
  const out = await session.run({ [session.inputNames[0]!]: tensor });
  return out[session.outputNames[0]!]!.data;
}

function toRunners(ort: OrtModule, sessions: { mel: OrtSession; embedding: OrtSession; classifier: OrtSession }): WakeModelRunners {
  return {
    async melspectrogram(frame) {
      // openWakeWord's melspectrogram model expects raw int16-range samples, not Web Audio's -1..1 floats.
      const scaled = new Float32Array(frame.length);
      for (let i = 0; i < frame.length; i++) scaled[i] = frame[i]! * 32768;
      const data = await runSession(ort, sessions.mel, scaled, [1, scaled.length]);
      const frames: Float32Array[] = [];
      for (let i = 0; i < data.length; i += MEL_BINS) frames.push(data.slice(i, i + MEL_BINS));
      return frames;
    },
    async embedding(melWindow) {
      const flat = new Float32Array(melWindow.length * MEL_BINS);
      melWindow.forEach((frame, i) => flat.set(frame, i * MEL_BINS));
      return runSession(ort, sessions.embedding, flat, [1, melWindow.length, MEL_BINS, 1]);
    },
    async classifier(embeddingWindow) {
      const flat = new Float32Array(embeddingWindow.length * EMBEDDING_SIZE);
      embeddingWindow.forEach((frame, i) => flat.set(frame, i * EMBEDDING_SIZE));
      const data = await runSession(ort, sessions.classifier, flat, [1, embeddingWindow.length, EMBEDDING_SIZE]);
      return data[0] ?? 0;
    },
  };
}

// Turns the mic's native-rate audio into SAMPLES_PER_FRAME (80 ms @ 16 kHz) chunks on the audio thread.
const WORKLET_SOURCE = `
class VoiceFramesProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      const merged = new Float32Array(this.buffer.length + input.length);
      merged.set(this.buffer);
      merged.set(input, this.buffer.length);
      this.buffer = merged;
      const frameSize = ${SAMPLES_PER_FRAME};
      while (this.buffer.length >= frameSize) {
        this.port.postMessage(this.buffer.slice(0, frameSize));
        this.buffer = this.buffer.slice(frameSize);
      }
    }
    return true;
  }
}
registerProcessor("voice-frames", VoiceFramesProcessor);
`;

export function createVoiceEars(rpc: PluginClientContext["rpc"]) {
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let wakeModel: ReturnType<typeof createWakeModel> | null = null;
  let earsModel: ReturnType<typeof createEarsModel> | null = null;
  let handler: ((event: EarsEvent) => void) | null = null;

  async function ensureModels() {
    if (earsModel) return;
    const ort = await loadOrt();
    const [mel, embedding, classifier] = await Promise.all([
      loadSession(ort, rpc, "melspectrogram"),
      loadSession(ort, rpc, "embedding"),
      loadSession(ort, rpc, "hey_jarvis"),
    ]);
    wakeModel = createWakeModel(toRunners(ort, { mel, embedding, classifier }));
    earsModel = createEarsModel({ pushFrame: (frame) => wakeModel!.pushFrame(frame) });
  }

  return {
    async open() {
      if (stream?.active) return;
      if (!hasMicApi(globalThis.navigator)) throw new Error(NO_MIC_MESSAGE);
      await ensureModels();
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
      audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await audioContext.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      workletNode = new AudioWorkletNode(audioContext, "voice-frames");
      workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        void earsModel?.pushFrame(event.data).then((result) => result && handler?.(result));
      };
      audioContext.createMediaStreamSource(stream).connect(workletNode);
    },
    async close() {
      workletNode?.disconnect();
      workletNode = null;
      await audioContext?.close();
      audioContext = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    },
    setAwake(value: boolean) {
      earsModel?.setAwake(value);
    },
    setPaused(value: boolean) {
      earsModel?.setPaused(value);
    },
    onEvent(fn: (event: EarsEvent) => void) {
      handler = fn;
    },
  };
}
