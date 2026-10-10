// Offline adapter: a Claude Code transcript (JSONL entries) -> S1's ToolStep[] (shared/exploration.ts).
// Never imported by server/, client/ or shared/. Bash becomes a `shell` item, which `toolSteps` classifies
// as live; Agent and every other tool are dropped, as the live adapter drops sub_agent.
import { exploration, toolSteps } from "../../../shared/exploration.ts";

const KIND = { Read: "read", Grep: "search", Glob: "search", Edit: "edit", MultiEdit: "edit", Write: "write" };

const blocks = (entry) => (Array.isArray(entry?.message?.content) ? entry.message.content : []);

// A tool_result's text as written: a string, or the text blocks joined.
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
}

// Every tool_use in order, paired with its tool_result (undefined when none).
function toolCalls(entries) {
  const results = new Map();
  for (const entry of entries) {
    for (const block of blocks(entry)) {
      if (block.type === "tool_result") results.set(block.tool_use_id, block);
    }
  }
  const calls = [];
  for (const entry of entries) {
    for (const block of blocks(entry)) {
      if (block.type === "tool_use") calls.push({ name: block.name, input: block.input ?? {}, result: results.get(block.id) });
    }
  }
  return calls;
}

// The timeline item the live adapter would see for a typed call or Bash; null for Agent and the rest.
function callItem({ name, input, result }) {
  const status = result && !result.is_error ? "completed" : "failed";
  const content = result ? resultText(result.content) : "";
  if (name === "Bash") return { type: "tool_call", status, detail: { type: "shell", command: input.command, output: content } };
  if (!(name in KIND)) return null;
  const kind = KIND[name];
  let detail;
  if (kind === "read") detail = { type: "read", filePath: input.file_path, content };
  else if (kind === "search") detail = { type: "search", filePaths: [], content };
  else if (kind === "edit") {
    const newString = name === "MultiEdit" ? input.edits?.map((e) => e.new_string).join("\n") : input.new_string;
    detail = { type: "edit", filePath: input.file_path, newString };
  } else detail = { type: "write", filePath: input.file_path, content: input.content };
  return { type: "tool_call", status, detail };
}

// Builds the timeline items the live adapter would see, then lets `toolSteps` shape them, so the two agree.
export function transcriptSteps(entries) {
  return toolSteps(toolCalls(entries).map(callItem).filter(Boolean));
}

// Bash calls, and the characters they printed, before the step where `exploration` stops counting.
// Typed calls go through `exploration` itself, so the stop rule is not restated here.
export function shellBeforeEdit(entries, { step }) {
  const total = { calls: 0, chars: 0 };
  for (const call of toolCalls(entries)) {
    if (call.name === "Bash") {
      total.calls += 1;
      total.chars += call.result ? resultText(call.result.content).length : 0;
      continue;
    }
    const item = callItem(call);
    if (item !== null && exploration(toolSteps([item]), { step }).edited) break;
  }
  return total;
}

const promptTokens = (usage) => (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);

// Pairs, per user turn whose tool results are all typed reads/searches, Σ result chars ÷ 4 with the prompt
// growth it caused: next call's prompt − previous call's prompt − previous call's output. Errored results count 0.
export function calibration(entries) {
  const kinds = new Map();
  for (const entry of entries) {
    for (const block of blocks(entry)) if (block.type === "tool_use") kinds.set(block.id, KIND[block.name]);
  }
  const pairs = [];
  let prev = null;
  let chars = 0;
  let typed = true;
  let seen = false;
  for (const entry of entries) {
    for (const block of blocks(entry)) {
      if (block.type !== "tool_result") continue;
      seen = true;
      const kind = kinds.get(block.tool_use_id);
      if (kind !== "read" && kind !== "search") typed = false;
      else if (!block.is_error) chars += resultText(block.content).length;
    }
    const usage = entry.type === "assistant" ? entry.message?.usage : null;
    if (!usage) continue;
    if (prev && seen && typed) {
      const estimated = chars / 4;
      const billed = promptTokens(usage) - promptTokens(prev) - (prev.output_tokens ?? 0);
      pairs.push({ estimated, billed, ratio: estimated === 0 ? null : billed / estimated });
    }
    prev = usage;
    chars = 0;
    typed = true;
    seen = false;
  }
  return pairs;
}
