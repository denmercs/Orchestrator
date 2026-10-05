import { usePaseo } from "@getpaseo/plugin/client";
import type { BoardItem } from "./board-model";

type PaseoApi = ReturnType<typeof usePaseo>;
type PaseoProject = Awaited<ReturnType<PaseoApi["projects"]["list"]>>["projects"][number];

const PROJECT_HINTS: Record<string, string[]> = {
  QUICK: ["quickpress", "wiscodes-quickpress"],
  GIH: ["gihimo"],
  QBUILD: ["qbuild", "quick builder", "quickbuilder"],
};

export async function startJiraSession(paseo: PaseoApi, item: BoardItem) {
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
      branchName: slug,
      baseBranch: "origin/main",
      worktreeSlug: slug,
    },
  });
  await workspace.setTitle(title);
  const agent = await workspace.agents.create({
    title,
    config: {
      provider: "cursor/grok-4.6",
      modeId: "agent",
      thinkingOptionId: "medium",
      featureValues: { auto_accept: true },
    },
    prompt: item.role === "epic" ? epicLoopPrompt(item) : storyPrompt(item),
    labels: {
      jira: item.key,
      kind: item.role === "epic" ? "epic-loop" : "session",
    },
  });
  return { agentId: agent.id, workspaceId: workspace.id };
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
    "1. Read the epic and its child issues with the mcp-atlassian tools (jira_get_issue, jira_search, jira_get_board_issues). Do not open a browser and do not ask anyone to log in to Jira.",
    "2. Plan remaining open children in dependency order.",
    "3. For each ready child, create a Paseo subagent titled \"<KEY> — <summary>\" in its own worktree off this repo's main branch.",
    "4. Keep this session as the epic parent. Do not implement child tickets yourself unless a child is blocked on a decision only you can make.",
    "5. Loop: check child sessions, unblock, spawn the next ready ticket, and stop when the epic's open work is done or waiting on a human.",
    "6. The Orchestrator plugin will poke this session when a child pull request merges (immediately after the child turn ends, and every 2 minutes as a fallback). Treat that as the signal to start the next ready ticket.",
    "",
    "Use Paseo tools or the Paseo CLI to create those child sessions. Jira access is already authenticated through mcp-atlassian.",
  ].join("\n");
}

function storyPrompt(item: BoardItem) {
  const kind = item.role === "child" ? "child ticket" : "story";
  return [
    `Implement ${item.key} — ${item.title}.`,
    "",
    `This is a Jira ${kind}${item.url ? ` (${item.url})` : ""}. Work in this worktree.`,
    "",
    "1. Read the ticket and its acceptance criteria with mcp-atlassian (jira_get_issue). Do not open a browser and do not ask anyone to log in to Jira. That MCP is already authenticated.",
    "2. Implement the change, with tests for the behavior you touch.",
    "3. Leave a short summary of what shipped and what is still open.",
    "",
    "Do not start other tickets unless this one is blocked on them.",
  ].join("\n");
}
