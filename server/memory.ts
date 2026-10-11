// The memory folder `.harness/memory/`: where each note lives, how it is read and written, and the short
// brief a step gets from it. Pure: only node:fs, node:path and node:crypto, no Paseo imports.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Citation = { path: string; from: number; to: number; hash: string };

const CITATION = /^(.+):(\d+)-(\d+)#([0-9a-f]{8})$/;

export function parseCitation(text: string): Citation {
  const m = CITATION.exec(text.trim());
  const from = m ? Number(m[2]) : 0;
  const to = m ? Number(m[3]) : 0;
  if (!m || from < 1 || to < from) throw new Error(`Bad citation "${text}": expected path:from-to#hash`);
  return { path: m[1], from, to, hash: m[4] };
}

export function formatCitation(c: Citation): string {
  return `${c.path}:${c.from}-${c.to}#${c.hash}`;
}

// First 8 hex chars of sha1 over the cited lines, each trimmed, so indentation changes don't stale a citation.
export function citationHash(lines: string[]): string {
  return createHash("sha1").update(lines.map((l) => l.trim()).join("\n")).digest("hex").slice(0, 8);
}

export type NoteType = "area" | "decision" | "fact" | "correction";
export type NoteStatus = "seeded" | "active" | "unverified" | "superseded" | "expired";

// Fixed starter categories; only the human adds more. Folders are not checked against this list.
export const CORRECTION_CATEGORIES = [
  "testing",
  "types",
  "error-handling",
  "conventions",
  "boundaries",
  "security",
  "ci-env",
  "performance",
  "scope",
];

const NOTE_TYPES: NoteType[] = ["area", "decision", "fact", "correction"];
const NOTE_STATUSES: NoteStatus[] = ["seeded", "active", "unverified", "superseded", "expired"];

export type Note = {
  slug: string;
  type: NoteType;
  /** Steps the note applies to; empty means every step. */
  steps: string[];
  /** Area name (a file in `areas/`), or null. */
  area: string | null;
  files: string[];
  citations: Citation[];
  verified_at: string | null;
  last_used: string | null;
  status: NoteStatus;
  /** Story ids, not note ids. */
  learned_in: string[];
  /** Note ids: the path under `.harness/memory/` without `.md`. */
  supports: string[];
  supersedes: string[];
  superseded_by: string[];
  /** Area only. */
  globs: string[];
  /** Correction only. */
  category: string | null;
  count: number;
  evidence: string[];
  /** Frontmatter keys this module doesn't know, in their original order. */
  extra: Record<string, string | string[]>;
  /** Everything after the closing `---`, exactly as written. */
  body: string;
};

type Value = string | string[];

// Frontmatter: `key: value`, `key:` (empty), `key: []`, or `key:` followed by `  - item` lines.
function parseFrontmatter(lines: string[], slug: string): Map<string, Value> {
  const fields = new Map<string, Value>();
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):(?: (.*))?$/.exec(lines[i]);
    if (!m) throw new Error(`Note ${slug}: cannot read frontmatter line "${lines[i]}"`);
    const raw = (m[2] ?? "").trim();
    if (raw === "[]") {
      fields.set(m[1], []);
    } else if (raw === "") {
      const items: string[] = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith("  - ")) items.push(lines[++i].slice(4).trim());
      fields.set(m[1], items.length > 0 ? items : "");
    } else {
      fields.set(m[1], raw);
    }
  }
  return fields;
}

function formatField(key: string, value: Value | null): string {
  if (Array.isArray(value)) return value.length === 0 ? `${key}: []\n` : `${key}:\n${value.map((v) => `  - ${v}\n`).join("")}`;
  return value ? `${key}: ${value}\n` : `${key}:\n`;
}

export function parseNote(text: string, slug: string): Note {
  const m = /^---\n(?:([\s\S]*?\n))?---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`Note ${slug}: no frontmatter`);
  const fields = parseFrontmatter((m[1] ?? "").split("\n").slice(0, -1), slug);
  const take = (key: string): Value | undefined => {
    const v = fields.get(key);
    fields.delete(key);
    return v;
  };
  const scalar = (key: string): string | null => {
    const v = take(key);
    return typeof v === "string" && v !== "" ? v : null;
  };
  const list = (key: string): string[] => {
    const v = take(key);
    return Array.isArray(v) ? v : [];
  };
  const type = scalar("type");
  if (!NOTE_TYPES.includes(type as NoteType)) throw new Error(`Note ${slug}: unknown type "${type}"`);
  const status = scalar("status");
  if (!NOTE_STATUSES.includes(status as NoteStatus)) throw new Error(`Note ${slug}: unknown status "${status}"`);
  const isArea = type === "area";
  const isCorrection = type === "correction";
  const note: Note = {
    slug,
    type: type as NoteType,
    steps: list("steps"),
    area: scalar("area"),
    files: list("files"),
    citations: list("citations").map(parseCitation),
    verified_at: scalar("verified_at"),
    last_used: scalar("last_used"),
    status: status as NoteStatus,
    learned_in: list("learned_in"),
    supports: list("supports"),
    supersedes: list("supersedes"),
    superseded_by: list("superseded_by"),
    globs: isArea ? list("globs") : [],
    category: isCorrection ? scalar("category") : null,
    count: isCorrection ? Number(scalar("count") ?? 0) || 0 : 0,
    evidence: isCorrection ? list("evidence") : [],
    extra: {},
    body: m[2],
  };
  for (const [key, value] of fields) note.extra[key] = value;
  return note;
}

export function formatNote(note: Note): string {
  let out = "---\n";
  out += formatField("type", note.type);
  out += formatField("steps", note.steps);
  out += formatField("area", note.area);
  out += formatField("files", note.files);
  out += formatField("citations", note.citations.map(formatCitation));
  out += formatField("verified_at", note.verified_at);
  out += formatField("last_used", note.last_used);
  out += formatField("status", note.status);
  out += formatField("learned_in", note.learned_in);
  out += formatField("supports", note.supports);
  out += formatField("supersedes", note.supersedes);
  out += formatField("superseded_by", note.superseded_by);
  if (note.type === "area") out += formatField("globs", note.globs);
  if (note.type === "correction") {
    out += formatField("category", note.category);
    out += formatField("count", String(note.count));
    out += formatField("evidence", note.evidence);
  }
  for (const [key, value] of Object.entries(note.extra)) out += formatField(key, value);
  return `${out}---\n${note.body}`;
}

const MEMORY_DIR = join(".harness", "memory");

const SEGMENT = /^[A-Za-z0-9][\w.-]*$/;

function segment(what: string, value: string): string {
  if (!SEGMENT.test(value) || value.includes("..")) throw new Error(`Bad ${what} "${value}": expected one plain path segment`);
  return value;
}

// Path of a note under `.harness/memory/`.
export function notePath(note: Pick<Note, "type" | "slug" | "category">): string {
  segment("slug", note.slug);
  switch (note.type) {
    case "area":
      return `areas/${note.slug}.md`;
    case "decision":
      return `decisions/${note.slug}.md`;
    case "fact":
      return `notes/${note.slug}.md`;
    case "correction":
      if (!note.category) throw new Error(`Note ${note.slug}: a correction needs a category`);
      return `corrections/${segment("category", note.category)}/${note.slug}.md`;
  }
}

// Writes one note. With `seededOnly`, an existing note that isn't `seeded` (or can't be read) is left alone.
export function writeNote(root: string, note: Note, opts: { seededOnly?: boolean } = {}): boolean {
  const file = join(root, MEMORY_DIR, notePath(note));
  if (opts.seededOnly && existsSync(file)) {
    try {
      if (parseNote(readFileSync(file, "utf8"), note.slug).status !== "seeded") return false;
    } catch {
      return false;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, formatNote(note));
  return true;
}

export type Backlink = { from: string; rel: "area" | "supports" | "supersedes" | "superseded_by" };
export type Memory = {
  areas: Note[];
  notes: Note[];
  /** Note id → the notes that link to it. Computed on read, never written. */
  backlinks: Record<string, Backlink[]>;
  /** SUMMARY.md as written, or "". */
  summary: string;
  /** Files that could not be read as notes, as paths under `.harness/memory/`. */
  errors: { path: string; message: string }[];
};

// A note's id: its path under `.harness/memory/` without `.md`.
export function noteId(note: Pick<Note, "type" | "slug" | "category">): string {
  return notePath(note).replace(/\.md$/, "");
}

function listMarkdown(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
}

export function readMemory(root: string): Memory {
  const dir = join(root, MEMORY_DIR);
  const memory: Memory = { areas: [], notes: [], backlinks: {}, summary: "", errors: [] };
  const summary = join(dir, "SUMMARY.md");
  if (existsSync(summary)) memory.summary = readFileSync(summary, "utf8");

  const folders = ["areas", "decisions", "notes"];
  const corrections = join(dir, "corrections");
  if (existsSync(corrections)) {
    for (const d of readdirSync(corrections, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (d.isDirectory()) folders.push(`corrections/${d.name}`);
    }
  }
  for (const folder of folders) {
    for (const file of listMarkdown(join(dir, folder))) {
      const path = `${folder}/${file}`;
      try {
        const note = parseNote(readFileSync(join(dir, path), "utf8"), file.slice(0, -3));
        if (note.type === "correction" && !note.category) note.category = folder.slice("corrections/".length);
        if (notePath(note) !== path) throw new Error(`Note ${note.slug}: a ${note.type} note does not belong in ${folder}/`);
        (note.type === "area" ? memory.areas : memory.notes).push(note);
      } catch (e) {
        memory.errors.push({ path, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  const link = (to: string, from: string, rel: Backlink["rel"]) => (memory.backlinks[to] ??= []).push({ from, rel });
  for (const note of [...memory.areas, ...memory.notes]) {
    const from = noteId(note);
    if (note.area) link(`areas/${note.area}`, from, "area");
    for (const id of note.supports) link(id, from, "supports");
    for (const id of note.supersedes) link(id, from, "supersedes");
    for (const id of note.superseded_by) link(id, from, "superseded_by");
  }
  return memory;
}

// `**` crosses folders, `*` and `?` stay inside one. Node's `path.matchesGlob` is still experimental.
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else {
        re += ".*";
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const LIVE: NoteStatus[] = ["active", "seeded"];

function firstLine(note: Note): string {
  return note.body.split("\n").find((l) => l.trim() !== "")?.trim() ?? note.slug;
}

// Lines for one step touching `paths`: the matching areas, then their facts and decisions (active before
// seeded), then their corrections by count. Facts and file pointers only, cut to `cap` lines.
export function briefFor(memory: Memory, query: { step: string; paths: string[] }, cap = 15): string[] {
  const live = (n: Note) => LIVE.includes(n.status);
  const areas = memory.areas.filter(
    (a) => live(a) && a.globs.some((g) => query.paths.some((p) => globToRegExp(g).test(p))),
  );
  const names = new Set(areas.map((a) => a.slug));
  const applies = (n: Note) =>
    live(n) && n.area !== null && names.has(n.area) && (n.steps.length === 0 || n.steps.includes(query.step));
  const rank = (n: Note) => LIVE.indexOf(n.status);

  const facts = memory.notes
    .filter((n) => (n.type === "fact" || n.type === "decision") && applies(n))
    .sort((a, b) => rank(a) - rank(b));
  const corrections = memory.notes.filter((n) => n.type === "correction" && applies(n)).sort((a, b) => b.count - a.count);

  const pointers = (n: Note) => (n.citations.length > 0 ? n.citations.map((c) => `${c.path}:${c.from}-${c.to}`) : n.files);
  return [
    ...areas.map((a) => `area ${a.slug}: ${a.globs.join(", ")}`),
    ...facts.map((n) => firstLine(n) + (pointers(n).length > 0 ? ` — ${pointers(n).join(", ")}` : "")),
    ...corrections.map((n) => `${firstLine(n)} (×${n.count})`),
  ].slice(0, cap);
}
