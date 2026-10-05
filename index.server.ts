import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listMergedPrs } from "./server/github-prs";
import { readHostMcpServers } from "./server/host-mcp";
import { listAccessibleJiraBoards, loadJiraBoard } from "./server/jira";
import { createLoopAdvance } from "./server/loop-advance";
import { PR_POLL_MS } from "./shared/timing";
import { detectObsidian, listTemplates } from "./server/obsidian";
import { listParents, listSchedules } from "./server/orchestration";
import { listFolders, listStandupTodos, saveStandupTodos, upsertStandupNote } from "./server/standup";
import {
  detectOrchestrationObsidian,
  getJiraBoard,
  listJiraBoards,
  listOrchestrationFolders,
  listOrchestrationMergedPrs,
  listOrchestrationParents,
  listOrchestrationSchedules,
  listOrchestrationStandupTodos,
  listOrchestrationTemplates,
  saveOrchestrationStandupTodos,
  upsertOrchestrationStandupNote,
} from "./shared/orchestration";
import { standupSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const loop = createLoopAdvance();
  server.registerSettings(standupSettings);
  server.handle(listOrchestrationSchedules, listSchedules);
  server.handle(listOrchestrationParents, listParents);
  server.handle(listJiraBoards, listAccessibleJiraBoards);
  server.handle(getJiraBoard, loadJiraBoard);
  server.handle(listOrchestrationFolders, listFolders);
  server.handle(upsertOrchestrationStandupNote, upsertStandupNote);
  server.handle(listOrchestrationStandupTodos, listStandupTodos);
  server.handle(saveOrchestrationStandupTodos, saveStandupTodos);
  server.handle(detectOrchestrationObsidian, detectObsidian);
  server.handle(listOrchestrationTemplates, listTemplates);
  server.handle(listOrchestrationMergedPrs, (_input, { paseo }) => {
    loop.rememberPaseo(paseo);
    return listMergedPrs();
  });
  const offBeforeCreate = server.before("agent.create", async ({ request }) => {
    const hostServers = await readHostMcpServers();
    if (Object.keys(hostServers).length === 0) {
      return;
    }
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          ...hostServers,
        },
      },
    };
  });
  const offTurnEnded = server.on("agent.turn_ended", (event, { paseo }) => {
    loop.rememberPaseo(paseo);
    void loop.onTurnEnded(event);
  });
  void loop.seedMergedPrs();
  const timer = setInterval(() => {
    void loop.pollMergedPrs();
  }, PR_POLL_MS);
  timer.unref?.();
  return () => {
    offBeforeCreate();
    offTurnEnded();
    clearInterval(timer);
  };
}
