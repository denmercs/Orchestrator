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
  formatDate,
  parseTodoNotes,
  shippedLines,
  standupNoteRelativePath,
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
  const notePath = await resolveNotePath(input.folderPath);
  try {
    const markdown = await readFile(notePath, "utf8");
    return { notePath, exists: true, items: parseTodoNotes(markdown) };
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    return { notePath, exists: false, items: [] };
  }
}

export async function saveStandupTodos(input: {
  folderPath: string;
  templatePath: string | null;
  items: { kind: "todo" | "blocker" | "note"; text: string; done: boolean }[];
}): Promise<RpcOutput<typeof saveOrchestrationStandupTodos>> {
  const folderPath = path.resolve(input.folderPath);
  const notePath = await resolveNotePath(folderPath);
  await mkdir(path.dirname(notePath), { recursive: true });

  let created = false;
  let markdown: string;
  try {
    markdown = await readFile(notePath, "utf8");
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    markdown = await readNoteTemplate(input.templatePath, new Date());
    created = true;
  }

  const next = writeTodoNotes(markdown, input.items.map((item) => ({ ...item, id: "" })));
  if (created || next.changed) {
    await writeAtomically(notePath, next.markdown);
  }

  return {
    notePath,
    created,
    items: parseTodoNotes(next.markdown),
  };
}

async function resolveNotePath(folderPath: string): Promise<string> {
  const resolved = path.resolve(folderPath);
  assertAllowedPath(resolved);
  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw new Error("Select a folder, not a file.");
  }
  const notePath = path.join(resolved, standupNoteRelativePath(path.basename(resolved), new Date()));
  assertAllowedPath(notePath);
  return notePath;
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
