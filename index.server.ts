import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listMergedPrs } from "./server/github-prs";
import { detectObsidian, listTemplates } from "./server/obsidian";
import { listParents, listSchedules } from "./server/orchestration";
import { listFolders, upsertStandupNote } from "./server/standup";
import {
  detectOrchestrationObsidian,
  listOrchestrationFolders,
  listOrchestrationMergedPrs,
  listOrchestrationTemplates,
  listOrchestrationParents,
  listOrchestrationSchedules,
  upsertOrchestrationStandupNote,
} from "./shared/orchestration";
import { standupSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(standupSettings);
  server.handle(listOrchestrationSchedules, listSchedules);
  server.handle(listOrchestrationParents, listParents);
  server.handle(listOrchestrationFolders, listFolders);
  server.handle(upsertOrchestrationStandupNote, upsertStandupNote);
  server.handle(detectOrchestrationObsidian, detectObsidian);
  server.handle(listOrchestrationTemplates, listTemplates);
  server.handle(listOrchestrationMergedPrs, () => listMergedPrs());
  return () => {};
}
