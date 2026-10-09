export const SHIPPED_START = "<!-- orchestrator:shipped -->";
export const SHIPPED_END = "<!-- /orchestrator:shipped -->";
export const WORK_START = "<!-- orchestrator:work -->";
export const WORK_END = "<!-- /orchestrator:work -->";
export const TODO_NOTES_START = "<!-- orchestrator:todo-notes -->";
export const TODO_NOTES_END = "<!-- /orchestrator:todo-notes -->";

export const standupTodoKinds = ["todo", "blocker", "note"] as const;
export type StandupTodoKind = (typeof standupTodoKinds)[number];

export type StandupTodo = {
  id: string;
  kind: StandupTodoKind;
  text: string;
  done: boolean;
  date: string;
};

export const YEAR_FOLDER = /^\d{4}$/;
export const DAILY_NOTE_FILE = /^(\d{4})-\d{2}-\d{2}\.md$/;

export function standupNoteRelativePath(folderName: string, now: Date): string {
  return standupNoteRelativePathForDate(folderName, formatDate(now));
}

export function standupNoteRelativePathForDate(folderName: string, date: string): string {
  if (YEAR_FOLDER.test(folderName)) {
    return `${date}.md`;
  }
  return `${date.slice(0, 4)}/${date}.md`;
}

export function formatDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function applyObsidianTemplate(source: string, now: Date, title: string): string {
  const date = formatDate(now);
  const time = formatTime(now);
  return source
    .replaceAll("{{title}}", title)
    .replace(/\{\{date(?::([^}]+))?\}\}/g, (_match, format: string | undefined) =>
      format ? formatTokens(now, format) : date,
    )
    .replace(/\{\{time(?::([^}]+))?\}\}/g, (_match, format: string | undefined) =>
      format ? formatTokens(now, format) : time,
    );
}

export function formatTime(now: Date): string {
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function suggestTemplatePath(
  folderPath: string,
  templates: { name: string; path: string }[],
  dailyNotesFolder: string | null,
  dailyNotesTemplate: string | null,
): string | null {
  const folderName = folderPath.split(/[/\\]/).filter(Boolean).at(-1)?.toLowerCase() ?? "";
  if (dailyNotesFolder && dailyNotesTemplate && isUnderFolder(folderPath, dailyNotesFolder)) {
    const match = templates.find((template) => pathsMatch(template.path, dailyNotesTemplate));
    if (match) {
      return match.path;
    }
  }
  const byName = templates.find((template) => template.name.toLowerCase() === folderName);
  if (byName) {
    return byName.path;
  }
  return templates.find((template) => template.name.toLowerCase() === "standup")?.path ?? null;
}

function isUnderFolder(target: string, folder: string): boolean {
  const normalizedTarget = target.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedFolder = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  return (
    normalizedTarget === normalizedFolder ||
    normalizedTarget.startsWith(`${normalizedFolder}/`)
  );
}

function pathsMatch(left: string, right: string): boolean {
  return left.replace(/\\/g, "/") === right.replace(/\\/g, "/");
}

function formatTokens(now: Date, format: string): string {
  return format
    .replaceAll("YYYY", String(now.getFullYear()))
    .replaceAll("MM", String(now.getMonth() + 1).padStart(2, "0"))
    .replaceAll("DD", String(now.getDate()).padStart(2, "0"))
    .replaceAll("HH", String(now.getHours()).padStart(2, "0"))
    .replaceAll("mm", String(now.getMinutes()).padStart(2, "0"))
    .replaceAll("ss", String(now.getSeconds()).padStart(2, "0"));
}

export function buildStandupNote(date: string): string {
  return [
    "---",
    `Created: "${date}"`,
    "tags: [log, standup]",
    'source_week: ""',
    "---",
    `# Standup ${date}`,
    "",
    "Derived from the weekly log + planning Focus (work in progress). Prefer editing the weekly Daily log table; regenerate with `journal-standup`.",
    "",
    "## Focus",
    "- (none in progress)",
    "",
    "## Work",
    workBlock("- (none)"),
    "",
    "## Yesterday",
    "- ",
    "",
    "## Today",
    "- ",
    "",
    "## Blockers",
    "- ",
    "",
    "## Talking points",
    "- ",
    "",
    "## Shipped",
    shippedBlock("- (none)"),
    "",
    "## Notes",
    "- ",
    "",
    todoNotesBlock("- (none)"),
    "",
  ].join("\n");
}

export function splitTicket(label: string): { key: string; title: string } {
  const match = label.match(/^([A-Z][A-Z0-9]+-\d+)\s+[—–:|-]\s+(.+)$/);
  if (match) {
    return { key: match[1], title: match[2] };
  }
  const ticket = label.match(/^([A-Z][A-Z0-9]+-\d+)\b/);
  if (ticket) {
    return { key: ticket[1], title: label.slice(ticket[0].length).replace(/^[ :—–-]+/, "") || label };
  }
  return { key: "", title: label };
}

export function shippedLines(prs: { key: string; title: string; number: string; url: string; repo: string }[]): string {
  if (prs.length === 0) {
    return "- (none)";
  }
  return prs
    .map((pr) => {
      const ticket = pr.key ? `${pr.key} — ` : "";
      const repo = pr.repo ? ` · ${pr.repo}` : "";
      return `- Merged ${ticket}${pr.title} ([#${pr.number}](${pr.url}))${repo}`;
    })
    .join("\n");
}

export function workLines(
  items: { key: string; summary: string; status: string; url: string }[],
): string {
  if (items.length === 0) {
    return "- (none)";
  }
  return items.map((item) => `- [${item.key}](${item.url}) — ${item.summary} · ${item.status}`).join("\n");
}

export function writeWorkItems(markdown: string, body: string): { markdown: string; changed: boolean } {
  const ensured = ensureWorkSection(markdown);
  const next = ensured.markdown.replace(
    new RegExp(`${escapeRegExp(WORK_START)}[\\s\\S]*?${escapeRegExp(WORK_END)}`),
    () => workBlock(body),
  );
  return { markdown: next, changed: next !== markdown };
}

export function ensureWorkSection(markdown: string): { markdown: string; changed: boolean } {
  if (markdown.includes(WORK_START) && markdown.includes(WORK_END)) {
    return { markdown, changed: false };
  }

  const section = ["## Work", workBlock("- (none)"), ""].join("\n");
  for (const anchor of [/^## Yesterday\s*$/m, /^## Shipped\s*$/m, /^## Notes\s*$/m]) {
    const at = markdown.search(anchor);
    if (at >= 0) {
      return { markdown: `${markdown.slice(0, at)}${section}\n${markdown.slice(at)}`, changed: true };
    }
  }

  const trimmed = markdown.replace(/\s*$/, "");
  return { markdown: `${trimmed}\n\n${section}`, changed: true };
}

function workBlock(body: string): string {
  return [WORK_START, body, WORK_END].join("\n");
}

export function writeShippedItems(markdown: string, body: string): { markdown: string; changed: boolean } {
  const ensured = ensureShippedSection(markdown);
  const next = ensured.markdown.replace(
    new RegExp(`${escapeRegExp(SHIPPED_START)}[\\s\\S]*?${escapeRegExp(SHIPPED_END)}`),
    shippedBlock(body),
  );
  return { markdown: next, changed: next !== markdown };
}

export function ensureShippedSection(markdown: string): { markdown: string; changed: boolean } {
  if (markdown.includes(SHIPPED_START) && markdown.includes(SHIPPED_END)) {
    return { markdown, changed: false };
  }

  const section = ["## Shipped", shippedBlock("- (none)"), ""].join("\n");
  const notesAt = markdown.search(/^## Notes\s*$/m);
  if (notesAt >= 0) {
    const next = `${markdown.slice(0, notesAt)}${section}${markdown.slice(notesAt)}`;
    return { markdown: next, changed: true };
  }

  const trimmed = markdown.replace(/\s*$/, "");
  return { markdown: `${trimmed}\n\n${section}`, changed: true };
}

function shippedBlock(body: string): string {
  return [SHIPPED_START, body, SHIPPED_END].join("\n");
}

export function parseTodoNotes(markdown: string, date: string): StandupTodo[] {
  const match = markdown.match(
    new RegExp(`${escapeRegExp(TODO_NOTES_START)}\\n([\\s\\S]*?)\\n${escapeRegExp(TODO_NOTES_END)}`),
  );
  if (!match) {
    return [];
  }
  const items: StandupTodo[] = [];
  const lines = match[1].split("\n");
  for (const line of lines) {
    const item = line.match(/^- \[([ xX])\] (todo|blocker|note):\s*(.*)$/);
    if (item) {
      items.push({
        id: `${date}:${items.length}:${item[2]}:${item[3]}`,
        kind: item[2] as StandupTodoKind,
        text: item[3],
        done: item[1].toLowerCase() === "x",
        date,
      });
      continue;
    }
    const last = items.at(-1);
    if (last && /^ {2}/.test(line)) {
      last.text = `${last.text}\n${line.slice(2)}`;
    }
  }
  return items
    .map((item) => ({ ...item, text: item.text.replace(/\s+$/, "") }))
    .filter((item) => item.text.length > 0);
}

export function writeTodoNotes(
  markdown: string,
  items: Pick<StandupTodo, "kind" | "text" | "done">[],
): { markdown: string; changed: boolean } {
  const ensured = ensureTodoNotesSection(markdown);
  const body =
    items.length === 0
      ? "- (none)"
      : items
          .map((item) => {
            const [first = "", ...rest] = item.text.split("\n");
            const head = `- [${item.done ? "x" : " "}] ${item.kind}: ${first}`;
            if (rest.length === 0) {
              return head;
            }
            return [head, ...rest.map((line) => `  ${line}`)].join("\n");
          })
          .join("\n");
  const next = ensured.markdown.replace(
    new RegExp(`${escapeRegExp(TODO_NOTES_START)}[\\s\\S]*?${escapeRegExp(TODO_NOTES_END)}`),
    todoNotesBlock(body),
  );
  return { markdown: next, changed: next !== markdown };
}

export function ensureTodoNotesSection(markdown: string): { markdown: string; changed: boolean } {
  if (markdown.includes(TODO_NOTES_START) && markdown.includes(TODO_NOTES_END)) {
    return { markdown, changed: false };
  }

  const block = `${todoNotesBlock("- (none)")}\n`;
  const notesAt = markdown.search(/^## Notes\s*$/m);
  if (notesAt >= 0) {
    const afterHeading = markdown.indexOf("\n", notesAt);
    const bodyStart = afterHeading >= 0 ? afterHeading + 1 : markdown.length;
    const nextHeading = markdown.slice(bodyStart).search(/^## /m);
    const insertAt = nextHeading >= 0 ? bodyStart + nextHeading : markdown.replace(/\s*$/, "").length;
    const prefix = markdown.slice(0, insertAt).replace(/\s*$/, "");
    const suffix = markdown.slice(insertAt);
    const next = `${prefix}\n\n${block}${suffix.startsWith("\n") ? suffix : `\n${suffix}`}`;
    return { markdown: next, changed: true };
  }

  const trimmed = markdown.replace(/\s*$/, "");
  return { markdown: `${trimmed}\n\n## Notes\n${block}`, changed: true };
}

function todoNotesBlock(body: string): string {
  return [TODO_NOTES_START, body, TODO_NOTES_END].join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
