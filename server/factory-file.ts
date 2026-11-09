import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factoryDir, namedStories, sliceDir, storyKey, writeSliceState } from "./factory-layout";
import { type ManagerPaseo, steerManager } from "./factory-manager";
import { readStoryFiles, slugOf } from "./harness-layout";
import { activePhase, initiativeAt } from "./initiative-loop";

export type FilePorts = { paseo: ManagerPaseo };
export type SliceRequest = { title: string; link?: string; story?: string };

const INBOX = "inbox";
const INBOX_OUTCOME = "Work filed from the start paths, waiting for the manager to order and run it.";

// A slice id from the title, with -2, -3... when the inbox already has one of that name.
function freeId(root: string, title: string, name = title) {
  const base = slugOf(name) || "slice";
  let id = base;
  for (let n = 2; existsSync(sliceDir(root, INBOX, id)); n++) id = `${base}-${n}`;
  return id;
}

// Writes the slice under mission `inbox` (run off, so the manager decides when it starts); returns its id.
export function writeSlice(root: string, { title, link, story }: SliceRequest, name = title) {
  const mission = join(factoryDir(root), "missions", INBOX);
  mkdirSync(join(mission, "slices"), { recursive: true });
  const outcome = join(mission, "mission.md");
  if (!existsSync(outcome)) writeFileSync(outcome, `${INBOX_OUTCOME}\n`, "utf8");
  const id = freeId(root, title, name);
  const dir = sliceDir(root, INBOX, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.md"), `${[title, link].filter(Boolean).join("\n\n")}\n`, "utf8");
  writeFileSync(join(dir, "state.md"), "---\n---\n", "utf8");
  if (story) writeSliceState(root, INBOX, id, { story });
  return id;
}

export type Filed = { ids: string[]; warning: string | null };

// The slices are already on disk when the steer goes out, so a steer that fails is a warning, not a failure.
async function steer(root: string, line: string, ports: FilePorts) {
  try {
    return (await steerManager(root, line, ports.paseo)) ? null : "No factory manager could be reached.";
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

// Files one slice for the manager and steers it once.
export async function fileSlice(root: string, request: SliceRequest, ports: FilePorts): Promise<Filed> {
  const id = writeSlice(root, request);
  return { ids: [id], warning: await steer(root, `Filed 1 slice in inbox: ${id}`, ports) };
}

// Files a slice for every not-yet-started story in the initiative's active phase, in story order, and steers once.
export async function fileInitiative(
  root: string,
  input: { repo: string; initiative: string },
  ports: FilePorts,
): Promise<Filed> {
  const init = initiativeAt(input.repo, input.initiative);
  const { phaseDir } = activePhase(init);
  if (!phaseDir) return { ids: [], warning: null };
  const named = namedStories(root);
  const ids: string[] = [];
  for (const story of readStoryFiles(phaseDir)) {
    const { status = "", step = "", title = "", jira_url: link = "" } = story.meta;
    if ((status && status !== "todo") || step || named.has(storyKey(story.path))) continue;
    ids.push(writeSlice(root, { title: title || story.id, link: link || undefined, story: story.path }, `${init.slug}-${story.id}`));
  }
  const warning = ids.length ? await steer(root, `Filed ${ids.length} slices in inbox: ${ids.join(", ")}`, ports) : null;
  return { ids, warning };
}
