import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listParents, listSchedules } from "./server/orchestration";
import { listOrchestrationParents, listOrchestrationSchedules } from "./shared/orchestration";

export default function contribute(server: PluginServerContext) {
  server.handle(listOrchestrationSchedules, listSchedules);
  server.handle(listOrchestrationParents, listParents);
  return () => {};
}
