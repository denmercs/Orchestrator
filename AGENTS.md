# Orchestrator: agent notes

## Kit

`skills/` and `rules/` are the kit. `npm test` runs the guard test `skills/kit.test.mjs`. It fails on forbidden strings and on any script a `SKILL.md` names that is missing.

- Kit content must stay public-safe: no employer names, ticket keys, device ids or personal paths. Fix the content, never add an allowlist entry.
- A skill carries its scripts in its own `scripts/` folder, because the worktree copy copies only skill folders.
