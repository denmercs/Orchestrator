import type { PluginClientContext } from "@getpaseo/plugin/client";
import { OrchestrationDashboard } from "./client/orchestration-dashboard";
import { INSTALL_LABEL } from "./shared/install";

const TITLE = INSTALL_LABEL ? `Orchestration (${INSTALL_LABEL})` : "Orchestration";

export default function contribute(client: PluginClientContext) {
  client.addSurface("orchestration", OrchestrationDashboard);
  client.addSidebarItem({
    id: "orchestration",
    title: TITLE,
    icon: "Activity",
    surface: "orchestration",
  });

  client.addCommandCenterItem({
    id: "open-orchestration",
    title: INSTALL_LABEL ? `Open orchestration dashboard (${INSTALL_LABEL})` : "Open orchestration dashboard",
    icon: "Activity",
    keywords: ["orchestration", "status", "dashboard", "schedules", "agents", "standup"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("orchestration");
    },
  });

  return () => {};
}
