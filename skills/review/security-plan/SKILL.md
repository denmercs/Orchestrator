---
name: security-plan
description: >
  Security posture planning. Markdown is the posture source of truth (surfaces,
  trust decisions, hardening stages with optional Jira keys); HTML is derived with
  the plan-html render script. Refreshes keyed issue status one way from Jira into
  the Markdown, then re-renders. Supports a whole-plugin security assess recorded
  under the plan's assess section. Use for a durable "how we intend to be secure"
  and plugin health. Does not replace the per-PR security check in Review or
  story Plan TDD grilling.
---

# Security plan

Set **security posture** as a living **Markdown** plan with a derived HTML briefing for humans.

This is **posture planning** (durable intent) plus an optional **whole-plugin assess**. It is not a relentless grill and not the ship gate.

**Prose:** apply the `anti-slop` skill to plan copy and chat. Expand abbreviations on first use; keep trust decisions concrete.

## Companion extra

Load `plan-html` with this skill; it holds the render scripts.

Run them as `.claude/skills/plan-html/scripts/<file>`. If that path is missing, use `~/.claude/skills/plan-html/scripts/<file>`.

- Scaffold: `node .claude/skills/plan-html/scripts/init-plan-html.cjs [repo-root] --kind security --slug <slug>` (fallback `~/.claude/skills/plan-html/scripts/init-plan-html.cjs`)
- Render: `node .claude/skills/plan-html/scripts/render-plan-html.cjs [repo-root] --kind security --slug <slug> --validate` (fallback `~/.claude/skills/plan-html/scripts/render-plan-html.cjs`)
- Validate: `node .claude/skills/plan-html/scripts/validate-plan-html.cjs [repo-root] --kind security --file <html>` (fallback `~/.claude/skills/plan-html/scripts/validate-plan-html.cjs`)

This skill's own scripts live beside it. Run them as `.claude/skills/security-plan/scripts/<file>`. If that path is missing, use `~/.claude/skills/security-plan/scripts/<file>`.

- Whole-plugin assess: `node .claude/skills/security-plan/scripts/security-assess.cjs [repo-root] --out .harness/security-assess.json` (fallback `~/.claude/skills/security-plan/scripts/security-assess.cjs`)
- Change scan: `node .claude/skills/security-plan/scripts/security-audit.cjs [repo-root]` (fallback `~/.claude/skills/security-plan/scripts/security-audit.cjs`)

Always run assess with `--out .harness/security-assess.json`. The plan-html validator cross-checks the `#assess` and `#status` sections against that file, so the numbers in the plan must match it.

### Script flags

`security-audit.cjs` (exit 1 when any error finding exists):

| Flag | Effect |
|------|--------|
| `--base <ref>` | Branch to diff against (default `main`) |
| `--deps` | Also run npm and composer dependency audits |
| `--json` | Print the report as JSON |
| `--out <file>` | Write the Markdown report to this file. Without it, no file is written |

`security-assess.cjs`:

| Flag | Effect |
|------|--------|
| `--wordpress-root <path>` | WordPress install path, needed for a complete Wordfence scan |
| `--wordfence required\|off` | Whether Wordfence CLI must run (default `required`) |
| `--skip-wordfence` | Same as `--wordfence off` |
| `--semgrep-config a,b` | Extra Semgrep configs, comma separated. `p/php` and the bundled WordPress rules always run |
| `--skip-semgrep` | Skip the Semgrep probe |
| `--skip-deps` | Skip the dependency probe |
| `--out <file>` | Write the JSON report to this file. Without it, no file is written |
| `--json` | Print the JSON report to stdout |
| `--strict` | Exit non-zero when the assess is incomplete or has error findings |

## Two stages

| Stage | Question | Tool |
|-------|----------|------|
| **1. Every PR** | May this change ship? | The Orchestrator Review step, which may run `security-audit.cjs` |
| **2. Whole plugin** | Is the product healthy? | This skill and `security-assess.cjs` |

Stage 2 probes: surface census, **Semgrep**, npm and composer **dependencies**, and **Wordfence CLI** `vuln-scan` (required for complete WordPress health when `--wordpress-root` is set). Do **not** run Stage 2 on every PR.

## Source of truth

The living Markdown (pack `security-posture.md`, or single file `.harness/security-posture.md`) is **the** source of truth for security posture: surface inventory, open and resolved trust decisions, hardening stages, optional epic and story keys, machine **assess** and CVE snapshots, and **status as shown** after refresh.

**Derived view:** render with `--kind security` so humans open `security-posture.html` in a browser. **Do not hand-edit** the HTML. Follow [HTML-REPORT.md](HTML-REPORT.md) for the section contract.

| Layer | Role |
|-------|------|
| **Markdown** | Posture source of truth. Read and decide from here |
| **HTML** | Human browser view, derived only |
| **Jira epics and stories** | Workflow; keys join stages; status feeds into the Markdown on refresh |
| **Architecture decision records (ADRs)** | Load-bearing *why* (for example a public REST policy) |
| **Orchestrator Review** | Per-PR check; consumes posture, does not replace it |
| **`security-assess.cjs`** | Whole-plugin facts for the `assess` section; not a PR gate |

**One way only:** Jira to Markdown on refresh, then re-render. Never push workflow status from this skill back to Jira.

Follow-up answers **update that same Markdown**, then re-render before the next question.

## Boundaries

| Use this | Use something else |
|----------|-------------------|
| Durable posture, trust boundaries, hardening roadmap | Per-PR PASS or FAIL: the Orchestrator Review step |
| Whole-plugin health (Semgrep, Wordfence, deps) | Same: Stage 2 assess into `assess` |
| Targeted Q&A on open security decisions | Full TDD grill: the story Plan step |
| Living stages plus **CVE and dependency** and **assess** snapshots | Penetration methodology and exploit proofs: `wordpress-penetration-testing` (on demand only) |
| How we intend to be secure | Structure and seams: `arch-plan` |

**Signal preference:** posture views use **machine** snapshots (assess JSON, npm and composer audit). They do **not** invent a pen-test score, readiness percentage, or subjective security grade. An **incomplete** assess (missing Semgrep or blocked Wordfence) is honest, not a fake PASS.

**Non-goals:** no production code, no invented CVEs, no pen-test scores, no replacing machine checks on a PR, no two-way Jira sync, no merging this into the architecture plan as a full audit section, no Wordfence or full Semgrep on every PR.

## Not the loop

Orchestrator Review covers per-story security. This skill is durable posture plus optional whole-plugin assess. Run it when posture is unclear or health is requested.

## Interaction model

1. **Explore and draft.** Inventory surfaces from the repo and the checklist themes below. Synthesize first; do **not** open with a long interview.
2. **Assess when health is in scope.** Run `security-assess.cjs` as above and fold it into `## assess`.
3. **Write the living Markdown**, render it, open it in a browser, and tell the user the absolute path.
4. **Targeted Q&A** only on **open** trust decisions (one at a time, with a recommended answer).
5. **After every material answer**, rewrite the **same** Markdown and re-render.
6. **Lock.** ADRs when load-bearing; publish stages as stories; remind that the per-PR check stays in Review.

**Prose:** full sentences and scannable lists.

## On every run

1. **Locate** the living Markdown (resolve order below).
2. **If stages or the finish line have keys**, refresh status from Jira into the Markdown only (same rules as `arch-plan`), re-render, and tell the user to refresh the browser.
3. **If assess is requested**, run `security-assess.cjs --out .harness/security-assess.json`, then fold it into `## assess` and the bottom `## status`.
4. Then continue: draft, decision loop, publish, or handoff.
5. No keys: skip Jira. No file: explore and draft.

## Living plan paths

**Resolve order:**

1. A path from the consumer's `docs/agents/domain.md` when it documents the security source of truth
2. Initiative pack: `.harness/initiatives/<slug>/security-posture.md` (`--slug`, or the only pack under `initiatives/`)
3. Single file: `.harness/security-posture.md`

Initiative-scoped posture is preferred when the trust surface belongs to that train. One Markdown file per train; **rewrite in place**, no timestamped copies.

Optionally lock-copy the rendered HTML to `docs/security/security-posture.html` when the user asks.

Open after render: `open <path.html>` (macOS), `xdg-open` (Linux), `start` (Windows).

Section contract: [HTML-REPORT.md](HTML-REPORT.md). Stages: [STAGES.md](STAGES.md).

## Checklist themes

Use these to inventory surfaces. Do not run a PR gate from here unless the user asks.

- Authorization and CSRF at every privileged entrypoint (REST routes with a real `permission_callback`, ajax and `admin_post` handlers with capability checks and nonces)
- Input, output, and SQL discipline (sanitize, validate, escape; prepared statements for dynamic SQL)
- Secrets and dangerous APIs (no hardcoded secrets; no `eval` or `extract` on entry paths)
- Uploads, outbound requests, and frontend sinks (allowlists, capability checks, XSS and open-redirect review)

## Repo inputs

1. The consumer's `AGENTS.md`, `docs/agents/issue-tracker.md`, `docs/agents/domain.md`
2. `CONTEXT.md`, `docs/adr/` (authorization, data, and public API decisions)
3. Entrypoints: REST, ajax, `admin_post`, cron, uploads, remote fetch, frontend bundles
4. An existing `security-posture.md` or `architecture-plan.md` (check `domain.md` and the pack first)
5. The last `.harness/security-assess.json` when present
6. Stack skills **on demand** only (`wordpress-security-validation`, `postgresql-security-best-practices`, `supabase-security`), not every run

## Workflow

### 1. Frame posture

- **Primary job** of this posture (one sentence)
- **Trust boundary** summary: who may do what
- **Non-goals**: accepted risk or out of scope (explicit)
- **Constraints**: compliance, public vs private APIs, WordPress roles

### 2. Whole-plugin assess (when health is in scope)

When the user asks for assess, deep, or whole-plugin health, or `## assess` is missing or stale and they want health:

```bash
node .claude/skills/security-plan/scripts/security-assess.cjs . --wordpress-root <path> --out .harness/security-assess.json
```

Fold the facts into `## assess` (and `## cves` from the deps probe). Triage ERROR findings into stages. Do not invent CVEs.

### 3. Draft the Markdown

Per [HTML-REPORT.md](HTML-REPORT.md): phase (when keyed), locks, surfaces, **assess snapshot**, **CVE and dependency snapshot**, current and target risk shape, decisions, hardening stages, non-goals, gate, status. Optional finish line when stories exist.

Prefer the last `security-assess.cjs` run; otherwise cite `security-audit.cjs . --deps` or npm and composer audit. Record counts and date, never a fake pen-test score.

### 4. Decision loop

Only open decisions. Material answers rewrite the Markdown. Do not grill every checklist item.

### 5. Publish keys (optional)

Fold into existing security or hardening epics when possible; write `epic:` and `story:` lines. The next refresh fills in status.

### 6. Handoff

| Next | When |
|------|------|
| Split into stories | Publish hardening stages |
| The story Plan step | Behavior and TDD for one hardening slice |
| Re-run assess | After hardening or before release |
| Orchestrator Review | Every PR; it may run `security-audit.cjs` |
| Architecture decision record (ADR) | Public-by-design routes, secret storage, capability model |
