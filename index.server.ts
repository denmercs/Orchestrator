import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadDailyVerse } from "./server/bible-verse";
import { listMergedPrs } from "./server/github-prs";
import { pickMcpServers, readHostMcpServers } from "./server/host-mcp";
import { mcpScopeFor, registerMcpScope, scopeWorkerWorkspace } from "./server/mcp-scope";
import {
  listAccessibleJiraBoards,
  listMyWorkStories,
  loadJiraBoard,
  loadJiraPullRequests,
  moveIssueToColumn,
} from "./server/jira";
import { deleteInitiative, loadHarnessBoards } from "./server/harness-board";
import { loadRunnerConfig, loadStepConfig } from "./server/agent-runner";
import { startPhaseArchitect } from "./server/harness-architect";
import { openPhasePlan, refreshPhasePlan } from "./server/phase-plan";
import { stopPlanServer } from "./server/plan-server";
import { createHarnessEpic, listHarness } from "./server/harness-layout";
import { advancePipeline, closeMergedStories, startStory } from "./server/pipeline-advance";
import { createLoopAdvance } from "./server/loop-advance";
import { createInitiativeLoop } from "./server/initiative-loop";
import { createContextWatch, paseoPort } from "./server/context-watch";
import { summariseTelemetry } from "./server/context-telemetry";
import { contextAct, contextSessionsRpc, contextSettings, contextSummaryRpc } from "./shared/context";
import {
  DEFAULT_LOOP_CONFIG,
  initiativeLoopSettings,
  startInitiativeLoop,
  stopInitiativeLoop,
} from "./shared/initiative-loop";
import { addSource, checkSource, loadCatalog, removeSourceCheckout } from "./server/skill-sources";
import { attachSkills } from "./server/skill-attach";
import { searchSkillsSh } from "./server/skills-sh";
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
  getEpicBoards,
  getJiraBoard,
  getProdPulse,
  getProdPulseAutomation,
  listJiraBoards,
  listHarnessInitiatives,
  planHarnessPhaseRpc,
  openPhasePlanRpc,
  refreshPhasePlanRpc,
  registerMcpScopeRpc,
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
import { agentRunnerSettings } from "./shared/agent-runner";
import {
  dashboardSettings,
  harnessSettings,
  jiraBoardSettings,
  mcpSettings,
  prodPulseSettings,
  standupSettings,
} from "./shared/settings";
import {
  addSkillSource,
  attachSkill,
  DEFAULT_PHASES,
  pipelineSettings,
  checkSkillSource,
  getSkillCatalog,
  removeSkillSource,
  searchSkillRegistry,
  startPipelineStory,
} from "./shared/pipeline";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(standupSettings);
  server.registerSettings(dashboardSettings);
  const runnerSettings = server.registerSettings(agentRunnerSettings);
  const readRunnerProfileId = async () => {
    const state = await runnerSettings.read();
    return state.status === "ready" ? state.values.profileId : "";
  };
  const readAgentConfig = async (paseo: Parameters<typeof loadRunnerConfig>[0]) =>
    loadRunnerConfig(paseo, await readRunnerProfileId());
  const boardSettings = server.registerSettings(jiraBoardSettings);
  const pulseSettings = server.registerSettings(prodPulseSettings);
  const harness = server.registerSettings(harnessSettings);
  const readHarness = async () => {
    const state = await harness.read();
    return state.status === "ready" ? state.values : { repo: "", epic: "" };
  };
  const mcp = server.registerSettings(mcpSettings);
  const readMcpExclude = async () => {
    const state = await mcp.read();
    return state.status === "ready" ? state.values.mcpExclude : [];
  };
  server.handle(getEpicBoards, async ({ repos }, { paseo }) => {
    // The board polls every few seconds, so this keeps the loop's Paseo handle fresh for its timer.
    initiativeLoop.rememberPaseo(paseo);
    return loadHarnessBoards(repos, await readHarness());
  });
  server.handle(deleteEpicInitiative, deleteInitiative);
  server.handle(listHarnessInitiatives, ({ repos }) => listHarness(repos));
  server.handle(createHarnessEpicRpc, async (input, { paseo }) => {
    const created = await createHarnessEpic(input);
    if (!created.ok || !created.epic) return { ...created, agentId: null, warning: null };
    const started = await startPhaseArchitect(
      paseo,
      { repo: input.repo, epic: created.epic },
      await readAgentConfig(paseo),
    );
    return { ...created, agentId: started.agentId, warning: started.error };
  });
  server.handle(planHarnessPhaseRpc, async (input, { paseo }) =>
    startPhaseArchitect(paseo, input, await readAgentConfig(paseo)),
  );
  const pipeline = server.registerSettings(pipelineSettings);
  const readPipelineValues = async () => {
    const state = await pipeline.read();
    return state.status === "ready" ? state.values : null;
  };
  const loopSettings = server.registerSettings(initiativeLoopSettings);
  const initiativeLoop = createInitiativeLoop(
    async () => {
      const state = await loopSettings.read();
      return state.status === "ready" ? state.values : DEFAULT_LOOP_CONFIG;
    },
    async (paseo, step, loop) => loadStepConfig(paseo, loop, step, await readRunnerProfileId()),
    // Loop steps load the drawer's extras whether or not the Story pipeline is switched on (d2).
    async () => {
      const values = await readPipelineValues();
      return values ? { phases: values.phases, sources: values.sources } : { phases: DEFAULT_PHASES, sources: [] };
    },
  );
  server.handle(startInitiativeLoop, (input, { paseo }) => initiativeLoop.start(paseo, input));
  server.handle(stopInitiativeLoop, (input) => initiativeLoop.stop(input));
  server.handle(openPhasePlanRpc, openPhasePlan);
  server.handle(refreshPhasePlanRpc, refreshPhasePlan);
  server.handle(registerMcpScopeRpc, (input) => {
    registerMcpScope(input);
    return { ok: true as const };
  });
  const context = server.registerSettings(contextSettings);
  let contextPaseo: Parameters<typeof loadRunnerConfig>[0] | null = null;
  const contextWatch = createContextWatch(
    paseoPort(
      () => contextPaseo,
      async () => {
        const state = await context.read();
        return state.status === "ready" ? state.values : { amber: 100_000, red: 150_000 };
      },
      initiativeLoop,
    ),
  );
  server.handle(contextAct, (input, { paseo }) => {
    contextPaseo = paseo;
    return contextWatch.act(input);
  });
  server.handle(contextSessionsRpc, ({ agentIds }, { paseo }) => {
    contextPaseo = paseo;
    return contextWatch.sessions(agentIds);
  });
  server.handle(contextSummaryRpc, ({ since }) => summariseTelemetry(since));
  const readPipeline = async () => {
    const values = await readPipelineValues();
    return values?.enabled ? values : null;
  };
  const loop = createLoopAdvance((paseo, fresh) =>
    closeMergedStories(paseo, fresh, readPipeline),
  );
  server.handle(getSkillCatalog, async () => loadCatalog((await readPipelineValues())?.sources ?? []));
  server.handle(addSkillSource, ({ location }) => addSource(location));
  server.handle(checkSkillSource, async ({ id }) => {
    const source = (await readPipelineValues())?.sources.find((s) => s.id === id);
    if (!source) {
      return { ok: false, error: "That source is not connected.", head: null, commits: [], changedSkills: [] };
    }
    return checkSource(source);
  });
  server.handle(removeSkillSource, ({ id }) => removeSourceCheckout(id));
  server.handle(searchSkillRegistry, async ({ query }) =>
    searchSkillsSh(query, { fetch, sources: (await readPipelineValues())?.sources ?? [] }),
  );
  server.handle(attachSkill, async ({ query }) => attachSkills(query, (await readPipelineValues())?.sources ?? []));
  server.handle(startPipelineStory, async (input, { paseo }) => {
    const config = await readPipeline();
    if (!config) {
      throw new Error("The Story pipeline is off. Turn it on in Skills first.");
    }
    return startStory(paseo, config, input, await readAgentConfig(paseo));
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
    const hostServers = pickMcpServers(
      await readHostMcpServers(request.config.cwd),
      mcpScopeFor(request.config.cwd),
      await readMcpExclude(),
    );
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
  const offWorkspaceCreated = server.on("workspace.created", ({ workspace }) => {
    scopeWorkerWorkspace(workspace);
  });
  const offTurnEnded = server.on("agent.turn_ended", (event, { paseo }) => {
    loop.rememberPaseo(paseo);
    void loop.onTurnEnded(event);
    void advancePipeline(paseo, event, readPipeline, readAgentConfig).catch((error) => {
      console.warn("orchestrator: pipeline advance failed", error);
    });
    void initiativeLoop.onTurnEnded(paseo, event).catch((error) => {
      console.warn("orchestrator: initiative loop failed", error);
    });
    contextPaseo = paseo;
    void contextWatch.onTurnEnded(event).catch((error) => {
      console.warn("orchestrator: context watch failed", error);
    });
  });
  void loop.seedMergedPrs();
  const timer = setInterval(() => {
    void loop.pollMergedPrs();
    void initiativeLoop.tick();
  }, PR_POLL_MS);
  timer.unref?.();
  return () => {
    offPulseSettings();
    stopPlanServer();
    offBeforeCreate();
    offWorkspaceCreated();
    offTurnEnded();
    clearInterval(timer);
  };
}
