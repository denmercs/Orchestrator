import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RpcOutput } from "@getpaseo/plugin";
import {
  detectOrchestrationObsidian,
  listOrchestrationTemplates,
} from "../shared/orchestration";
import { suggestTemplatePath } from "./standup-note";

type VaultRecord = {
  path: string;
  open: boolean;
  ts: number;
};

export async function detectObsidian(): Promise<RpcOutput<typeof detectOrchestrationObsidian>> {
  const vaults = await readVaults();
  const preferred = pickVault(vaults);
  if (!preferred) {
    return {
      vaultPath: null,
      standupFolder: null,
      label: null,
    };
  }

  return {
    vaultPath: preferred.path,
    standupFolder: null,
    label: path.basename(preferred.path),
  };
}

export async function listTemplates(input: {
  folderPath: string | null;
}): Promise<RpcOutput<typeof listOrchestrationTemplates>> {
  const vaultPath =
    (input.folderPath ? await findVaultRoot(input.folderPath) : null) ??
    pickVault(await readVaults())?.path ??
    null;
  if (!vaultPath) {
    return { templates: [], suggestedPath: null };
  }

  const templatesFolder = await readTemplatesFolder(vaultPath);
  const templates = templatesFolder ? await readTemplateFiles(templatesFolder) : [];
  const daily = await readDailyNotes(vaultPath);
  const suggestedPath = input.folderPath
    ? suggestTemplatePath(input.folderPath, templates, daily.folder, daily.template)
    : suggestTemplatePath(vaultPath, templates, daily.folder, daily.template);

  return { templates, suggestedPath };
}

export function pickVault(vaults: VaultRecord[]): VaultRecord | null {
  if (vaults.length === 0) {
    return null;
  }
  const open = vaults.filter((vault) => vault.open);
  const pool = open.length > 0 ? open : vaults;
  return [...pool].sort((left, right) => right.ts - left.ts)[0] ?? null;
}

export function parseObsidianVaults(raw: unknown): VaultRecord[] {
  if (raw === null || typeof raw !== "object") {
    return [];
  }
  const vaults = (raw as { vaults?: unknown }).vaults;
  if (vaults === null || typeof vaults !== "object") {
    return [];
  }

  return Object.values(vaults)
    .map((value) => {
      if (value === null || typeof value !== "object") {
        return null;
      }
      const row = value as { path?: unknown; open?: unknown; ts?: unknown };
      if (typeof row.path !== "string" || row.path.length === 0) {
        return null;
      }
      return {
        path: row.path,
        open: row.open === true,
        ts: typeof row.ts === "number" ? row.ts : 0,
      };
    })
    .filter((vault): vault is VaultRecord => vault !== null);
}

async function readVaults(): Promise<VaultRecord[]> {
  for (const configPath of obsidianConfigPaths()) {
    try {
      const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
      const vaults = parseObsidianVaults(parsed);
      if (vaults.length > 0) {
        return vaults;
      }
    } catch {
      // Try the next known Obsidian config location.
    }
  }
  return [];
}

async function findVaultRoot(start: string): Promise<string | null> {
  let current = path.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    try {
      if ((await stat(path.join(current, ".obsidian"))).isDirectory()) {
        return current;
      }
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
  return null;
}

async function readTemplatesFolder(vaultPath: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(vaultPath, ".obsidian", "templates.json"), "utf8"),
    );
    const folder =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { folder?: unknown }).folder
        : null;
    const relative = typeof folder === "string" && folder.length > 0 ? folder : "_Templates";
    const absolute = path.join(vaultPath, relative);
    return (await stat(absolute)).isDirectory() ? absolute : null;
  } catch {
    const fallback = path.join(vaultPath, "_Templates");
    try {
      return (await stat(fallback)).isDirectory() ? fallback : null;
    } catch {
      return null;
    }
  }
}

async function readTemplateFiles(templatesFolder: string): Promise<{ name: string; path: string }[]> {
  const names = await readdir(templatesFolder, { withFileTypes: true });
  return names
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => ({
      name: entry.name.replace(/\.md$/i, ""),
      path: path.join(templatesFolder, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function readDailyNotes(
  vaultPath: string,
): Promise<{ folder: string | null; template: string | null }> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(vaultPath, ".obsidian", "daily-notes.json"), "utf8"),
    );
    if (parsed === null || typeof parsed !== "object") {
      return { folder: null, template: null };
    }
    const row = parsed as { folder?: unknown; template?: unknown };
    return {
      folder: typeof row.folder === "string" && row.folder.length > 0
        ? path.join(vaultPath, row.folder)
        : null,
      template: typeof row.template === "string" && row.template.length > 0
        ? path.join(vaultPath, row.template)
        : null,
    };
  } catch {
    return { folder: null, template: null };
  }
}

function obsidianConfigPaths(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "obsidian", "obsidian.json")];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? [path.join(appData, "obsidian", "obsidian.json")] : [];
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return [path.join(configHome, "obsidian", "obsidian.json")];
}
