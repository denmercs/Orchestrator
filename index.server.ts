import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
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
  readIssueStatuses,
} from "./server/jira";
import { deleteInitiative, loadHarnessBoards } from "./server/harness-board";
import { loadRunnerConfig, loadStepConfig } from "./server/agent-runner";
import { startPhaseArchitect } from "./server/harness-architect";
import { openPhasePlan, refreshPhasePlan } from "./server/phase-plan";
import { stopPlanServer } from "./server/plan-server";
import { createHarnessEpic, listHarness } from "./server/harness-layout";
import { advancePipeline, closeMergedStories, startStory, watchPipelinePrs } from "./server/pipeline-advance";
import { createLoopAdvance } from "./server/loop-advance";
import { createInitiativeLoop } from "./server/initiative-loop";
import { startLocalTicket, startTicket } from "./server/ticket-start";
import { promoteSessionToStory } from "./shared/promote";
import { readBranchInitials } from "./server/git-identity";
import { getBranchInitials } from "./shared/naming";
import { createContextWatch, paseoPort } from "./server/context-watch";
import { createGateActions, loopGatePort } from "./server/gate-actions";
import { createVoiceResume } from "./server/voice-resume";
import { createSpeakReplies, speakRoute } from "./server/speak-replies";
import { speakRepliesSet, speakRepliesState } from "./shared/speak-replies";
import { gateAct } from "./shared/gates";
import { profilesFromConfigGet } from "./shared/agent-profiles";
import { applyVoiceSession, VOICE_SESSION_ENV, voiceProfileFor } from "./shared/voice-session";
import { readTelemetry, summariseTelemetry } from "./server/context-telemetry";
import { loadStoryContext } from "./server/story-context";
import { kiroUsageSource } from "./server/kiro-usage";
import { readPlanUsage } from "./server/plan-usage";
import { planUsageRpc } from "./shared/plan-usage";
import { createMemoryReplay, DEFAULT_COST_CAP_USD } from "./server/memory-replay";
import { readArms, readCorpus, readCostCap, readRunName, realReplayPorts } from "./server/replay-start";
import { claudeSignedIn } from "./server/claude-cli";
import { startMemoryReplay } from "./shared/replay-rpc";
import { createTranscriber, realTranscribePorts } from "./server/voice-transcribe";
import { createWakeModelLoader, realWakeModelPorts } from "./server/voice-wake-models";
import { createLocalVoice, realLocalPorts, type LocalPorts } from "./server/voice-local";
import { createSpeaker, DEFAULT_REFERENCE_CLIP, resolveReferenceClip, type SpeakerPorts } from "./server/voice-speaker";
import { realSpeakerPorts } from "./server/voice-speaker-workers";
import { REPLAY_START_FILE, REPLAY_START_POLL_MS, tickReplayStart } from "./server/replay-trigger";
import { LOOP_START_FILE, LOOP_START_POLL_MS, tickLoopStart } from "./server/loop-trigger";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createVoiceHelper, paseoVoiceHelperPorts, VOICE_HELPER_CWD } from "./server/voice-helper";
import {
  transcribeVoice,
  voiceBrief,
  voiceEvents,
  voiceHelperStart,
  voiceHelperStop,
  voiceHelperSwitch,
  voiceInterpret,
  voiceSpeak,
  voiceStatus,
  voiceTarget,
  voiceWakeModel,
} from "./shared/voice-rpc";
import { createReplySummary } from "./server/reply-summary";
import { createVoiceInterpret } from "./server/voice-interpret";
import { permissionEvents, turnEvents } from "./server/turn-events";
import { createVoiceHub, realHubPorts } from "./server/voice-turns";
import { createMicOffGate } from "./server/mic-off-gate";
import { createJarvisProvider, type JarvisConnection } from "./server/jarvis-provider";
import { createJarvisRouter, voiceSessionCreator } from "./server/jarvis-router";
import { createMorningBrief, fetchWeather } from "./server/morning-brief";
import { splitSessions, type VoiceEvent } from "./shared/voice-loop";

import { contextAct, contextSessionsRpc, contextSettings, contextSummaryRpc, DEFAULT_CONTEXT_CONFIG, storyContextRpc } from "./shared/context";
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
  startTicketRpc,
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
  budgetSettings,
  dashboardSettings,
  voiceSettings,
  gitSettings,
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

type ReplayRunner = ReturnType<typeof createMemoryReplay>;

// `deps.replay` and `deps.signedIn` let tests stand in for the memory replay runner and the Claude Code login check;
// `deps.replayStart` and `deps.loopStart` move the replay and initiative loop start files and their polls.
export default function contribute(
  server: PluginServerContext,
  deps: {
    replay?: ReplayRunner;
    signedIn?: () => Promise<boolean>;
    replayStart?: { file: string; everyMs: number };
    loopStart?: { file: string; everyMs: number };
    voiceHelperCwd?: string;
    // The Speaker's workers (tests stand in for the Python ones).
    speakerPorts?: (readClip: () => string | undefined) => SpeakerPorts & { start: () => void; stop: () => void };
    // Plays the Speaker's sentences on the Mac for the Speak pill and Jarvis (tests stand in for afplay and `say`).
    localPorts?: (render: LocalPorts["render"]) => LocalPorts;
    // Where the cloned voice's reference clip lives when the voice setting is empty.
    defaultReferenceClip?: string;
  } = {},
) {
  // Paseo 0.11.0+ only; on an older host Kiro stays "unavailable" in the stats strip.
  server.registerUsageSource?.(kiroUsageSource());
  server.registerSettings(standupSettings);
  server.registerSettings(dashboardSettings);
  const voiceSetting = server.registerSettings(voiceSettings);
  const budget = server.registerSettings(budgetSettings);
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
  const git = server.registerSettings(gitSettings);
  const readInitials = async () => {
    const state = await git.read();
    return readBranchInitials(state.status === "ready" ? state.values.branchInitials : "");
  };
  server.handle(getBranchInitials, async () => ({ initials: await readInitials() }));
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
  // Turn events, one source: the hub feeds the drawer's long poll and the Jarvis router (see publishVoice).
  const voiceHub = createVoiceHub(realHubPorts());
  let publishVoice: (events: VoiceEvent[]) => void = () => undefined;
  // Events go out in the order they came, even when a reply waits (up to ~3 s) on its summary.
  let publishChain: Promise<void> = Promise.resolve();
  const publishInOrder = (make: () => VoiceEvent[] | Promise<VoiceEvent[]>) => {
    publishChain = publishChain
      .then(async () => publishVoice(await make()))
      .catch((error) => console.warn("orchestrator: voice publish failed", error));
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
    readInitials,
    {
      cap: async () => {
        const state = await budget.read();
        return (state.status === "ready" ? state.values : budgetSettings.schema.parse({})).storyCapUsd;
      },
      rows: () => readTelemetry(),
    },
    (sessionId) => publishVoice([{ type: "notice", kind: "costCap", sessionId }]),
  );
  // The Initiatives tab and the loop start file both start the loop here.
  const startLoop = (input: RpcInput<typeof startInitiativeLoop>, paseo: Parameters<typeof initiativeLoop.start>[0]) =>
    initiativeLoop.start(paseo, input);
  server.handle(startInitiativeLoop, (input, { paseo }) => startLoop(input, paseo));
  server.handle(stopInitiativeLoop, (input) => initiativeLoop.stop(input));
  server.handle(startTicketRpc, (input, { paseo }) =>
    startTicket(input, {
      readIssue: async (key) => (await readIssueStatuses([key])).get(key),
      startLoop: (loop) => initiativeLoop.start(paseo, loop),
    }),
  );
  server.handle(promoteSessionToStory, async (input, { paseo }) => {
    const fail = (error: string) => ({ ok: false, error, ticketKey: null, agentId: null });
    try {
      const workspace = paseo.workspaces.ref(input.workspaceId);
      const repo = workspace.directory ?? (await workspace.refresh())?.workspaceDirectory ?? null;
      if (!repo) return fail("That workspace has no directory on disk.");
      const result = await startLocalTicket(
        { repo, title: input.title, kind: input.kind },
        { startLoop: (loop) => initiativeLoop.start(paseo, loop) },
      );
      return { ok: result.ok, error: result.error, ticketKey: result.key, agentId: result.agentId };
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : String(cause));
    }
  });
  server.handle(openPhasePlanRpc, openPhasePlan);
  server.handle(refreshPhasePlanRpc, refreshPhasePlan);
  server.handle(registerMcpScopeRpc, (input) => {
    registerMcpScope(input);
    return { ok: true as const };
  });
  const context = server.registerSettings(contextSettings);
  let contextPaseo: Parameters<typeof loadRunnerConfig>[0] | null = null;
  let replayPaseo: Parameters<typeof loadRunnerConfig>[0] | null = null;
  const memoryReplay =
    deps.replay ??
    createMemoryReplay(
      realReplayPorts(
        () => replayPaseo,
        async (paseo) =>
          // The replayed Review runs on the Review step's default model.
          loadStepConfig(
            paseo,
            await loopSettings.read().then((state) => (state.status === "ready" ? state.values : DEFAULT_LOOP_CONFIG)),
            "review",
            await readRunnerProfileId(),
          ),
      ),
    );
  let replaying = false;
  // The ⌘K RPC and the start file both start the replay here, so they make the same checks.
  const startReplay = async (input: RpcInput<typeof startMemoryReplay>, paseo: NonNullable<typeof contextPaseo>) => {
    replayPaseo = paseo;
    contextPaseo = paseo;
    if (replaying || memoryReplay.pendingAgents().length > 0) throw new Error("A memory replay is already running.");
    const corpus = readCorpus(input.root, input.controls);
    // The judge runs on the Claude Code CLI; signed out, every round would come back with no verdict.
    if (!(await (deps.signedIn ?? claudeSignedIn)())) {
      throw new Error("Claude Code is not signed in, so the replay judge can't run. Run `claude` and log in, then start the replay again.");
    }
    const costCap = input.costCap ?? readCostCap(input.root) ?? DEFAULT_COST_CAP_USD;
    const arms = readArms(input.root);
    const run = readRunName(input.root);
    const runDir = join(input.root, ".harness", "replay", run);
    replaying = true;
    void memoryReplay
      .replay(corpus, { run, root: input.root, runDir, costCap, arms })
      .catch((error) => console.warn("orchestrator: memory replay failed", error))
      .finally(() => {
        replaying = false;
      });
    return { run, rounds: corpus.length, costCap, runDir };
  };
  server.handle(startMemoryReplay, (input, { paseo }) => startReplay(input, paseo));
  const transcribe = createTranscriber(realTranscribePorts());
  server.handle(transcribeVoice, (input) => transcribe(input));
  const loadWakeModel = createWakeModelLoader(realWakeModelPorts());
  server.handle(voiceWakeModel, ({ model }) => loadWakeModel(model));
  const readPolicy = async () => {
    const state = await context.read();
    return state.status === "ready" ? state.values : DEFAULT_CONTEXT_CONFIG;
  };
  const readAutoCompact = async () => {
    const state = await context.read();
    return state.status === "ready" ? state.values.autoCompact : true;
  };
  const contextWatch = createContextWatch(paseoPort(() => contextPaseo, readPolicy, readAutoCompact, initiativeLoop));
  server.handle(contextAct, (input, { paseo }) => {
    contextPaseo = paseo;
    return contextWatch.act(input);
  });
  server.handle(gateAct, (input, { paseo }) => {
    // Restart goes through the context watch's fresh adapter, which uses this handle.
    contextPaseo = paseo;
    return createGateActions(loopGatePort(initiativeLoop, paseo, contextWatch)).act(input);
  });
  server.handle(contextSessionsRpc, ({ agentIds }, { paseo }) => {
    contextPaseo = paseo;
    return contextWatch.sessions(agentIds);
  });
  server.handle(contextSummaryRpc, ({ since, today }) => summariseTelemetry(since, undefined, today));
  server.handle(planUsageRpc, (_input, { paseo }) => readPlanUsage(paseo));
  server.handle(storyContextRpc, (input, { paseo }) => {
    contextPaseo = paseo;
    return loadStoryContext(input, {
      live: (agentId) => contextWatch.live(agentId),
      rows: () => readTelemetry(),
      policy: readPolicy,
    });
  });
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
  void pulseSettings.read().then(syncPulseSettings, () => undefined);
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
  const offBeforeCreate = server.before("agent.create", async ({ request }, { paseo }) => {
    const hostServers = pickMcpServers(
      await readHostMcpServers(request.config.cwd),
      mcpScopeFor(request.config.cwd),
      await readMcpExclude(),
    );
    const withServers =
      Object.keys(hostServers).length === 0
        ? request
        : {
            ...request,
            config: {
              ...request.config,
              mcpServers: {
                ...request.config.mcpServers,
                ...hostServers,
              },
            },
          };
    // Only voice-marked creates need the profile; a failed config read never blocks the create.
    if (request.env?.[VOICE_SESSION_ENV] !== "1") {
      return withServers === request ? undefined : withServers;
    }
    let profile = null;
    try {
      const state = await voiceSetting.read();
      profile = voiceProfileFor(
        profilesFromConfigGet(await paseo.config.get()),
        state.status === "ready" ? state.values.profile : "",
      );
    } catch (error) {
      console.warn("orchestrator: voice profile lookup failed", error);
    }
    return applyVoiceSession(withServers, profile);
  });
  const offWorkspaceCreated = server.on("workspace.created", ({ workspace }) => {
    scopeWorkerWorkspace(workspace);
  });
  // The Story pipeline's CI watch runs on the tick, with the handle the last event gave.
  let pipelinePaseo: Parameters<typeof loop.rememberPaseo>[0] | null = null;
  // Set on every turn event: the resume fires later, from a timer, after the event has gone.
  let voicePaseo: Parameters<typeof loop.rememberPaseo>[0] | null = null;
  const voiceResume = createVoiceResume({
    send: async (agentId, text) => {
      if (voicePaseo) await voicePaseo.agents.ref(agentId).send(text);
    },
  });
  // The helper's ports read Paseo through this stand-in, which always points at the handle the last RPC gave.
  let helperPaseo: Parameters<typeof loop.rememberPaseo>[0] | null = null;
  const helperCwd = deps.voiceHelperCwd ?? VOICE_HELPER_CWD;
  const helperPorts = paseoVoiceHelperPorts(
    new Proxy({} as NonNullable<typeof helperPaseo>, { get: (_target, key) => helperPaseo![key as keyof typeof helperPaseo] }),
    helperCwd,
  );
  const voiceHelper = createVoiceHelper(helperPorts);
  // A second small agent writes the spoken summary of each long reply; it lives and dies with the interpret helper.
  const replySummary = createReplySummary(helperPorts);
  // Turn ends carry no labels, so the helper is also known by its own folder: a turn that ends just
  // after voice turns off (the id already forgotten) must still stay telemetry only.
  const isVoiceHelper = (agent: { id: string; cwd: string }) =>
    agent.id === voiceHelper.agentId() || resolve(agent.cwd) === resolve(helperCwd);
  // One interpret service for the drawer's RPCs and Jarvis: it owns the switch, the helper's lifecycle and the fallback.
  const voiceInterpretService = createVoiceInterpret({
    start: async () => {
      await mkdir(helperCwd, { recursive: true });
      await Promise.all([voiceHelper.start(), replySummary.start().catch((error) => console.warn("orchestrator: reply summary start failed", error))]);
    },
    stop: async () => {
      await Promise.all([voiceHelper.stop(), replySummary.stop()]);
    },
    interpret: (req) => voiceHelper.interpret(req),
    agentId: () => voiceHelper.agentId(),
  });
  server.handle(voiceHelperStart, async (_input, { paseo }) => {
    helperPaseo = paseo;
    await voiceInterpretService.start();
    return { ok: true };
  });
  server.handle(voiceHelperStop, async (_input, { paseo }) => {
    helperPaseo = paseo;
    await voiceInterpretService.stop();
    return { ok: true };
  });
  server.handle(voiceHelperSwitch, (input, { paseo }) => {
    helperPaseo = paseo;
    if (input.enabled !== undefined) voiceInterpretService.setEnabled(input.enabled);
    return { enabled: voiceInterpretService.enabled() };
  });
  server.handle(voiceInterpret, (input, { paseo }) => {
    helperPaseo = paseo;
    return voiceInterpretService.interpret(input.transcript, { sessionId: input.sessionId, sessions: input.sessions });
  });
  // Whether the phone plays lines in the cloned voice (voice.phoneAudio) is read once and kept current.
  const voice = voiceSetting;
  let phoneAudio = false;
  let referenceClip = "";
  // Ignore me: closed until the saved value is known, open if it can't be read (see server/mic-off-gate.ts).
  const micOffGate = createMicOffGate(() => voice.read());
  const syncVoice = (state: Awaited<ReturnType<typeof voice.read>>) => {
    phoneAudio = state.status === "ready" && state.values.phoneAudio;
    referenceClip = state.status === "ready" ? state.values.referenceClip : "";
    micOffGate.sync(state);
  };
  const offVoiceSettings = voice.subscribe(syncVoice);
  void voice.read().then(syncVoice, () => undefined);
  void micOffGate.start();
  // The Speaker: the one voice for the Mac (drawer, Speak pill, Jarvis) and the phone. Its workers start now, so the cloned voice is
  // warm at launch, and stop on cleanup. Until they are up it answers "loading" and the Mac falls back to `say`.
  const speakerPorts = (deps.speakerPorts ?? realSpeakerPorts)(() =>
    resolveReferenceClip(referenceClip, existsSync, deps.defaultReferenceClip ?? DEFAULT_REFERENCE_CLIP),
  );
  const speak = createSpeaker(speakerPorts);
  server.handle(voiceSpeak, (input) => speak(input));
  speakerPorts.start();
  // Spoken replies on the Mac: a switched-on session says the short line (or, in full mode, the whole message) of each completed reply.
  const localVoice = createLocalVoice((deps.localPorts ?? realLocalPorts)(speak));
  const speakReplies = createSpeakReplies({ speak: (text) => localVoice.speak(text), hush: () => localVoice.hush() });
  server.handle(speakRepliesSet, async ({ agentId, mode }) => {
    await speakReplies.set(agentId, mode);
    return { ok: true };
  });
  server.handle(speakRepliesState, () => ({ modes: speakReplies.modes() }));
  const offTurnEnded = server.on("agent.turn_ended", (event, { paseo }) => {
    voicePaseo = paseo;
    // The Voice helper's own turns are telemetry only: its spend reaches the context card, and nothing
    // else (resume, loop, pipeline) may act on it.
    if (isVoiceHelper(event.agent)) {
      contextPaseo = paseo;
      void contextWatch.onTurnEnded(event).catch((error) => console.warn("orchestrator: context watch failed", error));
      return;
    }
    voiceResume.onTurnEnded(event);
    // A memory replay's agent is the runner's business only: the telemetry row first, then its result row.
    if (memoryReplay.pendingAgents().includes(event.agent.id)) {
      replayPaseo = paseo;
      contextPaseo = paseo;
      void contextWatch
        .onTurnEnded(event)
        .catch((error) => console.warn("orchestrator: context watch failed", error))
        .then(() =>
          event.outcome.kind === "completed"
            ? memoryReplay.onTurnEnded({ agentId: event.agent.id })
            : memoryReplay.onAgentFailed({
                agentId: event.agent.id,
                error: event.outcome.kind === "failed" ? event.outcome.error.message : `canceled: ${event.outcome.reason}`,
              }),
        )
        .catch((error) => console.warn("orchestrator: memory replay failed", error));
      return;
    }
    // A session on the Speak pill is heard on one device only. Phone active with voice.phoneAudio on: its reply goes through the
    // router as a watched reply (a `voice-line`), and the Mac stays quiet. Otherwise the pill speaks it on the Mac and its reply is
    // kept from the drawer and Jarvis, so it is never said twice.
    // A reply is never heard nowhere: if every phone loop is asleep it would drop the watched reply, so the Mac plays it instead.
    const picked = speakRoute({
      pill: speakReplies.has(event.agent.id),
      phoneActive: jarvisConnection?.isActive(Date.now()) ?? false,
      phoneAudio,
    });
    const route = picked === "phone" && !jarvis.listening() ? "mac" : picked;
    if (route !== "phone") speakReplies.onTurnEnded(event);
    const events = turnEvents(event, { watched: route === "phone" }).filter((e) => !(e.type === "reply" && route === "mac"));
    // Only a reply a loop will say gets a summary: watched, or from a target (a Mac-route reply is filtered above). Off or late, it goes without.
    publishInOrder(async () =>
      Promise.all(
        events.map(async (e) => {
          if (e.type !== "reply" || !(e.watched || jarvis.speaks(e.sessionId)) || !voiceInterpretService.enabled()) return e;
          const summary = await replySummary.summarize(e.text).catch(() => null);
          return summary ? { ...e, summary } : e;
        }),
      ),
    );
    loop.rememberPaseo(paseo);
    pipelinePaseo = paseo;
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
  // Paseo hands the plugin its API only inside events and RPCs, and the tick does nothing until it
  // has one. Any session event arms it, so after a restart supervision resumes as soon as a session
  // opens or starts a turn, not only at the next turn end.
  const arm = (paseo: Parameters<typeof loop.rememberPaseo>[0]) => {
    loop.rememberPaseo(paseo);
    initiativeLoop.rememberPaseo(paseo);
    pipelinePaseo = paseo;
  };
  const offSessionOpen = server.before("agent.session_open", (_input, { paseo }) => {
    arm(paseo);
  });
  const offTurnStarted = server.on("agent.turn_started", (event, { paseo }) => {
    arm(paseo);
    voiceResume.onTurnStarted(event.agent.id);
    speakReplies.onTurnStarted(event.agent.id);
  });
  const offAgentCreated = server.on("agent.created", (_event, { paseo }) => arm(paseo));
  const offPermissionRequested = server.on("agent.permission_requested", (event, { paseo }) => {
    arm(paseo);
    publishInOrder(() => permissionEvents(event));
    void initiativeLoop.onPermissionRequested(paseo, event).catch((error) => {
      console.warn("orchestrator: loop permission request failed", error);
    });
  });
  const offPermissionResolved = server.on("agent.permission_resolved", (event, { paseo }) => {
    arm(paseo);
    void initiativeLoop.onPermissionResolved(paseo, event).catch((error) => {
      console.warn("orchestrator: loop permission resolve failed", error);
    });
  });
  void loop.seedMergedPrs();
  const timer = setInterval(() => {
    void loop.pollMergedPrs();
    void initiativeLoop.tick();
    if (pipelinePaseo) {
      void watchPipelinePrs(pipelinePaseo, readPipeline, readAgentConfig).catch((error) => {
        console.warn("orchestrator: pipeline CI watch failed", error);
      });
    }
  }, PR_POLL_MS);
  timer.unref?.();
  // A Claude session starts the replay by writing the start file; any Paseo handle we have seen will do.
  const replayStart = deps.replayStart ?? { file: REPLAY_START_FILE, everyMs: REPLAY_START_POLL_MS };
  const paseoNow = () => contextPaseo ?? pipelinePaseo;
  const replayStartTimer = setInterval(() => {
    void tickReplayStart(replayStart.file, () => paseoNow() !== null, (input) => startReplay(input, paseoNow()!)).catch(
      (error) => console.warn("orchestrator: replay start file failed", error),
    );
  }, replayStart.everyMs);
  replayStartTimer.unref?.();
  // The same for the initiative loop.
  const loopStart = deps.loopStart ?? { file: LOOP_START_FILE, everyMs: LOOP_START_POLL_MS };
  const loopStartTimer = setInterval(() => {
    void tickLoopStart(loopStart.file, () => paseoNow() !== null, (input) => startLoop(input, paseoNow()!)).catch(
      (error) => console.warn("orchestrator: initiative loop start file failed", error),
    );
  }, loopStart.everyMs);
  loopStartTimer.unref?.();
  // Jarvis: a provider whose sessions route what you say (Paseo voice mode) to the Voice drawer's target.
  // Providers get no Paseo handle, so it uses the last one any event or RPC gave.
  const jarvisPaseo = () => {
    const paseo = paseoNow() ?? voicePaseo ?? helperPaseo;
    if (!paseo) throw new Error("Paseo isn't ready yet. Try again in a moment.");
    return paseo;
  };
  const liveAgents = async () => {
    const listed = await jarvisPaseo().agents.list({ filter: { includeArchived: false }, page: { limit: 200 } });
    return listed.entries.map((entry) => entry.agent).filter((agent) => agent.status !== "closed" && !agent.archivedAt);
  };
  const jarvis = createJarvisRouter({
    sessions: async () => splitSessions(await liveAgents()),
    // "Status": the same live agents; the line itself is built in shared/voice-status.ts.
    status: liveAgents,
    send: (sessionId, text) => jarvisPaseo().agents.ref(sessionId).send(text, { activeTurnBehavior: "steer" }),
    interpreter: voiceInterpretService,
    create: voiceSessionCreator(jarvisPaseo),
    // "Good morning, Jarvis": weather, the verse, your Jira stories and the priority initiative, one beat at a time.
    brief: createMorningBrief({
      weather: () => fetchWeather(),
      verse: () => loadDailyVerse(),
      stories: () => listMyWorkStories(),
      boards: async () => {
        const { repo } = await readHarness();
        return repo ? (await loadHarnessBoards([repo], await readHarness())).boards : [];
      },
      startLoop: (target) => startLoop(target, jarvisPaseo()),
    }),
  });
  // What each event says to the phone: the router steps it into every router's loop, and the open voice-mode
  // session says (or is owed) the lines. The drawer reads the same events from the hub.
  let jarvisConnection: JarvisConnection | null = null;
  publishVoice = (events) => {
    for (const event of events) {
      voiceHub.publish(event);
      void jarvis
        .event(event)
        .then((byRouter) => Promise.all(Object.entries(byRouter).map(([routerId, lines]) => jarvisConnection?.say(routerId, lines))))
        .catch((error) => console.warn("orchestrator: Jarvis event failed", error));
    }
  };
  server.handle(voiceEvents, async ({ after }) => ({ ...(await voiceHub.read(after)), phoneActive: jarvisConnection?.isActive(Date.now()) ?? false, voice: jarvisConnection?.voiceState(Date.now()) ?? "unknown", settingsUnreadable: micOffGate.unreadable(), settingsChecking: micOffGate.checking() }));
  // The drawer's "good morning": the same briefing as Jarvis, under its own router id so its open briefing is the drawer's.
  server.handle(voiceBrief, async ({ text }) => {
    const briefed = await jarvis.brief("drawer", text);
    return briefed && { spoken: briefed.spoken };
  });
  // The drawer's "status": the same line as Jarvis says on the phone.
  server.handle(voiceStatus, async ({ text }) => {
    const answered = await jarvis.status("drawer", text);
    return answered && { spoken: answered.spoken };
  });
  // A Jarvis session or the Voice helper is refused (ok: false), or Jarvis would steer itself.
  server.handle(voiceTarget, async (session, { paseo }) => {
    helperPaseo = paseo;
    return { ok: (await jarvis.setTarget(session)).ok };
  });
  // Paseo 0.11.0+ only, like the usage source.
  const jarvisProvider = createJarvisProvider({
    route: jarvis.route,
    warm: voiceInterpretService.warm,
    owe: jarvis.owe,
    playbackEnded: jarvis.playbackEnded,
    phoneAudio: () => phoneAudio,
    // voice.micOff: what Paseo voice mode heard is dropped before the router; the drawer shows what got through.
    muted: () => micOffGate.muted(),
    heard: (_routerId, text) => voiceHub.publish({ type: "heard", text }),
    // On the Mac Jarvis speaks through the same Speaker; false (an empty line) lets Paseo's `speak` take it.
    localSpeak: async (text) => (text.trim() ? (await localVoice.speak(text)) !== undefined : false),
  });
  server.registerProvider?.({
    ...jarvisProvider,
    async connect(...args) {
      const connection = (await jarvisProvider.connect(...args)) as JarvisConnection;
      jarvisConnection = connection;
      return connection;
    },
  });
  return () => {
    offPulseSettings();
    offVoiceSettings();
    micOffGate.stop();
    stopPlanServer();
    offBeforeCreate();
    offWorkspaceCreated();
    offTurnEnded();
    offSessionOpen();
    offTurnStarted();
    offAgentCreated();
    offPermissionRequested();
    offPermissionResolved();
    clearInterval(timer);
    clearInterval(replayStartTimer);
    clearInterval(loopStartTimer);
    voiceResume.stop();
    speakerPorts.stop();
    void voiceInterpretService.stop().catch((error) => console.warn("orchestrator: voice helper stop failed", error));
  };
}
