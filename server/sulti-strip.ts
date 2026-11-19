// The Sulti strip's server logic, kept apart from Paseo so it can be unit-tested.
import { SYSTEM_TAG } from "./factory-manager";
import { DASHBOARD_ROUTER, type RouteResult } from "./sulti-router";

export type StripEntry = { item?: { type?: string; text?: unknown }; timestamp?: string };

export type LatestReply = { text: string; at: string | null };

// The last line the sidebar should surface: newest assistant reply or factory `[system]` steer.
// Other user messages and tool calls are skipped. Null when none.
function stripLine(item: StripEntry["item"]): string | null {
  if (typeof item?.text !== "string") return null;
  if (item.type === "assistant_message") return item.text;
  if (item.type === "user_message" && item.text.startsWith(SYSTEM_TAG)) return item.text;
  return null;
}

export function latestReply(entries: readonly StripEntry[]): LatestReply | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const text = stripLine(entries[i].item);
    if (text) return { text, at: entries[i].timestamp ?? null };
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
