import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RpcOutput } from "@getpaseo/plugin";
import { listOrchestrationSchedules } from "../shared/orchestration";

const execFileAsync = promisify(execFile);

const PASEO_BINARIES = [
  process.env.PASEO_BIN,
  "paseo",
  "/opt/homebrew/bin/paseo",
  "/usr/local/bin/paseo",
  "/Applications/Paseo.app/Contents/Resources/bin/paseo",
].filter((value): value is string => Boolean(value));

type ScheduleRow = RpcOutput<typeof listOrchestrationSchedules>["schedules"][number];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function cadenceLabel(cadence: unknown): string {
  const row = asRecord(cadence);
  if (!row) {
    return asString(cadence) ?? "—";
  }

  if (row.type === "cron") {
    const expression = asString(row.expression) ?? "";
    const timezone = asString(row.timezone);
    return timezone ? `${expression} (${timezone})` : expression || "—";
  }

  if (row.type === "every" && typeof row.everyMs === "number") {
    const minutes = Math.max(1, Math.round(row.everyMs / 60_000));
    return `every ${minutes}m`;
  }

  return asString(row.expression) ?? asString(row.cron) ?? "—";
}

function scheduleStatus(value: unknown): ScheduleRow["status"] {
  if (value === "paused" || value === "completed" || value === "active") {
    return value;
  }
  return "active";
}

function normalizeSchedule(raw: unknown): ScheduleRow | null {
  const row = asRecord(raw);
  const id = asString(row?.id);
  if (!row || !id) {
    return null;
  }

  return {
    id,
    name: asString(row.name),
    status: scheduleStatus(row.status),
    cadence: cadenceLabel(row.cadence ?? row.cron),
    nextRunAt: asString(row.nextRunAt) ?? asString(row.nextRun),
    lastRunAt: asString(row.lastRunAt) ?? asString(row.lastRun),
  };
}

async function readScheduleJson(binary: string): Promise<string> {
  const { stdout } = await execFileAsync(binary, ["schedule", "ls", "--json"], {
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout;
}

export async function listSchedules(): Promise<RpcOutput<typeof listOrchestrationSchedules>> {
  let lastError: unknown;

  for (const binary of PASEO_BINARIES) {
    try {
      const parsed: unknown = JSON.parse(await readScheduleJson(binary));
      const rows = Array.isArray(parsed)
        ? parsed
        : (asRecord(parsed)?.schedules ?? []);
      return {
        schedules: (Array.isArray(rows) ? rows : [])
          .map(normalizeSchedule)
          .filter((row): row is ScheduleRow => row !== null),
      };
    } catch (error) {
      lastError = error;
    }
  }

  const message = lastError instanceof Error ? lastError.message : "Unable to list schedules";
  throw new Error(message);
}
