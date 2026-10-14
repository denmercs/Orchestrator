// The sentence player: pure, no React or Paseo imports. It plays a reply one sentence at a time and fetches the next
// sentence while the current one plays. `render` and `play` are ports, bound in client/voice-speaker.ts.
import { splitSentences } from "../shared/voice-sentences";

export { splitSentences };

export type Rendered = { audio: string; engine: "chatterbox" | "kokoro" | "loading" };
export type SentencePlayerPorts = {
  render(text: string, replyId: string): Promise<Rendered>;
  play(audio: string): Promise<void>;
};
export type SpeakResult = "ended" | "stopped";

export function createSentencePlayer({ render, play }: SentencePlayerPorts) {
  let generation = 0;
  let release: (() => void) | undefined;

  function stop() {
    generation += 1;
    release?.();
  }

  async function speak(text: string, replyId: string): Promise<SpeakResult> {
    stop();
    const mine = generation;
    const stopped = new Promise<"stopped">((resolve) => {
      release = () => resolve("stopped");
    });
    const alive = () => generation === mine;
    const sentences = splitSentences(text);
    const fetches = new Map<number, Promise<Rendered>>();
    const fetchAt = (i: number) => {
      if (i >= sentences.length) return undefined;
      let pending = fetches.get(i);
      if (!pending) {
        pending = render(sentences[i], replyId);
        pending.catch(() => {}); // a dropped answer must not surface as an unhandled rejection
        fetches.set(i, pending);
      }
      return pending;
    };
    fetchAt(0);
    for (let i = 0; i < sentences.length; i++) {
      const answer = await Promise.race([fetchAt(i)!, stopped]);
      if (answer === "stopped" || !alive()) return "stopped";
      fetchAt(i + 1);
      // "loading": the Speaker's workers are still starting, so there is nothing to play. Resolve "ended" with
      // nothing played, so the loop moves on instead of waiting on audio that isn't coming.
      if (answer.engine === "loading") return "ended";
      const played = await Promise.race([play(answer.audio).then(() => "done" as const), stopped]);
      if (played === "stopped" || !alive()) return "stopped";
    }
    return "ended";
  }

  return { speak, stop };
}
