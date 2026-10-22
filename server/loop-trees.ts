import { mkdir, readFile, rename as fsRename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { defaultTree, parseTree, type LoopTree } from "../shared/loop-tree";
import type { PipelineConfig } from "../shared/pipeline";

// The per-repo loop trees: one JSON file, `{ [absoluteRepoPath]: tree }`, under the plugin's own folder so a
// `paseo plugin update` doesn't wipe it. A repo with no saved tree gets the default computed from its config.
export const LOOP_TREES_FILE = path.join(homedir(), ".orchestrator", "loop-trees.json");

type Options = {
  // Where the trees live. Tests point this at a temp folder.
  file?: string;
  // The pipeline config for a repo (host settings with the repo's own file applied), for its default tree.
  config: (repo: string) => Promise<PipelineConfig>;
  // Tests swap this to fail the final step of a write.
  rename?: (from: string, to: string) => Promise<void>;
};

type Saved = { ok: boolean; error: string | null };

const writeFailed = (error: unknown) => ({
  ok: false,
  error: `Could not write the loop trees: ${error instanceof Error ? error.message : String(error)}`,
});

// One key per repo however the caller wrote the path (trailing slash, ./).
const keyOf = (repo: string) => path.resolve(repo);

const notAbsolute = (repo: string) => `Repo path must be absolute: "${repo}".`;

export function createLoopTrees({ file = LOOP_TREES_FILE, config, rename = fsRename }: Options) {
  // Writes are read-modify-write, so they take turns: two saves at once can't lose each other's update.
  let queue: Promise<unknown> = Promise.resolve();
  let writes = 0;
  function serially<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  }

  // The whole file, or why it can't be used. A missing file is an empty one; a broken one is reported and
  // never rewritten, so the user can fix or delete it by hand.
  async function readAll(): Promise<{ all: Record<string, unknown>; error: string | null }> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return { all: { ...parsed }, error: null };
      return { all: {}, error: `${file} is not a JSON object of repo trees. Fix or delete it.` };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { all: {}, error: null };
      const reason = error instanceof Error ? error.message : String(error);
      return { all: {}, error: `${file} can't be read (${reason}). Fix or delete it.` };
    }
  }

  // Temp file, then rename: a crash or a failed rename never leaves half a file, and the temp file is cleaned up.
  async function writeAtomically(all: Record<string, unknown>) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${writes++}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(all, null, 2), "utf8");
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async function get(given: string) {
    const repo = keyOf(given);
    if (!path.isAbsolute(given)) return { tree: defaultTree(await config(repo)), saved: false, error: notAbsolute(given) };
    const { all, error } = await readAll();
    const fallback = async (message: string | null) => ({ tree: defaultTree(await config(repo)), saved: false, error: message });
    if (error) return fallback(error);
    if (!(repo in all)) return fallback(null);
    const { tree, errors } = parseTree(all[repo]);
    if (!tree) return fallback(`The saved tree for "${repo}" is invalid: ${errors.join(" ")}`);
    return { tree, saved: true, error: null };
  }

  async function save(given: string, input: unknown): Promise<Saved> {
    if (!path.isAbsolute(given)) return { ok: false, error: notAbsolute(given) };
    const repo = keyOf(given);
    const { tree, errors } = parseTree(input);
    if (!tree) return { ok: false, error: errors.join(" ") };
    return serially(async () => {
      const { all, error } = await readAll();
      if (error) return { ok: false, error };
      all[repo] = tree satisfies LoopTree;
      return writeAtomically(all).then(() => ({ ok: true, error: null }), writeFailed);
    });
  }

  async function reset(given: string): Promise<Saved> {
    if (!path.isAbsolute(given)) return { ok: false, error: notAbsolute(given) };
    const repo = keyOf(given);
    return serially(async () => {
      const { all, error } = await readAll();
      if (error) return { ok: false, error };
      if (!(repo in all)) return { ok: true, error: null };
      delete all[repo];
      return writeAtomically(all).then(() => ({ ok: true, error: null }), writeFailed);
    });
  }

  async function exportTree(repo: string) {
    const { tree, error } = await get(repo);
    return { text: JSON.stringify(tree, null, 2), error };
  }

  async function importTree(repo: string, text: string): Promise<Saved> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return { ok: false, error: `The tree is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
    return save(repo, parsed);
  }

  async function copyTree(from: string, to: string): Promise<Saved> {
    const source = await get(from);
    if (source.error) return { ok: false, error: source.error };
    return save(to, source.tree);
  }

  return { get, save, reset, exportTree, importTree, copyTree };
}
