// Observations: things that went wrong, each with a date, a source story and an evidence link.
// Pure: only node:crypto, no Paseo imports.
import { createHash } from "node:crypto";
import { CORRECTION_CATEGORIES, globToRegExp, type Note, noteId } from "./memory";
import { emptyNote } from "./repo-facts";
import { readOutcome } from "../shared/story-outcome";

export type ObservationSource = "finding" | "ci-check" | "blocked" | "review-comment";

export type Observation = {
  id: string;
  source: ObservationSource;
  story: string;
  date: string;
  link: string;
  text: string;
};

export type ObservationContext = { story: string; date: string; link: string };

// First 12 hex chars of sha1 over source + story + text, so the same observation keeps its id between runs.
const observationId = (source: ObservationSource, story: string, text: string) =>
  createHash("sha1").update(source + story + text).digest("hex").slice(0, 12);

const bullet = (line: string) => line.replace(/^[-*]\s+/, "").trim();

// Reads a story's `## Outcome` entries: one `finding` per review line, one `ci-check` per failing check, one `blocked` per block.
export function storyObservations(text: string, context: ObservationContext): Observation[] {
  const make = (source: ObservationSource, body: string): Observation => ({
    id: observationId(source, context.story, body),
    source,
    story: context.story,
    date: context.date,
    link: context.link,
    text: body,
  });
  const found: Observation[] = [];
  for (const entry of readOutcome(text).entries) {
    if (/^Review round \d+$/.test(entry.title)) {
      for (const line of entry.lines) found.push(make("finding", bullet(line)));
    } else if (/^CI fix attempt \d+$/.test(entry.title)) {
      for (const line of entry.lines) {
        const checks = /^failing:\s*(.*)$/.exec(bullet(line))?.[1] ?? "";
        for (const name of checks.split(",").map((check) => check.trim()).filter(Boolean)) found.push(make("ci-check", name));
      }
    } else if (entry.title === "Blocked") {
      for (const line of entry.lines) found.push(make("blocked", bullet(line)));
    }
  }
  return found;
}

// Recorded `gh` JSON, trimmed to what we read. Inline comments (`gh api repos/{o}/{r}/pulls/N/comments`) carry
// `created_at`, `html_url`, `path`, `line`; review bodies (`gh pr view N --json reviews`) carry `submittedAt`/`createdAt` and `url`.
export type ReviewPr = { number: number; headRefName: string; url?: string };
export type ReviewComment = {
  body?: string | null;
  created_at?: string;
  submittedAt?: string;
  createdAt?: string;
  html_url?: string;
  url?: string;
  path?: string;
  line?: number | null;
};

// One `review-comment` per non-blank comment. Story: the one whose branch is the PR head (`storiesByBranch`), else `pr-N`.
// `commentsByPr` is keyed by PR number. Text is `path:line — body` for inline comments so areas can match the path.
export function reviewObservations(
  prs: ReviewPr[],
  commentsByPr: Record<number, ReviewComment[]>,
  storiesByBranch: Record<string, string>,
): Observation[] {
  const found: Observation[] = [];
  for (const pr of prs) {
    const story = storiesByBranch[pr.headRefName] ?? `pr-${pr.number}`;
    for (const comment of commentsByPr[pr.number] ?? []) {
      const body = (comment.body ?? "").trim();
      if (!body) continue;
      const where = comment.path ? `${comment.path}${comment.line ? `:${comment.line}` : ""} — ` : "";
      const text = where + body;
      found.push({
        id: observationId("review-comment", story, text),
        source: "review-comment",
        story,
        date: comment.created_at ?? comment.submittedAt ?? comment.createdAt ?? "",
        link: comment.html_url ?? comment.url ?? pr.url ?? "",
        text,
      });
    }
  }
  return found;
}

export type AsOfOptions = { asOf?: string; excludeStory?: string };

// Keeps observations dated at or before `asOf`, minus the excluded story. A date-only `asOf` ("2026-05-01") covers that whole day.
export function observationsAsOf(observations: Observation[], options: AsOfOptions): Observation[] {
  const { asOf, excludeStory } = options;
  if (asOf === undefined) return observations.filter((o) => o.story !== excludeStory);
  const limit = Date.parse(asOf) + (/^\d{4}-\d{2}-\d{2}$/.test(asOf) ? 86_400_000 : 1);
  return observations.filter((o) => o.story !== excludeStory && Date.parse(o.date) < limit);
}

// An area as the run knows it: its id (the area note's slug) and its globs.
export type AreaGlobs = { id: string; globs: string[] };

// A path is a token with a `/` or a file extension; a trailing `:line` is dropped.
const pathsIn = (text: string): string[] =>
  [...text.matchAll(/[\w.@~/*-]+/g)].map((m) => m[0].replace(/[.]+$/, "")).filter((token) => /\/|\.\w+$/.test(token));

// Code first: the id of the first area whose glob matches a path in the text, else null (the model then chooses).
// A path is a token with a `/` or a file extension; a trailing `:line` is dropped.
export function areaFor(text: string, areas: AreaGlobs[]): string | null {
  const paths = pathsIn(text);
  return areas.find((area) => area.globs.some((g) => paths.some((p) => globToRegExp(g).test(p))))?.id ?? null;
}

// A filed observation: the model's category and phrase, and the area (from code first, else the model's, else null).
export type Filing = { id: string; category: string; area: string | null; phrase: string };

export type ClassifyContext = { areas: string[]; phrases: Record<string, string[]> };
export type Classify = (
  batch: Observation[],
  context: ClassifyContext,
) => Promise<{ filings: { id: string; category: string; area: string | null; phrase: string }[]; costUsd: number }>;

// Cache keys carry the prompt version and the model, so changing either refiles everything.
export const PROMPT_VERSION = "v1";
export const MODEL = "claude-haiku-4-5";
export const BATCH_SIZE = 20;
export const MAX_TOKENS = 2000;
// The fixed instructions of the system prompt; the areas and phrase vocabulary are counted per batch.
const SYSTEM_OVERHEAD_CHARS = 2000;
// Haiku 4.5 prices, USD per token ($1 / $5 per million).
export const INPUT_USD_PER_TOKEN = 1 / 1_000_000;
export const OUTPUT_USD_PER_TOKEN = 5 / 1_000_000;

export type FileOptions = {
  cache: Record<string, Filing>;
  classify: Classify;
  costCap: number;
  areas: AreaGlobs[];
  log: (line: string) => void;
  batchSize?: number;
};
export type FileResult = { filed: Filing[]; cache: Record<string, Filing>; spentUsd: number; stopped: "cap" | "error" | null };

// Files observations in batches through `classify`. Cached ids are not re-sent. Before each batch, spent plus the worst case
// (input chars / 4 at the input price, plus MAX_TOKENS at the output price) must stay within the cap, else the run stops with what it has.
export async function fileObservations(observations: Observation[], options: FileOptions): Promise<FileResult> {
  const { classify, areas, log, batchSize = BATCH_SIZE } = options;
  // A cap that is not a finite, non-negative number fails closed: nothing is spent.
  const costCap = Number.isFinite(options.costCap) && options.costCap >= 0 ? options.costCap : 0;
  const cache = { ...options.cache };
  const key = (id: string) => `${PROMPT_VERSION}:${MODEL}:${id}`;
  const areaIds = areas.map((a) => a.id);
  const phrases: Record<string, string[]> = {};
  const note = (filing: Filing) => {
    const list = (phrases[filing.category] ??= []);
    if (!list.includes(filing.phrase)) list.push(filing.phrase);
  };
  for (const o of observations) if (cache[key(o.id)]) note(cache[key(o.id)]);

  log(`cost cap $${costCap.toFixed(2)}`);
  const pending = observations.filter((o) => !cache[key(o.id)]);
  let spentUsd = 0;
  let stopped: FileResult["stopped"] = null;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const chars = SYSTEM_OVERHEAD_CHARS + JSON.stringify({ batch, areas: areaIds, phrases }).length;
    const worst = (chars / 4) * INPUT_USD_PER_TOKEN + MAX_TOKENS * OUTPUT_USD_PER_TOKEN;
    if (spentUsd + worst > costCap) {
      log(`stopped at cap: spent $${spentUsd.toFixed(4)}, next batch could cost $${worst.toFixed(4)}`);
      stopped = "cap";
      break;
    }
    try {
      const result = await classify(batch, { areas: areaIds, phrases });
      spentUsd += result.costUsd;
      const byId = new Map(batch.map((o) => [o.id, o]));
      for (const raw of result.filings) {
        const obs = byId.get(raw.id);
        if (!obs) continue;
        if (!(CORRECTION_CATEGORIES as readonly string[]).includes(raw.category)) {
          log(`dropped ${raw.id}: category "${raw.category}" is not in the list`);
          continue;
        }
        const modelArea = raw.area !== null && areaIds.includes(raw.area) ? raw.area : null;
        const filing: Filing = { id: raw.id, category: raw.category, area: areaFor(obs.text, areas) ?? modelArea, phrase: raw.phrase };
        cache[key(raw.id)] = filing;
        note(filing);
      }
    } catch (error) {
      // A billed call can still fail (a 200 with unusable text); it reports its cost on the error.
      const cost = (error as { costUsd?: unknown } | null)?.costUsd;
      if (typeof cost === "number" && Number.isFinite(cost)) spentUsd += cost;
      log(`classify failed: ${error instanceof Error ? error.message : String(error)}`);
      stopped = "error";
      break;
    }
  }
  const filed = observations.flatMap((o) => cache[key(o.id)] ?? []);
  return { filed, cache, spentUsd, stopped };
}

const normalisePhrase = (phrase: string) => phrase.toLowerCase().trim().replace(/\s+/g, " ");
const slugOf = (phrase: string) => phrase.replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 6).join("-") || "correction";
const unique = <T>(list: T[]) => [...new Set(list)];

// One seeded `correction` note per (category, area, normalised phrase). Filings whose observation is unknown are skipped.
// Output is sorted by count (high first), then slug.
export function mergeCorrections(filed: Filing[], obsById: Map<string, Observation> | Record<string, Observation>): Note[] {
  const lookup = (id: string) => (obsById instanceof Map ? obsById.get(id) : obsById[id]);
  const groups = new Map<string, { category: string; area: string | null; phrase: string; observations: Observation[] }>();
  for (const filing of filed) {
    const obs = lookup(filing.id);
    if (!obs) continue;
    const phrase = normalisePhrase(filing.phrase);
    const key = JSON.stringify([filing.category, filing.area, phrase]);
    const group = groups.get(key) ?? { category: filing.category, area: filing.area, phrase, observations: [] };
    group.observations.push(obs);
    groups.set(key, group);
  }

  // Slugs are handed out biggest group first, so a clash costs the smaller group its `-2`.
  const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) => b.observations.length - a.observations.length || (ka < kb ? -1 : 1));
  const taken = new Set<string>();
  const notes: Note[] = [];
  for (const [, group] of ordered) {
    const stem = slugOf(group.phrase);
    let slug = stem;
    for (let n = 2; taken.has(`${group.category}/${slug}`); n++) slug = `${stem}-${n}`;
    taken.add(`${group.category}/${slug}`);

    const dates = group.observations.map((o) => o.date.slice(0, 10)).filter(Boolean).sort();
    const note = emptyNote(slug, "correction", dates.at(-1) ?? "");
    note.area = group.area;
    note.category = group.category;
    note.count = group.observations.length;
    note.evidence = unique(group.observations.map((o) => o.link).filter(Boolean));
    note.learned_in = unique(group.observations.map((o) => o.story));
    note.files = unique(group.observations.flatMap((o) => pathsIn(o.text).map((p) => p.replace(/:\d+$/, ""))));
    note.body = [group.phrase, "", ...group.observations.slice(0, 3).map((o) => o.text)].join("\n");
    notes.push(note);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return notes.sort((a, b) => b.count - a.count || cmp(a.slug, b.slug) || cmp(a.category ?? "", b.category ?? ""));
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

// The `## Top corrections` section of SUMMARY.md: up to 10 correction notes, highest count first, then id.
// The phrase is the first line of the note body.
export function renderTopCorrections(notes: Note[]): string {
  const top = notes
    .map((note) => ({ note, id: noteId(note) }))
    .sort((a, b) => b.note.count - a.note.count || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 10);
  if (top.length === 0) return "## Top corrections\n\nNone yet.\n";
  const rows = top.map(({ note, id }) => `| ${note.count} | ${cell(note.category ?? "")} | ${cell(note.area ?? "")} | ${cell(note.body.split("\n")[0])} | ${cell(id)} |`);
  return ["## Top corrections", "", "| count | category | area | correction | id |", "|---|---|---|---|---|", ...rows, ""].join("\n");
}
