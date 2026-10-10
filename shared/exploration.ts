// What a loop step reads before it starts changing code (see CONTEXT.md, "Telemetry row"). Pure:
// no host-plugin imports, and no branch on the provider.

import { classifyShell } from "./shell-steps";

export type ToolStep = {
  kind: "read" | "search" | "edit" | "write";
  // read/edit/write: the file path; search: the files it returned.
  paths: string[];
  // Characters returned by a completed read or search, else 0.
  chars: number;
  // write: the content written; edit: the new text or diff; else null.
  text: string | null;
};

export type Explore = {
  reads: number;
  searches: number;
  // Distinct files opened by a `read`.
  files: number;
  chars: number;
  // True once a step ended the count: a code edit, or for Plan the write that filled `## Plan`.
  edited: boolean;
};

const HARNESS = ".harness";

function inHarness(path: string): boolean {
  return path.split(/[\\/]/).includes(HARNESS);
}

// True when the text has a `## Plan` section with at least one non-blank line before the next `## `.
function fillsPlan(text: string | null): boolean {
  if (text === null) return false;
  let inPlan = false;
  for (const line of text.split("\n")) {
    if (/^## /.test(line)) {
      if (inPlan) return false;
      inPlan = /^## Plan\s*$/.test(line);
    } else if (inPlan && line.trim() !== "") {
      return true;
    }
  }
  return false;
}

function endsCount(step: ToolStep, planStep: boolean): boolean {
  if (step.kind !== "edit" && step.kind !== "write") return false;
  if (planStep && step.paths.some((path) => /(^|[\\/])\.harness[\\/]state\.md$/.test(path)) && fillsPlan(step.text)) return true;
  return step.paths.some((path) => !inHarness(path));
}

// Counts the steps up to the first edit or write outside `.harness/` (for the Plan step, up to the
// write that fills `## Plan`). Steps after that are ignored.
export function exploration(steps: readonly ToolStep[], { step }: { step: string | null }): Explore {
  const result: Explore = { reads: 0, searches: 0, files: 0, chars: 0, edited: false };
  const files = new Set<string>();
  for (const item of steps) {
    if (endsCount(item, step === "plan")) {
      result.edited = true;
      break;
    }
    if (item.kind === "read") {
      result.reads += 1;
      for (const path of item.paths) files.add(path);
      result.chars += item.chars;
    } else if (item.kind === "search") {
      result.searches += 1;
      result.chars += item.chars;
    }
  }
  result.files = files.size;
  return result;
}

// A timeline item, structurally: compatible with the plugin's ProviderTimelineItem and wider
// than the context panel's TimelineItem, which does not name the path and text fields.
export type ToolItem = {
  type: string;
  status?: string;
  detail?: { type: string; [field: string]: unknown };
};

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

// The steps `exploration` takes, from Paseo `tool_call` items, read by `detail.type` alone. A shell
// item becomes one step per classified command (see shell-steps.ts), with the whole output on its
// first read or search step. `other` shell commands, other detail types (fetch, sub_agent, ...) and
// non-tool items are dropped.
export function toolSteps(items: readonly ToolItem[]): ToolStep[] {
  const steps: ToolStep[] = [];
  for (const item of items) {
    if (item.type !== "tool_call" || !item.detail) continue;
    const { detail } = item;
    const content = item.status === "completed" ? str(detail.content) : null;
    const filePath = str(detail.filePath);
    switch (detail.type) {
      case "read":
        steps.push({ kind: "read", paths: filePath === null ? [] : [filePath], chars: content?.length ?? 0, text: null });
        break;
      case "search":
        steps.push({
          kind: "search",
          paths: Array.isArray(detail.filePaths) ? detail.filePaths.filter((path): path is string => typeof path === "string") : [],
          chars: content?.length ?? 0,
          text: null,
        });
        break;
      case "edit":
        steps.push({ kind: "edit", paths: filePath === null ? [] : [filePath], chars: 0, text: str(detail.newString) ?? str(detail.unifiedDiff) });
        break;
      case "write":
        steps.push({ kind: "write", paths: filePath === null ? [] : [filePath], chars: 0, text: str(detail.content) });
        break;
      case "shell": {
        const command = str(detail.command);
        if (command === null) break;
        // Whole output goes on the first read or search step, so `exploration` sums it once.
        let output = item.status === "completed" ? (str(detail.output)?.length ?? 0) : 0;
        for (const call of classifyShell(command, str(detail.cwd) ?? undefined)) {
          if (call.kind === "other") continue;
          const counted = call.kind === "read" || call.kind === "search";
          steps.push({ kind: call.kind, paths: call.paths, chars: counted ? output : 0, text: call.text });
          if (counted) output = 0;
        }
        break;
      }
    }
  }
  return steps;
}
