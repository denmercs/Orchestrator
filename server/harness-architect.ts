import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentCreateConfig } from "../shared/agent-runner";
import { phaseLabel, type HarnessTracker } from "../shared/orchestration";
import { ARCHITECTURE_METHOD } from "./architecture-method";
import { refreshPlanFromJira, syncPlanFromStories } from "./plan-status";
import { PHASE_FILE, epicDirFor, frontmatter, initiativeTitle, initiativeTracker, initiativesDir } from "./harness-layout";

// The plugin's own architecture step. Creating a phase starts one agent in the repo that
// explores the code, writes the phase's architecture.md and a story file per stage, then
// asks the open decisions one at a time, rewriting both after each answer. The method it
// follows lives in server/architecture-method.ts.

type PaseoApi = PluginHandlerContext["paseo"];

const ARCHITECT_KIND = "phase-architect";
// Marks architecture sessions in the session list, like ★ marks harness sessions.
const ARCHITECT_MARK = "📐";

function architectPrompt(input: {
  epicPath: string;
  initiativePath: string;
  initiative: string;
  tracker: HarnessTracker;
  number: string;
  phase: string;
  title: string;
}) {
  const { epicPath, initiativePath, initiative, tracker, number, phase, title } = input;
  return `You are planning the architecture for ${phase} "${title}" of the initiative "${initiative}".
Work only inside ${epicPath}/. Do not edit code, do not commit, do not touch other phases.
Call it "${phase}" in everything you write and say.

## Tracker
${tracker === "jira"
  ? "This initiative publishes to Jira (see Publishing below)."
  : "This initiative is tracked locally: its phases and stories/ in .harness are the epic and stories. Never create Jira issues for it."}

## This phase
- Plan file: ${epicPath}/architecture.md, frontmatter phase: ${number}, title: ${title},
  heading "# ${phase} — ${title}: architecture".
- Stories: ${epicPath}/stories/.
- If either already exists, resume from it. Never start over.

## Read before writing
- ${initiativePath}/initiative.md: the initiative's outcome.
- Every other phase's architecture.md under ${initiativePath}/phases/: what is already decided.
- The repo's AGENTS.md, CLAUDE.md, CONTEXT.md, docs/adr/, package or build files, entry points.
- The modules this phase touches. Apply the deletion test; note shallow modules and callers
  that reach past an interface.

When the draft is written, give me the two paths in two lines, then start the decision loop.

${ARCHITECTURE_METHOD}`;
}

async function architectRunning(paseo: PaseoApi, dir: string) {
  const listed = await paseo.agents.list({ filter: { includeArchived: false }, page: { limit: 200 } });
  return listed.entries.some(
    ({ agent }) =>
      agent.labels?.kind === ARCHITECT_KIND && agent.labels?.["harness-phase"] === dir && agent.status !== "closed",
  );
}

// Starts the architecture agent for a phase (repo-relative epic folder). Refused while one is open.
export async function startPhaseArchitect(
  paseo: PaseoApi,
  input: { repo: string; epic: string },
  agentConfig: AgentCreateConfig,
) {
  try {
    const root = resolve(input.repo);
    const epicDir = epicDirFor(root, input.epic);
    if (!epicDir) throw new Error(`${input.epic} is not a phase under .harness/initiatives.`);
    const epicPath = relative(root, epicDir).split(sep).join("/");
    if (await architectRunning(paseo, epicPath)) {
      throw new Error("This phase already has an architecture session open. Continue it there.");
    }
    const slug = relative(initiativesDir(root), epicDir).split(sep)[0];
    const initiativeDir = join(initiativesDir(root), slug);
    // Start from current tracker status; a failed refresh (no credentials, offline) is not fatal.
    await refreshPlanFromJira(epicDir);
    syncPlanFromStories(epicDir);
    const meta = frontmatter(readFileSync(join(epicDir, PHASE_FILE), "utf8"));
    const phase = phaseLabel(meta.phase ?? "");
    const title = meta.title || epicPath.split("/").pop() || "";
    const agent = await paseo.agents.create({
      title: `${ARCHITECT_MARK} ${phase} architecture — ${title}`.slice(0, 60),
      config: agentConfig,
      cwd: root,
      prompt: architectPrompt({
        epicPath,
        initiativePath: relative(root, initiativeDir).split(sep).join("/"),
        initiative: initiativeTitle(initiativeDir),
        tracker: initiativeTracker(initiativeDir),
        number: meta.phase ?? "",
        phase,
        title,
      }),
      labels: { kind: ARCHITECT_KIND, "harness-phase": epicPath },
    });
    return { ok: true, error: null, agentId: agent.id };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause), agentId: null };
  }
}
