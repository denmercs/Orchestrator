import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Factory, type FactorySlice, heldBy, mergeWatch, runnableSlices } from "../shared/factory";
import { factoryDir, readFactory } from "./factory-layout";

const line = (slice: FactorySlice, why = "") => `- ${slice.mission}/${slice.id}: phase ${slice.state.phase}${why ? `, ${why}` : ""}`;
const section = (title: string, lines: string[]) => [`## ${title}`, ...(lines.length ? lines : ["(none)"]), ""];

// The factory in a few lines for someone who only wants to know what runs, what is stuck and what waits on them: the project
// intent, then Running, Blocked and Needs you. It uses no model, no Paseo and no clock, so the same files give the same bytes.
export function renderDigest(factory: Factory): string {
  // A closed or archived slice is finished: it neither runs nor waits on anyone.
  const slices = factory.missions.flatMap((mission) => mission.slices.map((slice) => ({ slice, mission }))).filter(({ slice }) => !slice.state.close && !slice.state.archived);
  const blocked: string[] = [];
  const blockedSlices = new Set<FactorySlice>();
  for (const { slice, mission } of slices) {
    const cause = slice.state.ready === "blocked" ? "blocked" : heldBy(slice, mission);
    if (!cause) continue;
    blocked.push(line(slice, cause));
    blockedSlices.add(slice);
  }
  const waiting = new Set(mergeWatch(factory));
  const needsWhy = (slice: FactorySlice) => {
    if (slice.state.ready === "review") return "review is clean";
    if (waiting.has(slice)) return `PR ${slice.state.pr} waits on your merge`;
    if (slice.state.steered === "plan") return "plan awaits your approval";
    return "";
  };
  const live = new Set(slices.map(({ slice }) => slice));
  const running = runnableSlices(factory)
    .filter((slice) => live.has(slice) && !blockedSlices.has(slice) && !needsWhy(slice))
    .map((slice) => line(slice));
  const needs = slices.flatMap(({ slice }) => (needsWhy(slice) ? [line(slice, needsWhy(slice))] : []));
  return [`Project: ${factory.project}`, "", ...section("Running", running), ...section("Blocked", blocked), ...section("Needs you", needs)].join("\n");
}

// Writes `.harness/factory/digest.md` from the factory's files, only when the content changed. A repo with no factory gets no file.
export function writeDigest(root: string): void {
  const factory = readFactory(root);
  if (!factory.project && factory.missions.length === 0) return;
  const file = join(factoryDir(root), "digest.md");
  const text = renderDigest(factory);
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  writeFileSync(file, text);
}
