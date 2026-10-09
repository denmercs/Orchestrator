import type { usePaseo } from "@getpaseo/plugin/client";
import { FALLBACK_AGENT_CONFIG, type AgentCreateConfig } from "../shared/agent-runner";
import { HARNESS_MARK, WORKER_MARK } from "../shared/marks";
import { branchName } from "../shared/naming";
import type { BoardItem } from "./board-model";

type PaseoApi = ReturnType<typeof usePaseo>;
type PaseoProject = Awaited<ReturnType<PaseoApi["projects"]["list"]>>["projects"][number];

// Agent titles stay unmarked because the board parses the Jira key from the start of them.
export { HARNESS_MARK, WORKER_MARK };

const PROJECT_HINTS: Record<string, string[]> = {
  QUICK: ["quickpress", "wiscodes-quickpress"],
  GIH: ["gihimo"],
  QBUILD: ["qbuild", "quick builder", "quickbuilder"],
};

type StartPipeline = (input: {
  workspaceId: string;
  key: string;
  title: string;
  url: string | null;
}) => Promise<{ agentId: string; warnings: string[] }>;

type RegisterScope = (input: { cwd: string; scope: "jira" | "none" }) => Promise<{ ok: true }>;

// With `startPipeline`, stories run the Story pipeline (Plan first); epics always run the epic loop.
// `registerScope` gives the session or epic loop the Jira server only. The pipeline scopes its own steps.
// `initials` prefix the branch (`dm/quick-1/...`); the worktree folder keeps its flat slug.
export async function startJiraSession(
  paseo: PaseoApi,
  item: BoardItem,
  startPipeline?: StartPipeline,
  agentConfig?: AgentCreateConfig,
  registerScope?: RegisterScope,
  initials: string | null = null,
) {
  if (!item.key) {
    throw new Error("This card has no Jira key.");
  }

  const project = await resolveProject(paseo, item.key);
  const title = sessionTitle(item);
  const slug = worktreeSlug(item);
  const workspace = await paseo.workspaces.create({
    source: {
      kind: "worktree",
      projectId: project.projectId,
      cwd: project.projectRootPath,
      action: "branch-off",
      branchName: branchName({ initials, key: item.key, title: item.title }),
      baseBranch: "origin/main",
      worktreeSlug: slug,
    },
  });
  await workspace.setTitle(workspaceTitle(item, title));
  if (startPipeline && item.role !== "epic") {
    const started = await startPipeline({
      workspaceId: workspace.id,
      key: item.key,
      title: item.title,
      url: item.url,
    });
    return { agentId: started.agentId, workspaceId: workspace.id, warnings: started.warnings };
  }
  const warnings: string[] = [];
  if (registerScope) {
    const registered = workspace.directory
      ? await registerScope({ cwd: workspace.directory, scope: "jira" }).then(
          () => true,
          () => false,
        )
      : false;
    if (!registered) {
      warnings.push("MCP scope not applied; this session gets every host server.");
    }
  }
  const agent = await workspace.agents.create({
    title,
    config: agentConfig ?? { ...FALLBACK_AGENT_CONFIG },
    prompt: item.role === "epic" ? epicLoopPrompt(item) : storyPrompt(item),
    labels: {
      jira: item.key,
      kind: item.role === "epic" ? "epic-loop" : "session",
    },
  });
  return { agentId: agent.id, workspaceId: workspace.id, warnings };
}

async function resolveProject(paseo: PaseoApi, issueKey: string) {
  const prefix = issueKey.split("-")[0]?.toUpperCase() ?? "";
  const hints = PROJECT_HINTS[prefix] ?? [prefix.toLowerCase()];
  const listed = await paseo.projects.list();
  const match = listed.projects.find((project) => matchesProject(project, hints));
  if (!match) {
    throw new Error(
      `No Paseo project is mapped for ${prefix}. Add that repo in Paseo, then try again.`,
    );
  }
  return match;
}

function matchesProject(project: PaseoProject, hints: string[]) {
  const haystack = [
    project.projectDisplayName,
    project.projectCustomName,
    project.projectRootPath,
    project.projectId,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hints.some((hint) => haystack.includes(hint));
}

function sessionTitle(item: BoardItem) {
  const label = `${item.key} — ${item.title}`.trim();
  return label.length > 60 ? `${label.slice(0, 57)}...` : label;
}

function workspaceTitle(item: BoardItem, title: string) {
  if (item.role === "epic") {
    return `${HARNESS_MARK} ${title}`;
  }
  return item.role === "child" ? `${WORKER_MARK} ${title}` : title;
}

function worktreeSlug(item: BoardItem) {
  const title = item.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  const key = item.key.toLowerCase();
  return title ? `${key}-${title}` : key;
}

function epicLoopPrompt(item: BoardItem) {
  return [
    `Start a Paseo epic loop for ${item.key} — ${item.title}.`,
    "",
    `This is a Jira Epic${item.url ? ` (${item.url})` : ""}. You are the parent orchestrator.`,
    "",
    "1. Read the epic and its child issues with the attached Jira/Atlassian MCP tools. Do not open a browser and do not ask anyone to log in.",
    "2. Plan remaining open children in dependency order.",
    `3. For each ready child, first call create_workspace for a worktree off this repo's main branch with title "${WORKER_MARK} <KEY> — <summary>" set in that same call, then immediately create the subagent in that workspace (pass its workspaceId to create_agent), titled "<KEY> — <summary>". The worker title marks it in the sidebar and gives the child the Jira server only.`,
    "4. Keep this session as the epic parent. Do not implement child tickets yourself unless a child is blocked on a decision only you can make.",
    "5. Give each child session the label jira=<KEY> and start its title with the key. The Orchestrator plugin uses them to find which epic parent to wake.",
    "6. Check child sessions by status only. Do not read their transcripts unless a child is blocked and you must unblock it.",
    "7. When nothing more is ready, end your turn. Do not wait, sleep or poll inside a turn. The plugin wakes this session when one of its children's pull requests merges; treat that as the signal to start the next ready ticket.",
    "8. Stop when the epic's open work is done or waiting on a human.",
    "",
    "Use Paseo tools or the Paseo CLI to create those child sessions. The Jira/Atlassian MCP server is already authenticated.",
  ].join("\n");
}

function storyPrompt(item: BoardItem) {
  const kind = item.role === "child" ? "child ticket" : "story";
  return [
    `Implement ${item.key} — ${item.title}.`,
    "",
    `This is a Jira ${kind}${item.url ? ` (${item.url})` : ""}. Work in this worktree.`,
    "",
    "1. Read the ticket and its acceptance criteria with the attached Jira/Atlassian MCP tools. Do not open a browser and do not ask anyone to log in. They are already authenticated.",
    "2. Implement the change, with tests for the behavior you touch.",
    "3. Leave a short summary of what shipped and what is still open.",
    "",
    "Do not start other tickets unless this one is blocked on them.",
  ].join("\n");
}
