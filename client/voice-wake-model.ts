// The openWakeWord frame pipeline: 80 ms audio frames -> melspectrogram -> a sliding window of mel frames ->
// embedding -> a sliding window of embeddings -> hey_jarvis score. Pure: the three ONNX runs are injected so this
// tests without onnxruntime-web; client/voice-ears.ts binds them to the real models. The runs are async since a
// real onnxruntime-web `session.run()` is a Promise.
export const SAMPLES_PER_FRAME = 1280; // 80 ms @ 16 kHz
export const MEL_WINDOW = 76; // mel frames the embedding model consumes
export const EMBEDDING_WINDOW = 16; // embeddings the hey_jarvis classifier consumes
export const WAKE_THRESHOLD = 0.5;
export const WAKE_COOLDOWN_MS = 2000;

export type WakeModelRunners = {
  melspectrogram: (frame: Float32Array) => Promise<Float32Array[]>;
  embedding: (melWindow: Float32Array[]) => Promise<Float32Array>;
  classifier: (embeddingWindow: Float32Array[]) => Promise<number>;
};

export function createWakeModel(runners: WakeModelRunners, now: () => number = Date.now) {
  let melBuffer: Float32Array[] = [];
  let embeddings: Float32Array[] = [];
  let lastWakeAt = -Infinity;

  return {
    // Feeds one 80 ms frame in; resolves true the moment a wake is detected (once per cooldown window).
    async pushFrame(frame: Float32Array): Promise<boolean> {
      melBuffer.push(...(await runners.melspectrogram(frame)));
      if (melBuffer.length > MEL_WINDOW) melBuffer = melBuffer.slice(-MEL_WINDOW);
      if (melBuffer.length < MEL_WINDOW) return false;

      embeddings.push(await runners.embedding(melBuffer));
      if (embeddings.length > EMBEDDING_WINDOW) embeddings = embeddings.slice(-EMBEDDING_WINDOW);
      if (embeddings.length < EMBEDDING_WINDOW) return false;

      const score = await runners.classifier(embeddings);
      if (score < WAKE_THRESHOLD) return false;
      if (now() - lastWakeAt < WAKE_COOLDOWN_MS) return false;
      lastWakeAt = now();
      return true;
    },
  };
}
