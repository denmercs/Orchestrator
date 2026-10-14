// "Jarvis, status": one short spoken summary of the sessions, from their live state. Pure: the agents are listed
// elsewhere (the server) and handed in, so the drawer (Mac) and Jarvis (phone) say the same words.
import { NOTHING_RUNNING, statusErrorLine, statusIdleLine, statusCapped, statusNeedsYouLine, statusRunningLine } from "./voice-lines";
import { canTarget, sessionName, withoutName } from "./voice-loop";
import { shortName } from "./voice-names";

const ASK = /^(?:status|give me (?:a |the )?status|status report|what are the agents doing|what s going on|what is going on|what s happening|what is happening)(?: please)?$/;

const norm = (text: string): string =>
  withoutName(text).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

/** "Status" or "what are the agents doing" (optionally after the name) asks for the summary. */
export const isStatusAsk = (text: string): boolean => {
  const said = norm(text);
  // The whole phrase only: "status check the logs" or "the status of the build is red, fix it" is for the session.
  return ASK.test(said);
};

/** What the summary reads of a live agent; a subset of what `agents.list` returns. */
export type StatusAgent = {
  id: string;
  title?: string | null;
  status: string;
  attentionReason?: string | null;
  pendingPermissions?: unknown[] | null;
  archivedAt?: string | null;
  provider?: string;
  labels?: Record<string, string> | null;
};

const needsYou = (agent: StatusAgent): boolean => (agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission";
const hitError = (agent: StatusAgent): boolean => agent.status === "error" || agent.attentionReason === "error";
const working = (agent: StatusAgent): boolean => agent.status === "running" || agent.status === "initializing";

/** One short line: what needs you (permission, error), then what is running, then a count of the idle. Voice's own sessions and closed or archived ones are left out. */
export function statusLine(agents: StatusAgent[]): string {
  const live = agents.filter((agent) => agent.status !== "closed" && !agent.archivedAt && canTarget(agent));
  const names = (list: StatusAgent[]) => list.map((agent) => shortName(sessionName(agent)));
  const waiting = live.filter(needsYou);
  const failed = live.filter((agent) => !needsYou(agent) && hitError(agent));
  const running = live.filter((agent) => !needsYou(agent) && !hitError(agent) && working(agent));
  const idle = live.length - waiting.length - failed.length - running.length;
  const parts = [
    ...(waiting.length ? [statusNeedsYouLine(names(waiting))] : []),
    ...(failed.length ? [statusErrorLine(names(failed))] : []),
    ...(running.length ? [statusRunningLine(names(running))] : []),
  ];
  if (!waiting.length && !failed.length && !running.length) parts.push(NOTHING_RUNNING);
  if (idle) parts.push(statusIdleLine(idle));
  return statusCapped(parts.join(" "));
}
