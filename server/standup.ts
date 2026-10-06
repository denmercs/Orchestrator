import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RpcOutput } from "@getpaseo/plugin";
import {
  listOrchestrationFolders,
  listOrchestrationStandupTodos,
  saveOrchestrationStandupTodos,
  upsertOrchestrationStandupNote,
} from "../shared/orchestration";
import { listMergedPrs } from "./github-prs";
import { listMyWorkStories } from "./jira";
import {
  applyObsidianTemplate,
  buildStandupNote,
  DAILY_NOTE_FILE,
  formatDate,
  parseTodoNotes,
  shippedLines,
  standupNoteRelativePath,
  standupNoteRelativePathForDate,
  type StandupTodo,
  YEAR_FOLDER,
  writeShippedItems,
  workLines,
  writeTodoNotes,
  writeWorkItems,
} from "./standup-note";

const MAX_FOLDER_ENTRIES = 200;

export async function listFolders(input: {
  path: string | null;
}): Promise<RpcOutput<typeof listOrchestrationFolders>> {
  const start = input.path && input.path.length > 0 ? input.path : homedir();
  const resolved = path.resolve(start);
  assertAllowedPath(resolved);

  let directory: string;
  try {
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new Error("That path is not a folder.");
    }
    directory = resolved;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      const parent = path.dirname(resolved);
      if (parent === resolved) {
        throw new Error("That folder does not exist.");
      }
      return listFolders({ path: parent });
    }
    throw error;
  }

  const names = await readdir(directory, { withFileTypes: true });
  const entries = names
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path.join(directory, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_FOLDER_ENTRIES);

  const parent = path.dirname(directory);
  return {
    path: directory,
    parent: parent === directory ? null : parent,
    entries,
  };
}

export async function upsertStandupNote(input: {
  folderPath: string;
  templatePath: string | null;
}): Promise<RpcOutput<typeof upsertOrchestrationStandupNote>> {
  const folderPath = path.resolve(input.folderPath);
  assertAllowedPath(folderPath);

  const info = await stat(folderPath);
  if (!info.isDirectory()) {
    throw new Error("Select a folder, not a file.");
  }

  const now = new Date();
  const relative = standupNoteRelativePath(path.basename(folderPath), now);
  const notePath = path.join(folderPath, relative);
  assertAllowedPath(notePath);
  await mkdir(path.dirname(notePath), { recursive: true });

  let created = false;
  let markdown: string;
  try {
    markdown = await readFile(notePath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    markdown = await readNoteTemplate(input.templatePath, now);
    created = true;
  }

  const [merged, work] = await Promise.all([listMergedPrs(now), listMyWorkStories()]);
  const shipped = writeShippedItems(markdown, shippedLines(merged.prs));
  // A failed Jira read leaves the existing Work block alone rather than blanking it.
  const next = work.error ? shipped : writeWorkItems(shipped.markdown, workLines(work.items));
  if (created || next.markdown !== markdown) {
    await writeAtomically(notePath, next.markdown);
  }

  return {
    notePath,
    created,
    changed: created || next.markdown !== markdown,
    templateName: templateDisplayName(input.templatePath),
    prs: merged.prs,
    work: work.items,
    workError: work.error,
  };
}

export async function listStandupTodos(input: {
  folderPath: string;
}): Promise<RpcOutput<typeof listOrchestrationStandupTodos>> {
  const folderPath = await resolveStandupFolder(input.folderPath);
  const today = formatDate(new Date());
  const notePath = notePathForDate(folderPath, today);
  const notes = await listDailyNotes(folderPath);
  return {
    notePath,
    exists: notes.some((note) => note.path === notePath),
    today,
    items: await readTodosAcrossNotes(notes),
  };
}

export async function saveStandupTodos(input: {
  folderPath: string;
  templatePath: string | null;
  date: string | null;
  items: { kind: "todo" | "blocker" | "note"; text: string; done: boolean }[];
}): Promise<RpcOutput<typeof saveOrchestrationStandupTodos>> {
  const folderPath = await resolveStandupFolder(input.folderPath);
  const today = formatDate(new Date());
  const date = input.date ?? today;
  const notePath = notePathForDate(folderPath, date);
  await mkdir(path.dirname(notePath), { recursive: true });

  let created = false;
  let markdown: string;
  try {
    markdown = await readFile(notePath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    // Only today's note may be created from the template; past notes must already exist.
    if (date !== today) {
      throw new Error(`The ${date} standup note no longer exists.`);
    }
    markdown = await readNoteTemplate(input.templatePath, new Date());
    created = true;
  }

  const next = writeTodoNotes(markdown, input.items);
  if (created || next.changed) {
    await writeAtomically(notePath, next.markdown);
  }

  return {
    notePath,
    created,
    today,
    items: await readTodosAcrossNotes(await listDailyNotes(folderPath)),
  };
}

async function resolveStandupFolder(folderPath: string): Promise<string> {
  const resolved = path.resolve(folderPath);
  assertAllowedPath(resolved);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error("Select a folder, not a file.");
  }
  return resolved;
}

function notePathForDate(folderPath: string, date: string): string {
  const notePath = path.join(folderPath, standupNoteRelativePathForDate(path.basename(folderPath), date));
  assertAllowedPath(notePath);
  return notePath;
}

type DailyNote = { date: string; path: string };

/** Daily notes in the standup folder, newest first. Mirrors standupNoteRelativePathForDate. */
async function listDailyNotes(folderPath: string): Promise<DailyNote[]> {
  const directories = YEAR_FOLDER.test(path.basename(folderPath))
    ? [folderPath]
    : (await readdir(folderPath, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && YEAR_FOLDER.test(entry.name))
        .map((entry) => path.join(folderPath, entry.name));

  const listings = await Promise.all(
    directories.map(async (directory) =>
      (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && DAILY_NOTE_FILE.test(entry.name))
        .map((entry) => ({
          date: entry.name.slice(0, -".md".length),
          path: path.join(directory, entry.name),
        })),
    ),
  );
  return listings.flat().sort((left, right) => right.date.localeCompare(left.date));
}

async function readTodosAcrossNotes(notes: DailyNote[]): Promise<StandupTodo[]> {
  const perNote = await Promise.all(
    notes.map(async (note) => parseTodoNotes(await readFile(note.path, "utf8"), note.date)),
  );
  return perNote.flat();
}

async function readNoteTemplate(templatePath: string | null, now: Date): Promise<string> {
  const date = formatDate(now);
  const title = `Standup ${date}`;
  if (!templatePath) {
    return buildStandupNote(date);
  }
  const resolved = path.resolve(templatePath);
  assertAllowedPath(resolved);
  const source = await readFile(resolved, "utf8");
  return applyObsidianTemplate(source, now, title);
}

function templateDisplayName(templatePath: string | null): string | null {
  if (!templatePath) {
    return "Built-in standup";
  }
  return path.basename(templatePath, path.extname(templatePath));
}

function assertAllowedPath(target: string) {
  if (!path.isAbsolute(target)) {
    throw new Error("Folder path must be absolute.");
  }
  const normalized = path.normalize(target);
  if (normalized.split(path.sep).includes("Private")) {
    throw new Error("That folder is outside the standup notes path.");
  }
}

async function writeAtomically(notePath: string, markdown: string) {
  const tempPath = `${notePath}.${process.pid}.tmp`;
  await writeFile(tempPath, markdown, "utf8");
  await rename(tempPath, notePath);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
