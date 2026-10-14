// Splits a reply into speakable sentences. Shared because both the client sentence player and the server's Mac playback
// (server/voice-local.ts) use it, and the server bundle may not import from client/.
import { MAX_SPEAK_CHARS } from "./voice-rpc";

// Sentences, each at most MAX_SPEAK_CHARS so it fits the speak RPC. A sentence with no break inside the cap is cut at
// the last space before it (or at the cap when there is none).
export function splitSentences(text: string): string[] {
  const pieces: string[] = [];
  for (const sentence of text.match(/[^.!?\n]+(?:[.!?]+["')\]]*|$)|\n/g) ?? []) {
    let rest = sentence.trim();
    while (rest.length > MAX_SPEAK_CHARS) {
      const space = rest.lastIndexOf(" ", MAX_SPEAK_CHARS);
      const cut = space > 0 ? space : MAX_SPEAK_CHARS;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
  }
  return pieces;
}
