# Repo profiles

Read from [SKILL.md](SKILL.md) Phase 3. A profile is a lookup: **which conventions apply, which commands verify, which review rules this codebase has earned.**

This kit ships no profiles. A repo that documents itself well needs none: [detection](#detection) covers it. Add a row below only for a repo whose rules are not written down anywhere the reviewer can read.

## Detection

Resolve in this order and stop at the first hit:

1. `git remote get-url origin` → match a profile below by repo name.
2. No match → **derive** the profile from the checked-out repo:
   - conventions: root `AGENTS.md` / `CLAUDE.md`, `.cursor/rules/*.mdc`, `.github/PULL_REQUEST_TEMPLATE/`
   - commands: `package.json` scripts, `Makefile`, `build.sbt`, CI workflow files under `.github/workflows/`
   - base branch: `gh repo view --json defaultBranchRef`
   - issue key pattern: infer from branch names in `git log`
3. Still nothing → review on correctness, security, and tests only, and say in the output that no documented conventions were found. Do not invent house style.

**Derived beats stale.** If a row below contradicts what the repo says today, trust the repo and mention the drift.

---

## Row template

Copy this block, one per repo.

### `<repo-name>`

- **Conventions:** where they live (file paths), plus any rule a reviewer must know.
- **Verify commands:** the lint, typecheck and test commands to run, narrowest first.
- **Base branch:** `<main | master | …>`
- **Issue key pattern:** `<regex, or "none">`
