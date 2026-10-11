// S11 spike: join context telemetry rows → Paseo agent records → Claude transcripts.
// Read-only over ~/.orchestrator, ~/.paseo/agents and ~/.claude/projects. Writes agents.json to the OS temp dir.
// Only whitelisted fields are copied from agent records (they also hold MCP server env with secrets).
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
export const TELEMETRY_FILE = join(HOME, ".orchestrator", "context-telemetry.jsonl");
export const AGENTS_DIR = join(HOME, ".paseo", "agents");
export const PROJECTS_DIR = join(HOME, ".claude", "projects");
export const OUT_FILE = join(tmpdir(), "s11-agents.json");

// S6's baseline window ends with the last row measured on 2026-10-08.
export const BASELINE_END = "2026-10-08T04:50:09.999Z";
// One snapshot for every table: S11's last Implement turn (cycle 4). Rows and API calls after it are dropped,
// so this review, later stories and anything still running don't move the numbers on a rerun.
export const AFTER_END = "2026-10-08T16:01:08.999Z";

const SHORT = { "telemetry-and-token-savings": "telemetry", "skills-in-every-phase": "skills" };

function readJsonl(file) {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export function readTelemetry(file = TELEMETRY_FILE) {
  const rows = readJsonl(file);
  const rotated = file.replace(/\.jsonl$/, ".1.jsonl");
  return existsSync(rotated) ? [...readJsonl(rotated), ...rows] : rows;
}

export function indexAgentRecords(agentsDir = AGENTS_DIR) {
  const byId = new Map();
  for (const dir of readdirSync(agentsDir)) {
    const path = join(agentsDir, dir);
    if (!statSync(path).isDirectory()) continue;
    for (const f of readdirSync(path)) {
      if (!f.endsWith(".json")) continue;
      try {
        const j = JSON.parse(readFileSync(join(path, f), "utf8"));
        if (j.id) byId.set(j.id, j);
      } catch {
        // half-written record; skip
      }
    }
  }
  return byId;
}

const projectSlug = (cwd) => cwd.replace(/[/.]/g, "-");

export function transcriptPath(rec, projectsDir = PROJECTS_DIR) {
  const cwd = rec?.cwd ?? null;
  const sessionId = rec?.persistence?.sessionId ?? null;
  return cwd && sessionId ? join(projectsDir, projectSlug(cwd), `${sessionId}.jsonl`) : null;
}

// One entry per API call (message id); the transcript repeats a message per content block, last one wins.
export function readCalls(file, cutoff = AFTER_END) {
  const calls = new Map();
  for (const e of readJsonl(file)) {
    const u = e.message?.usage;
    if (e.type !== "assistant" || !u || !e.message.id || e.timestamp > cutoff) continue;
    calls.set(e.message.id, {
      at: e.timestamp,
      model: e.message.model,
      input: u.input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      cacheWrite5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      output: u.output_tokens ?? 0,
    });
  }
  return [...calls.values()];
}

// The loop's first prompt to the agent, as text.
function firstPrompt(file) {
  for (const e of readJsonl(file)) {
    if (e.type !== "user") continue;
    const c = e.message?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : "";
    if (text.includes("fresh agent for this step")) return text;
  }
  return null;
}

// This cycle's bullet from the first `## Cycles` block the agent read (state.md), with Read's line numbers stripped.
// Each cycle is one bullet, sometimes wrapped, so its size is measured in characters.
function cycleText(file, cycle) {
  if (cycle == null) return null;
  for (const e of readJsonl(file)) {
    const c = e.type === "user" ? e.message?.content : null;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type !== "tool_result") continue;
      const raw = typeof b.content === "string" ? b.content : (b.content ?? []).map((x) => x.text ?? "").join("");
      if (!raw.includes("## Cycles")) continue;
      const text = raw.split("\n").map((l) => l.replace(/^\s*\d+(→|\t)/, "")).join("\n");
      const block = text.slice(text.indexOf("## Cycles"));
      const m = block.match(new RegExp(`^- \\[[ x]\\] Cycle ${cycle}\\b[^\\n]*(\\n(?!- \\[|##|\\n)[^\\n]*)*`, "m"));
      if (m) return m[0];
    }
  }
  return null;
}

// Fallback when the agent never read a `## Cycles` block: the cycle line the loop pasted into the prompt.
function promptCycleLine(file) {
  const m = firstPrompt(file)?.match(/## (?:This step: )?Cycle \d+ only\n(- \[[ x]\] Cycle[^\n]*)/);
  return m ? m[1] : null;
}

// Which Phase 2 changes the agent ran with. S7: shared rules come first, before the step text.
// S8: tests run through .harness/bin/brief. S10: the plan carries **Files:**. S9: a model other than the old Opus default.
export const PRE_PHASE2_MODEL = "claude-opus-5-5";
function phase2Tags(prompt, model) {
  if (prompt == null) return null;
  const rules = prompt.indexOf("## Rules for every step");
  const step = prompt.indexOf("## This step");
  return {
    s7: prompt.startsWith("You are a fresh agent") && rules >= 0 && (step < 0 || rules < step),
    s8: prompt.includes(".harness/bin/brief"),
    s9: model != null && model !== PRE_PHASE2_MODEL,
    s10: prompt.includes("**Files:**"),
  };
}

export function agentRecord(id, rec, { projectsDir = PROJECTS_DIR, cutoff = AFTER_END } = {}) {
  const labels = rec?.labels ?? {};
  const cwd = rec?.cwd ?? null;
  const sessionId = rec?.persistence?.sessionId ?? null;
  const transcript = transcriptPath(rec, projectsDir);
  const hasTranscript = transcript ? existsSync(transcript) : false;
  const initiative = labels["loop-initiative"] ?? null;
  const model = rec?.config?.model ?? rec?.persistence?.metadata?.model ?? null;
  return {
    id,
    mapped: Boolean(rec),
    cwd,
    createdAt: rec?.createdAt ?? null,
    archivedAt: rec?.archivedAt ?? null,
    initiative,
    initiativeShort: initiative ? (SHORT[initiative] ?? initiative) : null,
    story: labels["loop-story"] ?? null,
    step: labels["loop-step"] ?? null,
    repo: labels["loop-repo"] ?? null,
    round: labels["loop-round"] != null ? Number(labels["loop-round"]) : null,
    cycle: labels["loop-cycle"] != null ? Number(labels["loop-cycle"]) : null,
    model,
    sessionId,
    transcript: hasTranscript ? transcript : null,
    calls: hasTranscript ? readCalls(transcript, cutoff) : [],
    tags: hasTranscript ? phase2Tags(firstPrompt(transcript), model) : null,
    cycleText: hasTranscript && labels["loop-step"] === "implement" ? cycleText(transcript, labels["loop-cycle"]) ?? promptCycleLine(transcript) : null,
  };
}

// Every agent record with a loop-step label and loop-repo = repo, created at or before `until`; not limited to telemetry rows.
export function loopAgents({ agentsDir = AGENTS_DIR, projectsDir = PROJECTS_DIR, repo, until = AFTER_END } = {}) {
  return [...indexAgentRecords(agentsDir).values()]
    .filter((r) => r.labels?.["loop-step"] && r.labels["loop-repo"] === repo && (!r.createdAt || r.createdAt <= until))
    .map((r) => agentRecord(r.id, r, { projectsDir, cutoff: until }));
}

export function load() {
  const rows = readTelemetry().filter((r) => r.at <= AFTER_END);
  const records = indexAgentRecords();
  const ids = [...new Set(rows.map((r) => r.agentId))];
  const agents = Object.fromEntries(ids.map((id) => [id, agentRecord(id, records.get(id))]));
  const unmapped = ids.filter((id) => !agents[id].mapped);
  return { rows, agents, unmapped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const data = load();
  writeFileSync(OUT_FILE, JSON.stringify({ agents: data.agents, unmapped: data.unmapped }, null, 1));
  console.log(`${data.rows.length} rows, ${Object.keys(data.agents).length} agents, ${data.unmapped.length} unmapped → ${OUT_FILE}`);
}
