import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkDebriefNotes } from "../shared/debrief-notes";
import { changedFiles, headInfo, lineCountAt, mergeBase, resolveCommit } from "./debrief-git";
import { debriefPage } from "./debrief-page";

// renderDebrief (see CONTEXT.md, "Debrief renderer"): the Debrief page for one head commit, written
// outside the repo. It throws only for a caller error (an outDir in the repo, a head that isn't a
// commit); everything the notes or the base get wrong becomes a problem line on the page.
// No clock: the same inputs give the same bytes.

export type RenderDebriefInput = { worktree: string; base: string; head: string; notesFile: string; outDir: string };

// realpath of the nearest ancestor that exists, then the rest of the path put back on.
async function realTarget(path: string): Promise<string> {
  let existing = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(await realpath(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return resolve(path);
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

async function insideWorktree(worktree: string, outDir: string) {
  const rel = relative(await realpath(worktree), await realTarget(outDir));
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
}

async function readNotes(notesFile: string): Promise<{ raw?: unknown; problem?: string }> {
  let text: string;
  try {
    text = await readFile(notesFile, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return { problem: missing ? "notes.json: file not found" : "notes.json: couldn't be read" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: "notes.json: not valid JSON" };
  }
  return { raw };
}

export async function renderDebrief({ worktree, base, head, notesFile, outDir }: RenderDebriefInput) {
  if (await insideWorktree(worktree, outDir)) throw new Error(`outDir ${outDir} is inside the worktree ${worktree}`);
  const headSha = await resolveCommit(worktree, head);
  if (!headSha) throw new Error(`head ${head} is not a commit in ${worktree}`);

  const problems: string[] = [];
  const info = await headInfo(worktree, head);

  const files = new Map<string, number | undefined>();
  const read = await readNotes(notesFile);
  let notes = null;
  if (read.problem) problems.push(read.problem);
  else {
    const names = new Set<string>();
    const raw = read.raw as { stops?: unknown; notes?: unknown } | null;
    for (const list of [raw?.stops, raw?.notes]) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) if (typeof entry?.file === "string") names.add(entry.file);
    }
    for (const name of [...names].sort()) files.set(name, await lineCountAt(worktree, headSha, name));
    const checked = checkDebriefNotes(read.raw, (file) => files.get(file));
    problems.push(...checked.problems);
    notes = checked.notes;
  }

  const from = await mergeBase(worktree, base, headSha);
  if (!from) problems.push(`base: ${base} has no common history with head`);

  const page = debriefPage({
    summary: notes?.summary ?? null,
    branch: info.branch,
    base,
    sha: info.sha,
    date: info.date,
    files: from ? await changedFiles(worktree, from, headSha) : [],
    problems,
    notes,
  });
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, "debrief.html");
  await writeFile(file, page);
  return { file, problems };
}
