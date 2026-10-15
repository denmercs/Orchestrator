---
name: plan-html
description: Helper scripts that scaffold, render and validate living plan pages (Markdown source of truth, derived HTML) for arch, ux, security and handoff plans.
---

# plan-html

A helper skill. It is loaded with `arch-plan`, `ui-ux-planner` and `code-handoff`, which own the content. This skill owns the scripts. Edit the Markdown; never hand-edit the derived HTML.

Run each script as `.claude/skills/plan-html/scripts/<file>`. If that path is missing, use `~/.claude/skills/plan-html/scripts/<file>`.

Kinds: `arch`, `ux`, `security`, `handoff`.

Default output, under `.harness/initiatives/<slug>/`:

- arch: `architecture-plan.md` and `architecture-plan.html`
- ux: `ux-plan.md` and `ux-plan.html`
- security: `security-posture.md` and `security-posture.html`
- handoff: `code-handoff.md` and `code-handoff.html`, always at the `.harness/` root

`--slug` must be a single folder name. Without it, the scripts use the only initiative folder, else the one initiative that already holds the file, else the `.harness/` root.

## init-plan-html.cjs

Scaffold the Markdown from a template, render the HTML and check its structure. It refuses to overwrite an existing `.md` unless `--force`.

```
node .claude/skills/plan-html/scripts/init-plan-html.cjs [repo-root] --kind arch --slug demo
```

Fallback: `~/.claude/skills/plan-html/scripts/init-plan-html.cjs`.

Flags: `--kind` (required), `--slug`, `--product`, `--task`, `--branch`, `--base` (default `main`), `--force`.

## render-plan-html.cjs

Derive the HTML from the Markdown.

```
node .claude/skills/plan-html/scripts/render-plan-html.cjs [repo-root] --kind arch --slug demo --validate
```

Fallback: `~/.claude/skills/plan-html/scripts/render-plan-html.cjs`.

Flags: `--kind` (required), `--slug`, `--file <md>`, `--out <html>`, `--validate` (also runs the validator).

## validate-plan-html.cjs

Check a rendered plan page against its kind. Flags: `--kind`, `--file <html>`, `--mode structure|ready` (default `ready`), `--strict-warn`.

```
node .claude/skills/plan-html/scripts/validate-plan-html.cjs [repo-root] --kind arch --file .harness/initiatives/demo/architecture-plan.html
```

Fallback: `~/.claude/skills/plan-html/scripts/validate-plan-html.cjs`.
