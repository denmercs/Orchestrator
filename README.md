# Orchestrator

A Paseo plugin that turns a plan into merged pull requests.

You decide what to build and approve each plan. Agents write the code, review it and fix CI. You merge.

```
Initiative ──► Phases ──► Stories ──► Pull requests ──► you merge
  the goal     planned     one branch    opened by
               with you    each          the plugin
```

## The idea in three lines

1. **Files are the state.** Every initiative, phase and story is a Markdown file in the repo's `.harness/` folder (kept out of git). Stop at any time. **Start** picks up from the files.
2. **The plugin is the loop, not an agent.** Plugin code reacts to Paseo events. It starts agents, commits, pushes, opens PRs and watches CI. Agents only plan and write code. Nothing runs in the background.
3. **Small, fresh agents.** Each step gets a new agent with only what it needs: its plan, its one cycle, no extra tools. That keeps context and cost low.

## How work flows

**1. Plan the phase with an architect.** **New initiative** sets the goal. **New phase** starts an architecture session: an agent reads the code, writes `architecture.md` and one story per stage, then asks you the open decisions one at a time. Say **"lock"** when you agree.

**2. Run the loop.** **Start** takes each ready story through these steps in its own worktree:

```
Plan ──you approve──► Implement ──► Review ──pass──► PR ──► CI watch ──green──► you merge
                      (one agent       │                       │
                       per cycle)      └─ findings: fix,       └─ red: Fix CI agent,
                          ▲               up to 3 rounds          up to 3 tries
                          └──────────────┘
```

- **Plan** waits for you. Question it, push back, or approve it.
- **Implement** runs one fresh agent per checklist item, test-first. The plugin commits each one.
- **Review** is a fresh critic that checks correctness, security, conventions and the full test gate, then fixes what it finds (non-blocking findings too). It fails the story back to Implement only for findings it could not fix.
- **PR and CI** need no agent. The plugin pushes, opens the PR and polls checks every 2 minutes.
- After a merge the next ready story starts. When a phase is done, the loop moves on to the next phase.

If an agent stalls, dies or waits on a permission, the loop nudges it, restarts it or blocks the story with a reason. Work an agent finds outside its story becomes a new story. The agent doesn't do it in place.

**3. Act on gates.** A story only needs you at three points: a plan to approve, a PR to merge, or a story that's stuck. The 🔔 bell lists them all.

## What lives where

```
.harness/initiatives/<slug>/
  initiative.md                 goal, tracker (local | jira), loop on/off, phase index
  phases/<n>-<name>/
    phase.md
    architecture.md             the plan (architecture.html is generated from it)
    stories/<id>.md             one per story; its frontmatter is the loop's state
```

Inside a story's worktree, each step finishes by writing a marker (`plan-done`, `review-failed`, …) to `.harness/state.md`. That's how the plugin knows what to start next.

## The dashboard

| Tab | What it shows |
|---|---|
| **Initiatives** | Every project's initiatives, phase boards, step bars, and Start and Stop |
| **Today** | Standup and todos |
| **Board** | Your Jira board. **Start** opens a session or the Story pipeline |
| **Pulse** | Sentry prod health, from the scheduled prod-pulse job |

Every session also gets a **context pill** with its size (for example `82k / 200k`). It warns at 100k and 150k and offers **Compact** or **Start fresh**. Turns and compactions are logged to `~/.orchestrator/context-telemetry.jsonl`, and a dashboard card sums them up, including spend.

## Choices that keep it cheap and predictable

- **Model split.** Plan and Review run on Opus, while Implement and Fix CI run on Sonnet. You can change this per step under **Loop profiles**.
- **Tools on a diet.** Loop steps get no MCP servers, and board sessions get Atlassian only. Each tool list costs tokens on every turn.
- **Any provider.** Step prompts name no skills or slash commands, and the context meter never branches on a provider's name.
- **Jira is optional.** A `local` initiative keeps everything in `.harness`. A `jira` initiative lets the architect publish the epic and stories.

## What's next

**Agent memory** (planned, not built). Today every agent starts cold and spends tokens rediscovering the repo. The plan is for each repo to learn as it goes:

- **Knowledge.** Facts about each area of the code, with file citations, written after each merge.
- **Corrections.** Review findings that keep coming back, counted, de-duplicated and approved by you.

The plugin, not the agent, picks the few lines that match a story's files and hands them over as a short brief. A no-memory holdout keeps it honest: if memory doesn't improve results, it switches itself off. See [docs/telemetry/agent-memory/README.md](docs/telemetry/agent-memory/README.md) for the plan, decisions and status.

Also planned: Kiro and Cursor as first-class providers.

## Code map

| Concern | File |
|---|---|
| Loop engine | `server/initiative-loop.ts` |
| How each step works (prompts) | `shared/story-method.ts` |
| How architecture sessions plan | `server/architecture-method.ts` |
| Folder layout | `server/harness-layout.ts` |
| Plan page rendering and serving | `server/plan-render.ts`, `server/plan-server.ts` |
| Context meter and telemetry | `shared/context-meter.ts`, `server/context-watch.ts`, `server/context-telemetry.ts` |
| Gates and step bar | `shared/gates.ts`, `shared/story-steps.ts` |
| Skills drawer and sources | `server/skill-sources.ts`, `shared/pipeline.ts` |

The vocabulary, and the detail behind each concept, is in [`CONTEXT.md`](CONTEXT.md).

## Install

Plugins are trusted, unsandboxed code. Turn on **Settings → Plugins** on the daemon first, then install from the app (**Settings → Plugins → Plugin source**) or the CLI:

```bash
paseo plugin install github:denmercs/Orchestrator
# or from a checkout
npm install && npm run typecheck && paseo plugin install /path/to/Orchestrator
```

Open it from ⌘K → **Open orchestration dashboard**.

## Develop

```bash
npm test
npm run typecheck
paseo plugin reload orchestrator
```

Back up `~/.paseo/plugin-settings/orchestrator` before `paseo plugin update`, because an update wipes the plugin's settings.
