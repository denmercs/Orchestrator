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

The drawer's **Automation** switch (off by default) keeps two Paseo schedules for the job: "Prod pulse (weekdays)" at 8:00, 12:00, 16:00 and "Prod pulse (weekends)" at 9:00, Central. On creates any that are missing and resumes paused ones; off pauses them. Nothing is deleted. Each run starts a Haiku agent that runs `~/.prod-pulse/run.sh`. The switch only turns on when that script exists.

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

When you say "lock", the plan is marked agreed and the board shows **Planning done** with a **Start** button. Start turns on the phase's loop: every ready story (todo, not blocked, dependencies merged) starts through the Story belt (Plan → Implement → Review → Done) in its own worktree, in parallel. The belt reads the story file and the phase's `architecture.md` instead of a Jira ticket, and the story file's status follows the belt (planning → implementing → reviewing → PR open). When a story's PR merges, its file is marked merged and whatever it unblocked starts. **Stop** lets running stories finish without starting more. Each story gets a key a PR title can carry: its Jira key if it has one, else one made from the initiative's initials, the phase and the story number (`ASE1-2`). Local stories are never closed in Jira. The loop lives in `server/phase-loop.ts`.

**View plan** on the board opens the plan in Paseo's browser, in the repo's workspace (in the system browser where Paseo has no browser). It also opens by itself the first time a phase's plan appears while the board is open, and the page reloads as `architecture.md` changes, so it follows the architecture session. Paseo's browser only opens http, so the plugin serves the page from `127.0.0.1` behind a random per-phase token (`server/plan-server.ts`). The page is `architecture.html`, which the plugin regenerates whenever `architecture.md` changes: current and target diagrams side by side, decision and stage cards, the start → finish path, and an optional second track (a second epic's stories). Gaps such as a missing diagram show under the board header. Card statuses stay current on their own: a card whose `story:` is a local id (`S1`) takes the status in that story's file. **Refresh from Jira** (shown once a card names a Jira key) does the same for Jira keys, writing each issue's status into the Markdown (card `status:` lines and "Jira" / "Status" table cells). It's one way and never changes Jira. Each architecture session also refreshes before it starts. Jira access uses the same credentials as the board (`JIRA_URL` / `JIRA_USERNAME` / `JIRA_API_TOKEN`, or the Atlassian MCP config). Rendering lives in `server/plan-render.ts`, status sync in `server/plan-status.ts`.

## Skills and the Story belt

The **Skills** button next to the board picker opens a drawer with two tabs.

**Phases** sets up the Story belt: Plan → Implement → Review → Done. Each phase picks the skill it runs, extra skills it loads, and what happens when it ends. The security audit is always loaded in Review.

The belt is off by default. Turn it on with **Belt on** in the drawer header. Then **Start** on a story card opens a Plan agent instead of a single session. Epics still use the epic loop.

Each phase runs in a fresh agent in the story's worktree and ends by writing a marker under `## Status` in `.harness/state.md`:

| Marker | What happens next |
|---|---|
| `plan-done` | Implement starts. Plan writes it only after you approve the plan. |
| `implement-done` | Review starts. |
| `implement-blocked` | Nothing; waits for you. |
| `review-done` | Done starts (opens the PR). |
| `review-failed` | A fresh Implement agent fixes the findings, then Review runs again, up to the round limit. |
| `done-done` | Nothing until the PR merges; then `/ss-close-story` runs if **After merge** is on. |

**Sources** connects skill repos: `owner/repo`, a git URL, or an absolute folder path. Git repos are cloned to `~/.orchestrator/skill-sources/` and pinned to a commit. **Check for updates** lists new commits and changed skills before you move the pin. Folders are read live. Skills already in `~/.claude` and `~/.agents` show as **This machine**.

When a phase uses a skill from a connected repo, it is copied into the story worktree (`.claude/`, `.cursor/`, `.agents/`) and hidden from git through `.git/info/exclude`. Files the repo already commits are never overwritten.

## Reload after edits

```bash
npm run typecheck
paseo plugin reload orchestrator
```
