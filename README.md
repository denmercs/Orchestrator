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
  initiative.md            # title + outcome; epics table between harness:epics markers
  epics/E<n>-<name>/
    epic.md                # frontmatter id + title
    stories/               # one .md per story: id, title, status, depends_on, blocked_by, pr
    state/                 # per-story working notes, written by the runner
```

**Harness plan → Initiatives** lists every Paseo project's initiatives. **New initiative** and **New phase** create the folders above (each phase is an `epics/E<n>-<name>` folder); **Open** puts a phase on the board. The board reads the plan straight from these files.

Running stories is optional. Set **Runner** to a module that exports `createHarnessRunner({ root, epicDir })` returning `{ state(), act(action, id), stop(), reset?() }` (contract in `server/harness-board.ts`). With a runner the board shows **Run plan**, **Start planning**, approvals and previews; without one it's the plan only.

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
