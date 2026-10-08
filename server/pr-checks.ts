import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pickLines } from "../shared/brief";

// A story PR's merge state and CI, through `gh`, reduced to one state the initiative loop acts on.

const execFileAsync = promisify(execFile);

const GH_BINARIES = [process.env.GH_BIN, "gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"].filter(
  (value): value is string => Boolean(value),
);

// Conclusions that mean the PR broke something. CANCELLED is left out: CI concurrency cancels superseded runs.
const FAILING = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);

export type PrState = "merged" | "closed" | "failing" | "pending" | "green" | "no-checks";
export type FailingCheck = { name: string; url: string; runId: string | null };
export type PrStatus = {
  state: PrState;
  number: number;
  url: string;
  headSha: string;
  failing: FailingCheck[];
};

export async function gh(args: string[], cwd: string, timeout = 30_000) {
  let lastError: unknown;
  for (const binary of GH_BINARIES) {
    try {
      const { stdout } = await execFileAsync(binary, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      lastError = error;
      // gh ran and failed: another binary won't help.
      if ((error as { code?: unknown }).code !== "ENOENT") break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("gh is not available.");
}

type Check = { name: string; done: boolean; outcome: string; url: string; at: string };

function normalize(raw: Record<string, unknown>): Check {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  if (raw.__typename === "StatusContext") {
    const state = text(raw.state).toUpperCase();
    return {
      name: text(raw.context) || "status",
      done: state !== "PENDING" && state !== "EXPECTED",
      outcome: state,
      url: text(raw.targetUrl),
      at: text(raw.startedAt),
    };
  }
  return {
    name: raw.workflowName ? `${text(raw.workflowName)} / ${text(raw.name)}` : text(raw.name),
    done: text(raw.status).toUpperCase() === "COMPLETED",
    outcome: text(raw.conclusion).toUpperCase(),
    url: text(raw.detailsUrl),
    at: text(raw.completedAt) || text(raw.startedAt),
  };
}

// Push and pull_request events both run CI, so a check name can appear twice; keep the newest.
function latest(rollup: unknown[]) {
  const byName = new Map<string, Check>();
  for (const entry of rollup) {
    if (entry === null || typeof entry !== "object") continue;
    const check = normalize(entry as Record<string, unknown>);
    const seen = byName.get(check.name);
    if (!seen || check.at >= seen.at) byName.set(check.name, check);
  }
  return [...byName.values()];
}

export async function prStatus(cwd: string, pr: number | string): Promise<PrStatus | null> {
  try {
    const out = await gh(
      ["pr", "view", String(pr), "--json", "number,url,state,headRefOid,statusCheckRollup"],
      cwd,
    );
    const row = JSON.parse(out) as {
      number: number;
      url: string;
      state: string;
      headRefOid: string;
      statusCheckRollup?: unknown[];
    };
    const base = { number: row.number, url: row.url, headSha: row.headRefOid, failing: [] as FailingCheck[] };
    if (row.state === "MERGED") return { ...base, state: "merged" };
    if (row.state === "CLOSED") return { ...base, state: "closed" };
    const checks = latest(row.statusCheckRollup ?? []);
    if (checks.length === 0) return { ...base, state: "no-checks" };
    const failing = checks
      .filter((check) => check.done && FAILING.has(check.outcome))
      .map((check) => ({ name: check.name, url: check.url, runId: /\/actions\/runs\/(\d+)/.exec(check.url)?.[1] ?? null }));
    if (failing.length > 0) return { ...base, state: "failing", failing };
    return { ...base, state: checks.every((check) => check.done) ? "green" : "pending" };
  } catch {
    return null;
  }
}

// The failed checks with the failures and summary of each failed GitHub Actions log, for the Fix CI prompt.
export async function failureReport(cwd: string, failing: FailingCheck[]) {
  const runs = [...new Set(failing.map((check) => check.runId).filter((id): id is string => Boolean(id)))];
  const logs = await Promise.all(
    runs.slice(0, 3).map(async (runId) => {
      const log = await gh(["run", "view", runId, "--log-failed"], cwd, 60_000).catch(() => "");
      return log ? `### Run ${runId} (failed steps, brief)\n\`\`\`\n${briefCiLog(log)}\n\`\`\`` : "";
    }),
  );
  return [failing.map((check) => `- ${check.name}${check.url ? ` — ${check.url}` : ""}`).join("\n"), ...logs.filter(Boolean)].join(
    "\n\n",
  );
}

// The open PR for a branch, once the Open PR step has pushed it.
export async function prForBranch(cwd: string, branch: string) {
  try {
    const out = await gh(["pr", "view", branch, "--json", "number,url,state"], cwd);
    const row = JSON.parse(out) as { number: number; url: string; state: string };
    return row.state === "OPEN" ? { number: row.number, url: row.url } : null;
  } catch {
    return null;
  }
}

// The lines of a `gh run view --log-failed` log worth showing, without gh's per-line prefix.
export function briefCiLog(log: string) {
  const lines = log.split("\n").map((line) => line.replace(/^[^\t\n]*\t[^\t\n]*\t\uFEFF?\d{4}-\d\d-\d\dT\S+Z ?/, ""));
  return pickLines(lines.join("\n")).join("\n").slice(-4000);
}
