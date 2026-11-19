import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkMotion, MOTION_PROMPT, renderMotion, type Motion } from "../shared/motion-brief";
import { diffForAgent, parseDiff, trimDiff, type CutFile } from "../shared/motion-diff";
import { type Ask, claudeCli, runClaudeWith } from "./claude-cli";
import { diffSince, resolveCommit } from "./debrief-git";
import { insideWorktree } from "./debrief-render";

// motionBrief (see CONTEXT.md, "Motion brief"): a paste-ready video script about the architectural
// decisions in `git diff base...head`, written outside the repo as motion.json and motion.md. The
// writer sees the trimmed diff and nothing else. Like renderDebrief it throws only for a caller error;
// everything else is a problem line.

export type MotionBriefInput = { worktree: string; base: string; head: string; outDir: string };
export type MotionResult = {
  file: string | null; // motion.md, when one was written
  text: string | null;
  cut: CutFile[];
  problems: string[];
  motion: Motion | null; // the scenes that passed the check
};

const WRITER_MODEL = "claude-sonnet-5-5";
const WRITER_TIMEOUT_MS = 300_000;

// The writer: one Sonnet completion through the Claude Code CLI, no tools, run from the temp dir.
export const sonnetWriter = (): Ask =>
  claudeCli(runClaudeWith({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000", MAX_THINKING_TOKENS: "0" }, WRITER_TIMEOUT_MS), WRITER_MODEL);

// The JSON object in a reply, with or without a code fence around it.
function parseReply(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

export async function motionBrief({ worktree, base, head, outDir }: MotionBriefInput, write: Ask = sonnetWriter()): Promise<MotionResult> {
  if (await insideWorktree(worktree, outDir)) throw new Error(`outDir ${outDir} is inside the worktree ${worktree}`);
  const headSha = await resolveCommit(worktree, head);
  if (!headSha) throw new Error(`head ${head} is not a commit in ${worktree}`);

  const none = (problem: string, cut: CutFile[] = []): MotionResult => ({ file: null, text: null, cut, problems: [problem], motion: null });
  const diff = await diffSince(worktree, base, headSha);
  if (diff === undefined) return none(`base: ${base} has no common history with head`);
  const files = parseDiff(diff);
  if (!files.length) return none("diff: no changes between the base and head");
  const trimmed = trimDiff(files);

  let reply: string;
  try {
    reply = (await write(MOTION_PROMPT, diffForAgent(trimmed, files))).text;
  } catch (error) {
    return none(`writer: ${error instanceof Error ? error.message : String(error)}`, trimmed.cut);
  }
  const raw = parseReply(reply);
  if (raw === undefined) return none("motion.json: the writer's reply is not valid JSON", trimmed.cut);

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "motion.json"), JSON.stringify(raw, null, 2) + "\n");
  const { motion, problems } = checkMotion(raw, files);
  const file = join(outDir, "motion.md");
  if (!motion) {
    await rm(file, { force: true });
    return { file: null, text: null, cut: trimmed.cut, problems, motion: null };
  }
  const text = renderMotion(motion);
  await writeFile(file, text);
  return { file, text, cut: trimmed.cut, problems, motion };
}
