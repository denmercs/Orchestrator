import { readSection } from "./story-method";

export type OutcomeEvent =
  | { kind: "review-failed"; round: number; findings: string[] }
  | { kind: "fix"; attempt: number; checks: string[] }
  | { kind: "blocked"; reason: string }
  | { kind: "merged" }
  | { kind: "no-change" };

export type OutcomeEntry = { title: string; lines: string[] };
export type Outcome = { reviewRounds: number; fixAttempts: number; failedChecks: string[]; entries: OutcomeEntry[] };

const HEADING = "## Outcome";

const fields = (text: string) => {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  return Object.fromEntries(
    block.split("\n").flatMap((line) => {
      const at = line.indexOf(":");
      return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()]] : [];
    }),
  ) as Record<string, string>;
};

// Sets frontmatter keys in place, adding any that are missing (and a block when there is none).
function setFields(text: string, values: Record<string, string | number>) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  const lines = match ? match[1].split("\n") : [];
  for (const [key, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.slice(0, line.indexOf(":")).trim() === key);
    const line = `${key}: ${value}`;
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  const block = `---\n${lines.join("\n")}\n---`;
  return match ? text.replace(match[0], () => block) : `${block}\n\n${text}`;
}

const count = (value: string | undefined) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function readOutcome(text: string): Outcome {
  const front = fields(text);
  const entries: OutcomeEntry[] = [];
  for (const line of readSection(text, "Outcome").split("\n")) {
    const title = /^###\s+(.+?)\s*$/.exec(line)?.[1];
    if (title) entries.push({ title, lines: [] });
    else if (line.trim() && entries.length) entries[entries.length - 1].lines.push(line.trim());
  }
  return {
    reviewRounds: count(front.review_rounds),
    fixAttempts: count(front.fix_attempts),
    failedChecks: (front.failed_checks ?? "").split(",").map((name) => name.trim()).filter(Boolean),
    entries,
  };
}

// Adds `### title` and its lines at the end of the `## Outcome` section, creating the section if needed.
function addEntry(text: string, title: string, lines: string[]) {
  const block = `### ${title}\n${lines.join("\n")}\n`;
  const start = text.search(/^##[ \t]+Outcome[ \t]*$/m);
  if (start < 0) return `${text.replace(/\s*$/, "")}\n\n${HEADING}\n\n${block}`;
  const rest = text.slice(start + HEADING.length);
  const next = rest.search(/^##[ \t]/m);
  const end = next < 0 ? text.length : start + HEADING.length + next;
  return `${text.slice(0, end).replace(/\s*$/, "")}\n\n${block}${next < 0 ? "" : `\n${text.slice(end)}`}`;
}

const findingLines = (findings: string[]) => {
  const lines = findings.map((line) => line.trim()).filter(Boolean).map((line) => `- ${line.replace(/^[-*]\s+/, "")}`);
  return lines.length ? lines : ["- (no findings written)"];
};

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

// Applies one outcome event to a story file's text. Repeating an event returns the text unchanged.
export function appendOutcome(text: string, event: OutcomeEvent): string {
  const outcome = readOutcome(text);
  const has = (title: string) => outcome.entries.some((entry) => entry.title === title);
  switch (event.kind) {
    case "review-failed": {
      const title = `Review round ${event.round}`;
      if (has(title)) return text;
      const next = addEntry(text, title, findingLines(event.findings));
      return setFields(next, { review_rounds: outcome.reviewRounds + 1 });
    }
    case "fix": {
      const title = `CI fix attempt ${event.attempt}`;
      if (has(title)) return text;
      const next = addEntry(text, title, [`- failing: ${event.checks.join(", ")}`]);
      const failed = [...new Set([...outcome.failedChecks, ...event.checks])];
      return setFields(next, { fix_attempts: outcome.fixAttempts + 1, failed_checks: failed.join(", ") });
    }
    case "blocked": {
      const line = `- ${event.reason.replace(/\s*\n\s*/g, " ").trim()}`;
      const last = outcome.entries[outcome.entries.length - 1];
      if (last?.title === "Blocked" && last.lines[0] === line) return text;
      return addEntry(text, "Blocked", [line]);
    }
    case "merged": {
      if (has("Merged")) return text;
      const rounds = plural(outcome.reviewRounds + 1, "review round");
      return addEntry(text, "Merged", [`- ${rounds}, ${plural(outcome.fixAttempts, "CI fix attempt")}`]);
    }
    case "no-change": {
      if (has("Nothing to ship")) return text;
      return addEntry(text, "Nothing to ship", ["- The branch had no commits over its base, so it closed without a PR."]);
    }
  }
}
