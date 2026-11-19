import { z } from "zod";

// The Debrief notes file (see CONTEXT.md, "Debrief renderer"): what the Debrief agent writes and
// `renderDebrief` reads. Pure, so Phase 2 can reuse the schema and the check on either side.

const where = { file: z.string().min(1), line: z.number().int().min(1) };

export const debriefStop = z.object({ ...where, why: z.string().min(1) });

export const debriefNote = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("decision"), ...where, text: z.string().min(1), rejected: z.string().min(1) }),
  z.object({ kind: z.literal("watch"), ...where, text: z.string().min(1) }),
  z.object({ kind: z.literal("note"), ...where, text: z.string().min(1) }),
]);

export const debriefBox = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  scenario: z.string().min(1).optional(),
});

export const debriefBuilt = z.object({ text: z.string().min(1), file: z.string().min(1).optional() });

export const MAX_STOPS = 5;

export const debriefNotes = z.object({
  version: z.literal(1),
  summary: z.string(),
  stops: z.array(debriefStop).max(MAX_STOPS),
  notes: z.array(debriefNote),
  boxes: z.array(debriefBox),
  built: z.array(debriefBuilt),
});

export type DebriefNotes = z.infer<typeof debriefNotes>;

export const DEBRIEF_NOTES_FORMAT = [
  "Write notes.json as one JSON object:",
  '{ "version": 1, "summary": string, "stops": [...], "notes": [...], "boxes": [...], "built": [...] }',
  "- summary: two or three plain sentences on what changed for the user.",
  "- stops: the places to read first, at most 5, each { file, line, why }.",
  '- notes: each { kind: "decision" | "watch" | "note", file, line, text }. A decision also needs `rejected`: what you did not do, and why.',
  "- boxes: each { id, label, scenario? }. A box id is `<path>#<function>` or `<path>:<line>`.",
  "- scenario: the name of a test that proves the box, written `describe > test`.",
  "- built: each { text, file? }, one line per thing you built.",
  "All paths are relative to the repo root. Every file and line must exist at the head commit.",
].join("\n");

export type DebriefCheck = { notes: DebriefNotes | null; problems: string[] };

const issue = (error: z.ZodError) => {
  const first = error.issues[0];
  return first ? `${first.path.join(".") || "value"}: ${first.message}` : "invalid";
};

// Parses the top level loosely, then each entry on its own, so one bad entry is dropped with one
// problem line and the rest stays. `lineCount` says how long a file is at the head commit, or
// undefined when it has no such file there. Box ids and scenario names pass through unchecked.
export function checkDebriefNotes(raw: unknown, lineCount: (file: string) => number | undefined): DebriefCheck {
  const top = z
    .object({
      version: z.literal(1),
      summary: z.string(),
      stops: z.array(z.unknown()),
      notes: z.array(z.unknown()),
      boxes: z.array(z.unknown()),
      built: z.array(z.unknown()),
    })
    .safeParse(raw);
  if (!top.success) return { notes: null, problems: [`notes.json: ${issue(top.error)}`] };

  const problems: string[] = [];
  const keep = <T extends { file: string; line: number }>(name: string, schema: z.ZodType<T>, entries: unknown[]) => {
    const kept: T[] = [];
    entries.forEach((entry, i) => {
      const parsed = schema.safeParse(entry);
      if (!parsed.success) return void problems.push(`${name}[${i}]: ${issue(parsed.error)}`);
      const { file, line } = parsed.data;
      const count = lineCount(file);
      if (count === undefined) return void problems.push(`${name}[${i}]: ${file} is not in the head commit`);
      if (line > count) return void problems.push(`${name}[${i}]: ${file} has ${count} lines, not ${line}`);
      kept.push(parsed.data);
    });
    return kept;
  };
  const plain = <T>(name: string, schema: z.ZodType<T>, entries: unknown[]) =>
    entries.flatMap((entry, i) => {
      const parsed = schema.safeParse(entry);
      if (parsed.success) return [parsed.data];
      problems.push(`${name}[${i}]: ${issue(parsed.error)}`);
      return [];
    });

  let stops = top.data.stops;
  if (stops.length > MAX_STOPS) {
    problems.push(`stops: ${stops.length} given, kept the first ${MAX_STOPS}`);
    stops = stops.slice(0, MAX_STOPS);
  }
  return {
    notes: {
      version: 1,
      summary: top.data.summary,
      stops: keep("stops", debriefStop, stops),
      notes: keep("notes", debriefNote, top.data.notes),
      boxes: plain("boxes", debriefBox, top.data.boxes),
      built: plain("built", debriefBuilt, top.data.built),
    },
    problems,
  };
}
