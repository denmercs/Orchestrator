// The Initiatives tab's start input (see .harness/state.md, Open decision 1). Pure: decides as you
// type whether the text is a Jira ticket or a new initiative. The client maps `color` to theme tokens.

export type StartRoute = { kind: "jira"; key: string } | { kind: "initiative"; title: string };
export type StartColor = "statusSuccess" | "statusDanger" | "accent";
export type StartLine = { text: string; color: StartColor };

const KEY = /^[A-Z][A-Z0-9]*-\d+$/i;
const KEY_IN_PATH = /\/browse\/([A-Z][A-Z0-9]*-\d+)(?![\w-])/i;
const KEY_IN_QUERY = /[?&]selectedIssue=([A-Z][A-Z0-9]*-\d+)(?![\w-])/i;
const KEY_ANYWHERE = /(?<![\w-])([A-Z][A-Z0-9]*-\d+)(?![\w-])/i;

// Jira only when the whole input is a bare key or a URL holding one; a sentence that mentions a
// key is an initiative.
export function routeStart(text: string): StartRoute | null {
  const title = text.replace(/\s+/g, " ").trim();
  if (!title) return null;
  if (KEY.test(title)) return { kind: "jira", key: title.toUpperCase() };
  const key = keyInUrl(title);
  if (key) return { kind: "jira", key: key.toUpperCase() };
  return { kind: "initiative", title };
}

function keyInUrl(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const marked = KEY_IN_PATH.exec(text) ?? KEY_IN_QUERY.exec(text);
  if (marked) return marked[1];
  if (!url.hostname.endsWith("atlassian.net")) return null;
  return KEY_ANYWHERE.exec(url.pathname + url.search)?.[1] ?? null;
}

export function detectLabel(route: StartRoute): StartLine {
  return route.kind === "jira"
    ? { text: "Jira ticket · track from issue type", color: "statusSuccess" }
    : { text: "New initiative → Architecture", color: "accent" };
}

export const START_HINTS: readonly StartLine[] = [
  { text: "Jira feature or story → Plan", color: "statusSuccess" },
  { text: "Jira bug → Diagnose", color: "statusDanger" },
  { text: "Anything else → New initiative", color: "accent" },
];
