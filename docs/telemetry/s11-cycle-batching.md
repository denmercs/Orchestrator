# S11 — Measure and decide on cycle batching

Initiative: Telemetry and Token Savings, Phase 2 (Leaner step agents). This is a copy of the S11 story notes,
which live in the git-ignored `.harness/` folder. The scripts in [`s11/`](s11/) read local data
(`~/.orchestrator`, `~/.paseo/agents`, `~/.claude/projects`), so they only reproduce these tables on the machine
that ran the loop.

## Goal

Find out what S7–S10 saved, and whether batching small TDD cycles into one agent is worth a phase.

## Acceptance

- Notes below compare tokens per step type and cost by model, before (S6 baseline) and after (this phase's later stories).
- They count cold starts per story and how much of each Implement agent's tokens is the cold start, to judge cycle batching.
- A recommendation: batch cycles or not, and if so, the rule (for example, cycles under N lines of plan). If yes, a new phase is proposed in the initiative's Outcome notes, not built here.
- No production code changes.

## Notes

- Stage S11 in Phase 2's architecture plan (`.harness/initiatives/telemetry-and-token-savings/`, kept local).

### Baseline (from S6)

Source: `~/.orchestrator/context-telemetry.jsonl`, measured 2026-10-08. It holds 115 rows, from
2026-10-07T23:23:10Z to 2026-10-08T04:50:09Z. It has never rotated, so there is no `.1.jsonl`.
89 rows are `turn` rows. 49 of those have a loop step, and the tables below use only those 49.

"Context tokens" means the context size at the end of each turn, added up. It is not billed tokens.

These rows have no `story` field because they were written before S6. Each `agentId` was mapped
to its `loop-story` and `loop-initiative` labels using Paseo's saved agent records, including
archived agents. All 32 agents in the file mapped, so none are unmapped. `telemetry` means this
initiative and `skills` means the skills-in-every-phase initiative. The prefix keeps story ids
from the two initiatives apart.

Phase 1 S3 and S4 do have rows. The plan expected none, but both ran between 23:55Z and 00:33Z,
after the file started. S2 only shows the end of its PR step, because the file started while that
agent was running.

Some runs are not complete:
- S6's own run covers only the steps that had finished when this was measured: plan, and
  implement so far. It has no review or pr rows.
- S13 had only finished plan and its first implement cycle.
- skills S1 had only finished plan.

No row has a `model`. S6's rows came from the plugin version installed at the time, which did not
write `model` yet, and older rows predate the field. Paseo's agent records show `claude-opus-5-5`
for every loop agent here.

Per story and step:

| Story | Step | Turns | Context tokens (Σ used) | Mean per turn | Agents (cold starts) | Models |
|---|---|---:|---:|---:|---:|---|
| telemetry S2 | pr | 5 | 582,143 | 116,429 | 1 | unknown |
| telemetry S3 | plan | 2 | 300,036 | 150,018 | 1 | unknown |
| telemetry S3 | implement | 1 | 171,936 | 171,936 | 1 | unknown |
| telemetry S3 | review | 1 | 125,263 | 125,263 | 1 | unknown |
| telemetry S3 | pr | 2 | 188,738 | 94,369 | 1 | unknown |
| telemetry S4 | plan | 2 | 284,686 | 142,343 | 1 | unknown |
| telemetry S4 | implement | 2 | 267,423 | 133,712 | 2 | unknown |
| telemetry S4 | review | 2 | 237,368 | 118,684 | 2 | unknown |
| telemetry S4 | pr | 4 | 422,748 | 105,687 | 1 | unknown |
| skills S0 | plan | 4 | 421,847 | 105,462 | 1 | unknown |
| skills S0 | implement | 3 | 307,117 | 102,372 | 1 | unknown |
| skills S0 | review | 1 | 100,088 | 100,088 | 1 | unknown |
| skills S0 | pr | 3 | 282,618 | 94,206 | 1 | unknown |
| telemetry S12 | plan | 3 | 337,713 | 112,571 | 1 | unknown |
| telemetry S12 | implement | 1 | 121,128 | 121,128 | 1 | unknown |
| telemetry S12 | review | 1 | 109,709 | 109,709 | 1 | unknown |
| telemetry S12 | pr | 2 | 191,379 | 95,690 | 1 | unknown |
| skills S1 | plan | 1 | 108,702 | 108,702 | 1 | unknown |
| telemetry S13 | plan | 3 | 166,746 | 55,582 | 1 | unknown |
| telemetry S13 | implement | 2 | 88,705 | 44,353 | 1 | unknown |
| telemetry S6 | plan | 2 | 133,314 | 66,657 | 1 | unknown |
| telemetry S6 | implement | 2 | 118,027 | 59,014 | 1 | unknown |

Per step, all stories:

| Step | Turns | Context tokens (Σ used) | Mean per turn | Agents (cold starts) | Models |
|---|---:|---:|---:|---:|---|
| plan | 17 | 1,753,044 | 103,120 | 7 | unknown |
| implement | 11 | 1,074,336 | 97,667 | 7 | unknown |
| review | 5 | 572,428 | 114,486 | 5 | unknown |
| pr | 16 | 1,667,626 | 104,227 | 5 | unknown |
| **all** | 49 | 5,067,434 | 103,417 | 24 | unknown |

One thing to watch: S13 and S6 ran after S12 merged. Their mean per turn is about 44k–67k, against
about 94k–172k for every run before them. That fits with S12 trimming the servers attached to each
agent, but it comes from two partial runs, so treat it as a hint, not a result.

### After

Source: the same telemetry file, joined to Paseo agent records and Claude transcripts by `docs/telemetry/s11/load.mjs`.
Every table from here on is one snapshot, cut at `AFTER_END` = 2026-10-08T16:01:08.999Z, S11's last Implement
turn (cycle 4). `load.mjs` drops telemetry rows and transcript API calls after that time (298 rows remain), so S11's
own review, later stories and anything still running don't move the numbers. Reproduce with
`node docs/telemetry/s11/report.mjs --check after`.

The split is by agent, not by row. An agent is "before" if its first loop-step turn falls in S6's window
(up to 04:50:09Z), and all of its turns count there, including turns after 04:50Z. So "before" has 62 turns,
not S6's 49: the S6, S13 and skills S1 runs carried on past the window. "Billed tokens" is input + cache write +
cache read + output over every API call in the agent's transcript, de-duplicated by message id. It is not yet
weighted by price; that comes with the cost section.

| Step | Turns (before → after) | Σ context | Mean per turn | Agents (cold starts) | Billed tokens |
|---|---:|---:|---:|---:|---:|
| plan | 18 → 23 | 1,862,545 → 1,551,979 | 103,475 → 67,477 | 7 → 9 | 12,276,290 → 8,854,008 |
| implement | 23 → 48 | 1,735,388 → 2,724,426 | 75,452 → 56,759 | 7 → 43 | 21,274,305 → 27,335,653 |
| review | 5 → 49 | 572,428 → 3,014,262 | 114,486 → 61,516 | 5 → 11 | 5,515,317 → 13,912,525 |
| pr | 16 → – | 1,667,626 → – | 104,227 → – | 5 → – | 7,898,908 → – |
| **all** | 62 → 120 | 5,837,987 → 7,290,667 | 94,161 → 60,756 | 24 → 63 | 46,964,820 → 50,102,186 |

Which Phase 2 changes the 63 after-agents actually ran with, read from each agent's first prompt
(S7: shared rules before the step text; S8: `.harness/bin/brief`; S10: `**Files:**`) and its model (S9):

| Tags | Agents |
|---|---:|
| none | 38 |
| S8 | 11 |
| S7 + S8 + S10 | 6 |
| S8 + S10 | 5 |
| S10 only | 3 |

What this shows so far:
- Mean context per turn fell at every step, by a quarter to a half (plan 103k → 67k, implement 75k → 57k, review
  114k → 62k). Most after-agents carry no Phase 2 prompt change (38 of 63), so this is mostly the per-cycle agents and S12's
  slimmer server set, not S7–S10.
- No after-agent has the S9 tag. Every one ran on `claude-opus-5-5`, so S9's model split has not run yet.
- Only 6 agents carry S7 (S11 plan, S11's four Implement cycles, S14 plan), so S7's cache-sharing prefix is barely measured.
- The PR step has no after-agents: it is scripted now, and that removes about 7.9M billed tokens per 5 stories.
- Implement cold starts went from 7 to 43 because each cycle gets a fresh agent. Billed tokens per Implement
  agent fell from about 3.0M to about 0.64M, but the step total rose (21.3M → 27.3M) over more stories. Cold-start
  share and the batching question are in the next sections.
- The "S10 only" agents are skills S2's three Implement cycles. Their plan used `**Files:**` before S8's prompt
  shipped, so the S10 tag there means the plan's shape, not the plugin version.

### Cold starts

Source: the same join and `AFTER_END` snapshot. Reproduce with `node docs/telemetry/s11/report.mjs --check cost`.
A cold start is the prompt side of an agent's first API call (input + cache write + cache read). Every
cache write in these transcripts is a 1-hour write, so a cold start mostly bills at 2× input. "Share" is the
cold start's $ ÷ the agent's total $, so it weights tokens by price rather than counting them raw.

Per story. A story marked "both" has agents on each side of S6's window. telemetry S11 is this run, cut
after its Implement step, so it has no review.

| Story | Set | plan | implement | review | pr | Cold starts | Cold-start tokens | Cold-start $ | Agent $ | Cold-start share |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| telemetry S2 | before | – | – | – | 1 | 1 | 88,732 | $0.71 | $2.02 | 35% |
| telemetry S3 | before | 1 | 1 | 1 | 1 | 4 | 354,686 | $2.84 | $7.94 | 36% |
| telemetry S4 | before | 1 | 2 | 2 | 1 | 6 | 532,950 | $4.26 | $9.96 | 43% |
| skills S0 | before | 1 | 1 | 1 | 1 | 4 | 354,508 | $2.84 | $5.94 | 48% |
| telemetry S12 | before | 1 | 1 | 1 | 1 | 4 | 356,311 | $2.85 | $6.23 | 46% |
| skills S1 | both | 1 | 5 | 2 | – | 8 | 313,523 | $1.73 | $5.30 | 33% |
| telemetry S13 | both | 1 | 4 | 1 | – | 6 | 193,277 | $0.88 | $5.33 | 16% |
| telemetry S6 | before | 1 | 1 | – | – | 2 | 63,950 | $0.29 | $2.95 | 10% |
| telemetry S7 | after | 1 | 3 | 1 | – | 5 | 160,221 | $0.73 | $3.81 | 19% |
| telemetry S8 | after | 1 | 8 | 2 | – | 11 | 352,960 | $1.60 | $6.09 | 26% |
| telemetry S9 | after | 1 | 5 | 1 | – | 7 | 227,225 | $1.04 | $4.67 | 22% |
| telemetry S10 | after | 1 | 5 | 1 | – | 7 | 223,164 | $1.01 | $4.76 | 21% |
| skills S2 | after | 1 | 3 | 1 | – | 5 | 161,702 | $0.74 | $3.45 | 21% |
| skills S3 | after | 1 | 3 | 1 | – | 5 | 158,601 | $0.71 | $2.05 | 35% |
| skills S4 | after | 1 | 4 | 1 | – | 6 | 193,266 | $0.88 | $3.89 | 23% |
| telemetry S14 | after | 1 | – | – | – | 1 | 31,707 | $0.14 | $0.61 | 23% |
| telemetry S11 | after | 1 | 4 | – | – | 5 | 178,276 | $0.87 | $5.17 | 17% |

Implement agents only:

| Set | Agents | Cold start (median tokens) | Agent $ (median) | Share median | Share p25–p75 | Share min–max |
|---|---:|---:|---:|---:|---:|---:|
| before | 7 | 88,621 | $2.00 | 36% | 24%–38% | 7%–48% |
| after | 43 | 32,533 | $0.51 | 29% | 25%–38% | 9%–49% |

What this shows:
- An agent's fixed prefix fell from about 89k tokens to about 33k. That is S12's slimmer server set: it was
  already in place before S7–S10 shipped, so it is the biggest single saving in this data.
- The prefix is still large next to the work. About 29% of a typical Implement agent's $ is its cold start,
  and the middle half runs 25%–38%. That is the ceiling on what cycle batching could save per merged cycle,
  before it pays for carrying the earlier cycles' context.
- Stories now have 5–11 cold starts instead of 4–6, but each costs about a third as much. Per story,
  cold-start $ fell from about $2.84 to about $0.70–$1.60.

### Cost

Prices in $ per MTok, from the `claude-api` skill (models table cached 2026-09-25, read 2026-10-08):
`claude-opus-5-5` $4 input / $20 output / $0.20 cache read; `claude-sonnet-5-5` $2 / $10 / $0.20;
`claude-haiku-4-5` $1 / $5 / $0.10. Cache writes are 1.25× input at the 5-minute TTL and 2× at 1 hour
(skill's `shared/prompt-caching.md`). These are first-party API rates. The real bill depends on the plan the
agents ran under, so read the $ as relative.

Measured: every loop agent ran on `claude-opus-5-5`. "Projected" re-prices the same after-set calls with
Implement (and Fix CI, which has no agents yet) on `claude-sonnet-5-5`, which is S9's default. Nothing ran on
it yet, so it is an estimate. It assumes Sonnet would use the same tokens.

| Step | Model (measured) | $ before | $ after | $ after, projected | Projected model |
|---|---|---:|---:|---:|---|
| plan | claude-opus-5-5 | $11.46 | $8.16 | $8.16 | same |
| implement | claude-opus-5-5 | $13.82 | $24.48 | $14.77 | claude-sonnet-5-5 |
| review | claude-opus-5-5 | $6.13 | $9.24 | $9.24 | same |
| pr | claude-opus-5-5 | $6.89 | – | – | same |
| **all** | | $38.30 | $41.88 | $32.17 | |

Per story: $4.79 before (8 stories), $3.81 after (11), $2.92 projected. Stories marked "both" above count
on both sides.

What this shows:
- Measured cost per story fell about 20%, with no help from S9. The scripted PR step (−$6.89 over 5
  stories) and the smaller prefix account for most of it.
- Implement is now the largest step, at 58% of after-set $. Moving it to Sonnet would cut it about 40%,
  not 50%, because cache reads cost the same $0.20 on both models.
- On Sonnet the cold start becomes a smaller share of Implement $: the median falls from 29% to 26% over
  the 43 after-set Implement agents. The cold start (a cache write at 2× input) halves, but the cache reads
  stay at $0.20. Batching saves cold starts and costs extra cache reads, so the S9 default makes it pay a
  little less. The batching model in the next section is priced at Sonnet rates as well as Opus.

### Batching

Source: the same join and `AFTER_END` snapshot. Reproduce with `node docs/telemetry/s11/report.mjs --check batching`.
It covers the 10 stories with at least 2 numbered Implement cycles (42 cycle agents, all four of S11's included).
Against the 43 after-set Implement agents above: 41 of them have a cycle number. Telemetry S8 and skills S1 each
had one more Implement agent with no cycle number, which can't be placed in a batch. S13's cycle 1 ran before the
window and makes 42.

The model: one agent runs a story's consecutive cycles i..j. Cycle i is billed as measured. Each later cycle
drops its cold start. Its first call reads the shared prefix from cache and writes only its own cycle bullet
(chars ÷ 4 tokens, 1-hour write). Every call in that cycle also carries the context the earlier cycles in the
batch added, as cache reads. That context is the earlier cycle's last prompt plus output, minus its first prompt,
which is about 15k–20k tokens per cycle. Both sides are priced on the same model, so only the batching differs.
"Ceiling" is the most batching could save: later cycles also write nothing new to cache, as if every re-read
of `state.md` and the plan files were free. The real saving sits between the two columns. "Cycle size" uses
characters, because each cycle in `## Cycles` is one bullet, so a line count is always about 1.

Whole story in one agent:

| Story | Cycles | Cycle chars | Calls | Separate $ (Opus) | Batched $ (Opus) | Saving | Batched $ (Sonnet) | Saving | Peak context |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|
| telemetry S13 | 4 | 546, 426, 624, 225 | 9, 16, 17, 41 | $3.28 | $3.53 | -8% | $2.56 | -23% | 158,007 |
| telemetry S7 | 3 | 686, 344, 488 | 12, 12, 9 | $1.66 | $1.53 | 8% | $0.99 | -1% | 101,999 |
| telemetry S8 | 7 | 400, 285, 468, 247, 275, 353, 105 | 7, 16, 12, 12, 7, 9, 9 | $3.17 | $2.99 | 6% | $2.13 | -14% | 140,310 |
| telemetry S9 | 5 | 364, 378, 458, 265, 403 | 7, 19, 10, 6, 23 | $2.80 | $2.73 | 2% | $1.93 | -14% | 137,315 |
| telemetry S10 | 5 | 337, 322, 458, 456, 556 | 14, 9, 11, 14, 15 | $2.42 | $2.28 | 6% | $1.62 | -10% | 117,423 |
| skills S1 | 4 | 264, 406, 382, 104 | 10, 6, 6, 6 | $1.39 | $1.07 | 23% | $0.69 | 13% | 80,716 |
| skills S2 | 3 | 681, 516, 222 | 15, 12, 9 | $1.73 | $1.66 | 4% | $1.12 | -7% | 109,808 |
| skills S3 | 3 | 492, 383, 418 | 10, 8, 6 | $1.03 | $0.80 | 22% | $0.52 | 14% | 65,683 |
| skills S4 | 4 | 636, 580, 433, 527 | 13, 10, 11, 20 | $2.24 | $2.18 | 3% | $1.52 | -12% | 119,874 |
| telemetry S11 | 4 | 319, 349, 333, 484 | 10, 11, 17, 25 | $4.14 | $4.51 | -9% | $3.12 | -25% | 228,036 |

Batching rules, summed over those 10 stories:

| Rule | Agents | Opus $ | Saving | Sonnet $ | Saving | Ceiling, Opus | Ceiling, Sonnet | Worst story (Opus) | Peak context |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| separate (today) | 42 | $23.86 | 0% | $14.40 | 0% | 0% | 0% | 0% | 115,032 |
| pairs | 24 | $22.56 | 5% | $14.44 | 0% | 19% | 10% | -2% | 175,277 |
| threes | 18 | $21.90 | 8% | $14.21 | 1% | 25% | 15% | 3% | 167,791 |
| whole story | 10 | $23.28 | 2% | $16.19 | -12% | 26% | 7% | -9% | 228,036 |
| join cycles ≤ 250 chars | 37 | $23.53 | 1% | $14.43 | 0% | 5% | 3% | -3% | 124,469 |
| join cycles ≤ 350 chars | 30 | $22.92 | 4% | $14.36 | 0% | 14% | 8% | -3% | 167,791 |
| join cycles ≤ 450 chars | 21 | $22.24 | 7% | $14.33 | 0% | 21% | 12% | 0% | 167,791 |

Joining one cycle onto the agent that just ran the previous one (32 pairs), Opus:

| Joining cycle's plan chars | Pairs | Saving per pair (median) | Share of the pair's $ | Same on Sonnet |
|---|---:|---:|---:|---:|
| 0–299 | 8 | $0.11 | 12% | $0.04 |
| 300–399 | 8 | $0.11 | 11% | $0.03 |
| 400–499 | 11 | $0.10 | 9% | $0.02 |
| 500+ | 5 | $0.07 | 5% | $0.00 |

| Joining cycle's API calls | Pairs | Saving per pair (median) | Share of the pair's $ | Same on Sonnet |
|---|---:|---:|---:|---:|
| 0–9 | 12 | $0.12 | 16% | $0.05 |
| 10–14 | 10 | $0.10 | 9% | $0.02 |
| 15–19 | 6 | $0.09 | 8% | $0.02 |
| 20+ | 4 | −$0.02 | 0% | −$0.10 |

What this shows:
- No curve crossing gives a useful rule. Joining a cycle saves about $0.10 on Opus at every plan size, falling
  from 12% to 5% as cycles grow. Cycles of 20+ calls stop paying at all (2 of 4 such pairs lose money). Smaller cycles save a little more, but the size measure that predicts it best
  (API calls) is only known after the cycle runs.
- Carried context eats the saving quickly. Each cycle adds about 15k–20k tokens that every later call re-reads.
  Pairs and threes beat separate agents, but the whole story in one agent saves less (2%). On Sonnet it costs
  12% more, because the cold-start write it saves is half price while the extra cache reads cost the same $0.20.
- At S9's default (Implement on Sonnet) the best rule saves about 1% of Implement $, a few cents per story. The ceiling
  is 10–15%, and reaching it needs later cycles to cost nothing beyond reading cache, which they don't.

### Recommendation

**Don't batch cycles. It doesn't justify a phase.** The rule set before measuring was "worth a phase if the
modelled saving is at least 10% of Implement step cost". The best rule (threes) reaches 8% on Opus
and 1% on Sonnet; pairs reach 5% and 0%. S9 makes Sonnet the Implement default (no agent has run on it yet, so that figure is
projected), and there the gain is cents per story.
Against that, batching gives up a fresh context per cycle, and the peak context per agent grows from 115k to
168k–175k. No plan-size threshold separates the cycles that pay from the ones that don't.

What did save money in this phase: S12's slimmer server set (cold start 89k → 33k tokens), the scripted PR
step (−$6.89 over 5 stories), and, projected, S9's Sonnet Implement (about −40% of Implement $). Per story,
cost fell from $4.79 to $3.81 measured, or $2.92 projected.

Revisit only if one of these changes: Implement goes back to Opus, the per-agent prefix grows back past about
50k tokens, or cycles shrink to a few calls each. Under those conditions the threes rule would come close to 10%.
S17 (Implement cycles as subagents) is still fine to build for a tidier workspace, but it should not be counted
as a token saving. Each subagent still starts cold.
