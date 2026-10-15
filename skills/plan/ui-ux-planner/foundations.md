# UX foundations (planner reference)

Read on demand from [`SKILL.md`](SKILL.md). Apply as **decision rules**, not essay summaries.

## Flow-efficiency decisions

| Rule | Ask | Prefer |
|------|-----|--------|
| **One job / surface** | Does this screen try to do two jobs? | Split or progressive-disclose |
| **Shortest success path** | Can we remove or default a step? | Fewer hops to the goal |
| **Recognition > recall** | Must the user remember data from prior steps? | Show status / choices |
| **Progressive disclosure** | Is this advanced or rare? | Hide behind “More” / later step |
| **Hick’s Law** | Too many equal choices? | Defaults, grouping, fewer peers |
| **Fitts’s Law** | Is the primary action hard to hit? | Larger, nearer, distinct |
| **Feedback** | Does every action show result? | Pending / success / failure |
| **Error prevention** | Can we stop the bad state? | Constraints, confirm only when costly |
| **Jakob’s Law** | Does the product already solve this? | Match existing pattern |
| **Peak-End** | What’s the last moment of the flow? | Clear success / next step |

## Fidelity ladder

1. **Job + constraints** — prose  
2. **Flow** — `step > step > outcome`  
3. **Surface inventory** — table  
4. **Skeleton** — hierarchy, primary action (wire-level)  
5. **Visual** — only when brand/risk demands it  

Do not start at step 5. Stop at the lowest fidelity that unblocks the story Plan step.

## Accessibility (always in contract)

- Interactive elements have accessible **names** (role + name preferred)  
- Keyboard reachability for critical paths  
- Contrast for text and primary controls  
- No information by color alone  
- Prefer role and accessible name locators when tests will exist  

## Mapping to TDD (handoff)

| UX plan field | Story Plan step / grill-tdd |
|----------------------|------------------------|
| Journey `step > step > outcome` | Test **expectation** chain |
| Journey / surface goal title | Test **name** |
| Empty / error / success | Extra cycles or guard cases |
| Primary action + accessible name | **locator** on UI contracts |
