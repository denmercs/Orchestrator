// S11 spike report (copied from .harness/s11). `--baseline-check` reproduces S6's per-step baseline table or exits non-zero.
import { load, BASELINE_END } from "./load.mjs";

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const STEPS = ["plan", "implement", "review", "pr", "fix-ci"];

// S6's "Per step, all stories" table: [turns, Σ used, agents].
const S6_BASELINE = {
  plan: [17, 1753044, 7],
  implement: [11, 1074336, 7],
  review: [5, 572428, 5],
  pr: [16, 1667626, 5],
  all: [49, 5067434, 24],
};

export function stepTurns(rows) {
  return rows.filter((r) => r.event === "turn" && r.step);
}

export function perStep(turns) {
  const groups = new Map();
  const add = (key, r) => {
    const g = groups.get(key) ?? { turns: 0, used: 0, agents: new Set() };
    g.turns += 1;
    g.used += r.used ?? 0;
    g.agents.add(r.agentId);
    groups.set(key, g);
  };
  for (const r of turns) {
    add(r.step, r);
    add("all", r);
  }
  const order = [...STEPS.filter((s) => groups.has(s)), ...[...groups.keys()].filter((k) => k !== "all" && !STEPS.includes(k)), "all"];
  return order.filter((k) => groups.has(k)).map((k) => {
    const g = groups.get(k);
    return { step: k, turns: g.turns, used: g.used, mean: g.used / g.turns, agents: g.agents.size };
  });
}

function table(lines) {
  const head = "| Step | Turns | Context tokens (Σ used) | Mean per turn | Agents (cold starts) |\n|---|---:|---:|---:|---:|";
  return [head, ...lines.map((l) => `| ${l.step === "all" ? "**all**" : l.step} | ${l.turns} | ${fmt(l.used)} | ${fmt(l.mean)} | ${l.agents} |`)].join("\n");
}

function baselineCheck() {
  const { rows, agents, unmapped } = load();
  const baseline = stepTurns(rows.filter((r) => r.at <= BASELINE_END));
  const lines = perStep(baseline);
  console.log(table(lines));
  const problems = [];
  for (const [step, [turns, used, n]] of Object.entries(S6_BASELINE)) {
    const l = lines.find((x) => x.step === step);
    if (!l || l.turns !== turns || l.used !== used || l.agents !== n)
      problems.push(`${step}: expected ${turns}/${fmt(used)}/${n}, got ${l ? `${l.turns}/${fmt(l.used)}/${l.agents}` : "nothing"}`);
  }
  const ids = Object.keys(agents);
  const noTranscript = ids.filter((id) => agents[id].mapped && !agents[id].transcript);
  console.log(`\n${ids.length} telemetry agents: ${ids.length - unmapped.length} mapped, ${unmapped.length} unmapped, ${noTranscript.length} mapped without a transcript.`);
  for (const id of unmapped) console.log(`unmapped: ${id}`);
  for (const id of noTranscript) console.log(`no transcript: ${id}`);
  if (problems.length) {
    console.error(`\nBaseline mismatch:\n${problems.join("\n")}`);
    process.exit(1);
  }
  console.log("\nbaseline-check: OK (matches S6)");
}

// Phase 2 changes an agent can carry: S7/S8/S10 read from its first prompt, S9 from its model.
const TAGS = ["s7", "s8", "s9", "s10"];

// An agent is "after" when its first loop-step turn row is past S6's baseline window.
export function splitAgents(rows, agents) {
  const first = new Map();
  for (const r of stepTurns(rows)) if (!first.has(r.agentId) || r.at < first.get(r.agentId)) first.set(r.agentId, r.at);
  const before = [], after = [];
  for (const [id, at] of first) (at <= BASELINE_END ? before : after).push(agents[id]);
  return { before, after };
}

const billed = (a) => a.calls.reduce((s, c) => s + c.input + c.cacheWrite + c.cacheRead + c.output, 0);

function perStepWithBilled(turns, agents) {
  const ids = new Map();
  for (const r of turns) {
    for (const k of [r.step, "all"]) (ids.get(k) ?? ids.set(k, new Set()).get(k)).add(r.agentId);
  }
  return perStep(turns).map((l) => ({ ...l, billed: [...ids.get(l.step)].reduce((s, id) => s + billed(agents[id]), 0) }));
}

function beforeAfterTable(before, after) {
  const steps = [...new Set([...before, ...after].map((l) => l.step))].sort((x, y) => (x === "all") - (y === "all") || STEPS.indexOf(x) - STEPS.indexOf(y));
  const cell = (l, f) => (l ? f(l) : "–");
  const head = "| Step | Turns (before → after) | Σ context | Mean per turn | Agents (cold starts) | Billed tokens |\n|---|---:|---:|---:|---:|---:|";
  return [head, ...steps.map((s) => {
    const b = before.find((l) => l.step === s), a = after.find((l) => l.step === s);
    const pair = (f) => `${cell(b, f)} → ${cell(a, f)}`;
    return `| ${s === "all" ? "**all**" : s} | ${pair((l) => l.turns)} | ${pair((l) => fmt(l.used))} | ${pair((l) => fmt(l.mean))} | ${pair((l) => l.agents)} | ${pair((l) => fmt(l.billed))} |`;
  })].join("\n");
}

function afterCheck() {
  const { rows, agents } = load();
  const { before, after } = splitAgents(rows, agents);
  const untagged = after.filter((a) => !a.tags || TAGS.some((t) => typeof a.tags[t] !== "boolean"));
  const turns = stepTurns(rows);
  const beforeIds = new Set(before.map((a) => a.id));
  const b = perStepWithBilled(turns.filter((r) => beforeIds.has(r.agentId)), agents);
  const a = perStepWithBilled(turns.filter((r) => !beforeIds.has(r.agentId)), agents);
  console.log(beforeAfterTable(b, a));
  const combos = new Map();
  for (const x of after) {
    const key = x.tags ? TAGS.filter((t) => x.tags[t]).join("+") || "none" : "untagged";
    combos.set(key, (combos.get(key) ?? 0) + 1);
  }
  console.log(`\n${before.length} before-agents, ${after.length} after-agents. Phase 2 tags on after-agents:`);
  for (const [k, n] of [...combos].sort((x, y) => y[1] - x[1])) console.log(`- ${k}: ${n}`);
  if (untagged.length) {
    console.error(`\n${untagged.length} after-agents without Phase 2 tags:\n${untagged.map((x) => `${x.id} ${x.initiativeShort} ${x.story} ${x.step}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\ncheck after: OK");
}

// Prices in $ per MTok, from the claude-api skill (model table cached 2026-09-25; shared/prompt-caching.md "Economics"):
// cache writes are 1.25x input at the 5-minute TTL and 2x at 1 hour.
export const PRICES_SOURCE = "claude-api skill, models table cached 2026-09-25, read 2026-10-08";
export const PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1 },
};
const PROJECTED = { implement: "claude-sonnet-5-5", "fix-ci": "claude-sonnet-5-5" };

const priced = (model) => PRICES[model] ?? (model === "<synthetic>" ? { input: 0, output: 0, cacheRead: 0 } : null);
function callCost(c, model = c.model, withOutput = true) {
  const p = priced(model);
  if (!p) return null;
  const write5m = c.cacheWrite - c.cacheWrite1h;
  return (c.input * p.input + write5m * p.input * 1.25 + c.cacheWrite1h * p.input * 2 + c.cacheRead * p.cacheRead + (withOutput ? c.output * p.output : 0)) / 1e6;
}
const sortedCalls = (a) => [...a.calls].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

// Cold start: the agent's first API call, its prompt side only (input + cache write + cache read).
export function coldStart(a) {
  const first = sortedCalls(a)[0];
  if (!first) return null;
  const usd = callCost(first, first.model, false);
  return usd == null ? null : { tokens: first.input + first.cacheWrite + first.cacheRead, usd };
}
export function agentCost(a, model) {
  const costs = a.calls.map((c) => callCost(c, model && c.model !== "<synthetic>" ? model : c.model));
  return costs.some((x) => x == null) || !costs.length ? null : sum(costs);
}

const usd = (n) => (n < -0.005 ? `−$${(-n).toFixed(2)}` : `$${Math.abs(n).toFixed(2)}`);
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q, lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};
const pct = (x) => `${Math.round(x * 100) || 0}%`;
const storyKey = (a) => `${a.initiativeShort} ${a.story}`;
const stepOrder = (x, y) => STEPS.indexOf(x) - STEPS.indexOf(y);

function costTables(before, after) {
  const all = [...before, ...after];
  const isBefore = new Set(before.map((a) => a.id));

  // Cold starts per story.
  const stories = new Map();
  for (const a of all) (stories.get(storyKey(a)) ?? stories.set(storyKey(a), []).get(storyKey(a))).push(a);
  const steps = STEPS.filter((s) => all.some((a) => a.step === s));
  console.log(`\n#### Cold starts per story\n\n| Story | Set | ${steps.join(" | ")} | Cold starts | Cold-start tokens | Cold-start $ | Agent $ | Cold-start share |\n|---|---|${steps.map(() => "---:|").join("")}---:|---:|---:|---:|---:|`);
  for (const [k, as] of stories) {
    const cs = sum(as.map((a) => coldStart(a).usd)), cost = sum(as.map((a) => agentCost(a)));
    const set = as.every((a) => isBefore.has(a.id)) ? "before" : as.every((a) => !isBefore.has(a.id)) ? "after" : "both";
    console.log(`| ${k} | ${set} | ${steps.map((s) => as.filter((a) => a.step === s).length || "–").join(" | ")} | ${as.length} | ${fmt(sum(as.map((a) => coldStart(a).tokens)))} | ${usd(cs)} | ${usd(cost)} | ${pct(cs / cost)} |`);
  }

  // Implement cold-start share, per agent, $-weighted.
  console.log("\n#### Implement cold-start share\n\nShare = first call's prompt-side $ ÷ the agent's total $.\n\n| Set | Agents | Cold start (median tokens) | Agent $ (median) | Share median | Share p25–p75 | Share min–max |\n|---|---:|---:|---:|---:|---:|---:|");
  for (const [name, set] of [["before", before], ["after", after]]) {
    const imp = set.filter((a) => a.step === "implement");
    if (!imp.length) continue;
    const shares = imp.map((a) => coldStart(a).usd / agentCost(a));
    console.log(`| ${name} | ${imp.length} | ${fmt(quantile(imp.map((a) => coldStart(a).tokens), 0.5))} | ${usd(quantile(imp.map((a) => agentCost(a)), 0.5))} | ${pct(quantile(shares, 0.5))} | ${pct(quantile(shares, 0.25))}–${pct(quantile(shares, 0.75))} | ${pct(Math.min(...shares))}–${pct(Math.max(...shares))} |`);
  }

  // Cost by step and model: measured, and projected with Implement/Fix CI on Sonnet at the same token counts.
  console.log("\n#### Cost by step and model\n\n| Step | Model (measured) | $ before | $ after | $ after, projected | Projected model |\n|---|---|---:|---:|---:|---|");
  const rowsFor = [...new Set(all.map((a) => a.step))].sort(stepOrder);
  let tb = 0, ta = 0, tp = 0;
  for (const s of rowsFor) {
    const b = before.filter((a) => a.step === s), a = after.filter((x) => x.step === s);
    const models = [...new Set([...b, ...a].flatMap((x) => x.calls.map((c) => c.model)).filter((m) => m !== "<synthetic>"))].join(", ");
    const cb = sum(b.map((x) => agentCost(x))), ca = sum(a.map((x) => agentCost(x))), cp = sum(a.map((x) => agentCost(x, PROJECTED[s])));
    tb += cb; ta += ca; tp += cp;
    console.log(`| ${s} | ${models} | ${b.length ? usd(cb) : "–"} | ${a.length ? usd(ca) : "–"} | ${a.length ? usd(cp) : "–"} | ${PROJECTED[s] ?? "same"} |`);
  }
  console.log(`| **all** | | ${usd(tb)} | ${usd(ta)} | ${usd(tp)} | |`);
  const perStory = (set) => new Set(set.map(storyKey)).size;
  console.log(`\nStories: ${perStory(before)} before, ${perStory(after)} after. $ per story: ${usd(tb / perStory(before))} before, ${usd(ta / perStory(after))} after, ${usd(tp / perStory(after))} projected.`);
}

function costCheck() {
  const { rows, agents } = load();
  const { before, after } = splitAgents(rows, agents);
  const all = [...before, ...after];
  const missing = all.filter((a) => !coldStart(a) || agentCost(a) == null);
  console.log(`Prices: ${PRICES_SOURCE}.`);
  if (!missing.length) costTables(before, after);
  if (missing.length) {
    console.error(`\n${missing.length} of ${all.length} agents lack a cold start or a $ figure:\n${missing.slice(0, 10).map((x) => `${x.id} ${x.initiativeShort} ${x.story} ${x.step} models=${[...new Set(x.calls.map((c) => c.model))].join(",")}`).join("\n")}`);
    process.exit(1);
  }
  console.log("\ncheck cost: OK");
}

// Batching model: one agent runs a story's consecutive Implement cycles i..j.
// Cycle i is billed as measured. Each later cycle k loses its cold start: its first call reads the shared prefix
// from cache and writes only the new cycle bullet (chars / 4 tokens, 1h write). Every call of cycle k also carries
// E_k, the context the earlier cycles in the batch added (last call's prompt + output − first call's prompt), read
// from cache. All calls are priced at `model` on both sides, so only the batching differs.
const prompt = (c) => c.input + c.cacheWrite + c.cacheRead;
function grown(a) {
  const cs = sortedCalls(a);
  return Math.max(0, prompt(cs.at(-1)) + cs.at(-1).output - prompt(cs[0]));
}
const cycleTokens = (a) => Math.ceil((a.cycleText?.length ?? 0) / 4);
// `upper` is a ceiling on the saving: later cycles also write nothing new to cache (as if every re-read of
// state.md and plan files were free), so all their prompt tokens bill as cache reads.
export function batchCost(cycles, model, upper = false) {
  if (cycles.some((a) => !a.calls.length || !a.cycleText)) return null;
  const price = (c) => callCost(c, c.model === "<synthetic>" ? c.model : model);
  let separate = 0, batched = 0, carried = 0, peak = 0;
  cycles.forEach((a, k) => {
    const cs = sortedCalls(a);
    separate += sum(cs.map(price));
    cs.forEach((c, n) => {
      let m = { ...c, cacheRead: c.cacheRead + carried };
      if (upper && k > 0) m = { ...c, input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: prompt(c) + carried };
      if (k > 0 && n === 0) {
        const write = Math.min(cycleTokens(a), prompt(c) - c.input);
        m = { ...c, cacheWrite: write, cacheWrite1h: write, cacheRead: prompt(c) - c.input - write + carried };
      }
      batched += price(m);
      peak = Math.max(peak, prompt(m));
    });
    carried += grown(a);
  });
  return { separate, batched, saving: separate - batched, peak };
}
function modelBatch(cycles, model) {
  return batchCost(cycles, model);
}

// A rule splits a story's cycles into batches.
const RULES = [
  ["separate (today)", (as) => as.map((a) => [a])],
  ["pairs", (as) => as.reduce((bs, a, i) => (i % 2 ? bs.at(-1).push(a) : bs.push([a]), bs), [])],
  ["threes", (as) => as.reduce((bs, a, i) => (i % 3 ? bs.at(-1).push(a) : bs.push([a]), bs), [])],
  ["whole story", (as) => [as]],
  ...[250, 350, 450].map((n) => [`join cycles ≤ ${n} chars`, (as) => as.reduce((bs, a, i) => (i && a.cycleText.length <= n ? bs.at(-1).push(a) : bs.push([a]), bs), [])]),
];

function batchingTables(stories) {
  const models = ["claude-opus-5-5", "claude-sonnet-5-5"];
  console.log(`\n#### Batched vs separate, whole story in one agent\n\n| Story | Cycles | Cycle chars | Calls | Separate $ (Opus) | Batched $ (Opus) | Saving | Batched $ (Sonnet) | Saving | Peak context |\n|---|---:|---|---|---:|---:|---:|---:|---:|---:|`);
  for (const [k, as] of stories) {
    const [o, sn] = models.map((m) => modelBatch(as, m));
    console.log(`| ${k} | ${as.length} | ${as.map((a) => a.cycleText.length).join(", ")} | ${as.map((a) => a.calls.length).join(", ")} | ${usd(o.separate)} | ${usd(o.batched)} | ${pct(o.saving / o.separate)} | ${usd(sn.batched)} | ${pct(sn.saving / sn.separate)} | ${fmt(o.peak)} |`);
  }

  console.log("\n#### Rules, summed over these stories\n\n| Rule | Agents | Opus $ | Saving | Sonnet $ | Saving | Ceiling, Opus | Ceiling, Sonnet | Worst story (Opus) | Peak context |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const [name, split] of RULES) {
    const res = [...models.map((m) => [m, false]), ...models.map((m) => [m, true])].map(([m, upper]) => {
      const per = stories.map(([, as]) => split(as).map((b) => batchCost(b, m, upper)));
      const flat = per.flat();
      return {
        agents: flat.length,
        sep: sum(flat.map((r) => r.separate)),
        bat: sum(flat.map((r) => r.batched)),
        worst: Math.min(...per.map((rs) => sum(rs.map((r) => r.saving)) / sum(rs.map((r) => r.separate)))),
        peak: Math.max(...flat.map((r) => r.peak)),
      };
    });
    const [o, sn, ou, su] = res;
    console.log(`| ${name} | ${o.agents} | ${usd(o.bat)} | ${pct(1 - o.bat / o.sep)} | ${usd(sn.bat)} | ${pct(1 - sn.bat / sn.sep)} | ${pct(1 - ou.bat / ou.sep)} | ${pct(1 - su.bat / su.sep)} | ${pct(o.worst)} | ${fmt(o.peak)} |`);
  }

  // Marginal: append cycle k to an agent that just ran cycle k−1 (a pair), by the joining cycle's size.
  const pairs = stories.flatMap(([, as]) => as.slice(1).map((a, i) => ({ a, r: batchCost([as[i], a], "claude-opus-5-5"), rs: batchCost([as[i], a], "claude-sonnet-5-5"), prevGrew: grown(as[i]) })));
  const bucket = (label, key, edges) => {
    console.log(`\n#### Joining one cycle to the previous one, by the joining cycle's ${label}\n\n| ${label} | Pairs | Earlier cycle's context carried (median) | Saving per pair, Opus (median) | Share of pair $ | Saving, Sonnet (median) | Pairs that lose |\n|---|---:|---:|---:|---:|---:|---:|`);
    for (let i = 0; i < edges.length - 1; i++) {
      const ps = pairs.filter((p) => key(p.a) >= edges[i] && key(p.a) < edges[i + 1]);
      if (!ps.length) continue;
      const hi = edges[i + 1] === Infinity ? "+" : `–${edges[i + 1] - 1}`;
      console.log(`| ${edges[i]}${hi} | ${ps.length} | ${fmt(quantile(ps.map((p) => p.prevGrew), 0.5))} | ${usd(quantile(ps.map((p) => p.r.saving), 0.5))} | ${pct(quantile(ps.map((p) => p.r.saving / p.r.separate), 0.5))} | ${usd(quantile(ps.map((p) => p.rs.saving), 0.5))} | ${ps.filter((p) => p.r.saving < 0).length} |`);
    }
  };
  bucket("plan chars", (a) => a.cycleText.length, [0, 300, 400, 500, Infinity]);
  bucket("API calls", (a) => a.calls.length, [0, 10, 15, 20, Infinity]);
}

// Implement agents that ran a numbered cycle, grouped by story and sorted by cycle.
function cycleStories(agents) {
  const stories = new Map();
  for (const a of agents) {
    if (a.step !== "implement" || a.cycle == null) continue;
    (stories.get(storyKey(a)) ?? stories.set(storyKey(a), []).get(storyKey(a))).push(a);
  }
  for (const as of stories.values()) as.sort((x, y) => x.cycle - y.cycle || (x.createdAt < y.createdAt ? -1 : 1));
  return stories;
}

function batchingCheck() {
  const { rows, agents } = load();
  const { before, after } = splitAgents(rows, agents);
  const stories = [...cycleStories([...before, ...after])].filter(([, as]) => as.length >= 2);
  const missing = stories.filter(([, as]) => modelBatch(as, "claude-opus-5-5") == null);
  if (!missing.length) batchingTables(stories);
  if (missing.length) {
    console.error(`${missing.length} of ${stories.length} stories with ≥2 Implement cycles lack a batched-vs-separate figure:\n${missing.map(([k, as]) => `${k} (${as.length} cycles)`).join("\n")}`);
    process.exit(1);
  }
  console.log("\ncheck batching: OK");
}

const args = process.argv.slice(2);
if (args.includes("--baseline-check")) baselineCheck();
else if (args[0] === "--check" && args[1] === "after") afterCheck();
else if (args[0] === "--check" && args[1] === "cost") costCheck();
else if (args[0] === "--check" && args[1] === "batching") batchingCheck();
else {
  console.error("usage: node docs/telemetry/s11/report.mjs --baseline-check | --check after | --check cost | --check batching");
  process.exit(2);
}
