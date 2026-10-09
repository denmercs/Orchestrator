import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { type Observation, type ReviewComment, reviewObservations, storyObservations } from "../shared/corrections";
import { dirsIn, initiativesDir, PHASES_DIR, readStoryFiles } from "./harness-layout";

// The I/O behind corrections: story files on disk plus `gh` for merged PRs and their review comments.

const execFileAsync = promisify(execFile);

export type Gh = (args: string[]) => Promise<string>;
export type GitDate = (file: string) => Promise<string | null>;
export type SourceOptions = { gh?: Gh; gitDate?: GitDate };

type MergedPr = { number: number; headRefName: string; mergedAt: string; url: string };

export const defaultGh = (root: string): Gh => async (args) =>
  (await execFileAsync("gh", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout;

const defaultGitDate = (root: string): GitDate => async (file) => {
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%cI", "--", relative(root, file)], { cwd: root });
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

const json = async <T>(gh: Gh, args: string[], fallback: T): Promise<T> => {
  try {
    return JSON.parse(await gh(args)) as T;
  } catch {
    return fallback;
  }
};

// Story folders: every phase folder, and the initiative folder itself for the flat layout.
function storyFolders(root: string): string[] {
  const folders: string[] = [];
  const base = initiativesDir(root);
  for (const slug of dirsIn(base)) {
    const initDir = join(base, slug);
    folders.push(initDir);
    for (const phase of dirsIn(join(initDir, PHASES_DIR))) folders.push(join(initDir, PHASES_DIR, phase));
  }
  return folders;
}

// Observations from the stories' `## Outcome` and, when gh works, from merged PRs' review comments.
export async function collectObservations(root: string, options: SourceOptions = {}): Promise<Observation[]> {
  const gh = options.gh ?? defaultGh(root);
  const gitDate = options.gitDate ?? defaultGitDate(root);
  const prs = await json<MergedPr[]>(
    gh,
    ["pr", "list", "--state", "merged", "--json", "number,headRefName,mergedAt,url", "--limit", "200"],
    [],
  );
  const byNumber = new Map(prs.map((pr) => [pr.number, pr]));
  const byBranch = new Map(prs.map((pr) => [pr.headRefName, pr]));

  const found: Observation[] = [];
  const storiesByBranch: Record<string, string> = {};
  for (const folder of storyFolders(root)) {
    for (const story of readStoryFiles(folder)) {
      if (story.meta.branch) storiesByBranch[story.meta.branch] = story.id;
      const pr = byNumber.get(Number(story.meta.pr)) ?? byBranch.get(story.meta.branch ?? "");
      const date = pr?.mergedAt || (await gitDate(story.path)) || statSync(story.path).mtime.toISOString();
      found.push(...storyObservations(readFileSync(story.path, "utf8"), { story: story.id, date, link: pr?.url || story.id }));
    }
  }

  const commentsByPr: Record<number, ReviewComment[]> = {};
  for (const pr of prs) {
    const [inline, view] = await Promise.all([
      json<ReviewComment[]>(gh, ["api", `repos/{owner}/{repo}/pulls/${pr.number}/comments`], []),
      json<{ reviews?: ReviewComment[] }>(gh, ["pr", "view", String(pr.number), "--json", "reviews"], {}),
    ]);
    commentsByPr[pr.number] = [...inline, ...(view.reviews ?? [])];
  }
  return [...found, ...reviewObservations(prs, commentsByPr, storiesByBranch)];
}
