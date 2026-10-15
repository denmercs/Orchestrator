# Security posture: living plan (Markdown to HTML)

Briefing for **security posture**. **Markdown is the posture source of truth**; HTML is derived for the browser with the render script (`.claude/skills/plan-html/scripts/render-plan-html.cjs --kind security`, fallback `~/.claude/skills/plan-html/scripts/render-plan-html.cjs`). Same craft as `arch-plan`: sticky nav, dark chrome with emerald, sky, and amber accents, Mermaid when structure helps, sparse prose. The scaffold is the plan-html `plan-security.md` template.

This answers *how we intend to be secure* and, when assessed, *is the plugin healthy as a whole*. It does **not** answer *may this PR ship?*; that stays with the Orchestrator Review step, which may run `security-audit.cjs`.

**Lifecycle:** rewrite the **same `.md`** after material follow-ups and after a Jira status refresh, then re-render. Do not timestamp a new file per answer.

## Why Markdown plus derived HTML

| Format | Use |
|--------|-----|
| **`security-posture.md`** (pack under `.harness/initiatives/<slug>/`, or `.harness/security-posture.md`) | Posture source of truth |
| **`security-posture.html`** | Human browser view, derived with the render script; do not hand-edit |
| ADRs | Load-bearing *why* |
| Chat to-do list or canvas | Not a substitute for the Markdown |

## Sections

Each `## <id>` heading in the Markdown becomes a `section#<id>` in the HTML. Required unless marked otherwise.

| Section | Contents |
|---------|----------|
| frontmatter | `kind: security`, `product`, `status`, `updated`, `task` |
| `## phase` | When tracker keys exist: delivery loop vs Jira posture, mapping table, the next hardening slice, and a reminder that every PR still gets the Review check |
| `## finish-line` | Optional. When hardening stories are keyed: a start-here card, an ordered table, and depends-on. Fold into existing security epics |
| `## locks` | Two columns: **Locked** (resolved trust decisions, one line each) and **Handoff** (next hardening story, re-run assess, Review check before PR) |
| `## surfaces` | Inventory table (below) |
| `## assess` | Whole-plugin snapshot when Stage 2 has been run (below) |
| `## cves` | Dependency advisory snapshot (below) |
| `## current` and `## target` | Side by side. Current: where trust is weak or unclear. Target: intended posture (authorization at the seam, nonce on state change, escape and prepare discipline, no secrets in the client). Mermaid optional and short |
| `## decisions` | **Open** as fuller cards (options plus a recommended one, amber); **Resolved** as compact emerald lines. When none are open: "No open security posture decisions." |
| `## stages` | Hardening stages per [STAGES.md](STAGES.md), with `epic:` and `story:` lines when published |
| `## nongoals` | Accepted risks and out-of-scope items. An honest non-goal beats a fake "secure everything" stage |
| `## gate` | A short card: the per-PR check is the Orchestrator Review step, which may run `security-audit.cjs`; this plan never passes a PR; whole-plugin health is `security-assess.cjs` on a separate cadence |
| `## status` | Required once assess has been run; bottom of the page (below) |

## Header

- Eyebrow: repo and Jira project
- Title: **Security posture**
- Meta: status, updated, last Jira refresh
- **Primary job** in one sentence
- Source-of-truth one-liner

## Surfaces

| Surface | Examples | Trust note |
|---------|----------|------------|
| HTTP entrypoints | REST, ajax, `admin_post` | Authorization and CSRF |
| Privileged actions | settings, deletes, imports | Capability |
| Data at rest | options, meta, files | Secrets and personal data |
| Outbound | remote fetch, webhooks | SSRF and secrets |
| Frontend | admin UI, public scripts | XSS and open redirect |

Mark **in scope** vs **accepted or out of scope**. Do not paste a full pen-test report.

## Whole-plugin assess

A machine **health snapshot** from `security-assess.cjs`. Not a pen-test score and not the PR ship gate. The plan-html validator cross-checks this section and `## status` against `.harness/security-assess.json`, so run assess with `--out .harness/security-assess.json`.

| Field | Source |
|-------|--------|
| Last run | Date and the assess command |
| Completeness | `complete` or `incomplete`, with reasons (missing Semgrep, blocked Wordfence, and so on) |
| Probes | surfaces, semgrep, deps, wordfence: status and one-line detail |
| ERROR and WARNING | Counts from the report. State ERROR as `ERROR <count>`. Link top findings; do not invent IDs |
| Action | Confirmed: hardening stage or story. Dismissed: note with evidence. Incomplete: pass `--wordpress-root` and install the CLIs |

Rules:

- Prefer the facts in `.harness/security-assess.json`. If never run: show **Not run** and a one-line next step.
- Wordfence needs a **WordPress install path** (`--wordpress-root`) and is required for **complete** WordPress health by default.
- Completeness is not "secure enough to skip the Review check."

## CVE and dependency scan

A machine **advisory snapshot** for known dependency CVEs. Not a pen-test score, readiness percentage, or subjective security grade.

| Field | Source |
|-------|--------|
| Last run | Date and command (the assess deps probe, `security-audit.cjs . --deps`, `npm audit`, or `composer audit`) |
| Critical and high | Counts from the scanner, or "not run" |
| Moderate and low | Optional; keep compact |
| Action | Fix before ship, accepted risk (link the non-goal), or re-run on the next plan run |

Rules:

- Prefer facts from the last scan over invented CVE lists. If no scan yet: **Not run** and a one-line next step.
- No pen-test score, OWASP "maturity" percentage, or 1 to 5 posture grade.
- Full exploit write-ups belong in on-demand pen-test skills or external reports, not here.

## Status summary

Bottom-of-page health, with no percentage score. Derive it from `## assess`, `## decisions`, `## stages`, and `## nongoals`.

| Status | When |
|--------|------|
| **Red** | Assess incomplete, or any untriaged ERROR finding |
| **Amber** | Assess complete; ERRORs dismissed or ticketed into stages; WARNING findings still open |
| **Green** | Assess complete; 0 open ERRORs; Wordfence clean (or off); deps accepted or clear |

Show one status chip (red, amber, or green) and one sentence on why.

**Risk register:** a short table of confirmed risks from assess and open decisions.

| Risk | Source | Status | Notes |
|------|--------|--------|-------|
| e.g. public REST write route | semgrep, surfaces | **Open**, **Resolved**, or **Accepted** | file:line, stage or story key, or non-goal link |

- **Open**: confirmed, not fixed yet.
- **Resolved**: fixed in code or closed by an ADR.
- **Accepted**: an explicit non-goal; link `## nongoals`.
- Leave out dismissed false positives. Update this table whenever assess is re-run or a risk closes.

**Snapshot strip:** completeness, open ERROR count, open WARNING count, last assess date.

## Footer

Next hardening pickup, the path to the source of truth, and the last assess date if any.

## Style and tone

Match `arch-plan`: sparse bullets, concrete trust decisions. No invented CVEs, no pen-test scores, no hedging. Apply the `anti-slop` skill and expand abbreviations on first use.
