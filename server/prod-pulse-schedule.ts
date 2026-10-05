import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RpcOutput } from "@getpaseo/plugin";
import type { getProdPulseAutomation } from "../shared/orchestration";
import { runPaseo } from "./orchestration";

type Automation = RpcOutput<typeof getProdPulseAutomation>;
type ScheduleStatus = Automation["schedules"][number];

const PULSE_DIR = process.env.PROD_PULSE_DIR ?? path.join(homedir(), ".prod-pulse");
const RUN_SCRIPT = path.join(PULSE_DIR, "run.sh");
const TIMEZONE = "America/Chicago";
const PROVIDER = "claude/claude-haiku-4-5";

// Same cadence the BB automations used. Names are the match key, so renaming one in Paseo
// makes the plugin treat it as missing and create a fresh one.
const SCHEDULES = [
  { name: "Prod pulse (weekdays)", label: "Weekdays 8:00, 12:00, 16:00", cron: "0 8,12,16 * * 1-5" },
  { name: "Prod pulse (weekends)", label: "Weekends 9:00", cron: "0 9 * * 0,6" },
] as const;

// A Paseo schedule runs an agent, not a script, so a small agent runs the job and reports.
// Successful runs take up to ~11 minutes, past the agent's 10-minute foreground limit.
const PROMPT = `Run the scheduled prod pulse job and report the result. Do nothing else: do not edit files, do not investigate, do not fix anything.

1. With the Bash tool, run this command in the background (run_in_background: true) and wait for it to finish:
   cd ${PULSE_DIR} && perl -e "alarm 1200; exec @ARGV" /bin/bash ${RUN_SCRIPT}; echo "exit=$?"
   (perl alarm kills it after 20 minutes if it hangs.)
2. When it finishes, run: tail -n 1 ${path.join(PULSE_DIR, "state", "runs.json")} | cut -c1-300
3. Reply in one or two lines: the exit code and the outcome/summary of the latest run entry. If exit was 142 say it timed out.`;

// Setting changes and status reads go through one queue so a fast toggle can't create twice.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export function applyProdPulseAutomation(enabled: boolean): Promise<void> {
  return enqueue(async () => {
    if (enabled && !(await jobInstalled())) {
      return;
    }
    const existing = await listPulseSchedules();
    for (const schedule of SCHEDULES) {
      const row = existing.get(schedule.name);
      if (enabled && !row) {
        await runPaseo(
          [
            "schedule",
            "create",
            PROMPT,
            "--name",
            schedule.name,
            "--cron",
            schedule.cron,
            "--timezone",
            TIMEZONE,
            "--provider",
            PROVIDER,
            "--cwd",
            PULSE_DIR,
            "--json",
          ],
          30_000,
        );
      } else if (enabled && row?.status === "paused") {
        await runPaseo(["schedule", "resume", row.id]);
      } else if (!enabled && row?.status === "active") {
        await runPaseo(["schedule", "pause", row.id]);
      }
    }
  });
}

export function loadProdPulseAutomation(): Promise<Automation> {
  return enqueue(async () => {
    const installed = await jobInstalled();
    try {
      const existing = await listPulseSchedules();
      return {
        jobInstalled: installed,
        jobPath: RUN_SCRIPT,
        schedules: SCHEDULES.map((schedule): ScheduleStatus => {
          const row = existing.get(schedule.name);
          return {
            name: schedule.name,
            label: schedule.label,
            cadence: `${schedule.cron} (${TIMEZONE})`,
            status: row?.status ?? "missing",
            nextRunAt: row?.nextRunAt ?? null,
          };
        }),
        error: null,
      };
    } catch (error) {
      return {
        jobInstalled: installed,
        jobPath: RUN_SCRIPT,
        schedules: [],
        error: error instanceof Error ? error.message : "Unable to read Paseo schedules.",
      };
    }
  });
}

async function listPulseSchedules() {
  const parsed: unknown = JSON.parse(await runPaseo(["schedule", "ls", "--json"]));
  const rows = Array.isArray(parsed) ? parsed : [];
  const byName = new Map<
    string,
    { id: string; status: Exclude<ScheduleStatus["status"], "missing">; nextRunAt: string | null }
  >();
  for (const raw of rows) {
    if (raw === null || typeof raw !== "object") {
      continue;
    }
    const row = raw as { id?: unknown; name?: unknown; status?: unknown; nextRunAt?: unknown };
    if (typeof row.id !== "string" || typeof row.name !== "string" || byName.has(row.name)) {
      continue;
    }
    byName.set(row.name, {
      id: row.id,
      status: row.status === "paused" ? "paused" : row.status === "completed" ? "completed" : "active",
      nextRunAt: typeof row.nextRunAt === "string" ? row.nextRunAt : null,
    });
  }
  return byName;
}

async function jobInstalled() {
  try {
    await access(RUN_SCRIPT);
    return true;
  } catch {
    return false;
  }
}
