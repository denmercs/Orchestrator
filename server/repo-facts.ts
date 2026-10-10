// Seeded notes read off a snapshot of the repo: decisions from docs now, areas and facts in later cycles.
// Pure: no I/O, no clock. `verifiedAt` is the snapshot commit's date, so a re-run is byte-identical.
import { citationHash, globToRegExp, type Note } from "./memory";

export type DocOptions = {
  /** An architecture.md counts only once locked (`status: agreed`); then only its `## decisions` lines. */
  locked: boolean;
  verifiedAt: string;
  /** Area for a line (1-based number); null when none. Areas arrive in a later cycle. */
  areaOf?: (line: string, lineNo: number) => string | null;
};

export function emptyNote(slug: string, type: Note["type"], verifiedAt: string): Note {
  return {
    slug,
    type,
    steps: [],
    area: null,
    files: [],
    citations: [],
    verified_at: verifiedAt,
    last_used: null,
    status: "seeded",
    learned_in: [],
    supports: [],
    supersedes: [],
    superseded_by: [],
    globs: [],
    category: null,
    count: 0,
    evidence: [],
    extra: {},
    body: "",
  };
}

function kebab(text: string, words: number): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, words)
    .join("-");
}

// One decision per prose or bullet line; headings, fenced blocks (mermaid included), tables and blanks are skipped.
export function docDecisions(path: string, text: string, opts: DocOptions): Note[] {
  const file = path.split("/").pop() ?? path;
  const stem = file.replace(/\.md$/, "");
  const architecture = file === "architecture.md";
  if (architecture && !opts.locked) return [];

  const notes: Note[] = [];
  let fence: string | null = null;
  let inDecisions = false;
  let comment = false;
  const lines = text.split("\n");
  // A leading frontmatter block is metadata, not a claim.
  const body0 = lines[0]?.trim() === "---" ? lines.findIndex((l, i) => i > 0 && l.trim() === "---") : -1;
  lines.forEach((line, i) => {
    if (i <= body0) return;
    const trimmed = line.trim();
    if (comment) {
      if (trimmed.includes("-->")) comment = false;
      return;
    }
    if (!fence && trimmed.startsWith("<!--")) {
      comment = !trimmed.includes("-->");
      return;
    }
    if (!fence && /^([-*_])(\s*\1){2,}$/.test(trimmed)) return;
    const marker = /^(```|~~~)/.exec(trimmed)?.[1];
    if (fence) {
      if (marker === fence) fence = null;
      return;
    }
    if (marker) {
      fence = marker;
      return;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      if (heading[1].length <= 2) inDecisions = heading[1] === "##" && heading[2].trim().toLowerCase() === "decisions";
      return;
    }
    if (trimmed === "" || trimmed.startsWith("|")) return;
    if (architecture && !inDecisions) return;

    const hash = citationHash([line]);
    const note = emptyNote(`${stem.toLowerCase()}-${kebab(trimmed, 5)}-${hash}`, "decision", opts.verifiedAt);
    note.area = opts.areaOf?.(line, i + 1) ?? null;
    note.citations = [{ path, from: i + 1, to: i + 1, hash }];
    note.body = line;
    notes.push(note);
  });
  return notes;
}

export function matchesGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

// One area per `##` term of CONTEXT.md whose section cites tracked paths or globs in backticks.
// A token counts as a path when it has a `/` or a file extension; it is kept only if some tracked file matches.
export function termAreas(contextText: string, files: string[], verifiedAt: string): Note[] {
  const sections: { title: string; line: number; body: string[] }[] = [];
  contextText.split("\n").forEach((line, i) => {
    const heading = /^##\s+(.*?)\s*$/.exec(line);
    if (heading) sections.push({ title: heading[1], line: i + 1, body: [line] });
    else sections.at(-1)?.body.push(line);
  });

  const areas: Note[] = [];
  for (const section of sections) {
    const tokens = [...section.body.join("\n").matchAll(/`([^`\s]+)`/g)].map((m) => m[1]);
    const globs = [...new Set(tokens.filter((t) => /\/|\.\w+$/.test(t)))].filter((g) =>
      files.some((f) => matchesGlob(g, f)),
    );
    const slug = kebab(section.title, Infinity);
    if (globs.length === 0 || slug === "") continue;
    const note = emptyNote(slug, "area", verifiedAt);
    note.globs = globs;
    note.citations = [{ path: "CONTEXT.md", from: section.line, to: section.line, hash: citationHash([section.body[0]]) }];
    areas.push(note);
  }
  return areas;
}

export type Commit = { sha: string; subject: string; date: string; files: string[] };
export type CoChange = { a: string; b: string; shared: number; jaccard: number; commits: string[] };

const BULK_FILES = 40;

// `package-lock.json` and anything under `.harness/` never count, in any stat.
function counted(commits: Commit[]): Commit[] {
  return commits.map((c) => ({
    ...c,
    files: [...new Set(c.files)].filter((f) => f !== "package-lock.json" && !f.startsWith(".harness/")),
  }));
}

const byPath = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

// Every file pair that changed together, over commits of at most 40 files (counted after the ignored paths
// are dropped; larger commits are bulk and say nothing about coupling). Jaccard = shared / (commits of a + commits of b - shared).
// Sorted by shared desc, then a, then b. Callers apply their own thresholds.
export function coChangePairs(commits: Commit[]): CoChange[] {
  const small = counted(commits).filter((c) => c.files.length <= BULK_FILES);
  const per = new Map<string, number>();
  const pairs = new Map<string, CoChange>();
  for (const c of small) {
    const files = [...c.files].sort(byPath);
    for (const f of files) per.set(f, (per.get(f) ?? 0) + 1);
    files.forEach((a, i) =>
      files.slice(i + 1).forEach((b) => {
        const key = `${a}\0${b}`;
        const pair = pairs.get(key) ?? { a, b, shared: 0, jaccard: 0, commits: [] };
        pair.shared += 1;
        pair.commits.push(c.sha);
        pairs.set(key, pair);
      }),
    );
  }
  for (const p of pairs.values()) p.jaccard = p.shared / ((per.get(p.a) ?? 0) + (per.get(p.b) ?? 0) - p.shared);
  return [...pairs.values()].sort((x, y) => y.shared - x.shared || byPath(x.a, y.a) || byPath(x.b, y.b));
}

function gitFact(kind: string, slug: string, files: string[], shas: string[], body: string, verifiedAt: string): Note {
  const note = emptyNote(slug, "fact", verifiedAt);
  note.files = files;
  note.extra = { kind, commits: shas.map((s) => s.slice(0, 7)).sort() };
  note.body = body;
  return note;
}

// Hotspots, co-change pairs and refix files. Git facts have no source line, so `citations` stays empty;
// `files` and `extra.commits` (7-char shas) are what a reader checks.
// Co-change confidence = shared / min(commits of a, commits of b) (bulk commits left out of both counts),
// so a small file that always moves with a big one still shows; clusters use Jaccard instead (see `coChangePairs`).
export function historyFacts(commits: Commit[], verifiedAt: string): Note[] {
  const all = counted(commits);
  const touching = new Map<string, Commit[]>();
  for (const c of all) for (const f of c.files) touching.set(f, [...(touching.get(f) ?? []), c]);
  const ranked = [...touching.entries()].sort((x, y) => y[1].length - x[1].length || byPath(x[0], y[0]));

  const hotspots = ranked
    .filter(([, cs]) => cs.length >= 5)
    .slice(0, 10)
    .map(([f, cs]) =>
      gitFact("hotspot", `hotspot-${kebab(f, Infinity)}`, [f], cs.map((c) => c.sha), `${f} changed in ${cs.length} commits.`, verifiedAt),
    );

  const small = new Map<string, number>();
  for (const c of all) if (c.files.length <= BULK_FILES) for (const f of c.files) small.set(f, (small.get(f) ?? 0) + 1);
  const coChange = coChangePairs(commits)
    .filter((p) => p.shared >= 3 && p.shared / Math.min(small.get(p.a) ?? 0, small.get(p.b) ?? 0) >= 0.5)
    .slice(0, 20)
    .map((p) =>
      gitFact(
        "co-change",
        `co-change-${kebab(p.a, Infinity)}-${kebab(p.b, Infinity)}`,
        [p.a, p.b],
        p.commits,
        `${p.a} and ${p.b} changed together in ${p.shared} commits.`,
        verifiedAt,
      ),
    );

  const refix = ranked
    .map(([f, cs]) => [f, cs.filter((c) => /\bfix/i.test(c.subject))] as const)
    .filter(([, fixes]) => fixes.length >= 3)
    .sort((x, y) => y[1].length - x[1].length || byPath(x[0], y[0]))
    .map(([f, fixes]) =>
      gitFact("refix", `refix-${kebab(f, Infinity)}`, [f], fixes.map((c) => c.sha), `${f} was touched by ${fixes.length} fix commits.`, verifiedAt),
    );

  return [...hotspots, ...coChange, ...refix];
}

export type AreaAssignment = {
  areas: Note[];
  /** Slug of the first area claiming `path` (term, then cluster, then folder); null for ignored paths. */
  primaryArea(path: string): string | null;
};

const stemOf = (path: string) => (path.split("/").pop() ?? path).replace(/\.[^.]*$/, "");
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

// Common leading characters of the members' basenames, minus trailing separators.
function sharedPrefix(members: string[]): string {
  const names = members.map((m) => m.split("/").pop() ?? m);
  let prefix = names[0];
  for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix.replace(/[^a-z0-9]+$/i, "");
}

// Areas in order: term areas as given; co-change clusters among files no term claims (union-find over pairs
// with >=3 shared commits and Jaccard >=0.5; a lone file is no cluster); then one `<folder>/**` per top-level
// folder (`root`, glob `*`, for top-level files) holding whatever is left. Citations stay empty for clusters
// and folders. Ordered by member path / slug so a re-run is byte-identical.
export function assignAreas(files: string[], terms: Note[], commits: Commit[], verifiedAt: string): AreaAssignment {
  const tracked = [...new Set(files)].filter((f) => f !== "package-lock.json" && !f.startsWith(".harness/")).sort(byPath);
  const inTerm = (f: string) => terms.some((t) => t.globs.some((g) => matchesGlob(g, f)));
  const unclaimed = tracked.filter((f) => !inTerm(f));
  const free = new Set(unclaimed);

  const parent = new Map(unclaimed.map((f) => [f, f]));
  const find = (f: string): string => {
    const p = parent.get(f) as string;
    if (p === f) return f;
    const root = find(p);
    parent.set(f, root);
    return root;
  };
  for (const p of coChangePairs(commits)) {
    if (p.shared >= 3 && p.jaccard >= 0.5 && free.has(p.a) && free.has(p.b)) parent.set(find(p.a), find(p.b));
  }
  const groups = new Map<string, string[]>();
  for (const f of unclaimed) groups.set(find(f), [...(groups.get(find(f)) ?? []), f]);

  const clusters = [...groups.values()].filter((m) => m.length > 1);
  const clustered = new Set(clusters.flat());
  // Analyzer ids are unique: a later area that kebabs to a taken or empty slug gets a suffix.
  const taken = new Set(terms.map((t) => t.slug));
  const unique = (slug: string, suffix: string, n: number): string => {
    let id = slug === "" ? `${suffix}-${n}` : taken.has(slug) ? `${slug}-${suffix}` : slug;
    for (let k = 2; taken.has(id); k++) id = `${slug === "" ? suffix : slug}-${suffix}-${k}`;
    taken.add(id);
    return id;
  };
  const clusterAreas = clusters.map((members, n) => {
    const prefix = sharedPrefix(members);
    const slug = prefix !== "" ? kebab(prefix, Infinity) : kebab(`${dirOf(members[0]) || "root"} ${stemOf(members[0])}`, Infinity);
    const note = emptyNote(unique(slug, "cluster", n + 1), "area", verifiedAt);
    note.globs = members;
    return note;
  });

  const folders = new Map<string, string>();
  for (const f of unclaimed) if (!clustered.has(f)) folders.set(f.includes("/") ? f.split("/")[0] : "root", f.includes("/") ? `${f.split("/")[0]}/**` : "*");
  const folderAreas = [...folders.entries()].sort((x, y) => byPath(x[0], y[0])).map(([slug, glob], n) => {
    const note = emptyNote(unique(kebab(slug, Infinity), "folder", n + 1), "area", verifiedAt);
    note.globs = [glob];
    return note;
  });

  const areas = [...terms, ...clusterAreas, ...folderAreas];
  return {
    areas,
    primaryArea: (path) =>
      path === "package-lock.json" || path.startsWith(".harness/")
        ? null
        : (areas.find((a) => a.globs.some((g) => matchesGlob(g, path)))?.slug ?? null),
  };
}

export type SourceFile = { path: string; text: string };

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
// `import … from '.x'`, `export … from '.x'`, `import '.x'` and `import('.x')`; relative specifiers only.
const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])(\.[^'"]*)\1/;

function normalize(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "..") out.pop();
    else if (part !== "." && part !== "") out.push(part);
  }
  return out.join("/");
}

function resolveImport(from: string, spec: string, tracked: Set<string>): string | null {
  const base = normalize(`${dirOf(from)}/${spec}`);
  const stripped = base.replace(/\.[cm]?jsx?$/, "");
  const candidates = [base, `${stripped}.ts`, `${stripped}.tsx`, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((c) => tracked.has(c)) ?? null;
}

// One fact per ordered area pair A -> B (A imports B), never A -> A, citing the first import line
// (sorted path, then line) that makes the edge. Package imports and unresolved specifiers are ignored.
export function dependencyFacts(files: SourceFile[], areas: Pick<AreaAssignment, "primaryArea">, verifiedAt: string): Note[] {
  const sorted = [...files].sort((x, y) => byPath(x.path, y.path));
  const tracked = new Set(sorted.map((f) => f.path));
  const edges = new Map<string, Note>();
  for (const file of sorted) {
    const from = areas.primaryArea(file.path);
    if (from === null || !SOURCE.test(file.path)) continue;
    const lines = file.text.split("\n");
    lines.forEach((line, i) => {
      const spec = IMPORT.exec(line)?.[2];
      const target = spec === undefined ? null : resolveImport(file.path, spec, tracked);
      const to = target === null ? null : areas.primaryArea(target);
      if (to === null || to === from) return;
      const slug = `dependency-${kebab(from, Infinity)}-to-${kebab(to, Infinity)}`;
      if (edges.has(slug)) return;
      const note = emptyNote(slug, "fact", verifiedAt);
      note.area = from;
      note.files = [file.path, target as string];
      note.extra = { kind: "dependency", from, to };
      note.citations = [{ path: file.path, from: i + 1, to: i + 1, hash: citationHash([line]) }];
      note.body = `${from} imports ${to}`;
      edges.set(slug, note);
    });
  }
  return [...edges.values()].sort((x, y) => byPath(x.slug, y.slug));
}

// Net `{`/`[` minus `}`/`]` on a line, quoted strings and `//` comments ignored (tsconfig allows comments).
function depthChange(line: string): number {
  const bare = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "").replace(/\/\/.*$/, "");
  return (bare.match(/[{[]/g)?.length ?? 0) - (bare.match(/[}\]]/g)?.length ?? 0);
}

// Direct `"key": …` lines of the object named `section`; nested lines are covered by their parent key's line.
function jsonKeyLines(text: string, section: string): { line: string; no: number; key: string }[] {
  const out: { line: string; no: number; key: string }[] = [];
  let depth = 0;
  let inside = false;
  text.split("\n").forEach((line, i) => {
    if (!inside) {
      if (new RegExp(`^\\s*"${section}"\\s*:\\s*\\{\\s*$`).test(line)) {
        inside = true;
        depth = 1;
      }
      return;
    }
    const key = /^\s*"([^"]+)"\s*:/.exec(line)?.[1];
    if (depth === 1 && key !== undefined) out.push({ line, no: i + 1, key });
    depth += depthChange(line);
    if (depth <= 0) inside = false;
  });
  return out;
}

const RULE_ENTRY = /^\s*(['"]?)([@\w/-]+)\1\s*:\s*(?:\[|['"]?(?:error|warn|off|[012])\b)/;

// Rules the repo's own tooling enforces, one fact per source line, `area: null` so briefs stay clear of them:
// tsconfig `compilerOptions` keys, package.json `scripts`, eslint rule entries and workflow `run:` lines.
// Parsing is line-based on purpose (tsconfig has comments). An eslint entry is any `'name': 'error'|'warn'|'off'|0-2|[…]`
// line after the first `rules:` line of an `eslint.config.*` / `.eslintrc*` file. A `run: |` block counts as its `run:` line only.
// Slugs are `enforced-<file stem>-<key>`; workflow runs and key collisions fall back to the line number.
export function enforcedRules(files: SourceFile[], verifiedAt: string): Note[] {
  const notes = new Map<string, Note>();
  const add = (file: SourceFile, no: number, line: string, key: string | null) => {
    const base = `enforced-${kebab(stemOf(file.path), Infinity)}`;
    let slug = key === null ? `${base}-run-${no}` : `${base}-${kebab(key, Infinity)}`;
    if (notes.has(slug)) slug = `${slug}-${no}`;
    const note = emptyNote(slug, "fact", verifiedAt);
    note.files = [file.path];
    note.extra = { kind: "enforced" };
    note.citations = [{ path: file.path, from: no, to: no, hash: citationHash([line]) }];
    note.body = line.trim();
    notes.set(slug, note);
  };
  for (const file of [...files].sort((x, y) => byPath(x.path, y.path))) {
    const name = file.path.split("/").pop() ?? file.path;
    if (/^tsconfig[^/]*\.json$/.test(name)) {
      for (const k of jsonKeyLines(file.text, "compilerOptions")) add(file, k.no, k.line, k.key);
    } else if (name === "package.json") {
      for (const k of jsonKeyLines(file.text, "scripts")) add(file, k.no, k.line, k.key);
    } else if (/^eslint\.config\.|^\.eslintrc/.test(name)) {
      let inRules = false;
      file.text.split("\n").forEach((line, i) => {
        if (/^\s*['"]?rules['"]?\s*:/.test(line)) inRules = true;
        const key = inRules ? RULE_ENTRY.exec(line)?.[2] : undefined;
        if (key !== undefined && key !== "rules") add(file, i + 1, line, key);
      });
    } else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.path)) {
      file.text.split("\n").forEach((line, i) => {
        if (/^\s*(?:-\s+)?run:/.test(line)) add(file, i + 1, line, null);
      });
    }
  }
  return [...notes.values()].sort((x, y) => byPath(x.slug, y.slug));
}

const rowCells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

// SUMMARY.md: an area table `| id | name | globs | notes |`. `name` starts as the id; the human edits it to rename
// an area, or gives two rows one name to merge them. `names` keeps those edits when the file is rewritten.
export function renderSummary(areas: Note[], counts: Map<string, number> | Record<string, number>, names?: Map<string, string>): string {
  const count = (id: string) => (counts instanceof Map ? counts.get(id) : counts[id]) ?? 0;
  const rows = areas.map((a) => `| ${a.slug} | ${names?.get(a.slug) ?? a.slug} | ${a.globs.join(", ")} | ${count(a.slug)} |`);
  return ["# Memory summary", "", "Edit `name` to rename an area; give two rows the same name to merge them.", "", "| id | name | globs | notes |", "|---|---|---|---|", ...rows, ""].join("\n");
}

// id -> name for every row of the area table; the header and separator rows are skipped.
// Reading stops at the first `## ` heading, so sections appended after the table (Top corrections) are not areas.
export function readAreaNames(text: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) break;
    if (!line.trim().startsWith("|")) continue;
    const [id, name] = rowCells(line);
    if (id === undefined || name === undefined || id === "" || name === "" || id === "id" || /^-+$/.test(id)) continue;
    names.set(id, name);
  }
  return names;
}

export type Snapshot = {
  /** Tracked files at the snapshot commit. */
  files: SourceFile[];
  commits: Commit[];
  /** Untracked architecture docs already filtered to the locked ones. */
  harnessDocs: SourceFile[];
  verifiedAt: string;
  areaNames?: Map<string, string>;
};

const DOCS = /^(?:README\.md|CONTEXT\.md|AGENTS\.md|docs\/adr\/[^/]+\.md)$/;

// Every seeded note for a snapshot, plus the SUMMARY.md text. Areas and facts are built under the analyzer's ids,
// then renamed: areas sharing a name become one area (globs and citations unioned) and each note's `area` follows.
export function seedNotes(snapshot: Snapshot): { notes: Note[]; summary: string } {
  const { files, commits, harnessDocs, verifiedAt } = snapshot;
  const paths = files.map((f) => f.path);
  const context = files.find((f) => f.path === "CONTEXT.md");
  const terms = context ? termAreas(context.text, paths, verifiedAt) : [];
  const { areas, primaryArea } = assignAreas(paths, terms, commits, verifiedAt);

  const termSlugs = new Set(terms.map((t) => t.slug));
  const areaOfDoc = (doc: SourceFile) => {
    const lines = doc.text.split("\n");
    return (line: string, lineNo: number): string | null => {
      if (doc.path === "CONTEXT.md") {
        for (let i = lineNo - 1; i >= 0; i--) {
          const title = /^##\s+(.*?)\s*$/.exec(lines[i])?.[1];
          if (title === undefined) continue;
          const slug = kebab(title, Infinity);
          if (termSlugs.has(slug)) return slug;
          break;
        }
      }
      const cited = [...line.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).find((t) => /\/|\.\w+$/.test(t));
      return cited === undefined ? null : primaryArea(cited);
    };
  };
  const docs = files.filter((f) => DOCS.test(f.path)).sort((x, y) => byPath(x.path, y.path));
  const decisions = [
    ...docs.flatMap((d) => docDecisions(d.path, d.text, { locked: false, verifiedAt, areaOf: areaOfDoc(d) })),
    ...[...harnessDocs].sort((x, y) => byPath(x.path, y.path)).flatMap((d) => docDecisions(d.path, d.text, { locked: true, verifiedAt })),
  ];
  const git = historyFacts(commits, verifiedAt);
  for (const fact of git) fact.area = primaryArea(fact.files[0]);
  const facts = [...git, ...dependencyFacts(files, { primaryArea }, verifiedAt), ...enforcedRules(files, verifiedAt)];

  const counts = new Map<string, number>();
  for (const n of [...decisions, ...facts]) if (n.area !== null) counts.set(n.area, (counts.get(n.area) ?? 0) + 1);
  const names = snapshot.areaNames ?? new Map<string, string>();
  const finalName = (id: string) => kebab(names.get(id) ?? id, Infinity) || id;

  const merged = new Map<string, Note>();
  for (const area of areas) {
    const slug = finalName(area.slug);
    const into = merged.get(slug);
    if (!into) {
      merged.set(slug, { ...area, slug, globs: [...area.globs].sort(byPath), citations: [...area.citations] });
      continue;
    }
    into.globs = [...new Set([...into.globs, ...area.globs])].sort(byPath);
    for (const c of area.citations) if (!into.citations.some((x) => x.path === c.path && x.from === c.from && x.hash === c.hash)) into.citations.push(c);
  }
  const renamed = [...decisions, ...facts].map((n) => ({ ...n, area: n.area === null ? null : finalName(n.area) }));

  const seen = new Set<string>();
  const notes = [...merged.values(), ...renamed].filter((n) => {
    const id = `${n.type}/${n.slug}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { notes, summary: renderSummary(areas, counts, snapshot.areaNames) };
}
