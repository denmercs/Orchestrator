# Hardening stages (security posture)

Ordered hardening checklist for the living plan's `## stages` section. Adapt titles to the product; keep intent. Prefer **folding into existing epics** plus stories over one epic per stage.

| ID | Intent | Acceptance (one line) |
|----|--------|------------------------|
| **H0** | Name trust boundaries and surfaces in glossary language | Surfaces table complete; terms in `CONTEXT.md` or the plan until promoted |
| **H1** | Authorization and CSRF at privileged entrypoints | Capabilities and nonces, or a real REST `permission_callback`, on in-scope routes |
| **H2** | Input, output, and SQL discipline on hot paths | Sanitize, validate, escape; prepared SQL where dynamic |
| **H3** | Secrets and dangerous APIs | No hardcoded secrets; no eval or extract patterns on entry paths |
| **H4** | Uploads, outbound requests, and frontend sinks (as applicable) | Allowlists and capability checks; frontend XSS and redirect review or follow-ups noted |
| **H4a** | Whole-plugin assess wired | `security-assess.cjs` run recorded in `## assess`; `--wordpress-root` set for WordPress; Semgrep and Wordfence complete or gaps ticketed |
| **H5** | Per-PR check wired | Review runs the audit script (`security-audit.cjs`) before the PR, and the posture names that step |

## Rules

- Stages are **hardening slices**, not a pen-test novel, pen-test score, or chat to-do dump.
- Known dependency CVEs belong in the `## cves` snapshot (and optionally a hardening story), not as a graded "pen-test readiness" metric.
- Whole-plugin Semgrep and Wordfence findings belong in `## assess`. Promote confirmed ERRORs into H1 to H4 stories; do not block every PR with Stage 2 tools.
- Skip a stage only with an explicit non-goal in the plan.
- H1 to H4 may each become one or more stories with their own Plan step.
- **H5** does not replace running the audit. It makes sure the check is part of the delivery loop.
- Jira: `epic:` and `story:` meta lines; refresh status on a plan run only (one way, Jira to Markdown).
