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

## Reload after edits

```bash
npm run typecheck
paseo plugin reload orchestrator
```
