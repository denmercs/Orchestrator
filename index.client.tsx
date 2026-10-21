import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { CURSOR_THEMES } from "./client/cursor-themes";
import { OrchestrationDashboard } from "./client/orchestration-dashboard";
import { PromotePanel } from "./client/promote-panel";
import { contributePromoteEntry } from "./client/promote-entry";
import { contributeSessionRolePills } from "./client/session-role-pills";
import { attachSkill } from "./shared/pipeline";
import { INSTALL_LABEL } from "./shared/install";
import { startMemoryReplay } from "./shared/replay-rpc";
import { createVoiceEars } from "./client/voice-ears";
import { createVoiceLink } from "./client/voice-link";
import { createVoiceMic, createVoiceTranscriber } from "./client/voice-mic";
import { hasMicApi } from "./client/voice-mic-model";
import { createVoiceHelperClient } from "./client/voice-helper-client";
import { createVoicePrefs } from "./client/voice-prefs";
import { createVoiceRunner } from "./client/voice-runner";
import { createVoiceSpeaker } from "./client/voice-speaker";
import { createVoiceLineRenderer, voiceLineSchema } from "./client/voice-line-renderer";
import { voiceBrief, voiceEvents, voiceStatus, voiceTarget } from "./shared/voice-rpc";

const TITLE = INSTALL_LABEL ? `Orchestration (${INSTALL_LABEL})` : "Orchestration";

export default function contribute(client: PluginClientContext) {
  const voice = createVoiceRunner({
    link: createVoiceLink(client.paseo),
    recorder: createVoiceMic(),
    transcriber: createVoiceTranscriber(client.rpc),
    helper: createVoiceHelperClient(client.rpc),
    events: { read: (after) => client.rpc(voiceEvents, { after }) },
    brief: async (text) => (await client.rpc(voiceBrief, { text }))?.spoken ?? null,
    status: async (text) => (await client.rpc(voiceStatus, { text }))?.spoken ?? null,
    speaker: createVoiceSpeaker(client.rpc, client.playAudio),
    ears: createVoiceEars(client.rpc),
    prefs: createVoicePrefs(client.rpc),
    hasMic: () => hasMicApi(globalThis.navigator),
  });
  // Launch-time: open the mic (unless muted) and start the events poll; the loop stays asleep until a wake word.
  void voice.start();
  // Jarvis lines for the phone (behind voice.phoneAudio) arrive as timeline items; the renderer speaks each once.
  const offVoiceLines = client.addTimelineRenderer({
    kind: "voice-line",
    version: 1,
    schema: voiceLineSchema,
    Component: createVoiceLineRenderer(createVoiceSpeaker(client.rpc, client.playAudio)),
  });
  // The Jarvis router (server) sends to the drawer's target, so every new target is passed on.
  let toldTarget: string | undefined;
  const offTarget = voice.subscribe(() => {
    const session = voice.getState().session;
    if (!session || session.id === toldTarget) return;
    toldTarget = session.id;
    client.rpc(voiceTarget, session).catch((error) => console.warn("orchestrator: voice target not passed on", error));
  });
  const Dashboard = (props: PluginSurfaceProps) => <OrchestrationDashboard {...props} voice={voice} />;
  client.addSurface("orchestration", Dashboard);
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
  const offPills = contributeSessionRolePills(client, voice);
  const offThemes = CURSOR_THEMES.map((theme) => client.addTheme(theme));
  // Promote: a slash command and a composer pill that open the same form, which starts a Story on a
  // scratch ticket. The screen takes the title (from /promote args) and the workspace via its params.
  const offPromoteScreen = client.addScreen({ id: "promote", title: "Promote to story", Component: PromotePanel });
  const offPromote = contributePromoteEntry(client);
  return async () => {
    offTarget();
    voice.off();
    await Promise.all([offVoiceLines(), offAttach(), offPills(), offPromote(), offPromoteScreen(), ...offThemes.map((off) => off())]);
  };
}
