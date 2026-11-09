# Factory plan

One agent the human talks to. Seats do the work. A tick walks the plan. The human approves anything that merges.

This is the software-factory shape discussed for Orchestrator: a manager session in the role of a persistent front door, and a work tree (project, mission, slice) with spec, proof, refocus, and a ceremony check. The initiative loop becomes the machinery inside a slice. Sulti stays the voice door onto the manager. It does not add a second harness, a second daemon, or agents that message each other.

Later work should reuse the names in this file. When code adds one of these concepts, update `CONTEXT.md` in the same change.

## Names

- **Manager.** The only session the human converses with about the factory. It is a model session, not Sulti. Chat lands here, and Sulti routes voice here. It writes the factory files and reports status. It does not edit product code.
- **Seat.** A stable role: builder, design, QA, reviewer. The Paseo agent sitting in it is replaceable. The seat file and its notes survive compact, a dead session, and a fresh agent.
- **Project.** The goal, in `project.md`. One factory per repo worktree.
- **Mission.** An outcome and an ordered set of slices. Merge management lives here.
- **Slice.** One change. It has a spec, a proof, and a state file. Build, test, and review happen here.
- **Tick.** The background pass that starts or restarts the seat for the current phase. The manager does not have to remember the sequence.
- **Refocus.** Three lines injected into a worker prompt: slice spec, mission outcome, project intent, plus the question of whether the current step still serves them.
- **Ceremony.** Process activity (extra checks, handoffs, notes) that outruns movement on the spec or the product. The health check blocks a slice when ceremony wins.

## Leave out

- Agents typing into each other's sessions, or any seat approving another seat.
- An always-on fleet, peer terminals, a terminal wrapper, or a second machine. One Paseo daemon. Extra hosts only after one slice survives a dead agent overnight. No health UI before that same bar.
- A separate epidemiology population or pass. Workers cannot rewrite `culture.md` or seat notes, and a worker turn must not append process checks to either. The manager is the only writer of culture; new lines wait on human acceptance. Quarantine is the manager deleting a bad note.
- Vendor harnesses and a hosted bot product. Paseo sessions are the workers.

## Files

All under the factory's home worktree, kept out of git the same way `.harness/` already is. The home worktree holds the plan only. No seat builds in it. Each slice runs in its own worktree, named in its `state.md`, so two slices never share a checkout.

### Slice workspace

A fresh slice gets its workspace from the loop's `createStoryWorkspace`, under the repo's project (found through `listProjects`, as `startStory` does). The tick records it as `workspace` (with `worktree`) in the slice's `state.md` and in the story's frontmatter. Adopting a story copies the story's `workspace` into a slice that has none. A slice with a `workspace` starts every seat inside it through `startStepAgent`; with none on record, seats start by cwd as before. Sessions are named the loop's way: `🔁 S8 · Plan — Factory start paths` for a slice that names a story, the slice id when it has none. Implement runs as one parent session with a subagent per cycle (`loop-cycles: subagents`), not one top-level session per cycle. Later rounds (a test failure, review fixes) are one agent each.

A slice is closed when its PR is merged, when the manager writes `close: on`, or when it is `ready: ci` with no PR (the work is already on base). Closing archives its workspace and records `archived: on`. While an agent is running there, the archive is skipped and the manager gets one `archive_held` steer. The repo root is never archived, and a failed archive is ignored.

The sweep is a one-off the manager starts with `sweep: on` in `manager.md`. The tick archives idle stray `factory-sN` and `factory-<slug>` workspaces that no slice names (by `workspace` or `worktree`), clears the field, and steers the count.

Because the tree is not in git, archiving or cleaning up the home worktree deletes the factory. The home worktree is pinned: job cleanup skips it, and archiving it asks the human first.

```text
.harness/factory/project.md
.harness/factory/manager.md
.harness/factory/culture.md
.harness/factory/seats/<role>.md
.harness/factory/missions/<id>/mission.md
.harness/factory/missions/<id>/slices/<id>/spec.md
.harness/factory/missions/<id>/slices/<id>/design.md
.harness/factory/missions/<id>/slices/<id>/proof.md
.harness/factory/missions/<id>/slices/<id>/state.md
```

| File | Who writes it | What it holds |
|---|---|---|
| `project.md` | Manager | The goal, in a few sentences. |
| `manager.md` | Manager create path | The manager's Paseo agent id. The tick sends status steers to this id only. |
| `culture.md` | Manager, after the human accepts a proposed line | Short standing law. Workers may read the lines the tick selects. |
| `seats/<role>.md` | Manager | Role, model profile, skills, Paseo agent id, and notes from corrections. |
| `mission.md` | Manager | Outcome, slice order, and which slices `depends` on which. |
| `spec.md` | Manager | What this change must do, and what "done" means. A seat that finds the spec wrong says so in `proof.md` and stops. It does not edit the spec. |
| `design.md` | Design seat, only when `design: on` | The screens, states, and what to look at. Empty when this slice is not visual. The builder implements it. The design seat does not edit product code. |
| `proof.md` | Seat | Evidence the spec holds. Empty until the seat records it. |
| `state.md` | Tick, except `run`, `design` and `kind`, which the manager sets | Phase, seat name, agent id, attempt, the slice's `worktree` and `story` file, `kind: scout` or `kind: ship`, `run: on` once the manager instantiates the slice, and `design: on` when the slice is a screen or a visual. Absent `run` means idle. Absent `kind` means `scout`. |

Chat is not the source of truth. If it is not in these files, the tick does not know it.

## State and tokens

`.harness` stays the store. A database, a daemon-only record, or the Paseo transcript would not make the work more durable, and the transcript is the expensive copy. The tick already survives a dead agent by reading files in the plugin process, which costs no model tokens. Skills and the next agent can open the same files.

What costs tokens is pasting the tree into a prompt, or telling an agent to read every factory file at the start of a turn. Split the two jobs:

- **Machine fields** live in frontmatter (`phase`, `seat`, `agent`, `attempt`, `worktree`, `story`, `kind`, `depends`). Only the tick reads and writes them. A prompt never includes them as a dump.
- **Prose** stays markdown (`project.md`, the mission outcome, `spec.md`, `proof.md`, seat notes). The tick reads it in Node and pastes a projection: the current phase, a short spec, the mission outcome, the project intent, and the proof status. Seat notes in a worker prompt are the standing rules only, a short block the manager rewrites, not an append-only log.

Shared instructions stay at the top of the prompt so the provider can cache them. The slice projection goes last. A fresh agent is told which file holds the plan. It is not given other slices, other missions, other seats' notes, or culture except the lines the tick selects for this wake.

Do not move this store to SQLite for token savings. Add a queryable index later only if the tick has to scan more slices than a directory listing can handle.

## Manager

The manager is an ordinary model session in the home worktree. Sulti cannot be it: Sulti has no model behind it (`server/jarvis-provider.ts`). It only routes each utterance to a target session (`server/jarvis-router.ts`). So Sulti stays the voice door, and its target for factory talk is the manager.

The manager's create path records its agent id in `manager.md`. Paseo reopens the Sulti session when voice mode turns on or off, so nothing keys on the Sulti session id. If the manager session dies, a fresh one is created from the same prompt and `manager.md` gets the new id. The factory files carry what it needs.

The human's words go to the manager. The manager updates factory files and, when it must speak to a worker, the tick or an explicit steer does that send.

When a slice needs the human, the tick steers one short status line into the manager id in `manager.md`. The manager says it, in chat or through Sulti. The human does not open the builder to restate the goal.

The manager prompt states three limits: it does not edit product code, it does not tell a worker to rewrite `culture.md` or seat notes, and it does not treat another agent's approval as permission to merge.

## Initiative loop

The loop stays the phase machine for one slice: step prompts, `.harness/state.md` markers, review findings, stuck detection, a dead session restarted on the same step, and the PR and CI watch. Those parts are still true.

What is no longer true is that the loop is the thing you run and watch. Today it supervises a story on its own (`supervise` in `server/initiative-loop.ts`), and the Initiatives tab is how you see it. Under the factory that is a second boss. You would be talking to the manager and still navigating initiatives.

The factory tick is the only supervisor. It decides which slice runs. For the build, test, and review phases it calls the loop's step machinery on that slice's story files. The loop does not pick the next story, and it does not speak to you. A block, a stuck slice, or a clean review becomes one status line steered into the manager. `awaiting-approval` waits on the manager's conversation with you, not on a dashboard row.

The Initiatives, Today, Todos, Board, and Pulse tabs can show work already on disk. They are not how you start or steer the factory. In-flight initiatives finish or get adopted as slices. After that, the loop runs only because a slice is in a loop phase. Nothing starts an initiative on its own, including a morning brief.

Adopting a story means the manager writes a slice whose `state.md` names the story file and its worktree. From then on the tick owns it. The loop's own supervisor (`supervise` and `sweep`) skips any story a slice names, and the tick skips any story the loop still supervises. One owner per story at a time, so a dead agent gets exactly one replacement.

The fresh compact is a second path that replaces an agent. When a slice agent's context is full, the loop and the compactor start a fresh agent on the slice's story and update the slice's `state.md` to the new agent id, so the tick sees a live agent and does not also replace it.

### Phases and loop steps

The factory phase in the slice's `state.md` is the truth. The loop's `.harness/state.md` in the slice worktree only holds the step marker inside the current phase. The tick writes that marker when it enters a phase, and reads it to know the step is done.

| Factory phase | Seat | Loop steps | Notes |
|---|---|---|---|
| `spec` | Manager | none | The manager writes `spec.md`. The tick then writes the story file in the slice worktree from the spec and records it as `story`. |
| `design` | Design | none | Only with `design: on`. Writes `design.md`. |
| `build` | Builder | plan, diagnose when the story is a bug, implement | Done on the implement marker and a commit. |
| `test` | QA | none | QA runs the checks the spec names and fills `proof.md`. A failing check sends the slice back to `build` as a fresh Implement round carrying the failing checks, not the `fix` step. `fix` stays for CI failures in `ship`. |
| `review` | Reviewer | review | Review-fix rounds go to the builder seat, as the loop does today. |
| `ship` | Builder | pr, then the PR and CI watch | `kind: ship` only, after review is clean. A scout slice ends at review. |

## Civilization

OpenRig treats an agent population as a civilization: seats, pods, culture, project, mission, slice, refocus, ceremony versus progress, bureaucracy, scope creep, agents approving agents, and bad ideas spreading through notes. The factory applies what transfers and drops what does not. These are rules here, not a new product.

Culture is a short standing law. A failure does not auto-append a check. The manager may propose one new line to the human. It is written only after the human accepts. Seats cannot write `culture.md`.

Proof stops when it meets the spec. There is no phase whose job is to improve the proof after that.

Each seat prompt gets only its own domain: the slice projection, its role notes, and the culture lines the tick selects. A builder does not receive another seat's notes.

A rig template is a later saved arrangement of seats plus culture, reused when an arrangement has worked. It is not a second population, and it is not part of the first six build steps.

Remove or do not build: any path where a seat messages or approves another seat; any path that appends process checks to culture or seat notes from a worker turn; an always-on fleet, peer terminals, a separate epidemiology population, and a health UI before the first slice survives a dead agent; the initiative loop as its own supervisor, including a morning brief that starts an initiative by itself. That start path goes away when the factory tick is the supervisor. In-flight initiatives finish or are adopted as slices.

## Parity

Tmux, the terminal UI, and a separate daemon are OpenRig's transport. The factory still has to do the same jobs inside Orchestrator. A Paseo session is a seat. The sidebar is the view of who is alive. The tick is the workflow. `.harness` is both the scope (what the work is) and the queue (who acts next). The manager is the operator, and Sulti is the voice door onto it.

| OpenRig behavior | Orchestrator |
|---|---|
| Stable seat address, conversation replaceable | `seats/<role>.md` plus the Paseo agent id. Restart writes a new id. The role name does not change. |
| You talk to the operator. The lead runs the team. | One manager session does both. You bring the goal. It files work and instantiates a slice. It does not edit product code. |
| Scope files do not start work. A workflow instance does. | Writing a mission or slice leaves it idle. The manager sets `run: on` on that slice. The tick starts nothing else. |
| A message is not a queue item. | A steer is conversation. A slice with `run: on` is the owned packet. The tick delivers that packet to the seat for the current phase. |
| Each station is a different seat. | `spec` goes to the manager. `design` goes to the design seat when `design: on`. `build` and `ship` go to the builder. `test` goes to QA. `review` goes to the reviewer. The tick hands the packet to the next seat. Seats do not message each other. |
| Release stays a human act. | Review clean steers the manager. Merge waits on you. |
| Handover does not drop the workflow. | A dead, archived, closed, or errored agent is replaced on the same phase. An agent waiting on `agent.permission_requested` is alive. The tick does not replace it. |
| Refocus, culture, proof that stops | Already the rules in this plan. |
| Snapshot across a reboot | The files are the snapshot. The next tick restores the seat that holds `run: on`. |

The design seat is part of the factory. The manager sets `design: on` when the slice is a screen or a visual, and the tick runs the design phase after spec and before build. The design seat writes `design.md` and does not edit product code. A slice without `design: on` skips that phase. A second independent reviewer and a saved rig template still wait until one builder and one reviewer have finished a slice.

## One provider

A factory runs on one provider's models: all Cursor or all Claude, never a mix. The manager, every seat, the builder's cheap helpers, the one-shot calls and every fallback take their model from that provider. When no model of that provider fits, the create fails and the manager is told. It never falls through to the other provider. The provider is the Paseo provider, so `cursor/claude-haiku-5-5` counts as Cursor.

The code mixes today, and these must change before the rule holds:

- `MANAGER_MODELS` and `MANAGER_SESSION_MODELS` fall back from `claude` to `cursor`.
- A seat with no profile of the runner's provider falls back to `MANAGER_MODELS`.
- The one-shot calls (status reporter, correction classifier, replay judge) always use the Claude CLI.
- The voice helper, the reply summariser and the Prod Pulse schedule are pinned to `claude/claude-haiku-4-5`.

## Tick

One pass, owned by the factory. Do not leave the initiative loop's own supervisor running as a peer. A slice with no `run: on` is idle, even when its spec exists and its dependencies are done.

Each pass:

1. Read missions and slices. A slice is runnable when the manager has set `run: on`, every slice it `depends` on has a finished proof and a clean review, and no earlier phase is still open.
2. Deliver the packet to the seat for this phase: manager for `spec`, design for `design` when `design: on`, builder for `build` and `ship`, QA for `test`, reviewer for `review`. If that seat's agent is missing, archived, closed, or in error, start a fresh agent in the slice's worktree and point `state.md` at the new id. Leave an agent that is waiting on a permission. Prompt from the spec, the current phase, and refocus. The builder prompt also includes `design.md` when that file has content.
3. Advance the phase only from evidence: spec written, `design.md` written when `design: on`, build committed, tests green, proof filled, review clean, PR open and CI green. Skip `design` when `design` is not `on`. Advancing hands the packet to the next seat. It does not send a chat from the old seat.
4. On review clean for a scout slice, or green CI for a ship slice, steer the manager: which slice, and that it is ready for the human. Merge stays on the existing permission and PR path. The tick does not merge, and a repo's `autoMerge` does not apply to slices.

Parallel slices wait until step 6 below. Until then the tick runs one runnable slice.

## Refocus

On every wake of a seat agent, and after compact or a fresh session, the prompt includes:

- the slice spec (one paragraph, from `spec.md`)
- the mission outcome (from `mission.md`)
- the project intent (from `project.md`)
- one question: does this step still serve those three? If not, stop and say so in the proof, and do not widen the change.

Do not paste the whole project into the worker.

## Health

Extend the stuck check (`shared/stuck.ts`). Today its idle count runs on implement only. The factory runs both signals on every phase a seat works in (`build`, `test`, `review`, `ship`). Block the slice and tell the manager when:

- **Ceremony turns.** `stuckTurns` completed turns in a row edit or write files, and every one of those files is under `.harness/`. A turn with no edits does not count toward this signal, and a turn that edits any file outside `.harness/` resets it. `toolSteps` already gives the paths.
- **Checks instead of a fix.** The existing shared-failure streak (`fail_tests`, `fail_runs`) reaches its limit, and every turn in that streak edited only test files (`*.test.*`, `*.spec.*`, or a `test/` or `__tests__/` folder) or `.harness/`. A streak whose turns touch the code under test stays the plain stuck block it is today.

Workers have no tool to clear that block. The manager tells the human, and the human reopens it.

## Approval

`agent.permission_requested` stays the human gate. A seat may not approve another seat. A `kind: scout` slice ends in `proof.md` or a report section of it and does not open a PR. A `kind: ship` slice is the only path that opens one, in the `ship` phase, and only after review is clean.

## Build order

Each step is done when its check passes. Do not start the next step first.

1. **Files and names.** Read and write the tree above. A missing factory directory is an idle tick, not an error. Unit-test the parser and the runnable-slice rule (`depends` is honored from step 6).
2. **Manager session.** Create the manager as a model session in the home worktree and record its id in `manager.md`. Its create path appends the factory limits to the system prompt. Sulti routes factory talk to that id. A test shows a worker session does not get that prompt, a status steer from the tick is sent only to the id in `manager.md`, and a voice on/off reopen of Sulti does not change it.
3. **Tick restart and one owner.** A slice without `run: on` stays idle. Given a slice in `build` whose agent id is dead, the tick creates one builder agent in the slice's worktree, stores the new id, and the prompt contains the spec and the refocus lines. A live agent is left alone, including one waiting on a permission. The loop's `supervise` and `sweep` skip a story a slice names, and the tick skips a story the loop still supervises. A test with both running shows a dead builder gets exactly one replacement.
4. **Phases.** Spec, design when `design: on`, build, test, review, and ship for `kind: ship` advance only on the evidence in the files and the turn outcome, through the loop steps in the phase table, and each advance hands the packet to the next seat. A slice without `design: on` never starts the design seat. A scout slice never opens a PR. Ready for the human produces one manager steer and does not merge. An in-flight story can be adopted as a slice. S8 removed the start paths that started an initiative on their own; each now files a slice in mission `inbox` for the manager instead (`server/factory-file.ts`): the morning brief (`startInitiative` in `server/morning-brief.ts` and its "do it" in the Sulti router), ticket start (`startTicket`, `startLocalTicket`), promote, the loop start file (`tickLoopStart`), the Start input (`routeStart`), and the Initiatives Start buttons.
5. **Health.** The ceremony block fires on the two signals above, on every seat phase, and does not fire on a turn that edits product code or turns a failing test green.
6. **Fan-out.** Honor `depends`. Two slices with no dependency both run, each in its own worktree. A slice whose dependency has an empty proof does not start. A slice that can never start (a dependency that is blocked, unknown, idle, or part of a loop) steers the manager once instead of waiting in silence.
7. **Factory view.** A Factory tab replaces the Initiatives tab and opens by default when the repo has a factory. Today, Todos, Board and Pulse stay. Start only after step 6 has run on a real story, and remove the Initiatives tab only once its Start buttons have moved (S8). The view is read-only and reads the factory files and agent status, nothing new:
   - One card per seat: role, model (from `seatProfile`), and whether its agent is alive, dead, or none.
   - The runnable slices drawn as their phases (spec, design, build, test, review, ship), with the current phase and its seat lit.
   - The reviewer's review round and last verdict, in place of a call count.
   - A factory log: the status steers sent to the manager and the phase changes, newest first.
   - No progress percentages, because Paseo reports only running or idle. Parallel slices from step 6 are the only fan-out shown.

Rig templates (saved seat arrangements plus culture) and a second machine are after step 6 has run on a real story.

## First finished path

One manager session. One mission. One scout slice. The builder seat dies mid-build. The next tick restarts it with refocus, without the human restating the goal. Review clean shows up as one line in the manager conversation. Nothing merges until the human says so.
