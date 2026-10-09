import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendOutcome } from "../shared/story-outcome";
import { collectObservations } from "./correction-sources";

const outcome = (id: string, branch: string, extra: string, finding: string) =>
  [{ kind: "review-failed" as const, round: 1, findings: [finding] }].reduce(
    appendOutcome,
    `---\nid: ${id}\ntitle: T\nstatus: merged\nbranch: ${branch}\n${extra}---\n\n## Goal\n\nDo it.\n`,
  );

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "corr-src-"));
  const init = join(root, ".harness", "initiatives", "mem");
  const phaseStories = join(init, "phases", "1-first", "stories");
  const flatStories = join(init, "stories");
  mkdirSync(phaseStories, { recursive: true });
  mkdirSync(flatStories, { recursive: true });
  writeFileSync(join(phaseStories, "S1.md"), outcome("S1", "dm/s1", "pr: 7\n", "a.ts:1 — bad — fix"));
  writeFileSync(join(flatStories, "S2.md"), outcome("S2", "dm/s2", "", "b.ts:2 — worse — fix"));
  const s3 = join(flatStories, "S3.md");
  writeFileSync(s3, outcome("S3", "dm/s3", "", "c.ts:3 — worst — fix"));
  utimesSync(s3, new Date("2026-01-02T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
  return { root, s2: join(flatStories, "S2.md") };
}

const prs = [
  { number: 7, headRefName: "dm/s1", mergedAt: "2026-03-01T10:00:00Z", url: "https://gh.test/pull/7" },
  { number: 8, headRefName: "dm/s2", mergedAt: "2026-03-05T10:00:00Z", url: "https://gh.test/pull/8" },
];

const gh = async (args: string[]) => {
  const line = args.join(" ");
  if (line.startsWith("pr list")) return JSON.stringify(prs);
  if (line.startsWith("pr view 7")) return JSON.stringify({ reviews: [{ body: "Please rename", submittedAt: "2026-02-20T00:00:00Z", url: "https://gh.test/r/1" }, { body: "" }] });
  if (line.startsWith("pr view")) return JSON.stringify({ reviews: [] });
  if (line.startsWith("api") && line.includes("pulls/7/comments"))
    return JSON.stringify([{ body: "Handle null", created_at: "2026-02-21T00:00:00Z", html_url: "https://gh.test/c/1", path: "a.ts", line: 4 }]);
  if (line.startsWith("api")) return "[]";
  throw new Error(`unexpected gh ${line}`);
};

test("collectObservations dates stories from the merged PR, then git, then mtime, and adds review comments", async () => {
  const { root, s2 } = fixture();
  try {
    const obs = await collectObservations(root, {
      gh,
      // S2 has a PR by branch (8), so git is only asked for the one without a PR
      gitDate: async (file) => (file.endsWith("S3.md") ? null : file === s2 ? "never" : null),
    });
    const finding = (story: string) => obs.find((o) => o.source === "finding" && o.story === story);
    assert.deepEqual([finding("S1")?.date, finding("S1")?.link], ["2026-03-01T10:00:00Z", "https://gh.test/pull/7"]);
    assert.deepEqual([finding("S2")?.date, finding("S2")?.link], ["2026-03-05T10:00:00Z", "https://gh.test/pull/8"]);
    assert.equal(finding("S3")?.date, "2026-01-02T00:00:00.000Z");
    assert.equal(finding("S3")?.link, "S3");
    const reviews = obs.filter((o) => o.source === "review-comment");
    assert.deepEqual(reviews.map((o) => [o.story, o.date, o.link, o.text]).sort(), [
      ["S1", "2026-02-20T00:00:00Z", "https://gh.test/r/1", "Please rename"],
      ["S1", "2026-02-21T00:00:00Z", "https://gh.test/c/1", "a.ts:4 — Handle null"],
    ]);

    const viaGit = await collectObservations(root, { gh, gitDate: async (file) => (file.endsWith("S3.md") ? "2026-02-02T00:00:00Z" : null) });
    assert.equal(viaGit.find((o) => o.story === "S3")?.date, "2026-02-02T00:00:00Z");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectObservations survives a failing gh: story observations stay, review comments are skipped", async () => {
  const { root } = fixture();
  try {
    const obs = await collectObservations(root, {
      gh: async () => {
        throw new Error("gh: command not found");
      },
      gitDate: async () => "2026-02-02T00:00:00Z",
    });
    assert.deepEqual(obs.map((o) => o.source), ["finding", "finding", "finding"]);
    assert.ok(obs.every((o) => o.date === "2026-02-02T00:00:00Z"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
