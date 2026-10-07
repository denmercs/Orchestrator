# Orchestrator: skill vocabulary

This file defines the words the skill code uses: the Skills drawer, the Story belt and the skill sources behind them. Later work should reuse these names instead of making up new ones. When code adds or renames one of these concepts, update this file in the same change.

## Phase 1 rule

Skills are used through pinned sources, worktree copies and attachments. They are **never installed** into `~/.claude/skills` or `~/.agents/skills`, and the plugin never runs `npx skills add`. The `installed` source only *reads* those folders. Nothing in the plugin writes to them.

## Skill source

A place skills are read from. Code: `SkillSource` in `shared/belt.ts` (`id`, `label`, `location`, `kind`, `enabled`, `pin`). Sources are stored in the belt settings (`sources`) and managed on the drawer's **Sources** tab. There are three kinds of location, worked out by `parseLocation` in `server/skill-sources.ts`:

- **git**: an `owner/repo` (taken as GitHub) or a git URL (`https://`, `ssh://`, `git@`). `addSource` clones it and pins it to the current commit.
- **folder**: an absolute or `~/` path. Read live in place. It has no pin and no checkout.
- **`installed`** (`MACHINE_SOURCE`): the skills already on this machine. `scanMachine` reads `~/.claude/skills`, `~/.agents/skills` and `~/.claude/commands`. It is never stored in `sources` and nothing is copied for it. The drawer shows it as **This machine**.

`kind` (`team`, `personal`, `imported`) says who owns the source. It does not say how the source is read. `enabled: false` keeps a source connected but leaves its skills out of the catalog.

- **Pin**: the commit a git source is held at (`pin`). It only moves when someone runs **Check for updates** (`checkSource`), which fetches without moving the pin, and then presses **Update to `<sha>`**. Folder and `installed` sources have no pin.
- **Checkout**: the local clone of a git source, at `SOURCES_ROOT/<id>` (`~/.orchestrator/skill-sources/<id>`). `materialise` keeps it on the pin before anything is read from it.

_Avoid_: repo, registry, library, provider (for a source); version, ref (for the pin).

## Catalog skill

One skill that can be picked, as listed by `loadCatalog`. Code: `CatalogSkill` (`name`, `folder`, `description`, `source`, `kind`). The catalog is every `installed` skill plus the skills of each enabled source.

- `name` is the `name` in the skill's `SKILL.md` frontmatter, falling back to `folder` when there is none. This is the name skills.sh uses. For a command it is the file name without `.md`.
- `folder` is the folder holding `SKILL.md`, or the command's file name without `.md`.
- `description` is the frontmatter `description` (one line, trimmed), or `""`. `readFrontmatter` parses both keys.
- `source` is the `id` of the Skill source it came from, or `installed`.
- `kind` is `skill` (a folder with `SKILL.md`, found up to five folders deep) or `command` (a `.md` file in `commands/` or `.claude/commands/`).

_Avoid_: plugin, tool, package.

## Skill ref

A pointer from the belt settings to a catalog skill. Code: `SkillRef` (`name`, `source`). It matches a catalog skill on the same `source` whose `name` or `folder` equals the ref's `name` (`matchesRef` in `shared/belt.ts`; `findSkill` on the server prefers a `name` match). Refs saved with folder names keep working. A ref whose source is gone, turned off, or has no skill by that name is not an error when saved. `installSkills` reports it as a warning when the phase starts.

_Avoid_: skill id, skill key.

## Belt phase extras

The extra skills a Story belt phase loads on top of the skill it runs. Code: `Phase.extras`, an array of `Extra` (a Skill ref plus optional `required` and `optional` flags). The skill the phase runs is `Phase.runs`, which is a single Skill ref and is not an extra. The phase prompt names the extras with "Also use these skills: …".

An extra marked `required` in `DEFAULT_PHASES` is always loaded, even if saved settings removed it. `phaseSkills` adds it back. Today that is `ss-security-audit` in Review.

_Avoid_: add-ons, plugins, secondary skills.

## Worktree copy

How a phase's skills reach a new story agent. When a phase starts, `installSkills` copies each non-`installed` Skill ref (the `runs` skill and the extras) from its source into the story worktree:

- a skill folder goes to `.claude/skills/<folder>`, `.cursor/skills/<folder>` and `.agents/skills/<folder>`, named after its folder, not its frontmatter `name`;
- a command goes to `.claude/commands/<folder>.md` and `.cursor/commands/<folder>.md`.

The copied paths are added to the worktree's `info/exclude` so they never show up in git. A path the repo already commits is left alone. `installed` refs are skipped because those skills are already global. This copy is the only way skills are "installed", and it happens per worktree.

_Avoid_: install (on its own, which reads as global), sync, deploy.

## skills.sh registry

The public skills.sh index, used to *find* skills. Searching it gives a GitHub `owner/repo` that holds the skill. That repo is then connected as a git Skill source, pinned like any other. The registry never installs anything and is not a Skill source itself. The Skills drawer's Sources tab searches it (**Search skills.sh**); **Connect** on a result adds its repo as an imported source.

_Avoid_: marketplace, store, skills.sh source.

## Skill attachment

A skill handed to an agent that is already running, through that agent's composer, instead of through a belt phase. The skill is read from a connected Skill source. Nothing is copied into the worktree or installed globally. Belt phase extras serve new story agents. Attachments serve running agents. `readSkill` returns what an attachment carries: the `SKILL.md` body after the frontmatter, absolute paths to the skill's other files in the pinned checkout, folder or machine path, and the source's pin as `commit`. It reads only connected, enabled sources (and `installed`) and never clones anything else. Every composer offers them through the **Skills** attachment source (`skills.attach`): the attached text is a header naming the skill, its source and short pin, then the body, then a `## Files in this skill` list.

_Avoid_: skill injection, skill upload.
