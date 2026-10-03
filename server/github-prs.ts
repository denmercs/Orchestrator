import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RpcOutput } from "@getpaseo/plugin";
import { listOrchestrationMergedPrs } from "../shared/orchestration";
import { formatDate, splitTicket } from "./standup-note";

const execFileAsync = promisify(execFile);

const GH_BINARIES = [
  process.env.GH_BIN,
  "gh",
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
].filter((value): value is string => Boolean(value));

export type MergedPr = RpcOutput<typeof listOrchestrationMergedPrs>["prs"][number];

export async function listMergedPrs(
  now = new Date(),
): Promise<RpcOutput<typeof listOrchestrationMergedPrs>> {
  const date = formatDate(now);
  try {
    const raw = await searchMergedPrs(now);
    const prs = raw
      .map((row) => toMergedPr(row, now))
      .filter((pr): pr is MergedPr => pr !== null)
      .sort((left, right) => right.mergedAt.localeCompare(left.mergedAt));
    return { date, prs, error: null };
  } catch (error) {
    return {
      date,
      prs: [],
      error: error instanceof Error ? error.message : "Unable to list merged pull requests.",
    };
  }
}

async function searchMergedPrs(now: Date): Promise<unknown[]> {
  const since = formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  let lastError: unknown;
  for (const binary of GH_BINARIES) {
    try {
      const { stdout } = await execFileAsync(
        binary,
        [
          "search",
          "prs",
          "--author",
          "@me",
          "--merged",
          "--merged-at",
          `>=${since}`,
          "--limit",
          "50",
          "--json",
          "title,url,number,repository,closedAt",
        ],
        { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const parsed: unknown = JSON.parse(stdout);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : "gh is not available.";
  throw new Error(message);
}

function toMergedPr(raw: unknown, now: Date): MergedPr | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const row = raw as {
    title?: unknown;
    url?: unknown;
    number?: unknown;
    closedAt?: unknown;
    repository?: unknown;
  };
  if (typeof row.title !== "string" || typeof row.url !== "string" || typeof row.number !== "number") {
    return null;
  }
  if (typeof row.closedAt !== "string" || formatDate(new Date(row.closedAt)) !== formatDate(now)) {
    return null;
  }
  const { key, title } = splitTicket(row.title);
  return {
    number: String(row.number),
    title,
    key,
    url: row.url,
    repo: repositoryName(row.repository),
    mergedAt: row.closedAt,
  };
}

function repositoryName(raw: unknown): string {
  if (raw !== null && typeof raw === "object") {
    const row = raw as { nameWithOwner?: unknown; name?: unknown };
    if (typeof row.nameWithOwner === "string" && row.nameWithOwner.length > 0) {
      return row.nameWithOwner;
    }
    if (typeof row.name === "string") {
      return row.name;
    }
  }
  return "";
}
