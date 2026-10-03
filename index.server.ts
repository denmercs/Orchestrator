import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listSchedules } from "./server/orchestration";
import { listOrchestrationSchedules } from "./shared/orchestration";

export default function contribute(server: PluginServerContext) {
  server.handle(listOrchestrationSchedules, listSchedules);
  return () => {};
}
