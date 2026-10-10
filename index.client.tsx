import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CURSOR_THEMES } from "./client/cursor-themes";
import { OrchestrationDashboard } from "./client/orchestration-dashboard";
import { contributeSessionRolePills } from "./client/session-role-pills";
import { attachSkill } from "./shared/pipeline";
import { INSTALL_LABEL } from "./shared/install";
import { startMemoryReplay } from "./shared/replay-rpc";

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

  // Replays this repo's past Reviews in three memory arms. Progress lands in `.harness/replay/run/` (run.log shows the cost cap).
  client.addCommandCenterItem({
    id: "replay-past-reviews",
    title: "Replay past Reviews (memory)",
    icon: "History",
    keywords: ["replay", "review", "memory", "arms", "experiment"],
    context: "workspace",
    async onSelect({ rpc, workspace }) {
      await rpc(startMemoryReplay, { root: workspace.projectRootPath });
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
  const offThemes = CURSOR_THEMES.map((theme) => client.addTheme(theme));
  return async () => {
    await Promise.all([offAttach(), offPills(), ...offThemes.map((off) => off())]);
  };
}
