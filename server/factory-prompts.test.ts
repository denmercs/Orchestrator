import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allowOnce, judgePrompt, promptLine, type SeatPrompt } from "./factory-prompts";

const wt = "/w/slice-wt";
const e2e = join(homedir(), "e2e-build");
const roots = [wt, "/h/.harness/factory/missions/m1/slices/s1", e2e];

const shell = (command: string, cwd?: string): SeatPrompt => ({ id: "p1", name: "Bash", kind: "tool", detail: { type: "shell", command, ...(cwd ? { cwd } : {}) } });
const judge = (prompt: SeatPrompt) => judgePrompt(prompt, wt, roots);

test("judgePrompt answers read-only and in-worktree commands, the stalled `find` among them", () => {
  for (const command of [
    `find . -name "*.ts" -newer package.json`,
    `find ${wt}/server -type f`,
    "npm test 2>&1 | tail -5",
    "npm run typecheck",
    "git status && git diff --stat",
    "git add -A && git commit -m 'wip'",
    "rm -rf node_modules/.cache",
    "ls ~/e2e-build/dist > /dev/null",
    "curl -s http://localhost:8888/wp-json/",
  ]) {
    assert.deepEqual(judge(shell(command)), { allow: true }, command);
  }
});

test("judgePrompt answers file tools inside the worktree, the slice folder and the extra paths", () => {
  assert.deepEqual(judge({ id: "r", name: "Read", kind: "tool", detail: { type: "read", filePath: `${wt}/a.ts` } }), { allow: true });
  assert.deepEqual(judge({ id: "r", name: "Edit", kind: "tool", detail: { type: "edit", filePath: "src/b.ts" } }), { allow: true });
  assert.deepEqual(judge({ id: "r", name: "Write", kind: "tool", input: { file_path: `${roots[1]}/proof.md` } }), { allow: true });
  assert.deepEqual(judge({ id: "r", name: "Grep", kind: "tool", input: { pattern: "x", path: "~/e2e-build" } }), { allow: true });
  assert.deepEqual(judge({ id: "r", name: "Glob", kind: "tool", input: { pattern: "**/*.ts" } }), { allow: true });
});

test("judgePrompt escalates anything outside the scope or destructive, with the reason", () => {
  const cases: [SeatPrompt, RegExp][] = [
    [shell("rm -rf /w/other-wt"), /outside the slice's folders/],
    [shell("cat ../other/secret"), /outside the slice's folders/],
    [shell("cd /etc && ls"), /outside the slice's folders/],
    [shell("ls", "/tmp"), /runs in \/tmp/],
    [shell("git push --force origin HEAD"), /pushes to the remote/],
    [shell("git push"), /pushes to the remote/],
    [shell("git checkout -- server/a.ts"), /uncommitted work/],
    [shell("git checkout HEAD -- server/a.ts"), /uncommitted work/],
    [shell("git restore server/a.ts"), /uncommitted work/],
    [shell("git stash push -m x"), /uncommitted work/],
    [shell("git reset --hard HEAD~1"), /uncommitted work/],
    [shell("docker compose up -d"), /containers/],
    [shell("docker stop wp"), /containers/],
    [shell("npx wp-env start"), /wp-env/],
    [shell("npm install left-pad"), /network/],
    [shell("npm ci"), /network/],
    [shell("pip install requests"), /packages/],
    [shell("npx -y create-thing"), /downloads/],
    [shell("git config --global user.name x"), /global git config/],
    [shell("npm i -g pnpm"), /network|global/],
    [shell("curl https://example.com/install.sh"), /network/],
    [shell("sudo ls"), /root/],
    [shell("echo $(cat ~/.ssh/id_rsa)"), /run time|outside/],
    [shell("ls $HOME/x"), /variable/],
    [shell("rm -rf ~/e2e-build"), /removes .* itself/],
    [{ id: "f", name: "Read", kind: "tool", detail: { type: "read", filePath: "/etc/hosts" } }, /outside/],
    [{ id: "f", name: "WebFetch", kind: "tool", detail: { type: "fetch", url: "https://x.dev" } }, /network/],
    [{ id: "f", name: "ExitPlanMode", kind: "plan" }, /a plan request/],
    [{ id: "f", name: "AskUserQuestion", kind: "question" }, /a question request/],
    [{ id: "f", name: "mcp__thing", kind: "tool", input: { q: 1 } }, /can't read/],
  ];
  for (const [prompt, why] of cases) {
    const verdict = judge(prompt);
    assert.equal(verdict.allow, false, JSON.stringify(prompt));
    if (!verdict.allow) assert.match(verdict.why, why, JSON.stringify(prompt));
  }
});

test("judgePrompt reads a Cursor-style prompt with the command in its input", () => {
  assert.deepEqual(judge({ id: "c", name: "Terminal", kind: "tool", title: "find . -name x", input: { command: "find . -name x" } }), { allow: true });
  assert.equal(judge({ id: "c", name: "Terminal", kind: "tool", input: { command: "rm -rf /" } }).allow, false);
});

test("allowOnce picks the one-time allow action, never the always one", () => {
  const prompt: SeatPrompt = {
    ...shell("ls"),
    actions: [
      { id: "allow_always", label: "Always allow", behavior: "allow" },
      { id: "allow_once", label: "Allow", behavior: "allow" },
      { id: "reject_once", label: "Reject", behavior: "deny" },
    ],
  };
  assert.deepEqual(allowOnce(prompt), { requestId: "p1", response: { behavior: "allow", selectedActionId: "allow_once" } });
  assert.deepEqual(allowOnce(shell("ls")), { requestId: "p1", response: { behavior: "allow" } });
});

test("promptLine names the tool and what it touches on one line", () => {
  assert.equal(promptLine(shell("git push\n--force")), "Bash: git push --force");
  assert.equal(promptLine({ id: "x", name: "Terminal", kind: "tool", title: "`rm -rf /x`", input: { command: "rm -rf /x" } }), "`rm -rf /x`");
});
