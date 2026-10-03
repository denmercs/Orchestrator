export const SHIPPED_START = "<!-- orchestrator:shipped -->";
export const SHIPPED_END = "<!-- /orchestrator:shipped -->";

const YEAR_FOLDER = /^\d{4}$/;

export function standupNoteRelativePath(folderName: string, now: Date): string {
  const year = String(now.getFullYear());
  const date = formatDate(now);
  if (YEAR_FOLDER.test(folderName)) {
    return `${date}.md`;
  }
  return `${year}/${date}.md`;
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
  ].join("\n");
}

export function splitTicket(label: string): { key: string; title: string } {
  const match = label.match(/^([A-Z][A-Z0-9]+-\d+)\s+[—–:-]\s+(.+)$/);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
