// The Voice event hub: the last turn events with a cursor, handed to the Jarvis router (listeners) and the drawer (long poll). The timer is a port so tests never wait.
import type { VoiceEvent } from "../shared/voice-loop";

export const HUB_KEEP = 50;
/** Under the 30 s RPC limit. */
export const READ_WAIT_MS = 20_000;

export type HubPorts = {
  /** Starts a timer and returns its cancel. */
  setTimer: (fn: () => void, ms: number) => () => void;
};

export const realHubPorts = (): HubPorts => ({
  setTimer: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
});

export type HubRead = { cursor: number; events: VoiceEvent[] };

export function createVoiceHub(ports: HubPorts) {
  let cursor = 0;
  let kept: VoiceEvent[] = [];
  const listeners = new Set<(event: VoiceEvent, cursor: number) => void>();
  const waiting = new Set<() => void>();

  const since = (after: number): HubRead => ({ cursor, events: kept.slice(Math.max(0, kept.length - (cursor - after))) });

  return {
    cursor: () => cursor,
    publish(event: VoiceEvent): number {
      cursor += 1;
      kept = [...kept, event].slice(-HUB_KEEP);
      for (const wake of [...waiting]) wake();
      for (const listener of listeners) listener(event, cursor);
      return cursor;
    },
    read(after: number): Promise<HubRead> {
      if (cursor > after) return Promise.resolve(since(after));
      return new Promise((resolve) => {
        const done = () => {
          cancel();
          waiting.delete(done);
          resolve(since(after));
        };
        const cancel = ports.setTimer(done, READ_WAIT_MS);
        waiting.add(done);
      });
    },
    subscribe(listener: (event: VoiceEvent, cursor: number) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
