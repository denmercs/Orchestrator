import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadDailyVerse } from "./server/bible-verse";
import { listMergedPrs } from "./server/github-prs";
import { readHostMcpServers } from "./server/host-mcp";
import {
  listAccessibleJiraBoards,
  listMyWorkStories,
  loadJiraBoard,
  loadJiraPullRequests,
  moveIssueToColumn,
} from "./server/jira";
import { deleteInitiative, loadHarnessBoard } from "./server/harness-board";
import { startPhaseArchitect } from "./server/harness-architect";
import { openPhasePlan, refreshPhasePlan } from "./server/phase-plan";
import { stopPlanServer } from "./server/plan-server";
import { advancePhaseLoops, runPhaseLoop } from "./server/phase-loop";
import { createHarnessEpic, listHarness } from "./server/harness-layout";
import { advanceBelt, closeMergedStories, startStory } from "./server/belt-advance";
import { createLoopAdvance } from "./server/loop-advance";
import { addSource, checkSource, loadCatalog, removeSourceCheckout } from "./server/skill-sources";
import { loadProdPulse } from "./server/prod-pulse";
import { applyProdPulseAutomation, loadProdPulseAutomation } from "./server/prod-pulse-schedule";
import { PR_POLL_MS } from "./shared/timing";
import { detectObsidian, listTemplates } from "./server/obsidian";
import { listParents, listSchedules } from "./server/orchestration";
import { listFolders, listStandupTodos, saveStandupTodos, upsertStandupNote } from "./server/standup";
import {
  createHarnessEpicRpc,
  deleteEpicInitiative,
  detectOrchestrationObsidian,
  getDailyVerse,
  getEpicBoard,
  getJiraBoard,
  getProdPulse,
  getProdPulseAutomation,
  listJiraBoards,
  listHarnessInitiatives,
  planHarnessPhaseRpc,
  openPhasePlanRpc,
  refreshPhasePlanRpc,
  phaseLoopRpc,
  listJiraPullRequests,
  listOrchestrationFolders,
  moveJiraIssue,
  listOrchestrationMergedPrs,
  listOrchestrationParents,
  listOrchestrationSchedules,
  listOrchestrationStandupTodos,
  listOrchestrationStandupWork,
  listOrchestrationTemplates,
  saveOrchestrationStandupTodos,
  upsertOrchestrationStandupNote,
} from "./shared/orchestration";
import { harnessSettings, jiraBoardSettings, prodPulseSettings, standupSettings } from "./shared/settings";
import {
  addSkillSource,
  beltSettings,
  checkSkillSource,
  getSkillCatalog,
  removeSkillSource,
  startBeltStory,
} from "./shared/belt";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(standupSettings);
  const boardSettings = server.registerSettings(jiraBoardSettings);
  const pulseSettings = server.registerSettings(prodPulseSettings);
  const harness = server.registerSettings(harnessSettings);
  const readHarness = async () => {
    const state = await harness.read();
    return state.status === "ready" ? state.values : { repo: "", epic: "" };
  };
  server.handle(getEpicBoard, async () => loadHarnessBoard(await readHarness()));
  server.handle(deleteEpicInitiative, async () => deleteInitiative(await readHarness()));
  server.handle(listHarnessInitiatives, ({ repos }) => listHarness(repos));
  server.handle(createHarnessEpicRpc, async (input, { paseo }) => {
    const created = await createHarnessEpic(input);
    if (!created.ok || !created.epic) return { ...created, agentId: null, warning: null };
    const started = await startPhaseArchitect(paseo, { repo: input.repo, epic: created.epic });
    return { ...created, agentId: started.agentId, warning: started.error };
  });
  server.handle(planHarnessPhaseRpc, (input, { paseo }) => startPhaseArchitect(paseo, input));
  server.handle(openPhasePlanRpc, openPhasePlan);
  server.handle(refreshPhasePlanRpc, refreshPhasePlan);
  const belt = server.registerSettings(beltSettings);
  const readBeltValues = async () => {
    const state = await belt.read();
    return state.status === "ready" ? state.values : null;
  };
  const readBelt = async () => {
    const values = await readBeltValues();
    return values?.enabled ? values : null;
  };
  const loop = createLoopAdvance(async (paseo, fresh) => {
    await closeMergedStories(paseo, fresh, readBelt);
    // Initiative loops run on the belt's phases even while the belt is off for Jira stories.
    await advancePhaseLoops(paseo, fresh, readBeltValues);
  });
  server.handle(phaseLoopRpc, (input, { paseo }) => {
    loop.rememberPaseo(paseo);
    return runPhaseLoop(paseo, readBeltValues, input);
  });
  server.handle(getSkillCatalog, async () => loadCatalog((await readBeltValues())?.sources ?? []));
  server.handle(addSkillSource, ({ location }) => addSource(location));
  server.handle(checkSkillSource, async ({ id }) => {
    const source = (await readBeltValues())?.sources.find((s) => s.id === id);
    if (!source) {
      return { ok: false, error: "That source is not connected.", head: null, commits: [], changedSkills: [] };
    }
    return checkSource(source);
  });
  server.handle(removeSkillSource, ({ id }) => removeSourceCheckout(id));
  server.handle(startBeltStory, async (input, { paseo }) => {
    const config = await readBelt();
    if (!config) {
      throw new Error("The Story belt is off. Turn it on in Skills first.");
    }
    return startStory(paseo, config, input);
  });
  server.handle(listOrchestrationSchedules, listSchedules);
  server.handle(listOrchestrationParents, listParents);
  server.handle(listJiraBoards, async () => {
    const settings = await boardSettings.read();
    return listAccessibleJiraBoards(settings.status === "ready" ? settings.values.boardFilter : undefined);
  });
  server.handle(getJiraBoard, loadJiraBoard);
  server.handle(listJiraPullRequests, loadJiraPullRequests);
  server.handle(moveJiraIssue, moveIssueToColumn);
  server.handle(getDailyVerse, () => loadDailyVerse());
  server.handle(getProdPulse, () => loadProdPulse());
  server.handle(getProdPulseAutomation, () => loadProdPulseAutomation());
  // Off by default: schedules spend Claude credits, so they only appear once the drawer's
  // Automation switch is turned on. Off pauses them; nothing is ever deleted.
  let lastAutoSchedule: boolean | null = null;
  const syncPulseSettings = async (state: Awaited<ReturnType<typeof pulseSettings.read>>) => {
    if (state.status !== "ready" || state.values.autoSchedule === lastAutoSchedule) {
      return;
    }
    const first = lastAutoSchedule === null;
    lastAutoSchedule = state.values.autoSchedule;
    // At startup an off setting does nothing, so schedules made outside the plugin are left alone.
    if (first && !lastAutoSchedule) {
      return;
    }
    await applyProdPulseAutomation(lastAutoSchedule).catch(() => undefined);
  };
  const offPulseSettings = pulseSettings.subscribe(syncPulseSettings);
  void pulseSettings.read().then(syncPulseSettings);
  server.handle(listOrchestrationFolders, listFolders);
  server.handle(upsertOrchestrationStandupNote, upsertStandupNote);
  server.handle(listOrchestrationStandupTodos, listStandupTodos);
  server.handle(saveOrchestrationStandupTodos, saveStandupTodos);
  server.handle(listOrchestrationStandupWork, () => listMyWorkStories());
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
    void advanceBelt(paseo, event, readBelt).catch((error) => {
      console.warn("orchestrator: belt advance failed", error);
    });
  });
  void loop.seedMergedPrs();
  const timer = setInterval(() => {
    void loop.pollMergedPrs();
  }, PR_POLL_MS);
  timer.unref?.();
  return () => {
    offPulseSettings();
    stopPlanServer();
    offBeforeCreate();
    offTurnEnded();
    clearInterval(timer);
  };
}
