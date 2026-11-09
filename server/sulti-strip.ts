// The Sulti strip's server logic, kept apart from Paseo so it can be unit-tested.
import { DASHBOARD_ROUTER, type RouteResult } from "./sulti-router";

export type StripEntry = { item?: { type?: string; text?: unknown }; timestamp?: string };

export type LatestReply = { text: string; at: string | null };

// The last assistant message in a page of timeline entries (oldest first), with its timestamp.
// Tool calls and user messages are skipped. Null when the page holds no reply.
export function latestReply(entries: readonly StripEntry[]): LatestReply | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const { item, timestamp } = entries[i];
    if (item?.type === "assistant_message" && typeof item.text === "string") {
      return { text: item.text, at: timestamp ?? null };
    }
  }
  return null;
}

export type StripRead = { sultiId: string | null; reply: string | null; at: string | null; error: string | null };

export type SultiStripPorts = {
  sulti: () => Promise<string>;
  timeline: (sultiId: string) => Promise<readonly StripEntry[]>;
  route: (routerId: string, text: string, signal?: AbortSignal, opts?: { typed?: boolean }) => Promise<RouteResult>;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createSultiStrip(ports: SultiStripPorts) {
  return {
    /** The Sulti session's latest reply. Never throws: a failure comes back as the error text. */
    async read(): Promise<StripRead> {
      let sultiId: string;
      try {
        sultiId = await ports.sulti();
      } catch (error) {
        return { sultiId: null, reply: null, at: null, error: errorText(error) };
      }
      try {
        const reply = latestReply(await ports.timeline(sultiId));
        return { sultiId, reply: reply?.text ?? null, at: reply?.at ?? null, error: null };
      } catch (error) {
        return { sultiId, reply: null, at: null, error: errorText(error) };
      }
    },
    /** Typed text goes through the Sulti router as the dashboard's own router. Blank text is rejected. */
    async send(text: string): Promise<RouteResult> {
      if (!text.trim()) throw new Error("Nothing to send.");
      return ports.route(DASHBOARD_ROUTER, text, undefined, { typed: true });
    },
  };
}
