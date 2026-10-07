// How a phase's architecture is planned. The architecture session gets this verbatim after its
// phase-specific instructions (server/harness-architect.ts). Edit here to change how every
// phase is planned.

export const ARCHITECTURE_METHOD = `# How to plan a phase's architecture

## Vocabulary
Use these words exactly; don't swap in "component", "service", "API" or "boundary".
- **Module**: anything with an interface and an implementation, at any scale (function, class,
  package, slice across tiers).
- **Interface**: everything a caller must know to use the module: types, invariants, ordering,
  error modes, configuration, performance.
- **Implementation**: the code inside a module.
- **Depth**: behaviour a caller or test gets per unit of interface it has to learn. Deep = a lot
  behind a small interface. Shallow = the interface is nearly as complex as the implementation.
- **Seam**: where a module's interface lives; a place behaviour can change without editing there.
- **Adapter**: a concrete thing that satisfies an interface at a seam.
- **Leverage**: what callers get from depth. **Locality**: what maintainers get from depth
  (change, bugs and verification in one place).
Prefer the repo's own names for domain concepts (CONTEXT.md, README) over invented ones.

## Principles
- Deletion test: imagine deleting the module. If complexity vanishes, it was a pass-through. If it
  reappears across callers, the module earns its keep.
- The interface is the test surface. If tests must reach past it, the module is the wrong shape.
- One adapter is a hypothetical seam; two adapters make a real one. Don't add a seam nothing varies across.
- Depth is a property of the interface, not the implementation.

## The plan file
architecture.md is the plan's only source of truth. The plugin renders architecture.html from it for
people to read; never write or edit the HTML. Rewrite the Markdown in place after every material
answer (one that changes a shape, a seam, a stage, a key or a decision). Never write dated copies or a
second plan, and never append chat history.

Frontmatter: phase, title, status (draft | agreed), updated (YYYY-MM-DD). The plugin adds
jira_refreshed and jira_site when it refreshes from Jira; keep them.

Sections are level-2 headings with these exact ids, in this order (the HTML titles them):

- \`## job\`: one sentence: what this phase's structure must make possible.
- \`## phase\`: once anything is tracked in Jira. Where delivery stands: which epic(s) home this
  plan, a table mapping each stage or decision to its Jira home and status, then a "> " callout
  with the current truth and the next action.
- \`## finish-line\`: once stories have keys. The pickup path: "▶ Start here" (the story to do now,
  its status, what it unblocks), then a table \`# | Story | Epic | Role | Jira | Depends on\`
  in pickup order, ending with a 🏁 row for what is true when the phase is done.
- \`## locks\`: once anything is decided. *Locked* (one line per resolved decision) and *Next*
  (numbered steps matching "▶ Start here").
- \`## scope\`: in scope; constraints (public interfaces, platform, earlier phases, ADRs).
- \`## current\`: a Mermaid diagram of today's modules and where callers leak past them, then at
  most two short lines. Rendered side by side with target.
- \`## target\`: a Mermaid diagram of where this phase ends, then each seam's interface in one
  line (five bullets at most).
- \`## decisions\`: one card per decision.
- \`## stages\`: one card per stage (track A).
- \`## track-b\`: only when a second epic owns a capability train that interleaves with the
  stages. One card per story, in order, ending with a 🏁 card. Don't repeat S0–S5 here.
- \`## nongoals\`: short bullets.

Cards are level-3 headings: \`### <id> — <title>\`.
- Decisions: \`### d1 — <question> (open)\` with options, trade-offs and **Recommended:**; once
  answered, \`### d1 — <question> (resolved: <answer>, YYYY-MM-DD)\` and one line of why. Update
  cards in place. With none open, write one line saying so.
- Stages: \`### S1 — <verb + module>\`, then the tracker join lines, then
  "Acceptance: <one observable line>" and "Story: stories/NN-<slug>.md".

Tracker join lines go directly under a stage or track-b card heading, one per line:
\`epic: KEY-1\`, \`story: KEY-2\`, \`status: <Jira status>\`. The plugin fills \`status:\` from
Jira (the story's status, or the epic's when there is no story) and fills "Jira" table cells for
rows naming a key. That flow is one way: never change Jira status yourself and never invent a
status. A card without keys stays untracked.

## Stages
Move from current to target in this order. Skip a stage that doesn't apply and say why on its card.
- S0: name the deep module(s) in the project's vocabulary.
- S1: define the interface; its tests sit at the seam.
- S2: move the logic behind the seam; callers use the interface.
- S3: a second adapter, only if something really varies.
- S4: migrate the remaining callers; nothing reaches past the interface.
- S5: delete pass-throughs and the tests that only covered them.
If the phase changes behaviour only, not structure, say so and use plain delivery stages instead.

## Stories
One file per stage in stories/, named NN-<slug>.md (NN is pickup order). Frontmatter:
id (S1, S2, …), title (short, imperative), status (todo), depends_on (comma-separated ids or empty);
add jira: <key> once published. Body: Goal; Acceptance (observable checks); Notes linking the
stage and decisions in ../architecture.md. Only add, reorder or rewrite stories whose status is todo.

## Publishing to Jira
Only when I ask to publish. Prefer one existing epic as the home for all stages, with one story per
stage under it; create an epic per stage only when no home fits. A second capability train gets its
own epic (track B). Use the Atlassian tools if this session has them, write the keys into the
cards' join lines and the finish line, and add jira: <key> to each story file. Never transition,
comment on, or edit Jira issues beyond creating them.

## Decision loop
After the draft, ask the highest-impact open decision: one question, your recommended answer, and
what changes either way. Batch small defaults as "assumption → answer" lines so they can be
pushed back on quickly. After each answer, rewrite the plan and the affected stories, then ask the
next. On "lock": set status: agreed, update the date, and stop.

## Tone
Plain English. Diagrams carry structure; cards carry decisions; the finish line carries pickup
order. If a sentence could be a bullet, make it one. Expand abbreviations on first use.
No hype, no hedging.`;
