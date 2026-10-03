import type { PluginClientContext } from "@getpaseo/plugin/client";
import { OrchestrationDashboard } from "./client/orchestration-dashboard";

export default function contribute(client: PluginClientContext) {
  client.addSurface("orchestration", OrchestrationDashboard);
  client.addSidebarItem({
    id: "orchestration",
    title: "Orchestration",
    icon: "Activity",
    surface: "orchestration",
  });

  client.addCommandCenterItem({
    id: "open-orchestration",
    title: "Open orchestration dashboard",
    icon: "Activity",
    keywords: ["orchestration", "status", "dashboard", "schedules", "agents"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("orchestration");
    },
  });

  return () => {};
}
