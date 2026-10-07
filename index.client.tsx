import type { PluginClientContext } from "@getpaseo/plugin/client";
import { OrchestrationDashboard } from "./client/orchestration-dashboard";
import { contributeSessionRolePills } from "./client/session-role-pills";
import { attachSkill } from "./shared/belt";
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

  // Composer "Skills": attach a skill from a connected source to a running agent.
  const offAttach = client.addAttachmentSource({
    id: "skills",
    title: "Skills",
    icon: "FileText",
    pickerTitle: "Attach a skill",
    searchPlaceholder: "Search skills",
    search: attachSkill,
  });
  const offPills = contributeSessionRolePills(client);
  return async () => {
    await Promise.all([offAttach(), offPills()]);
  };
}
