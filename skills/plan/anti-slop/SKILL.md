---
name: anti-slop
description: >
  Revise prose and chat so they sound human — ban AI-marker density, empty hype,
  unexplained abbreviations, and corporate synonym soup. Prefer short plain replies:
  problem → fix → next. Use for release marketing, workflow output, and
  chat replies. Not for detector evasion or caveman chat.
---

# Anti-slop

Revision gate for **human-sounding prose**. Use it for **marketing copy** and for **workflow writing** (plans, briefings, issues, skills).

**Not:** rewriting text to dodge AI detectors. **Is:** cutting tells, empty intensifiers, unexplained shorthand, and fake warmth so a person on the team could have written it.

## When to use

| Use this | Skip |
|----------|------|
| Email, social, YouTube, launch blog, changelog blurbs | Pure code |
| Plans (architecture, security, UX), working-file narrative, issue bodies | Mechanical evidence tables (commands, pass/fail rows) |
| Skill and command markdown in this repo | Architecture decision record (ADR) decision logs that stay short and factual |
| **Workflow chat replies** (grill, plan, implement, review, finish, PR) — same bar as plans | Chat terseness-as-telegraph — that is `caveman` (only when user asks) |
| After `release-marketing` | |
| Softening technical blog intros that sound generated | Deep tutorial body — prefer `technical-writing` |

## Workflow chat voice

Every workflow chat session should sound like a sharp teammate on Slack — simple, concise, clear. Not a launch blog, not a robot dump, not caveman.

| Do | Don't |
|----|--------|
| Problem / Fix / Next — a few full sentences | Prefaces (“Great question!”, “Let's dive in”, “I'd be happy to…”) |
| Concrete names: files, behaviors, commands | Vague filler (“leverage”, “robust”, “holistic”, “ensure alignment”) |
| One idea per sentence | Stacked benefits or nested caveats in one breath |
| Show the decision and stop | Recap the whole skill before asking |
| For grill: major Q + recommend; then minor list | Twenty obvious one-by-one confirmations; essay recaps |

**Length:** Prefer a few tight lines over a wall of markdown. Tables and lists beat paragraphs.

**Grill shape (example):**

```markdown
**Major:** Should checkout fail closed when tax is unknown?
**Recommend:** Yes — block place-order and show “tax unavailable”.
Why: wrong tax in production is worse than a retry.

**Minors** (say “all good” or correct a line):
1. Test path → `tests/checkout/tax.test.ts` (repo pattern)
2. Layer → unit (public API covers it)
3. Locator → role=button name=Place order
```

## Density, not banlists alone

Slop is a **density** problem. One “seamless” in a long piece can stand. A cluster of unlock / seamless / delve / tapestry / embark / “I’m excited to announce” in the same screenful is generated text.

Score roughly per ~100 words: if two or more tier-1 markers appear, rewrite that block.

## Tier-1 markers (rewrite on sight)

- unlock, seamless, delve, tapestry, embark, landscape (as metaphor)
- “I’m excited to announce”, “We’re thrilled”, “game-changing”, “revolutionary”
- “In today’s fast-paced…”, “At the end of the day”, “It goes without saying”
- Fake empathy openers (“We know how hard it is to…”) with no specific product fact after
- Empty intensifiers stacked: truly / really / simply / robust / powerful / next-level
- Vague plan filler: “leverage synergies”, “holistic approach”, “best-in-class”, “empower users”

## Abbreviations (kit-wide)

On **first use** in a skill, plan, briefing, or issue: write the full phrase, then the short form in parentheses. After that, the short form is fine.

| Prefer first use | Then |
|------------------|------|
| architecture decision record (ADR) | ADR |
| information architecture (IA) | IA |
| end-to-end (E2E) | E2E |
| source of truth | Prefer the full phrase; do not write “SoT” |
| human-in-the-loop (HITL) | HITL |
| away-from-keyboard (AFK) | AFK |
| React Testing Library (RTL) | RTL |
| accessibility (not only “a11y”) | a11y only after first expansion, or spell out |

Do not invent new shorthand. Prefer the repo’s `CONTEXT.md` terms over clever synonyms.

## Prefer

- **Specific nouns** — name the feature, screen, path, or outcome
- **One claim per sentence** — cut stacked benefits in one breath
- **Real verbs** — ship, filter, save, export, schedule, test, merge (not “empower”, “elevate”, “leverage”)
- **Short paragraphs** — especially email, social, and “at a glance” summaries
- **Proof** — what changed, which command, which file, or a clip / screenshot from the brief
- **Plain process language** — “one behavior at a time” over metaphor stacks

## Channel / surface modulation

| Surface | Tone |
|---------|------|
| Email | Warmer, direct; subject line earns the open; no brochure voice |
| Social | Shorter; hook in first line; hard length caps in templates |
| YouTube description | Scannable; chapters; no keyword stuffing |
| Blog / SEO shell | Clear promise; keywords in title/meta/H1 once; body still human |
| Plans and HTML briefings | Scannable sections; concrete decisions; no hype in “At a glance” |
| Working notes / issues | Behavior and acceptance in plain English; expand abbreviations once |
| Skill markdown | Imperative, unambiguous; same abbreviation rule |

Never compensate for weak substance with corporate-synonym soup.

## Consumer `TONE.md`

If the consumer has a brand `TONE.md` (path in the Release Brief or repo root), apply its bans and voice attributes **in addition** to this skill. When they conflict, consumer tone wins on brand words; this skill still wins on tier-1 AI markers and unexplained abbreviations.

## Slop pass checklist

### Marketing / release pack

- [ ] Opening states a concrete change or problem — not a press-release throat-clear
- [ ] No tier-1 cluster in any ~100-word window
- [ ] Every paragraph earns its keep (cut filler)
- [ ] Claims match the Release Brief; nothing oversold in **Out of scope / do-not-claim**
- [ ] Call to action is one clear action with a real URL when available
- [ ] Reads like a teammate wrote it after shipping — not like a launch template filled by a bot

### Plans, skills, issues, briefings, workflow chat

- [ ] Abbreviations expanded on first use (table above)
- [ ] No tier-1 marketing markers in planning prose **or** chat
- [ ] Each section / reply has one job; headings say what the reader gets
- [ ] Decisions name options and the choice — not “we should align stakeholders holistically”
- [ ] Paths, commands, and behavior names are concrete where they matter
- [ ] Chat replies are short enough to skim (problem → fix → next); no throat-clearing or fake enthusiasm
- [ ] Someone new to the repo could follow without a glossary of slang

## Out of scope

- Detector-evasion pipelines or “humanize API” tools
- Changing product facts to sound nicer
- Replacing `technical-writing` for long tutorials
- Rewriting `caveman` chat output into full prose mid-session
