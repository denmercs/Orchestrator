import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factoryDir, sliceDir, writeSliceState } from "./factory-layout";
import { type ManagerPaseo, steerManager } from "./factory-manager";
import { slugOf } from "./harness-layout";

export type FilePorts = { paseo: ManagerPaseo };
export type SliceRequest = { title: string; link?: string; story?: string };

const INBOX = "inbox";
const INBOX_OUTCOME = "Work filed from the start paths, waiting for the manager to order and run it.";

// A slice id from the title, with -2, -3... when the inbox already has one of that name.
function freeId(root: string, title: string) {
  const base = slugOf(title) || "slice";
  let id = base;
  for (let n = 2; existsSync(sliceDir(root, INBOX, id)); n++) id = `${base}-${n}`;
  return id;
}

// Writes the slice under mission `inbox` (run off, so the manager decides when it starts); returns its id.
export function writeSlice(root: string, { title, link, story }: SliceRequest) {
  const mission = join(factoryDir(root), "missions", INBOX);
  mkdirSync(join(mission, "slices"), { recursive: true });
  const outcome = join(mission, "mission.md");
  if (!existsSync(outcome)) writeFileSync(outcome, `${INBOX_OUTCOME}\n`, "utf8");
  const id = freeId(root, title);
  const dir = sliceDir(root, INBOX, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.md"), `${[title, link].filter(Boolean).join("\n\n")}\n`, "utf8");
  writeFileSync(join(dir, "state.md"), "---\n---\n", "utf8");
  if (story) writeSliceState(root, INBOX, id, { story });
  return id;
}

// Files one slice for the manager and steers it once.
export async function fileSlice(root: string, request: SliceRequest, ports: FilePorts) {
  const id = writeSlice(root, request);
  await steerManager(root, `Filed 1 slice in inbox: ${id}`, ports.paseo);
  return [id];
}
