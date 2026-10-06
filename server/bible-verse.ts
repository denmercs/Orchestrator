import type { DailyVerse } from "../shared/orchestration";
import { readKeychainSecret } from "./keychain";

// Used when the Lifeway API is unavailable. Curated so a random pick never lands
// mid-genealogy. One per day, same for the whole day.
const REFERENCES = [
  "Joshua 1:9",
  "Psalm 16:8",
  "Psalm 19:14",
  "Psalm 23:1",
  "Psalm 27:1",
  "Psalm 46:1",
  "Psalm 90:12",
  "Psalm 118:24",
  "Psalm 119:105",
  "Proverbs 3:5-6",
  "Proverbs 16:3",
  "Isaiah 26:3",
  "Isaiah 40:31",
  "Isaiah 41:10",
  "Jeremiah 29:11",
  "Lamentations 3:22-23",
  "Micah 6:8",
  "Matthew 5:16",
  "Matthew 6:33",
  "Matthew 11:28",
  "John 14:27",
  "John 15:5",
  "Romans 8:28",
  "Romans 12:2",
  "Romans 15:13",
  "1 Corinthians 15:58",
  "2 Corinthians 5:17",
  "Galatians 6:9",
  "Ephesians 2:10",
  "Philippians 4:6-7",
  "Philippians 4:13",
  "Colossians 3:23",
  "2 Timothy 1:7",
  "Hebrews 12:1",
  "James 1:5",
  "1 Peter 5:7",
];

// Lifeway's Scripture MCP (developers.lifeway.com hackathon) serves the CSB and its own
// verse of the day, which rolls over at midnight US Central.
const LIFEWAY_MCP = "https://developers.hackathon.dev.lifeway.com/mcp";
const LIFEWAY_KEYCHAIN = "orchestrator.lifeway-scripture";
// bolls.life is free and keyless and carries the ESV; personal-dashboard use only.
const BOLLS_ENDPOINT = "https://bolls.life/get-text/";
const BOLLS_TRANSLATION = "ESV";
// bible.helloao.org is free and keyless; the BSB is a modern public-domain translation.
const BSB_ENDPOINT = "https://bible.helloao.org/api/BSB/";
// bible-api.com is free and keyless; WEB is public domain, so it is the last fallback.
const WEB_ENDPOINT = "https://bible-api.com/";

// helloao addresses books by USFM id, bolls.life by canonical number (Genesis = 1).
const BOOKS: Record<string, { usfm: string; number: number }> = {
  Joshua: { usfm: "JOS", number: 6 },
  Psalm: { usfm: "PSA", number: 19 },
  Proverbs: { usfm: "PRO", number: 20 },
  Isaiah: { usfm: "ISA", number: 23 },
  Jeremiah: { usfm: "JER", number: 24 },
  Lamentations: { usfm: "LAM", number: 25 },
  Micah: { usfm: "MIC", number: 33 },
  Matthew: { usfm: "MAT", number: 40 },
  John: { usfm: "JHN", number: 43 },
  Romans: { usfm: "ROM", number: 45 },
  "1 Corinthians": { usfm: "1CO", number: 46 },
  "2 Corinthians": { usfm: "2CO", number: 47 },
  Galatians: { usfm: "GAL", number: 48 },
  Ephesians: { usfm: "EPH", number: 49 },
  Philippians: { usfm: "PHP", number: 50 },
  Colossians: { usfm: "COL", number: 51 },
  "2 Timothy": { usfm: "2TI", number: 55 },
  Hebrews: { usfm: "HEB", number: 58 },
  James: { usfm: "JAS", number: 59 },
  "1 Peter": { usfm: "1PE", number: 60 },
};

let cached: { day: string; verse: DailyVerse } | null = null;

function localDay(now: Date) {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function referenceFor(now: Date) {
  const dayNumber = Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86_400_000,
  );
  return REFERENCES[dayNumber % REFERENCES.length];
}

function clean(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

type JsonRpcResponse = { result?: unknown; error?: { message?: string } };

// Streamable HTTP answers with plain JSON or a one-shot SSE stream; take the last data frame.
async function readRpc(response: Response): Promise<JsonRpcResponse> {
  const body = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return body ? (JSON.parse(body) as JsonRpcResponse) : {};
  }
  const frames = body.split("\n").filter((line) => line.startsWith("data:"));
  const last = frames.at(-1);
  return last ? (JSON.parse(last.slice(5)) as JsonRpcResponse) : {};
}

async function callLifeway(apiKey: string, tool: string, args: Record<string, unknown>) {
  let sessionId: string | null = null;
  const post = async (message: Record<string, unknown>) => {
    const response = await fetch(LIFEWAY_MCP, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      // Status only: the body could echo the request.
      throw new Error(`lifeway-mcp ${response.status}`);
    }
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    return response;
  };
  await readRpc(
    await post({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "orchestrator", version: "0.1.0" },
      },
    }),
  );
  await post({ method: "notifications/initialized" });
  const reply = await readRpc(await post({ id: 2, method: "tools/call", params: { name: tool, arguments: args } }));
  if (reply.error) {
    throw new Error(`lifeway-mcp ${reply.error.message ?? "error"}`);
  }
  return reply.result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: { type?: string; text?: string }[];
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

// The tool returns a passage with a reference and one or more verses; accept either a
// single text field or a verses array whose texts are joined.
function readPassage(value: unknown): { reference: string; text: string; translation: string } | null {
  const row = asRecord(value);
  if (!row) {
    return null;
  }
  const nested = readPassage(row.passage) ?? readPassage(row.verse);
  if (nested) {
    return nested;
  }
  const reference = typeof row.reference === "string" ? row.reference : "";
  const verses = Array.isArray(row.verses) ? row.verses : [];
  const text =
    typeof row.text === "string"
      ? row.text
      : verses
          .map((verse) => asRecord(verse)?.text)
          .filter((part): part is string => typeof part === "string")
          .join(" ");
  const translation = typeof row.translation === "string" ? row.translation : "CSB";
  return reference && text ? { reference, text: clean(text), translation } : null;
}

async function fetchLifeway(apiKey: string): Promise<DailyVerse> {
  const result = await callLifeway(apiKey, "random_verse", { category: "daily" });
  if (result.isError) {
    throw new Error("lifeway-mcp tool error");
  }
  let passage = readPassage(result.structuredContent);
  for (const part of result.content ?? []) {
    if (passage || part.type !== "text" || !part.text) {
      continue;
    }
    try {
      passage = readPassage(JSON.parse(part.text));
    } catch {
      // Not JSON; nothing structured to read.
    }
  }
  if (!passage) {
    throw new Error("lifeway-mcp returned no passage");
  }
  return {
    reference: passage.reference,
    text: passage.text,
    translation: passage.translation.toUpperCase().includes("CSB") ? "CSB" : passage.translation,
    copyright: "Christian Standard Bible® © Holman Bible Publishers. Used by permission.",
  };
}

function parseReference(reference: string) {
  const match = /^(.+) (\d+):(\d+)(?:-(\d+))?$/.exec(reference);
  const book = match ? BOOKS[match[1]] : undefined;
  if (!match || !book) {
    throw new Error(`no book id for ${reference}`);
  }
  return { book, chapter: match[2], first: Number(match[3]), last: Number(match[4] ?? match[3]) };
}

async function fetchBolls(reference: string): Promise<DailyVerse> {
  const { book, chapter, first, last } = parseReference(reference);
  const response = await fetch(`${BOLLS_ENDPOINT}${BOLLS_TRANSLATION}/${book.number}/${chapter}/`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`bolls ${response.status}`);
  }
  const body = (await response.json()) as unknown;
  const verses = Array.isArray(body) ? body.map(asRecord) : [];
  // Some translations inline footnote markers as <sup>…</sup>; drop them, then any other tags.
  const text = verses
    .filter((verse) => typeof verse?.verse === "number" && verse.verse >= first && verse.verse <= last)
    .map((verse) => (typeof verse?.text === "string" ? verse.text : ""))
    .map((part) => part.replace(/<sup>.*?<\/sup>/g, "").replace(/<[^>]+>/g, ""))
    .join(" ");
  return {
    reference,
    text: clean(text) || null,
    translation: BOLLS_TRANSLATION,
    copyright: BOLLS_TRANSLATION === "ESV" ? "ESV® Bible © Crossway." : null,
  };
}

async function fetchBsb(reference: string): Promise<DailyVerse> {
  const { book, chapter, first, last } = parseReference(reference);
  const response = await fetch(`${BSB_ENDPOINT}${book.usfm}/${chapter}.json`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) {
    throw new Error(`bsb ${response.status}`);
  }
  const body = (await response.json()) as {
    chapter?: { content?: { type?: string; number?: number; content?: unknown[] }[] };
  };
  // Verse content mixes plain strings, poetry lines ({ text }), and footnote markers ({ noteId }).
  const text = (body.chapter?.content ?? [])
    .filter((item) => item.type === "verse" && typeof item.number === "number" && item.number >= first && item.number <= last)
    .flatMap((item) => item.content ?? [])
    .map((part) => (typeof part === "string" ? part : (asRecord(part)?.text ?? "")))
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
  return { reference, text: clean(text) || null, translation: "BSB", copyright: null };
}

async function fetchWeb(reference: string): Promise<DailyVerse> {
  const response = await fetch(`${WEB_ENDPOINT}${encodeURIComponent(reference)}?translation=web`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`bible-api ${response.status}`);
  }
  const body = (await response.json()) as { text?: unknown };
  const text = typeof body.text === "string" ? clean(body.text) : "";
  return { reference, text: text || null, translation: "WEB", copyright: null };
}

export async function loadDailyVerse(now = new Date()): Promise<DailyVerse> {
  const day = localDay(now);
  if (cached?.day === day) {
    return cached.verse;
  }
  const reference = referenceFor(now);
  const lifewayKey = await readKeychainSecret(LIFEWAY_KEYCHAIN);
  // Best first. Each failure falls through; offline ends at the bare reference.
  const sources: (() => Promise<DailyVerse>)[] = [
    ...(lifewayKey ? [() => fetchLifeway(lifewayKey)] : []),
    () => fetchBolls(reference),
    () => fetchBsb(reference),
    () => fetchWeb(reference),
  ];
  for (const load of sources) {
    try {
      const verse = await load();
      if (!verse.text) {
        continue;
      }
      // Kept for the day even when a fallback served it, so a dead key is not retried every load.
      cached = { day, verse };
      return verse;
    } catch {
      // Try the next source.
    }
  }
  return { reference, text: null, translation: "BSB", copyright: null };
}
