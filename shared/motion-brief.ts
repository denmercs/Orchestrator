import { z } from "zod";
import type { DiffFile } from "./motion-diff";

// The Motion brief (see CONTEXT.md, "Motion brief"): `motion.json`, which the writer agent makes from
// the diff alone, the check that ties every claim to real diff lines, and the paste-ready `motion.md`
// the script fills around it. Pure: the same motion.json and diff give the same text.

const ref = z.object({ file: z.string().min(1), side: z.enum(["+", "-"]), snippet: z.string().min(1) });
const claim = z.object({ text: z.string().min(1), refs: z.array(ref) });

export const motionScene = z.object({
  name: z.string().min(1),
  visual: z.string().min(1),
  labels: z.array(z.object({ text: z.string().min(1), code: z.array(z.string().min(1)).min(1) })),
  beats: z.array(z.object({ caption: z.string().min(1) })).min(1).max(2),
  decision: claim,
  instead_of: claim.nullable(),
  because: claim.nullable(),
});

export type MotionRef = z.infer<typeof ref>;
export type MotionClaim = z.infer<typeof claim>;
export type MotionScene = z.infer<typeof motionScene>;
export type Motion = { title: string; subtitle: string; metaphor: string; scenes: MotionScene[] };

export const MAX_SCENES = 8;
export const MIN_SCENES = 6;
export const MOTION_SECONDS = 65;
const FIRST_SCENE_SECONDS = 8;
const CAPTION_WORDS = 20;
export const NO_DECISION = "No architectural decision in this diff.";

export const MOTION_PROMPT = [
  "You write the script for a short animated video that explains the architectural decisions in one code change.",
  "Your only input is the change's git diff: a summary of every file, then the diff itself. You have no other context.",
  "Answer with one JSON object and nothing else, no prose and no code fence:",
  '{ "title": string, "subtitle": string, "metaphor": string, "scenes": [ { "name", "visual", "labels", "beats", "decision", "instead_of", "because" } ] }',
  '- metaphor: one visual metaphor for the whole change, a noun phrase that reads after "Show ", e.g. "a stack of glass cards".',
  "- scenes: 6 to 8 scenes, one decision each, in the order a reviewer should meet them.",
  "- name: a short scene title. The last scene resolves back to the finished result: name it \"Collapse\" or put \"finished\" in its name.",
  '- visual: what the viewer sees, dark UI, clean technical style. Put every on-screen label in double quotes, e.g. "z 1000".',
  "  Every piece of text in double quotes in visual must be a label, with the code it names. Use double quotes for nothing else; leave generic words unquoted.",
  '- labels: each { "text", "code": [...] }. text is a quoted label from visual, word for word. code lists the exact pieces of the diff it names, each copied from a + or - line.',
  '- beats: one or two, each { "caption" }. A caption is at most 20 words and at most 2 sentences.',
  '- decision: { "text", "refs" }: the choice, in one sentence. At least one ref must be an added line.',
  '- instead_of: { "text", "refs" } or null: only what the diff removed or replaced. Every ref must be a removed line or a deleted file.',
  '- because: { "text", "refs" } or null: a consequence the added code shows. At least one ref must be an added line.',
  '- a ref is { "file", "side": "+" | "-", "snippet" }: file is the path in the diff, side says added (+) or removed (-), and snippet is text copied from one line on that side of that file.',
  "Write no rejected alternative and no motive unless a cited line shows it.",
  "If the diff doesn't show an alternative, instead_of is null and the scene states only the choice and how it works.",
  "Tests are not a scene. Every claim, label and snippet is checked against the diff, and anything that isn't in it is dropped.",
].join("\n");

export type MotionCheck = { motion: Motion | null; problems: string[] };

const squeeze = (text: string) => text.replace(/\s+/g, " ").trim();
const issue = (error: z.ZodError) => {
  const first = error.issues[0];
  return first ? `${first.path.join(".") || "value"}: ${first.message}` : "invalid";
};

// Why `scene` fails, or null. `onLine(file, side, snippet)` says whether the snippet sits on a line of
// that file and side; `inDiff(code)` whether it sits on any +/- line.
type Lines = { onLine: (r: MotionRef) => boolean; deleted: (file: string) => boolean; inDiff: (code: string) => boolean };

const refFails = (r: MotionRef, lines: Lines) => (lines.onLine(r) ? null : `"${r.snippet}" is not on a ${r.side} line of ${r.file}`);

function claimFails(name: string, c: MotionClaim, lines: Lines, side: "+" | "-"): string | null {
  if (side === "+") {
    if (!c.refs.some((r) => r.side === "+")) return `${name} cites no added line`;
    for (const r of c.refs) if (refFails(r, lines)) return `${name}: ${refFails(r, lines)}`;
    return null;
  }
  if (!c.refs.length) return `${name} cites no removed line`;
  for (const r of c.refs) {
    if (r.side !== "-") return `${name}: "${r.snippet}" is not a removed line`;
    if (!lines.deleted(r.file) && refFails(r, lines)) return `${name}: ${refFails(r, lines)}`;
  }
  return null;
}

function sceneFails(scene: MotionScene, lines: Lines): string | null {
  const decision = claimFails("decision", scene.decision, lines, "+");
  if (decision) return decision;
  const texts = new Set(scene.labels.map((l) => l.text));
  for (const match of scene.visual.matchAll(/"([^"]+)"|“([^”]+)”/g)) {
    const quoted = match[1] ?? match[2]!;
    if (!texts.has(quoted)) return `label "${quoted}" in visual is not in labels`;
  }
  for (const label of scene.labels) {
    const missing = label.code.find((code) => !lines.inDiff(code));
    if (missing !== undefined) return `label "${label.text}": "${missing}" is not on a +/- line of the diff`;
  }
  return null;
}

// A long caption only warns, so it can be fixed by hand; `n` is the scene's number in motion.md.
const captionWarnings = (scene: MotionScene, n: number) =>
  scene.beats.flatMap(({ caption }, b) => {
    const which = `Scene ${n} ${scene.beats.length === 2 ? `beat ${b ? "two" : "one"} ` : ""}caption`;
    const words = caption.trim().split(/\s+/).length;
    const sentences = caption.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim()).length;
    return [
      ...(words > CAPTION_WORDS ? [`${which} is ${words} words (limit ${CAPTION_WORDS})`] : []),
      ...(sentences > 2 ? [`${which} is ${sentences} sentences (limit 2)`] : []),
    ];
  });

export function checkMotion(raw: unknown, files: DiffFile[]): MotionCheck {
  const top = z
    .object({ title: z.string().min(1), subtitle: z.string().min(1), metaphor: z.string().min(1), scenes: z.array(z.unknown()) })
    .safeParse(raw);
  if (!top.success) return { motion: null, problems: [`motion.json: ${issue(top.error)}`] };

  const byPath = new Map(files.map((f) => [f.path, { "+": f.added.map(squeeze), "-": f.removed.map(squeeze) }]));
  const every = files.flatMap((f) => [...f.added, ...f.removed]).map(squeeze);
  const lines: Lines = {
    onLine: (r) => !!byPath.get(r.file)?.[r.side].some((line) => line.includes(squeeze(r.snippet))),
    deleted: (path) => files.some((f) => f.path === path && f.status === "D"),
    inDiff: (code) => every.some((line) => line.includes(squeeze(code))),
  };

  const problems: string[] = [];
  let entries = top.data.scenes;
  if (entries.length > MAX_SCENES) {
    problems.push(`scenes: ${entries.length} given, kept the first ${MAX_SCENES}`);
    entries = entries.slice(0, MAX_SCENES);
  }
  const scenes = entries.flatMap((entry, i) => {
    const parsed = motionScene.safeParse(entry);
    if (!parsed.success) return void problems.push(`scenes[${i}]: ${issue(parsed.error)}`), [];
    const scene = parsed.data;
    const at = `scenes[${i}] (${scene.name})`;
    const fails = sceneFails(scene, lines);
    if (fails) return void problems.push(`${at}: ${fails}`), [];
    const instead = scene.instead_of && claimFails("instead_of", scene.instead_of, lines, "-");
    if (instead) problems.push(`${at}: ${instead}; set to null`);
    const because = scene.because && claimFails("because", scene.because, lines, "+");
    if (because) problems.push(`${at}: ${because}; set to null`);
    return [{ ...scene, instead_of: instead ? null : scene.instead_of, because: because ? null : scene.because }];
  });

  if (scenes.length < 2) return { motion: null, problems: [...problems, NO_DECISION] };
  scenes.forEach((scene, i) => problems.push(...captionWarnings(scene, i + 1)));
  if (scenes.length < MIN_SCENES) problems.push(`scenes: ${scenes.length} passed the check, a brief wants ${MIN_SCENES} to ${MAX_SCENES}`);
  const last = scenes.at(-1)!.name;
  if (last !== "Collapse" && !/finished/i.test(last)) problems.push('scenes: the last scene should be "Collapse" or show the finished result');
  const { title, subtitle, metaphor } = top.data;
  return { motion: { title, subtitle, metaphor, scenes }, problems };
}

// [start, end] in whole seconds per scene: the first gets 8s, the rest split what is left by weight
// (its beat count), rounded on the running total so the last ends exactly on `total`.
export function sceneTimes(weights: number[], total = MOTION_SECONDS): [number, number][] {
  const first = Math.min(FIRST_SCENE_SECONDS, total);
  const rest = weights.slice(1);
  const sum = rest.reduce((n, w) => n + w, 0);
  let running = 0;
  let start = first;
  return [
    [0, first],
    ...rest.map((w): [number, number] => {
      running += w;
      const end = first + Math.round(((total - first) * running) / sum);
      const span: [number, number] = [start, end];
      start = end;
      return span;
    }),
  ];
}

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`);
const bare = (text: string) => text.trim().replace(/\.+$/, "");

export function renderMotion(motion: Motion, total = MOTION_SECONDS): string {
  const times = sceneTimes(motion.scenes.map((s) => s.beats.length), total);
  const header =
    `Make a ${total}-second animated explainer in ${motion.scenes.length} scenes, dark UI, clean technical style. ` +
    `Title: **"${bare(motion.title)}"** Subtitle: "${bare(motion.subtitle)}" Show ${bare(motion.metaphor)}. Use captions, no voiceover.`;
  const scenes = motion.scenes.map((scene, i) => {
    const [a, b] = times[i]!;
    const captions =
      scene.beats.length === 1
        ? `Caption: "${scene.beats[0]!.caption.trim()}"`
        : `Beat one caption: "${scene.beats[0]!.caption.trim()}" Beat two caption: "${scene.beats[1]!.caption.trim()}"`;
    return `**Scene ${i + 1} (${a}–${b}s): ${bare(scene.name)}.** ${sentence(scene.visual)} ${captions}`;
  });
  return [header, ...scenes].join("\n\n") + "\n";
}
