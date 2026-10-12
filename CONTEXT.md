# Orchestrator: vocabulary

This file defines the words the plugin code uses: the Skills drawer, the Story pipeline and the skill sources behind them, and the context meter that watches each session's size. Later work should reuse these names instead of making up new ones. When code adds or renames one of these concepts, update this file in the same change.

## Phase 1 rule

Skills are used through pinned sources, worktree copies and attachments. They are **never installed** into `~/.claude/skills` or `~/.agents/skills`, and the plugin never runs `npx skills add`. The `installed` source only *reads* those folders. Nothing in the plugin writes to them.

## Skill source

A place skills are read from. Code: `SkillSource` in `shared/pipeline.ts` (`id`, `label`, `location`, `kind`, `enabled`, `pin`). Sources are stored in the pipeline settings (`sources`) and managed on the drawer's **Sources** tab. There are three kinds of location, worked out by `parseLocation` in `server/skill-sources.ts`:

- **git**: an `owner/repo` (taken as GitHub) or a git URL (`https://`, `ssh://`, `git@`). `addSource` clones it and pins it to the current commit.
- **folder**: an absolute or `~/` path. Read live in place. It has no pin and no checkout.
- **`installed`** (`MACHINE_SOURCE`): the skills already on this machine. `scanMachine` reads `~/.claude/skills`, `~/.agents/skills` and `~/.claude/commands`. It is never stored in `sources` and nothing is copied for it. The drawer shows it as **This machine**.

`kind` (`team`, `personal`, `imported`) says who owns the source. It does not say how the source is read. `enabled: false` keeps a source connected but leaves its skills out of the catalog.

- **Pin**: the commit a git source is held at (`pin`). It only moves when someone runs **Check for updates** (`checkSource`), which fetches without moving the pin, and then presses **Update to `<sha>`**. Folder and `installed` sources have no pin.
- **Checkout**: the local clone of a git source, at `SOURCES_ROOT/<id>` (`~/.orchestrator/skill-sources/<id>`). `materialise` keeps it on the pin before anything is read from it.

_Avoid_: repo, registry, library, provider (for a source); version, ref (for the pin).

## Catalog skill

One skill that can be picked, as listed by `loadCatalog`. Code: `CatalogSkill` (`name`, `folder`, `description`, `source`, `kind`). The catalog is every `installed` skill plus the skills of each enabled source.

- `name` is the `name` in the skill's `SKILL.md` frontmatter, falling back to `folder` when there is none. This is the name skills.sh uses. For a command it is the file name without `.md`.
- `folder` is the folder holding `SKILL.md`, or the command's file name without `.md`.
- `description` is the frontmatter `description` (one line, trimmed), or `""`. `readFrontmatter` parses both keys.
- `source` is the `id` of the Skill source it came from, or `installed`.
- `kind` is `skill` (a folder with `SKILL.md`, found up to five folders deep) or `command` (a `.md` file in `commands/` or `.claude/commands/`).

_Avoid_: plugin, tool, package.

## Skill ref

A pointer from the pipeline settings to a catalog skill. Code: `SkillRef` (`name`, `source`). It matches a catalog skill on the same `source` whose `name` or `folder` equals the ref's `name` (`matchesRef` in `shared/pipeline.ts`; `findSkill` on the server prefers a `name` match). Refs saved with folder names keep working. A ref whose source is gone, turned off, or has no skill by that name is not an error when saved. `installSkills` reports it as a warning when the phase starts.

_Avoid_: skill id, skill key.

## Pipeline phase extras

The extra skills a Story pipeline phase loads on top of the skill it runs. Code: `Phase.extras`, an array of `Extra` (a Skill ref plus optional `required` and `optional` flags). The skill the phase runs is `Phase.runs`, a single Skill ref or `null` for the built-in step, and is not an extra. The phase prompt names the extras with "Also use these skills: …".

An extra marked `required` in `DEFAULT_PHASES` is always loaded, even if saved settings removed it. `phaseSkills` adds it back. The defaults have none today: every phase runs its built-in step from `shared/story-method.ts`, and `Phase.runs` is `null` unless you pick a skill.

The initiative loop uses the same extras: each loop step loads the extras of the phase it maps to (see Loop step skills).

_Avoid_: add-ons, plugins, secondary skills.

## Loop step skills

The skills an initiative loop step loads: the extras of the Skills drawer phase that the step maps to. plan and diagnose → Plan, implement and fix → Implement, review → Review, pr → Done. Code: `LoopStep` in `shared/initiative-loop.ts` names the steps; the extras come from `Phase.extras`, with `required` ones added back through `phaseSkills`, as for the pipeline. They reach the loop agent by the Worktree copy into the story worktree, and the step prompt names them with "Also use these skills: …", left out when there are none. A ref that can't be found is a warning on the story, never a failed step.

`Phase.runs` is pipeline-only. The skill a phase runs carries its own `.harness/state.md` contract, which would fight the step prompt, so a loop step loads only the extras. The pipeline switch (`enabled`) does not affect loop step skills: they load whether the Story pipeline is on or off.

Review is an audit container. No skill is forced into it by default; the loop's review step loads whatever the user adds to the drawer's Review phase.

_Avoid_: loop skills, step extras.

## Worktree copy

How drawer skills reach a new story agent, whether a Story pipeline phase or an initiative loop step starts it. `installSkills` copies each non-`installed` Skill ref from its source into the story worktree: for a pipeline phase the `runs` skill and the extras, for a loop step only the extras of its phase (see Loop step skills).

- a skill folder goes to `.claude/skills/<folder>`, `.cursor/skills/<folder>` and `.agents/skills/<folder>`, named after its folder, not its frontmatter `name`;
- a command goes to `.claude/commands/<folder>.md` and `.cursor/commands/<folder>.md`.

The copied paths are added to the worktree's `info/exclude` so they never show up in git. A path the repo already commits is left alone. `installed` refs are skipped because those skills are already global. When two refs in one phase resolve to different skills with the same folder (two sources that both have `review/`, or `engineering/review` and `personal/review` in one source), the first one in ref order keeps the folder and the second is skipped with a warning naming both; the same skill listed twice is copied once, quietly. This copy is the only way skills are "installed", and it happens per worktree.

_Avoid_: install (on its own, which reads as global), sync, deploy.

## skills.sh registry

The public skills.sh index, used to *find* skills. Searching it gives a GitHub `owner/repo` that holds the skill. That repo is then connected as a git Skill source, pinned like any other. The registry never installs anything and is not a Skill source itself. The Skills drawer's Sources tab searches it (**Search skills.sh**); **Connect** on a result adds its repo as an imported source.

_Avoid_: marketplace, store, skills.sh source.

## Skill attachment

A skill handed to an agent that is already running, through that agent's composer, instead of through a pipeline phase. The skill is read from a connected Skill source. Nothing is copied into the worktree or installed globally. Pipeline phase extras serve new story agents. Attachments serve running agents. `readSkill` returns what an attachment carries: the `SKILL.md` body after the frontmatter, absolute paths to the skill's other files in the pinned checkout, folder or machine path, and the source's pin as `commit`. It reads only connected, enabled sources (and `installed`) and never clones anything else. Every composer offers them through the **Skills** attachment source (`skills.attach`): the attached text is a header naming the skill, its source and short pin, then the body, then a `## Files in this skill` list.

_Avoid_: skill injection, skill upload.

## Context meter

The pure function that turns what a session reports into a context reading. It reads the agent's `lastUsage`, its command list and its timeline, and never its provider name. There are no `provider === …` branches. Code: `readContext(snapshot, policy)` in `shared/context-meter.ts`, where `policy` is a `MeterPolicy` (the step's **Context policy**, plus `default`'s as the fallback). `thresholdsFor(policy, max)` turns the percents into absolute `Thresholds`, which the pill and the story panel show.

- **Context reading**: one measurement of a session at the end of a turn: `used` (`lastUsage.contextWindowUsedTokens`), `max` (`lastUsage.contextWindowMaxTokens`), plus its level, capability and compact strategy. `lastUsage` is read from `paseo.agents.ref(id)` after `refresh()`. A fresh handle reads `null` until then. List entries carry it too, at `entry.agent.lastUsage`.
- **Context policy**: when a session warns and acts, set per loop step as a percent of its window. The `context` setting (v2) holds `default`, `plan`, `implement`, `review` as `{ warn, act, mode }` (`mode` is `compact` or `fresh`; defaults 70 / 85, `compact` for Implement, `fresh` otherwise) plus `autoCompact`. A session's step comes from its `loop-step` label through `STEP_PHASES` (Diagnose → plan, Fix → implement); a session with no step, a Pr step or a replay agent uses `default`. Code: `meterPolicy(config, labels)` in `shared/context.ts`. v1's `amber`/`red` token counts migrate to `default` as a percent of 200k (100k / 150k → 50 / 75). Acting in the chosen `mode` is not wired yet; for now `mode` only decides the story panel's act word ("hand off" when `fresh`).
- **Level**: how full the session is under its step's policy: `ok`, `amber` (used / max at or past `warn`), `red` (at or past `act`), or `unknown` when the agent reports no usage. With no `max` the meter uses `default`'s percents of a 200k window.
- **Capability**: how much the agent reports, which decides what the meter can do:
  - **Full**: usage and max, a `compact` entry in `commands()` (match `name === "compact"` exactly; `autocompact` is a different entry), and `compaction` timeline items with `preTokens`. Claude is Full.
  - **Partial**: usage and max but no `compact` command. Compacting uses the fresh strategy.
  - **Basic**: no usage. The level is `unknown`; the strategy still follows the command list.
- **Compact strategy**: what Compact does for this session. **native** sends `/compact Keep: <keep-list>` to the running agent, which summarises in place. **fresh** writes a handoff and starts a new agent in the same workspace. A `compact` entry in the command list gets native; anything else gets fresh.
- **Compactor**: the module that carries out a compact strategy, with one adapter per strategy (`Compactor.compact(agent, keepList)`). A native compact shows up in the timeline as a `compaction` item with `status: "completed"` and `preTokens`, then a smaller next reading. Paseo still echoes the `/compact …` text as a `user_message`, but no assistant reply follows it.
- **Fresh adapter**: the compactor for the fresh strategy, and for **Start fresh** on any session. Code: `freshCompactor(port)` in `server/compactor.ts`, talking to Paseo and the initiative loop only through a `FreshPort`. It refuses a session that is mid-turn. An ordinary session first runs one more turn that writes the **handoff** (`.harness/handoff.md` in its cwd, overwritten each time; `.harness/` is kept out of git), and the new session is told to continue from it. A loop agent (`kind: initiative-loop`) gets no handoff turn: the loop rebuilds its step prompt from the story files and adds "Resume from `.harness/state.md`" (`resumePrompt`). Either way it creates one agent in the same workspace with the same provider/model, mode and thinking option, the old title + " · fresh", and the old labels plus `context-from: <old id>`. For a loop agent the story's `agent:` frontmatter then moves to the new session (`handOver`, only while it still names the old one). Last, the old session is archived. A failed handoff or create archives nothing.
- **Keep-list**: what a compact tells the agent to keep. Code: `keepList(labels)` in `server/compactor.ts`: `.harness/state.md`, files changed this session, failing tests and their output. A loop agent (with `loop-step` and `loop-story` labels) also keeps `step <step>` and `story <id>`. The native adapter (`nativeCompactor`) sends it as `/compact Keep: <list>.`.
- **Context watch**: the server side that runs the meter. Code: `createContextWatch(port)` in `server/context-watch.ts`, talking to Paseo only through a port (`paseoPort`). On `agent.turn_ended` it takes a context reading, records a telemetry row, decides on a warning, and serves the pill and the stats strip over RPC (`orchestration.context.act`, `orchestration.context.sessions`, `orchestration.context.summary`). `sessions(agentIds)` gives each session's pill status: the reading from its last turn end, its warning memory and the red threshold. A session the watch has not seen yet is read on the spot with empty memory, and a gone one is null. `turn_ended.timeline` is the whole timeline so far, so the watch only looks at items it has not seen yet: a per-agent cursor (the timeline length at the last turn end). The first time it sees an agent, only items after the last `user_message` count, so a restart does not count old compactions again. On a loop agent's `turn` rows it also writes `explore`: next to the cursor it keeps the `read`/`search`/`edit`/`write` tool calls seen so far (`toolSteps` in `shared/exploration.ts`, read by `detail.type` only) and counts them with `exploration` until the first edit or write outside `.harness/` (for the Plan step, the write that fills `## Plan`), then freezes the count. It only counts a session it saw from its first turn: first sight mid-session or a replaced, shorter timeline records `explore: null` from then on. Shell calls are classified from their command text alone (`classifyShell` in `shared/shell-steps.ts`, never the provider): each simple command in the call (split on `;`, `&&`, `||`, `&`, newline and `|`, with `cd`, `NAME=value` and `bash -c '…'` followed) is `read`, `search`, `edit`, `write` or `other`, and `other` is dropped. Relative paths resolve against the call's `cwd` and any `cd`, and paths that cannot be resolved (`$(…)`, globs) are dropped while the step still counts. Writes to scratch paths (`/tmp`, `/dev`, `/private`, `/var/folders`) are `other`. The whole `detail.output` of a completed call goes on its first read or search step, so `chars` counts it once. Known gap: `python3`/`node` scripts that write files count as `other`. Readings, warning memory, cursors and exploration counts live in server memory and are not persisted. A compaction is recorded by the turn end that sees it (the `compaction` item, or a drop to under half), not when Compact is pressed, and it re-arms the session's warnings. A fresh compact is recorded the same way: the new session's first turn end writes `compact.fresh`, with the old session's last `used` as `preTokens`. That pending entry lives in memory too, so a restart in between loses one row. After the warning step it runs the **Auto-compact** rule (`shouldAutoCompact`): at red (the step's act %) it acts in the step's policy mode (`actStrategy` in `shared/context-meter.ts`): `compact` sends native `/compact Keep: …` when the session has `/compact` and otherwise starts fresh (a fallback), `fresh` starts the fresh adapter. It remembers what it started so the compaction row it later writes carries `trigger: "auto"`. It fires once per red crossing (`memory.auto` is `armed`, then `sent`) and a compaction re-arms it, though never on the turn end that records the compaction, so a reading still red after a compact does not loop. It never fires when the `autoCompact` setting is off, the agent is running or has a permission pending (read fresh from the agent), the turn ended `failed` or `canceled`, the session is on Ignore or skipped, or the agent is a replay step. A loop agent acts only while `stepActive` holds (the story's `agent:` is this session and its marker is `<step>-running`; `initiativeLoop.stepActive`), so a step that just wrote `-done` is left alone. A fresh auto compact is started after the turn end's rows are written and not awaited, since its handoff turn can run for minutes. `skip-auto` sets `memory.auto` to `skipped`; a compaction does not clear that. A session's pill status carries `auto`: whether it will compact on its own at red.
- **Warning**: the notice raised when a session's level rises to `amber` or `red`. At most one per session per level. It honours **Remind me at 150k** (wait for red) and **Ignore**. Code: `nextWarning(memory, reading)`.
- **Auto-compact**: the context watch compacting a session on its own when it turns red, in the mode of the session's step policy: `compact` (native `/compact`, or fresh when the session has none) or `fresh`. Setting: `autoCompact` in the context settings, default on. Once per red crossing, re-armed by a compaction; never for Ignore, **Don't auto-compact**, a running or permission-blocked agent, a failed or canceled turn, a replay agent, or a loop agent whose step is no longer running. Recorded as `trigger: "auto"` on the compaction row. Code: `shouldAutoCompact` and `actStrategy` in `shared/context-meter.ts`. A manual Compact from the pill ignores the mode and follows the session's capability. Amber still only warns.
- **Telemetry row**: one line in `~/.orchestrator/context-telemetry.jsonl`: `{ at, agentId, provider, step, used, max, event }`, where `event` is `turn`, `turn.stopped`, `warning`, `compact.native`, `compact.fresh`, `compact.inferred`, `ignore` or `remind`. Every completed turn end writes one `turn` row (with `used: null` on a Basic session). A canceled or failed turn end writes a `turn.stopped` row instead, with the same fields, so turn counts stay completed-only while an agent whose last turn fails keeps its cost and explore count; the summary does not count `turn.stopped` rows as turns. A turn end repeating the last handled `turnId` is skipped, and turn ends for one agent run one at a time. `warning` rows add `level`; `compact.*` rows add `preTokens`, so the summary can count tokens avoided. `step` is the agent's `loop-step` label, or null. Rows may also carry `model` (from the agent's config, null for a provider default), `cycle` (the `loop-cycle` label as a number, null unless it is all digits), `story` (the `loop-story` label) and `initiative` (the `loop-initiative` label, so a `story` id that repeats across initiatives stays distinct); `cycle`, `story` and `initiative` are null outside the loop. Rows also carry `costUsd`, the session's running total dollar cost so far (null when the agent reports none); do not sum it across rows. `turn` and `turn.stopped` rows add `turnId` (Paseo's id for the turn, null when the provider gives none) and `turnCostUsd`, this turn's cost alone: `costUsd` minus the session's `costUsd` at its previous turn end (never below 0), equal to `costUsd` on the session's first turn and null when the cost is null or the watch first saw the session mid-way. Summing `turnCostUsd` gives real spend. All of these are optional, so rows from before they existed still parse. `turn` rows of a loop step also carry `explore`, `{ reads, searches, files, chars, edited }`: what the step has read before its first code edit (`files` = distinct files opened by a read, `chars` = characters its reads and searches returned, `edited` = the count has frozen); it is null when the watch lost the count and absent outside the loop and on older rows. The summary's `byStep[step].explore` sums each agent's last `explore` as `{ agents, reads, searches, files, chars, edited, unknown }`, where `edited` counts agents that reached an edit and `unknown` those whose count was null. `provider` and `model` are recorded for analysis only and never branched on. Once the file would pass 5 MB it moves to `context-telemetry.1.jsonl` (replacing an older one) and a new file starts; the summary reads both, so totals survive a rotation. `compact.*` rows the watch started at red also carry `trigger: "auto"`; a row with no `trigger` is a pill Compact or Claude's own compaction. A `compact.fresh` row also carries `fallback: "fresh"` when Compact was asked for (by a `compact` step mode at red, or the pill) but the session has no `/compact`, so it started fresh; the summary does not count it yet. `skip-auto` is one more event, written when the user opts a session out. The summary's `compactions` is `{ native, fresh, inferred, auto }`, where `auto` counts rows with `trigger: "auto"` (they also count in `native` or `fresh`).

- **Spend**: dollars spent today and over the last 7 calendar days (`spendToday`, `spendWeek` in the summary). Per agent it is the last running-total `costUsd` in the window minus its last one before the window (never below 0), summed over agents. Rows without a cost are skipped and the rotated file counts. Today starts at the caller's `today` (ISO) or the server's local midnight. Code: `summariseTelemetry`.
- **Context pill**: the composer pill on every live session with a workspace, showing `used / max` (`82k / 200k`), a dot in the level's colour, and the compact strategy in its title ("Compact: /compact in place", or "Compact unavailable, starting fresh" for a session without `/compact`). It is grey `Context ?` when the session reports no usage. Its menu is Compact now, Start fresh, Remind me at <red>, and Ignore, each through `orchestration.context.act`. It shares the role pill's one `agents.list` subscription (`client/session-role-pills.ts`), and refetches its status through `orchestration.context.sessions` when a session's used/max changes or a turn ends. A warning toasts once per session per level, shown by the pill's icon (`client/context-pill-icon.tsx`) when that session's composer is on screen. Warnings raised before the app started only colour the pill. The rules are pure, in `client/context-pill-model.ts`. Its menu also has **Don't auto-compact** (`skip-auto`), disabled when the session will not auto-compact; it lasts for the session and survives a compaction. With auto-compact on, the amber toast reads "…; compacts automatically at <red>. Pick \"Don't auto-compact\" in the pill menu to stop it." and the red toast "…; compacting now."; otherwise the plain warning. The stats strip's Compactions tile reads `taken N (A auto) vs ignored M`, and the tile next to it, "Claude's own compacts", counts inferred compactions.
- **Recap pill**: the composer pill on every live Claude session with a workspace. It sends Claude Code's `/recap` (the session recap ⌘K offers) to that session, and is disabled while a turn runs. A failed send toasts through the context pill's icon. It rides the same `agents.list` subscription as the role and context pills; the rules are in `client/recap-pill-model.ts`.
- **Story context**: one story's current session as the story panel shows it, from `orchestration.story.context` `{ repo, initiative, storyId }`. The session is the story file's `agent:` (found across the initiative's phases); the result is null when there is none or the agent is gone. It joins the watch's live reading (`live(agentId)`: reading, labels, split inputs), the story's telemetry rows and the thresholds: `step` (the `loop-step` label), `used`, `max`, `percent`, `level`, `session` (1 + fresh hand-offs on this step since the story last ran another step), `compactions` (native + inferred for this agent), `burn` (mean of the last 5 turn deltas since the last compact, never below 0), `turnsToAct` (turns at that burn until the act marker, or "now"), `markers` (warn = amber, act = red, as tokens and % of max; the act word is "compact" for native, "hand off" for fresh) and an estimated `split` into system, conversation and tool tokens (null whenever the watch can't trust it). It also carries `costUsd`, the cost so far: for each of the story's agents (any telemetry row with this initiative and story) its last cumulative `costUsd`, summed; null when none of those rows has a cost. Code: `contextPanel` in `shared/context-panel.ts`, `loadStoryContext` in `server/story-context.ts`, `storyCost` in `server/context-telemetry.ts`.

_Avoid_: token meter, context gauge (for the meter); threshold state (for level); summarise, reset (for compact); alert, nag (for warning).

## Gate

A point where an agent is paused waiting on you. A story has at most one gate, decided by its status alone:

- **plan**: `awaiting-approval`. Text "Plan awaiting approval".
- **merge**: `pr-open` with CI `green`. Text "PR #N ready to merge", or "PR ready to merge" with no PR number. Pending or failing CI is not a gate.
- **stuck**: `blocked`. Text is the blocked reason, or "Blocked" when there is none. Loop supervision blocks a story once its retries run out, when the evidence says it is stuck (see **Stuck**), or while its session waits on a permission request.

Each gate carries `board` (the board's selection key, `boardKey(board)`: `repo` + `"\n"` + `initiative`), `storyId`, and `where` (initiative title and phase label, "Orchestration Redesign · Phase 1"). `gatesOf(boards)` lists them in board order, then story order. A board whose state is null or failed to load has none. `needsYou(story)` is "has a gate", and the epic board's "Needs you" group and badges use it. Gates carry no time: stories have no timestamp. Code: `shared/gates.ts`.

_Avoid_: blocker (for any gate), task, todo, action item.

**Gate action**: acting on a story's gate from outside its session (`gateAct`, `orchestration.gates.act`, with the board key, story id and action). Seven actions, each belonging to one gate:

- **approve** (plan): sends "Approved. Go ahead." to the story's agent. Frontmatter is untouched; the planner's own `plan-done` moves the story on.
- **changes** (plan): sends nothing and returns the agent id, so you can open the session and say what to change.
- **nudge** (stuck): sends the nudge message, then reopens the story.
- **restart** (stuck): Start fresh on the agent (the context watch's fresh adapter), then reopens the story; the new session's id comes back. The fresh adapter's own refusals pass through.
- **retry** (stuck): what it does depends on the story's `block_kind`, which every block writes:
  - `start` (could not start), `pr` (PR failed to open, closed, or missing), `ci` (CI fix limit or a failed fix push): reopen only, and the loop picks the story up again. `ci` also clears `fix_attempts` and `fixed_sha`.
  - `retry-limit`, `stuck`, `step` (implement-blocked, an unticked cycle after implement-done, the review-failed limit), or none (older blocks): session open → reopen, then send the retry message; session ended or gone → the loop starts the same step, round and cycle in a fresh session, whose id comes back. With no agent set, reopen only.
  - Refused while an open session waits on a permission, and for a `pr` block whose PR is still closed (reopen it on GitHub first).
  - If the retry message can't be sent, the story stays reopened and the error comes back.

  The retry button sits on a blocked story's inline panel and in its Details drawer.
- **continue** (cost): raises the story's **Cost cap** by the base cap and reopens it. Marker running and session open → sends the continue message; session ended → the loop starts the same step in a fresh session; marker already done → nothing more. Refused off a cost-cap block. Retry on a `cost-cap-left` block behaves the same.
- **leave** (cost): marks a `cost-cap` block as `cost-cap-left`: it stays blocked on the board but drops out of Needs you. Refused off a cost-cap block.

Reopen puts the story back to `blocked_from` and clears `blocked_reason`, `blocked_from`, `block_kind`, `waiting_on`, `stalled`, `retries`, `idle_turns`, `fail_tests`, `fail_runs` and `stuck_nudged` (a `step` block also sets its state.md marker back to `<step>-running`), so the loop's marker flow and supervision pick it up again. An action is refused, with nothing sent, when the story is not on that board, its status no longer matches the action's gate ("S12 is now implementing, not awaiting approval."), it is waiting on a permission (answer it in the session), or it has no live agent (none set, unknown, or archived; a closed or errored session counts too, except for restart, which can start fresh from one, and retry, which follows its own rules above). There is no action for the merge gate. Code: `server/gate-actions.ts`.

## Step bar

The five-segment bar that shows where a story is: **Plan**, **Implement**, **Review**, **PR**, **CI watch**. Each segment is `done` (finished), `now` (running), `gate` (waiting on you) or `todo` (not reached). Steps before the current one are `done`, steps after it `todo`. With it come a node sub-label (`sub`), a panel line (`detail`) and a button label (`cta`, a label only).

| status | bar | sub |
|---|---|---|
| `todo` | todo ×5 | "Ready to start" if `ready`, else "after S0" (first dependency not merged in the board) |
| `planning` | now on Plan | "Planning" |
| `awaiting-approval` | gate on Plan | "Plan awaiting approval" |
| `implementing` | now on Implement | "Implementing" |
| `reviewing` | now on Review (the loop's PR step also runs here) | "Reviewing" |
| `pr-open`, CI pending, `""` or `none` | done ×4, now on CI watch | "CI running" |
| `pr-open`, CI `failing` | done ×4, now on CI watch | "CI failing" |
| `pr-open`, CI `green` | done ×4, gate on CI watch | "Ready to merge" |
| `blocked` | gate on the `blockedFrom` step (Plan when empty or unknown) | "Stuck · no progress"; `detail` is the blocked reason or "Blocked" |
| `merged` | done ×5 | "Merged #N", or "Merged" with no PR |
| anything else | todo ×5 | the status text |

- **Track**: `plan` or `diagnose`, which first step the story runs. On `diagnose` the first label is **Diagnose** instead of Plan, and the planning texts read "Diagnosing" / "Diagnosis awaiting approval". The bar itself is the same. It comes from the story's `track:` frontmatter (`EpicStory.track`, read by `readStories`); anything other than `diagnose` is `plan`. See Diagnose track.
- **blockedFrom**: the status a blocked story was blocked from, read from its `blocked_from` frontmatter (written by `block()` in `server/initiative-loop.ts`), `""` when unset.
- **Context bar** (`$`): a second bar under a board node's step bar, shown only for a running or `blocked` story with an `agent` (`planning`, `implementing`, `reviewing`, `pr-open`, `blocked`). It fills to the session's context used / max, coloured by level (ok green, amber, red), with a red **act marker** at the red threshold / max. No reading (no used or max, gone agent, failed call) means no bar. Code: `contextAgents` and `nodeContext` in `client/epic-board-model.ts`, read through `contextSessionsRpc`.
- **Initiative badge**: one badge per board, first match wins: **Needs plan** (no stories, no plan), **Planning** (no stories, a plan), **Done** (every story merged), **Needs you** (any story with a gate), **In progress** (any story planning, implementing, reviewing or `pr-open`), **Ready** (any `ready` story), otherwise **In progress**. It uses `needsYou`, so it agrees with the gate queue.

Code: `shared/story-steps.ts`, `stepBar(story, track, stories?)` (`stories` is the board, to name the dependency a todo story waits on) and `initiativeStatus(state)` (an `EpicBoardState`).

_Avoid_: progress bar, pipeline, stepper (for the bar); stage, phase (for a step); status pill (for the initiative badge).

## Diagnose track

The way a bug story starts: a Diagnose step instead of Plan. A story whose frontmatter says `track: diagnose` starts on the `diagnose` loop step (`startStory`). The bug's Jira key and link come from frontmatter `jira:` and `jira_url:` (`StoryContext.ticketKey`, `ticketUrl`), and the step prompt names both under `## Bug`. The Diagnose agent reproduces the bug, finds the cause, and writes `## Plan` and `## Cycles` into `.harness/state.md`, the first cycle a failing regression test. Then it sets `diagnose-done` without asking anyone.

There is no gate. `reconcile` hands `diagnose-done` straight to Implement, as it does `plan-done`, so Implement, Review, PR and CI watch run unchanged and the story is never `awaiting-approval`. `diagnose-blocked` blocks the story with the reason on the next line. A turn that ends with neither marker is stalled and nudged by Loop supervision, since nobody is waiting on it. While it runs the story's status is `planning` (the first step of the bar, labelled **Diagnose**). Diagnose loads the Plan phase's extras (`STEP_PHASES.diagnose = "plan"`) and runs on the Plan step's profile, Opus when unset; it has no profile row of its own. Code: `STEPS.diagnose` and `MARKERS` in `shared/story-method.ts`, the diagnose branch of `reconcile` in `server/initiative-loop.ts`.

_Avoid_: bugfix track, triage (for the track); diagnosing (as a status).

## Loop supervision

How the initiative loop keeps a step moving with no agent watching it. Code: `supervise` and the turn-end and permission handlers in `server/initiative-loop.ts`. It covers the `plan`, `diagnose`, `implement` and `review` steps while the story is `planning`, `implementing` or `reviewing` and its `.harness/state.md` marker is still `<step>-running` (or its worktree is gone). `awaiting-approval` waits on you and `pr-open` has its own watcher, so neither is supervised.

- **Stalled**: the story's current session ended a turn but its step isn't finished. Either the turn failed, or it completed without writing the step's marker. The turn end writes the reason to the story's `stalled:` frontmatter. The next tick sends that session a **nudge** (`nudgePrompt(reason)`). Leaving the nudge to the tick gives a rate limit or outage about two minutes to clear.
- **Dead session**: the story's `agent:` is gone from Paseo, archived, `closed` or `error`. The tick starts a fresh session on the same step, round and cycle, labelled `loop-attempt: <n>`, whose prompt ends with `RESTART_LINE`. A subagent-cycles parent (`cycles: subagents`) comes back as a parent with only the cycles still open. If Paseo doesn't answer, the session is left alone and the tick tries again later.
- **Worktree gone**: the story's `worktree:` no longer exists, so there is nothing to resume. Its work usually went out through a PR opened outside the loop. The tick looks up the branch's PR: open or merged hands the story to the PR watcher as `pr-open`, which records a merge and archives the workspace; closed blocks it. No PR counts as a retry, because gh being down looks the same.
- **Retry**: each nudge, restart or PR-less lookup adds one to the story's `retries:`. A normal step start clears it. Once `retries` reaches the loop setting `maxRetries` (default 2), the story is blocked with the reason and the count.
- **Stuck**: a supervised step whose completed turns show it is going nowhere, read from evidence rather than the marker (`stuckCheck` in `shared/stuck.ts`, run by `onTurnEnded` after reconcile while the step is still `<step>-running`). Two signals: no file edits outside `.harness/` for `stuckTurns` turns (setting, default 8, 3 to 30; Implement only, skipped for `cycles: subagents` parents), and one test failing in 3 brief test runs in a row (`fail_tests` is the names failing in every run of the streak; typecheck and lint runs are skipped, a passing run resets it). The counters `idle_turns`, `fail_tests`, `fail_runs` live in the story's frontmatter. The first time the evidence holds, the session gets one nudge naming it ("You look stuck: …"), `stuck_nudged` is set, and that turn is neither stalled nor a retry. If it still holds on a later turn, the story blocks with `blocked_reason: stuck: <evidence>` and `block_kind: stuck`. Progress (an edit, or a run that no longer fails the same test) clears the counters and the nudge. A new step and a reopen clear all four fields. The 2-minute tick also watches a running turn (`midTurnCheck`, `midTurnWatch` in `server/initiative-loop.ts`), reading disk instead of the timeline: the brief wrapper's logs in `.harness/logs/<step>-*.log` written since the turn began (same 3-in-a-row failing-test rule), and, on Implement only (not `cycles: subagents` parents), a fingerprint of the worktree outside `.harness/` unchanged for 20 minutes (fixed, not a setting). First evidence steers one nudge into the running turn and sets `stuck_nudged` and `mid_nudged`, so it is still one nudge per stuck spell; evidence again after the nudge blocks the story as above and interrupts the turn. The idle clock pauses while a brief run is going (its `.harness/logs/<step>-<pid>.running` marker, with a live pid, under 60 minutes old; a run past that counts as idle again), restarts at each finished test run, and a nudge whose send fails is still recorded, so the next evidence blocks. Progress after the nudge clears both flags, and a new turn id resets the `mid_*` fields. A tool call the timeline's tail shows `running` in the current turn (any command, brief or not) also pauses the idle clock, and one running for 60 minutes or more skips the nudge, since a steer only lands once the call returns, and blocks with `stuck: one command running over 60 minutes` and interrupts the turn (Implement only, not `cycles: subagents` parents; an unreadable timeline counts as no call, leaving the brief marker).
- **Permission wait**: a permission request from the story's current session blocks the story ("Waiting on permission: …") and sets `waiting_on: permission`. The story keeps its slot, because its session is still open. When the request is answered, the story goes back to the status it was blocked from.
- A turn you cancel is never retried. The loop leaves that session to you.
- The tick needs a Paseo handle. Paseo gives the plugin one only inside events and RPCs, so session open, turn start, agent create, permission events and the board's poll all provide it. After a restart, supervision resumes at the first of these.

_Avoid_: watchdog, heartbeat (for supervision); hung, frozen (for stalled).

## Review findings

The checklist a Review agent writes under `## Review findings` in `.harness/state.md`, and the plain-code decision the plugin makes from it. Code: `readFindings` and `afterReview` in `shared/story-method.ts`, used by both the initiative loop and the Story pipeline.

- **Finding**: one checklist line, `- [ ] blocking: file:line — what is wrong — what would fix it` or `- [ ] non-blocking: …`. **Blocking** means it is wrong: an acceptance check not met, a bug, a security gap, a failing test, lint or build. **Non-blocking** means it works but should improve: naming, readability, a missing edge-case test, a repo convention. An untagged checklist line counts as blocking. "follow-up:" lines are not findings.
- **Review fixes first**: after the whole review is written, the reviewer fixes every finding it can, blocking and non-blocking, inside the story's scope, ticks each one it fixed and re-runs the gate. It leaves a line unticked only when fixing it needs a human decision or work outside the story. Its commit subject goes on the line after `review-done`, and the plugin commits the fixes under it when it opens the PR.
- **Fix round**: the Implement step at round > 1. It fixes every unticked finding, blocking and non-blocking, and ticks each one. It may tick a non-blocking line it judges wrong with "— won't fix: <why>".
- **Re-review**: Review at round > 1. It checks each ticked line, unticks any that isn't fixed, and adds only new blocking lines, so the rounds settle instead of finding new nits each time. Then it fixes and ticks what it can, as the first review does.
- **Decision** (`afterReview`), on `review-done`: no unticked finding opens the PR. Otherwise a fix round (the initiative loop records it, and a block, as a `Review round` entry in the story's `## Outcome`), until `reviewRounds`. At the limit, an open blocking finding blocks the story (the pipeline writes `review-blocked`). Open non-blocking ones go to the PR as **unfixed**, listed under "Not fixed in review (non-blocking)" in its body (`openStoryPr`'s `unfixed`). The reviewer's marker doesn't choose; an older reviewer's `review-failed` with no checklist still gets a fix round.

_Avoid_: nits, must-fix, severity levels beyond these two.

## CI watch

How a story PR's checks are followed until they pass, with no agent watching. Code: `ciAction` in `server/ci-watch.ts`, used by both the initiative loop (`watchPr`) and the Story pipeline (`watchPipelinePrs`), each on the 2-minute tick. `prStatus` in `server/pr-checks.ts` reads the PR; `ciAction` decides from it, the **CI watch record** (`fixedSha`, `attempts`) and the `maxFixes` setting:

- **merged** or **closed**: the watch ends.
- **wait**: CI is pending, green or has no checks, or the head that failed already has a Fix CI agent (`fixedSha` is the head).
- **fix**: a failing head not tried yet starts a fresh **Fix CI** agent with the failure report (`failureReport`: the failed checks and their trimmed logs). Its `fix-done` makes the plugin commit and push, which gives CI a new head to check.
- **give-up**: a new failing head after `maxFixes` attempts. The initiative loop blocks the story; the pipeline writes `ci-failed` and the reason to `## Status`.

The initiative loop keeps the record in the story's frontmatter (`fixed_sha`, `fix_attempts`) and its `maxFixes` in the loop settings (default 3). The pipeline keeps it in the worktree's `.harness/ci.json` (`pr`, `url`, `fixedSha`, `attempts`, and `done` once the watch ends), written when the plugin opens the PR, and its `maxFixes` in the pipeline settings (default 3, on the drawer's Done row). Fix CI is not a drawer phase: its agent is labelled `phase: fix` and loads the Implement phase's extras.

_Avoid_: CI babysitter, CI subscriber, retry (that is Loop supervision).

## Alerts bell

The bell in the header that lists the current gates, one row per Gate, with a badge showing the gate count. Clicking a row opens that story on the epic board (`gate.board`, `gate.storyId`). Its alerts are gates and nothing else; context-meter warnings stay on the Context pill and are never in the bell.

_Avoid_: notifications, inbox, alert (for a context-meter warning).

## Start input

The input at the top of the Initiatives tab. As you type, `routeStart` decides the route and a pill shows it: a bare Jira key (any case) or a URL holding one is **Jira ticket · track from issue type** (green); anything else is **New initiative → Architecture** (blue); blank shows no pill and disables Start. The hint line under it is always shown. Start (or Enter) on a Jira key picks the repo from the key's prefix (`repoForKey`, else the harness repo; neither toasts "No repo for <PREFIX>") and calls `orchestration.start-ticket`, which writes or reuses a one-story `<key>-<slug>` initiative and starts its loop (Bug → Diagnose, else Plan). Anything else calls `orchestration.harness-create-epic` on the harness repo with the text as the initiative and phase title. On success the input clears, the started agent opens and the boards re-read; failures toast. Code: `StartInput` in `client/start-input.tsx`, `routeStart`/`detectLabel`/`START_HINTS` in `shared/start-route.ts`, `startTicket` in `server/ticket-start.ts`.

_Avoid_: omnibox, command bar.

## Needs-you queue

The card at the top of the Initiatives tab that lists the current gates, shown only when there is at least one. A chip "NEEDS YOU · N", then one row per gate from `gateRow(gate)`: the story id as the tag, "<story title>: <gate text>", `where`, and the gate's actions. Plan: **Approve plan** (approve) and **Request changes** (changes, then the session opens; "No session to open" without an agent). Stuck: **Restart from handoff** (restart) and **Nudge** (nudge). Merge: **Review & merge** opens the PR (`${repoUrl}/pull/${pr}`, the gate's `prUrl`); no RPC. A row runs one action at a time; its buttons stay disabled until the boards have re-read after it, so a gate can't be acted on twice. Failure toasts the error. Code: `NeedsYouQueue` in `client/needs-you.tsx`, rows from `gateRow` in `shared/gates.ts`.

_Avoid_: inbox, approvals list.

## Stats strip

The five numbers under the needs-you queue, from the epic boards, the gates and the spend summary:

- **Running**: stories in `planning`, `implementing` or `reviewing` (an agent is mid-step; `awaiting-approval` and `pr-open` are waits). Sub "agents working".
- **Ready**: stories with `ready`. Sub "waiting to start".
- **Needs you**: the gate count, amber above 0. Sub "agents paused at gates".
- **Merged**: merged / total stories, summed over every board with state (each board holds its current phase). Sub "stories across initiatives".
- **Spend today**: `$x.xx`, sub "of <budget> budget · $y.yy this week"; "—" until the summary loads or while it fails. Polled every 60 s from `orchestration.context.summary` with `today` = local midnight.

Running, Ready and Merged show "—" until the boards first load. Each stat has a coloured dot by its label (green, blue, amber, grey) as in the design. The strip wraps on narrow layouts. Code: `statsOf` and `startOfDay` in `shared/stats-strip.ts`, `StatsStrip` and `useSpend` in `client/needs-you.tsx`.

**Budget**: the host setting `budget` (`budgetSettings`, version 1): `{ dailyBudgetUsd: 25, storyCapUsd: 5 }`. The strip shows today's spend against the daily budget, whole dollars when whole ("$25"), and the selected-story panel shows a story's cost against the story cap. The daily budget is display only; the story cap is enforced as the **Cost cap**. Nothing edits it yet. Code: `shared/settings.ts`.

**Cost cap**: the most one story may spend, `storyCapUsd` from the **Budget** (a story's own `cost_cap_usd` overrides it once **continue** has raised it). Checked at each turn end of an agent step: a story at or over the cap blocks with `block_kind` `cost-cap` (reason "cost cap ($x.xx of $y)"), a stuck-style gate that offers **continue** and **leave**. Spend is the story's telemetry cost, counting the live session. Code: `ReadCost` and `raiseCap`/`leaveStopped` in `server/initiative-loop.ts`.

_Avoid_: KPI row, metrics (for the strip); quota, limit (for the budget).

## Plan usage

How much of each provider's plan is used, as the Paseo daemon reports it through `paseo.providers.listUsage()`: one line per provider under the stats strip's five stats, always Claude, Kiro, Cursor in that order (other providers the daemon reports are left out). Each line is the provider name, its plan label if any, then each window or balance as "Session 39% · resets in 3h 54m" or "Plan usage 814% · $569.46 of $70 · resets in 23d 4h". A balance's % is used / limit; with no limit only the amount shows. Coloured by the daemon's `tone` (danger red, warning amber).

- **"unavailable"** when the daemon gives no entry for the provider, a status other than `available`, no number at all, or `listUsage()` itself rejects (an older daemon). Never an estimate. Kiro comes from the plugin's own **Kiro usage source**, so it is "unavailable" only on a host without `registerUsageSource` (Paseo before 0.11.0) or when `kiro-cli` is missing or fails.
- **"runs out in …"** only when the daemon gives `runsOutAt`; nothing is computed from our own spend.
- **"—"** until the first call returns. A failed poll of the RPC keeps the last good lines.

Polled every 60 s from `orchestration.usage.plan`. Distinct from **Budget**, which is our own spend setting. Code: `planUsageRpc`, `PLAN_PROVIDERS` and `planUsageRows` in `shared/plan-usage.ts`, `readPlanUsage` in `server/plan-usage.ts`, `usePlanUsage` and `StatsStrip` in `client/needs-you.tsx`.

_Avoid_: quota, limit (as the name for this); usage limits.

## Kiro usage source

A `registerUsageSource` entry with `id: "kiro"` that the plugin registers itself, because Paseo ships no Kiro source. It runs `kiro-cli chat --no-interactive "/usage"` (no credits spent, about 4 s), strips ANSI, and reads the plan label and "Credits (used of limit …)" line into one `credits` balance whose `resetsAt` is local midnight of the reset date. The daemon's `listUsage()` uses the source id as `providerId`, which is how **Plan usage** finds the Kiro row. Anything it can't read becomes an `error` report, never a guess. Registered only when the host has `registerUsageSource`; remove it once Paseo ships its own Kiro source (a duplicate id makes registration throw). Code: `parseKiroUsage` and `kiroUsageSource` in `server/kiro-usage.ts`, registered in `contribute`.

_Avoid_: Kiro quota.

## Memory

What the harness has learned about a repo, kept as plain files in `.harness/memory/`. One **note** per file; the folder says what kind: `areas/<area>.md` (a part of the repo, with `globs` that match its files), `decisions/<slug>.md`, `notes/<slug>.md` (facts), `corrections/<category>/<slug>.md` (a known mistake with a `count` and `evidence`), plus `SUMMARY.md` at the root. A note's **id** is its path without `.md` (`decisions/no-provider-branches`); `area` holds just the area name and `learned_in` holds story ids.

- **Frontmatter**: `type`, `steps` (empty = every step), `area`, `files`, `citations`, `verified_at`, `last_used`, `status`, and the typed links `learned_in`, `supports`, `supersedes`, `superseded_by`. Lists are block lists (`  - item`) or `[]`. Unknown keys, such as a human's `approved:`, are kept in order.
- **Citation**: `path:from-to#hash`, where the hash is the first 8 hex chars of sha1 over the cited lines, each trimmed. A citation whose hash no longer matches the file is stale.
- **Status**: `seeded` (written by the analyzer, ranked below learned notes), `active`, `unverified`, `superseded`, `expired`. A seeded-only write never overwrites a note that has moved past `seeded`.
- **Backlinks**: worked out when memory is read from every `area`, `supports`, `supersedes` and `superseded_by` link. Never written to disk.
- **Brief**: at most `cap` lines for one step and a set of paths: the matching area lines, then their facts and decisions (active before seeded), then their corrections by count. Facts and file pointers only; notes with no area, and `unverified`, `superseded` or `expired` notes, are left out.
- **Repo analyzer**: seeds memory on day one from git, with no model. It reads a commit (`HEAD`, or the last one at or before `asOf`), never the working tree, and writes `status: seeded` notes: areas (CONTEXT.md terms that cite paths, then co-change clusters, then `<folder>/**`, with top-level files listed by name in `entry` for source and `root` for the rest), import dependencies between areas, hotspot, co-change and re-fixed files from `git log`, decisions (one per prose or bullet line of README, CONTEXT, AGENTS, `docs/adr/` and locked `architecture.md`, verbatim and cited), and the rules lint, tsconfig, scripts and CI already enforce. Git facts cite short commit shas instead of a line. `SUMMARY.md` lists the areas; renaming a row, or giving two rows one name, is read back on the next run. A re-run is a no-op on an unchanged repo and never touches a learned note or `corrections/`. A second pass reads what went wrong and files it with a cheap model (Haiku): past review comments on merged PRs, story `## Outcome` entries and failed CI checks. Each observation gets a category and an area, and duplicates merge into one seeded `corrections/` note with a count; `SUMMARY.md` ends with the top ten. The pass has a cost cap, $3 by default (`--cap N`), printed first, and the run stops at it and keeps what it has. Each filing is cached in `.harness/memory/.cache/filings.jsonl`, so a re-run costs nothing. `asOf` drops later observations and `excludeStory` drops one story's own. Run it with `node --import ./test-support/register.mjs scripts/seed-memory.mjs [--as-of D] [--cap 3] [--exclude S]`.

Code: `server/memory.ts` (`parseNote`, `formatNote`, `notePath`, `writeNote`, `readMemory`, `briefFor`, citation helpers). Pure: no Paseo imports, no model. The analyzer is `server/repo-facts.ts` (pure) and `server/repo-analyzer.ts` (git and writes); its corrections pass is `server/corrections.ts`, `server/correction-sources.ts` and `server/correction-classifier.ts`.

_Avoid_: knowledge base, lessons (for the folder).

## Voice resume

In voice mode Paseo cancels the agent's turn the moment its mic hears any sound. That cuts a spoken reply short, or kills a running tool call, which Claude then reports as "the user doesn't want to proceed with this tool use". When the sound was only noise, no transcript follows and the agent sits idle. Voice resume spots a **cut**: a canceled turn whose last tool call since the last user message didn't complete (`noiseCut`). A `speak` is a speech cut. Any other tool is a tool cut, but only in a session that has called `speak` somewhere in its timeline, so a Stop pressed mid-command in a typed session is left alone. It then waits `RESUME_QUIET_MS` (10s). A new turn in that window means you really spoke, so it does nothing; otherwise it sends the agent `RESUME_MESSAGE` (speech: finish what it was saying) or `TOOL_RESUME_MESSAGE` (tool: nothing was rejected, run it again). A resume that is cut again isn't resumed, so noise can't loop it. A turn canceled with no unfinished tool call (mid-thought) is not resumed: nothing tells noise from a Stop there. It can't stop the cut itself: Paseo does that before the plugin sees anything. A Stop you press mid-speech, or mid-tool in a voice session, looks the same, so it is resumed too. Code: `server/voice-resume.ts`.

_Avoid_: barge-in fix, noise filter.

## Voice loop

The pure state machine behind the Voice drawer: `step(state, event) → { state, effects }`. The drawer and its adapters (mic, transcriber, interpreter, session link, speaker) only carry events in and effects out; the loop decides everything and holds no clocks (the runner owns the ~10 s confirm timeout and the 3 s interpreter fallback). Modes: `asleep` (starts here; only `wake` does anything, a `pick` just sets the target), `listening`, `confirming`, `waiting` (sent, no reply yet) and `speaking`; a `sleep` event (voice turned off) clears the target's pending, confirm, held and queued state, returns to `asleep` and yields a `sleep` effect. "Never mind" and "Jarvis, ignore me" (and close mishearings) are matched in the loop before the interpreter is asked, so they never reach the helper or a session; fragments of under two words do nothing. Anything else is handed out as `interpret(seq, text)`; the helper's `send` / `confirm` / `switch` / `drop` comes back as `interpreted(seq, result)`, and a stale `seq` is ignored. Every `send` is a **steer** and is paired with a short `receipt` naming the target ("Sent to api-refactor"). Only the `interrupt` event (the drawer's button) yields an `interrupt` effect; a spoken "interrupt" or "stop" is a critical word like `merge` and `delete`: it asks (`askConfirm`, naming the session: "Say one to send, or two to cancel."). Only "one", the same word said back, or `confirm(word)` sends it, still as a steer; "two" (or "to"/"too", how it is often heard) cancels, and "yes" does nothing. A target session's `reply` is spoken as `<name>: <first paragraph, markdown stripped, at most 300 characters>`, held until you stop talking or confirming; `finished`, `needsYou`, `error` and `costCap` notices are spoken too, queued while you are talking, being spoken to or confirming, and merged into one line ("Two sessions finished. docs needs you."). Speaking over a reply stops playback and nothing else. Code: `shared/voice-loop.ts`, no imports. The interpreter behind `interpret` is the **Voice helper**.

_Avoid_: voice mode (that is Paseo's), assistant.

## Voice helper

A small Haiku agent that cleans up what the transcriber heard before the Voice loop acts on it. Paseo runs it on the user's Claude login; it starts when voice turns on, is reused for every utterance, and is archived when voice turns off. It has no MCP servers and no tools (`NO_TOOLS_OPTIONS`). Each request gives it the transcript plus the target's title, the last 4 messages, the vocabulary and the session names, and it answers exactly one of `send` / `confirm` / `switch` / `drop`; anything else is read as `drop`. The client races it against 3 s and falls back to pass-through (the text as heard), reporting `timeout` or `error` so the panel can say so. It never decides what is safe: critical words are still confirmed by the Voice loop whatever the helper says. Its own turn ends only write context telemetry; they never start loops, run the pipeline or resume voice. The switch is on by default and is not persisted. The runner and drawer wiring that uses it waits for a follow-up story. Code: `shared/voice-interpreter.ts`, `server/voice-helper.ts`, `shared/voice-rpc.ts`, `client/voice-interpret-model.ts`, `client/voice-interpret-panel.tsx`.

_Avoid_: assistant, voice mode (that is Paseo's), interpreter agent.

## Voice drawer

The right-hand drawer, opened from the header **Voice** button beside Story pipeline. It shows the **Voice runner**'s state and sends it presses: an On/Off toggle (on opens the mic, off closes it), the session list (tap one to make it the target), a tap-to-talk button (tap to start, tap again to send, Cancel to throw the recording away), Interrupt, the confirm buttons while the loop is waiting for a word (send the word, or Cancel), a **Dictation** text box with Send and an "Auto-send when I pause" switch (on by default), the last five transcripts with what happened to each, the receipt and reply lines as text, and any error. A missing `ffmpeg`, `whisper-cli` or model shows its install message here. A mic that cannot open turns voice back off with one message: on a device with no `navigator.mediaDevices` (Paseo's phone app) "This device can't record from a plugin. Use voice from the laptop.", and a permission message for a denied prompt. The text box is for the phone keyboard's own dictation mic as much as for typing: what lands in it goes through the runner's `submitText`, so it needs neither the mic nor the transcriber. With auto-send on, once the text has not changed for 1.5 s (`DICTATION_PAUSE_MS`) what is new is sent and the box cleared, keeping focus so dictation carries on; an edit restarts the wait, and a keyboard that puts the last send back in front of new words only sends the new words. Where the mic can't open, a hint says "Tap the box, then your keyboard's mic, and just talk. Each pause sends." Nothing is spoken yet. Code: `client/voice-drawer.tsx` (`VoiceDrawer`, `VoiceButton`); the pause logic is `client/dictation-model.ts`; the mic and transcriber adapters are in `client/voice-mic.ts`.

_Avoid_: voice mode (that is Paseo's), assistant panel.

## Voice pill

The fourth composer pill (`session-voice`), shown on every session while voice is on. It reads the **Voice runner**'s state: on the target session it shows the loop's mode, on any other session it offers to make that session the target. Off, it is not shown. It joins the existing shared agent subscription in `client/session-role-pills.ts`, which also feeds the runner its session list. Label and title: `client/voice-pill-model.ts`.

_Avoid_: voice badge.

## Voice runner

The one app-wide object that carries the **Voice loop** into the real world. Plain TypeScript, no React, created once per plugin load in `index.client.tsx`. It holds the loop state, feeds events to `step()`, carries out each effect through injected ports (Session link, recorder, transcriber, interpreter, clock), owns the ~10 s confirm timeout and the tap-to-talk limits (`toggleTalk` starts and ends a recording on alternate taps, `cancelTalk` throws one away; a clip under 300 ms is not transcribed, and one still going at 30 s is ended and sent), and keeps the last five transcripts, the last 20 lines and the last error. The drawer and the pill read it through `subscribe`/`getState`. `submitText(text)` feeds typed or dictated text in as the same `utterance` a transcript makes, so the confirm rules and receipts are unchanged; with a target chosen it wakes the loop if voice is off (the mic stays closed), and with none it only says "Pick a session first." Turning it off sleeps the loop and closes the mic. Turning it on clears the last error and opens the mic; if that open fails, voice turns back off with the reason as the error. A tap while the open is pending waits for it, and a start that finds the mic released opens it once more before failing. Hints for the transcriber are the command words plus the session names. Code: `client/voice-runner.ts`.

_Avoid_: voice service, assistant.
