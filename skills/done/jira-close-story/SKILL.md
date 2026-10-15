---
name: jira-close-story
description: >
  Close or transition Jira issues to Done after merge (or when updating the board):
  subtasks first when closing a parent, optional assignee and fix version updates,
  then transitions via Atlassian MCP. Use when the user closes a Jira story/task,
  post-merge tracker cleanup, or wants subtasks marked Done before the parent.
---

# Jira close story

End-to-end Jira updates for **one issue key**.

## Principles

- **MCP first:** With an **Atlassian MCP** server enabled, read each tool’s **schema** before the first call. Tool names vary by server; use the names the enabled server exposes and keep the logical steps below.
- **No invented people:** Default **assignee**, **fix version** naming, and **project** quirks live in the repo's issue-tracker docs or the human’s chat instructions — not in this skill.
- **Fix version source:** Choose an **unreleased** Jira fix version from **Jira** (list versions for the issue’s **project key**). **Do not** copy “next version” from **`package.json`** unless the human explicitly says that file is the source of truth (it usually is not for Jira).

## Issue shape

- **Parent / story with subtasks:** Transition **open child issues to Done** (or the team's equivalent terminal status) **before** transitioning the parent, unless the repo's docs say otherwise.
- **Sub-task key only:** Close that issue directly (no parent transition required).
- **Ordinary story/task:** Fetch issue → apply field updates the human/docs require → transition to Done.

## MCP flow (summary)

Use tools only as their **schemas** allow (argument names, JSON strings for `fields`, etc.). Typical steps:

1. **Get the issue** — type, status, subtasks, project key, existing fix versions and assignee.
2. **Get the project's versions** — use the project key from the issue (e.g. `PROJ` from `PROJ-123`); filter **unreleased**; pick the version name to set (a human-supplied exact **name** wins).
3. **Update the issue** — set **assignee**, **fix versions**, or other fields when required; `fields` must be valid JSON per the schema.
4. **Get transitions, then transition** — resolve the transition id for **Done** (or the terminal name your board uses); repeat per issue (children → parent).

If a transition requires **resolution** or other mandatory fields, supply them in the transition's `fields` JSON per the tool docs.

## Ask mode / no MCP / read-only

Print a **manual checklist** for the human:

- [ ] Subtasks Done before parent (if applicable).
- [ ] Assignee / fix version per team policy (Jira UI or REST).
- [ ] Transition issue(s) to Done.
