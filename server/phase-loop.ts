import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { BELT_LABEL, STORY_FILE_LABEL, type BeltConfig } from "../shared/belt";
import { startStory } from "./belt-advance";
import type { MergedPr } from "./github-prs";
import {
  PHASE_FILE,
  epicDirFor,
  frontmatter,
  initiativeTracker,
  initiativesDir,
  slugOf,
  storyFiles,
  writeFrontmatter,
} from "./harness-layout";

// Runs a planned phase's stories through the Story belt, in parallel: Start turns the phase's
// loop on and starts every ready story (todo, not blocked, dependencies merged), each in its own
// worktree. When a story's PR merges, its file is marked merged and whatever became ready starts.
// Stop turns the loop off; stories already running finish. The flag is `loop: on` in phase.md.

type PaseoApi = PluginHandlerContext["paseo"];
type ReadConfig = () => Promise<BeltConfig | null>;

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const list = (value: string | undefined) => (value ? value.split(",").map((part) => part.trim()).filter(Boolean) : []);

// Story files being started by this process, so overlapping triggers can't start one twice.
const starting = new Set<string>();

// <root>/.harness/initiatives/<slug>/phases/<n-name>: the initiative folder is two levels up.
const initiativeOf = (epicDir: string) => dirname(dirname(epicDir));

const phaseMeta = (epicDir: string) => {
  const file = join(epicDir, PHASE_FILE);
  return frontmatter(existsSync(file) ? readFileSync(file, "utf8") : "");
};

export const loopOn = (epicDir: string) => phaseMeta(epicDir).loop === "on";

// A key a PR title can start with: the story's Jira key, else one derived from the initiative
// (initials), phase and story number, e.g. ASE1-2. Saved to the story file on first start.
function keyFor(epicDir: string, meta: Record<string, string>, index: number) {
  if (JIRA_KEY.test(meta.jira ?? "")) return meta.jira;
  if (JIRA_KEY.test(meta.key ?? "")) return meta.key;
  const slug = initiativeOf(epicDir).split(sep).pop() ?? "";
  const code = (slug.split("-").map((word) => word[0] ?? "").join("").toUpperCase() || "IN").slice(0, 4);
  const phase = phaseMeta(epicDir).phase || "1";
  const number = /(\d+)$/.exec(meta.id ?? "")?.[1] ?? String(index + 1);
  return `${/^[A-Z]/.test(code) ? code : `I${code}`}${phase}-${number}`;
}

async function projectFor(paseo: PaseoApi, root: string) {
  const { projects } = await paseo.projects.list();
  const project = projects.find((item) => item.projectRootPath && resolve(item.projectRootPath) === root);
  if (!project) throw new Error(`${root} is not a Paseo project. Add it in Paseo first.`);
  return project;
}

// Starts every ready story in the phase. Returns the keys started and any per-story errors.
async function startReady(paseo: PaseoApi, config: BeltConfig, root: string, epicDir: string) {
  const files = storyFiles(epicDir);
  const merged = new Set(files.filter((story) => story.meta.status === "merged").map((story) => story.meta.id));
  const ready = files.filter(
    ({ file, meta }) =>
      (meta.status || "todo") === "todo" &&
      !meta.blocked_by &&
      list(meta.depends_on).every((id) => merged.has(id)) &&
      !starting.has(file),
  );
  if (ready.length === 0) return { started: [] as string[], errors: [] as string[] };
  const project = await projectFor(paseo, root);
  const tracker = initiativeTracker(initiativeOf(epicDir));
  const started: string[] = [];
  const errors: string[] = [];
  await Promise.all(
    ready.map(async ({ file, meta }) => {
      const index = files.findIndex((story) => story.file === file);
      const key = keyFor(epicDir, meta, index);
      const title = meta.title || meta.id || key;
      starting.add(file);
      try {
        // Claim the story before anything slow, so a second trigger sees it as taken.
        writeFrontmatter(file, { key, status: "planning" });
        const branch = `${key.toLowerCase()}-${slugOf(title).slice(0, 36)}`.replace(/-+$/, "");
        const workspace = await paseo.workspaces.create({
          source: {
            kind: "worktree",
            projectId: project.projectId,
            cwd: project.projectRootPath,
            action: "branch-off",
            branchName: branch,
            baseBranch: "origin/main",
            worktreeSlug: branch,
          },
        });
        await workspace.setTitle(`${key} — ${title}`.slice(0, 80));
        await startStory(paseo, config, {
          workspaceId: workspace.id,
          key,
          title,
          url: null,
          story: { file, tracker },
        });
        started.push(key);
      } catch (cause) {
        writeFrontmatter(file, { status: "todo" });
        errors.push(`${key}: ${cause instanceof Error ? cause.message : String(cause)}`);
      } finally {
        starting.delete(file);
      }
    }),
  );
  return { started, errors };
}

function phaseOf(input: { repo: string; epic: string }) {
  const root = resolve(input.repo);
  const epicDir = epicDirFor(root, input.epic);
  if (!epicDir) throw new Error(`${input.epic} is not a phase under .harness/initiatives.`);
  return { root, epicDir };
}

export async function runPhaseLoop(
  paseo: PaseoApi,
  readConfig: ReadConfig,
  input: { repo: string; epic: string; action: "start" | "stop" },
) {
  try {
    const { root, epicDir } = phaseOf(input);
    if (input.action === "stop") {
      writeFrontmatter(join(epicDir, PHASE_FILE), { loop: "off" });
      return { ok: true, error: null, started: [], errors: [] };
    }
    const config = await readConfig();
    if (!config) throw new Error("The Story belt settings aren't loaded yet. Try again in a moment.");
    writeFrontmatter(join(epicDir, PHASE_FILE), { loop: "on" });
    const result = await startReady(paseo, config, root, epicDir);
    return { ok: true, error: null, ...result };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), started: [], errors: [] };
  }
}

// A PR merged: mark its initiative story merged, then start what became ready in loops that are on.
export async function advancePhaseLoops(paseo: PaseoApi, fresh: MergedPr[], readConfig: ReadConfig) {
  const keys = new Set(fresh.map((pr) => pr.key).filter(Boolean));
  if (keys.size === 0) return;
  const listed = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200 } });
  const files = new Set<string>();
  for (const { agent } of listed.entries) {
    const file = agent.labels?.[STORY_FILE_LABEL];
    if (agent.labels?.belt === BELT_LABEL && file && keys.has(agent.labels?.jira ?? "") && existsSync(file)) files.add(file);
  }
  if (files.size === 0) return;
  const config = await readConfig();
  const phases = new Set<string>();
  for (const file of files) {
    writeFrontmatter(file, { status: "merged" });
    phases.add(dirname(dirname(file)));
  }
  for (const epicDir of phases) {
    if (!config || !loopOn(epicDir)) continue;
    // The repo is three levels above the initiative folder; skip anything not in that layout.
    const root = resolve(initiativeOf(epicDir), "..", "..", "..");
    if (resolve(initiativesDir(root)) !== dirname(initiativeOf(epicDir))) continue;
    const result = await startReady(paseo, config, root, epicDir).catch((error) => {
      console.warn("orchestrator: phase loop could not start the next stories", epicDir, error);
      return null;
    });
    for (const error of result?.errors ?? []) console.warn("orchestrator: phase loop", error);
  }
}
