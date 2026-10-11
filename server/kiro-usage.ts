// Kiro plan usage (see CONTEXT.md, "Kiro usage source"): parses `kiro-cli chat --no-interactive "/usage"`.
// Types only from the SDK, so the plugin still loads on a host without `registerUsageSource`.
import type { UsageBalance, UsageReport, UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const HEADER = /resets on (\d{4})-(\d{2})-(\d{2})\s*\|\s*(.+?)\s*$/m;
const CREDITS = /Credits \(\s*([\d.]+) of ([\d.]+)/;

// Same thresholds as the SDK's `toneFromUsedPct` (a runtime import, so written out here).
const toneFor = (used: number, limit: number): UsageBalance["tone"] => {
  const pct = (used / limit) * 100;
  return pct > 90 ? "danger" : pct >= 70 ? "warning" : "ok";
};

export function parseKiroUsage(stdout: string): UsageReport {
  const text = stdout.replace(ANSI, "");
  const credits = CREDITS.exec(text);
  const used = credits ? Number(credits[1]) : NaN;
  const limit = credits ? Number(credits[2]) : NaN;
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) {
    return { status: "error", error: "Unrecognised kiro-cli /usage output" };
  }
  const header = HEADER.exec(text);
  // Kiro gives no timezone: local midnight of the reset date.
  const resetsAt = header ? new Date(Number(header[1]), Number(header[2]) - 1, Number(header[3])).toISOString() : null;
  return {
    status: "available",
    ...(header ? { planLabel: header[4] } : {}),
    windows: [],
    balances: [{ id: "credits", label: "Credits", used, limit, unit: "credits", resetsAt, tone: toneFor(used, limit) }],
  };
}

export type KiroUsageDeps = {
  findCli: () => Promise<string | null>;
  run: (cli: string) => Promise<string>;
};

const isExecutable = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );

// PATH first, then ~/.local/bin: the daemon's PATH may not include it.
const findKiroCli = async () => {
  const dirs = [...(process.env.PATH ?? "").split(delimiter).filter(Boolean), join(homedir(), ".local", "bin")];
  for (const dir of dirs) {
    const candidate = join(dir, "kiro-cli");
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
};

// 15 s, under the daemon's 20 s deadline; stderr (the progress spinner) is ignored.
const runKiroUsage = async (cli: string) => {
  const { stdout } = await execFileAsync(cli, ["chat", "--no-interactive", "/usage"], {
    cwd: homedir(),
    timeout: 15_000,
  });
  return stdout;
};

const defaultDeps: KiroUsageDeps = { findCli: findKiroCli, run: runKiroUsage };

export function kiroUsageSource(deps: KiroUsageDeps = defaultDeps): UsageSourceRegistration {
  const accounts = async () =>
    (await deps.findCli()) ? [{ key: "default", harness: "Kiro", input: {} }] : [];
  return {
    id: "kiro",
    label: "Kiro",
    input: z.object({}),
    // A session scope only gets the card for a Kiro agent, never a Claude one.
    discover: async (scope) => (scope.kind === "session" && scope.provider !== "kiro" ? [] : accounts()),
    fetch: async () => {
      try {
        const cli = await deps.findCli();
        if (!cli) return { status: "error", error: "kiro-cli not found" };
        return parseKiroUsage(await deps.run(cli));
      } catch (error) {
        return { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
