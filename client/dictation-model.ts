// Dictation mode, as logic: the Voice drawer's text box sends what is new once the text stops changing for a pause.
// Kept free of React so it can be tested with a fake clock; the drawer only feeds it the box and clears it when told.
import type { VoiceRunnerPorts } from "./voice-runner";

/** How long the box must stay unchanged before auto-send sends it. */
export const DICTATION_PAUSE_MS = 1_500;

type Clock = NonNullable<VoiceRunnerPorts["clock"]>;

const realClock: Clock = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/**
 * What the box holds that was not sent yet. Some keyboards keep dictating into their own buffer after the box is
 * cleared and put the last send back in front of the new words; that copy is dropped.
 */
export function unsent(box: string, lastSent: string): string {
  const repeated = lastSent !== "" && box.length > lastSent.length && box.startsWith(lastSent);
  return (repeated ? box.slice(lastSent.length) : box).trim();
}

export type DictationOptions = {
  /** Hands the text on; false means it was not taken, so the box keeps it. */
  send(text: string): boolean;
  /** Empties the box (the drawer's state); focus is left alone so dictation can carry on. */
  clear(): void;
  clock?: Clock;
  pauseMs?: number;
};

export function createDictation(opts: DictationOptions) {
  const clock = opts.clock ?? realClock;
  const pauseMs = opts.pauseMs ?? DICTATION_PAUSE_MS;
  let box = "";
  let lastSent = "";
  let auto = true;
  let timer: unknown = null;

  const stopTimer = () => {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  };
  // Every change restarts the wait, so text edited mid-pause is sent only once it settles.
  const restart = () => {
    stopTimer();
    if (auto && unsent(box, lastSent))
      timer = clock.setTimeout(() => {
        timer = null;
        send();
      }, pauseMs);
  };

  /** Sends what is new now (the Send button, or the pause). Nothing new, or a refused send, keeps the box. */
  function send(): boolean {
    stopTimer();
    const text = unsent(box, lastSent);
    if (!text || !opts.send(text)) return false;
    lastSent = box;
    box = "";
    opts.clear();
    return true;
  }

  return {
    send,
    change(text: string) {
      box = text;
      // Once the box is neither the last send nor still growing into it, the keyboard started afresh.
      if (!text.startsWith(lastSent) && !lastSent.startsWith(text)) lastSent = "";
      restart();
    },
    setAuto(on: boolean) {
      auto = on;
      restart();
    },
    dispose: stopTimer,
  };
}
