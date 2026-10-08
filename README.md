# Orchestrator

Paseo sidebar dashboard for live agent, workspace, and schedule status.

## Install

Plugins are trusted, unsandboxed code. Enable **Settings → Plugins** on the daemon first.

In the app, open **Settings → Plugins**, paste a source into **Plugin source**, and select **Install plugin**:

- `/absolute/path/to/Orchestrator`
- `github:denmercs/Orchestrator`

Or from the CLI:

```bash
cd /path/to/Orchestrator
npm install
npm run typecheck
paseo plugin install /path/to/Orchestrator
```

```bash
paseo plugin install github:denmercs/Orchestrator
```

The **Orchestration** item appears in the sidebar. Drag it after Schedule in **Settings → Sidebar**. Open it from ⌘K → **Open orchestration dashboard**.

## Sentry prod pulse

When `~/.prod-pulse/page/data.json` exists (written by the scheduled `/ss-prod-pulse` job), a **Sentry** button appears next to the board picker. It opens a drawer with release health, new bugs on the current prod release (repro, FullStory/Sentry links), older bugs still hitting, and suggested next steps. Set `PROD_PULSE_DIR` on the daemon to read a different folder. No Sentry token is needed; the drawer only reads the job's output.

The drawer's **Automation** switch (off by default) keeps one Paseo schedule for the job: "Prod pulse (Mon & Fri)" at 13:00 Central on Mondays and Fridays. On creates it if missing and resumes it if paused; off pauses them. Nothing is deleted. Each run starts a Haiku agent that runs `~/.prod-pulse/run.sh`. The switch only turns on when that script exists.

## Harness initiatives

The plugin owns the initiative layout; each repo stores it in its own `.harness` (kept out of git):

```
.harness/initiatives/<slug>/
  initiative.md            # tracker (local | jira), title, outcome; generated phases-and-stories list
  phases/<n>-<name>/
    phase.md               # frontmatter phase (its number) + title
    architecture.md        # the plan: shapes, decisions, stages, Jira keys; written by the architecture session
    architecture.html      # generated from architecture.md for reading; never edit
    stories/               # one .md per story: id, title, status, depends_on, blocked_by, pr
```

Each initiative has a **tracker**, picked on **New initiative**. **Local** (the default, for work) keeps the epic and stories in `.harness`: the phase is the epic, `stories/` are the stories, and `initiative.md` carries a generated list of every phase with its stories and statuses. Nothing is created in Jira. **Publish to Jira** (for personal projects) lets the architecture session create the epic and stories in Jira when you ask it to publish.

**Initiative → Initiatives** lists every Paseo project's initiatives. **New initiative** and **New phase** create the folders above (each phase is a `phases/<n>-<name>` folder); **Open** puts a phase on the board. The board reads the plan straight from these files.

Creating a phase also starts its **architecture session**: a Claude agent in that repo that reads the code and the initiative, writes the phase's `architecture.md` and one story file per stage, then asks the open decisions one at a time, rewriting both after each answer. Say "lock" to mark it agreed. **Plan architecture** on a phase row starts it again; the agent resumes from the existing files. How phases are planned (vocabulary, plan sections, stages, decision loop) lives in `server/architecture-method.ts`; edit it to change every future architecture session.

When you say "lock", the plan is marked agreed and the board shows **Planning done** with a **Start** button, which starts the [initiative loop](#initiative-loop).

**View plan** on the board opens the plan in Paseo's browser, in the repo's workspace (in the system browser where Paseo has no browser). It also opens by itself the first time a phase's plan appears while the board is open, and the page reloads as `architecture.md` changes, so it follows the architecture session. Paseo's browser only opens http, so the plugin serves the page from `127.0.0.1` behind a random per-phase token (`server/plan-server.ts`). The page is `architecture.html`, which the plugin regenerates whenever `architecture.md` changes: current and target diagrams side by side, decision and stage cards, the start → finish path, and an optional second track (a second epic's stories). Gaps such as a missing diagram show under the board header. Card statuses stay current on their own: a card whose `story:` is a local id (`S1`) takes the status in that story's file. **Refresh from Jira** (shown once a card names a Jira key) does the same for Jira keys, writing each issue's status into the Markdown (card `status:` lines and "Jira" / "Status" table cells). It's one way and never changes Jira. Each architecture session also refreshes before it starts. Jira access uses the same credentials as the board (`JIRA_URL` / `JIRA_USERNAME` / `JIRA_API_TOKEN`, or the Atlassian MCP config). Rendering lives in `server/plan-render.ts`, status sync in `server/plan-status.ts`.

## Initiative loop

**Start** on an initiative (in **Initiatives**, or on the board header) delivers its stories phase by phase with no outside tooling. The plugin is the loop: it reacts to Paseo events and needs no long-running process or heartbeat.

1. It picks the first phase with unmerged stories. A phase with no stories stops it there; plan that phase's architecture first.
2. Each ready story (`todo`, every `depends_on` merged, no `blocked_by`) gets its own Paseo **worktree workspace** (🔁) on `feature/<phase>-<story-id>-<title>`, cut from the remote's default branch (set `base:` in `initiative.md` to override). Paseo runs the repo's `paseo.json` worktree setup. At most **parallel** stories run at once (default 1).
3. Each step runs as a fresh agent in that workspace: **Plan** → **Implement** (one agent per cycle) → **Review**, then the plugin opens the PR itself. A step ends by writing a marker under `## Status` in the worktree's `.harness/state.md`. When the agent's turn ends, the plugin reads it and starts the next step.
   - **Plan** waits for you. The story shows **Your turn**; open its session to question the plan, push back, or approve it. It writes `## Plan` (naming the files) and a `## Cycles` checklist.
   - **Implement** runs one fresh agent per unticked cycle. Each gets only its cycle line and `## Plan`, works test-first, ticks the cycle and stops. The plugin commits the cycle (never `.harness/`) and starts the next. A cycle that ends unticked blocks the story instead of running again. With no checklist, one agent does the whole change.
   - **Review** is a fresh critic (correctness, security, conventions, full gate). Findings send it back to one Implement agent, up to **reviewRounds** (3); then the story blocks.
   - After a pass, the plugin commits anything left, pushes the branch and runs `gh pr create` with `.harness/pr-body.md`. No agent runs for this.
4. Every 2 minutes the plugin checks each open story PR with `gh`. A failing check starts a **Fix CI** agent with the failed logs, once per commit, up to **maxFixes** (3); the plugin commits and pushes its fix. Green shows **Merge**; you merge. A merge marks the story `merged`, archives its workspace and starts the next ready story; when a phase is all merged it moves to the next phase. When every phase is merged the initiative's loop is `done`.

**Stop** only stops new work from starting; agents already running finish, and merges and CI are still recorded. **Start** again picks up from the story files. Work an agent finds outside its story is filed as a new `todo` story (`discovered_from:`) instead of done in place.

The story files are the state. The loop writes `status`, `branch`, `base`, `workspace`, `worktree`, `step`, `round`, `cycle`, `agent`, `pr`, `ci`, `fix_attempts` and `blocked_reason` into their frontmatter, and `loop: on | off | done` into `initiative.md`. To retry a blocked story, set its `status` back (`todo` to start over) and remove `blocked_reason`. Repos with a started initiative are listed in `~/.orchestrator/initiative-loops.json` so the timer knows where to look.

**Agent**: every step runs on your Paseo agent profile named **default** (provider, model, mode, thinking). Without one, Claude runs on its own default model in auto mode. The step prompts name no skills or slash commands, so any provider works. `parallel`, `reviewRounds` and `maxFixes` live in the plugin's `initiative-loop` settings. How each step works lives in `shared/story-method.ts`; the engine is `server/initiative-loop.ts`.

**MCP servers**: the plugin copies your Cursor, Claude and Kiro MCP servers onto agents, but story steps get only what they need. Initiative steps get none, belt Plan and Review get one Atlassian server, and architecture sessions get Atlassian only when the initiative publishes to Jira. Story sessions and epic loops started from the board get Atlassian only. Your own Paseo sessions, and anything else the plugin did not start, keep every server. Servers are attached without `alwaysLoad`, so providers that defer tool loading still can. Each server's tool list is sent with every model call, so this keeps the per-turn context small.

## Skills and the Story belt

The **Skills** button next to the board picker opens a drawer with two tabs.

**Phases** sets up the Story belt: Plan → Implement → Review → Done. It runs a Jira story through the same steps as the initiative loop (`shared/story-method.ts`): one agent per Implement cycle, commits and the PR by the plugin. Each phase runs its built-in step; you can name a skill for it to use and add extra skills, and pick what happens when it ends. Saved phases that pointed at the retired skillsync skills (`ss-*`, `tdd`) fall back to the built-in steps.

The belt is off by default. Turn it on with **Belt on** in the drawer header. Then **Start** on a story card opens a Plan agent instead of a single session. Epics still use the epic loop.

Each phase runs in a fresh agent in the story's worktree and ends by writing a marker under `## Status` in `.harness/state.md`:

| Marker | What happens next |
|---|---|
| `plan-done` | Implement starts. Plan writes it only after you approve the plan. |
| `implement-done` | The plugin commits the cycle, then the next cycle's Implement agent starts, or Review once every cycle is ticked. |
| `implement-blocked` | Nothing; waits for you. |
| `review-done` | The plugin pushes the branch and opens the PR (`pr-done` with its URL, or `pr-failed` with the reason). |
| `review-failed` | A fresh Implement agent fixes the findings, then Review runs again, up to the round limit. |
| `pr-done` | Nothing until the PR merges; then the plugin moves the Jira story and its subtasks to Done if **After merge** is on. |

**Sources** connects skill repos: `owner/repo`, a git URL, or an absolute folder path. Git repos are cloned to `~/.orchestrator/skill-sources/` and pinned to a commit. **Check for updates** lists new commits and changed skills before you move the pin. Folders are read live. Skills already in `~/.claude` and `~/.agents` show as **This machine**.

When a phase uses a skill from a connected repo, it is copied into the story worktree (`.claude/`, `.cursor/`, `.agents/`) and hidden from git through `.git/info/exclude`. Files the repo already commits are never overwritten.

## Reload after edits

```bash
npm run typecheck
paseo plugin reload orchestrator
```
