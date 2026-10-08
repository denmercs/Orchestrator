import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { isInsideProject, mainCheckoutPath, readAtlassianMcpEnv, readHostMcpServers } from "./host-mcp";

test("isInsideProject matches the project folder itself and a child folder", () => {
  assert.equal(isInsideProject("/code/lifeway", ["/code/lifeway"]), true);
  assert.equal(isInsideProject("/code/lifeway", ["/code/lifeway/packages/app"]), true);
});

test("isInsideProject rejects a sibling that only shares a name prefix", () => {
  assert.equal(isInsideProject("/code/lifeway", ["/code/lifeway-discipleship"]), false);
  assert.equal(isInsideProject("/code/lifeway", ["/code"]), false);
});

test("isInsideProject ignores a trailing slash on either side", () => {
  assert.equal(isInsideProject("/code/lifeway/", ["/code/lifeway"]), true);
  assert.equal(isInsideProject("/code/lifeway", ["/code/lifeway/"]), true);
});

test("isInsideProject matches when any of the given folders is inside", () => {
  assert.equal(isInsideProject("/code/lifeway", ["/elsewhere", "/code/lifeway/x"]), true);
  assert.equal(isInsideProject("/code/lifeway", []), false);
});

test("mainCheckoutPath maps a worktree folder to the same spot in the main checkout", () => {
  assert.equal(mainCheckoutPath("/wt/story", "/wt/story", "/code/lifeway/.git"), "/code/lifeway");
  assert.equal(
    mainCheckoutPath("/wt/story/packages/app", "/wt/story", "/code/lifeway/.git"),
    "/code/lifeway/packages/app",
  );
});

test("mainCheckoutPath returns null for a plain checkout", () => {
  assert.equal(mainCheckoutPath("/code/lifeway/sub", "/code/lifeway", "/code/lifeway/.git"), null);
});

test("mainCheckoutPath returns null when the common dir is bare or not named .git", () => {
  assert.equal(mainCheckoutPath("/wt/story", "/wt/story", "/code/lifeway.git"), null);
  assert.equal(mainCheckoutPath("/wt/story", "/wt/story", "/code/mirror"), null);
});

let root: string;
let home: string;
let projectA: string;
let projectB: string;
let elsewhere: string;
let repo: string;
let worktree: string;

async function writeJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}

// Points HOME and every other config root at the fixture, and the process cwd elsewhere, so this
// machine's own MCP config stays out of the results.
async function withFixtureHome<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ["HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "APPDATA", "PASEO_HOME"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const savedCwd = process.cwd();
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.PASEO_HOME = join(home, ".paseo");
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.APPDATA;
  process.chdir(elsewhere);
  try {
    return await fn();
  } finally {
    process.chdir(savedCwd);
    for (const key of keys) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

before(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "orchestrator-host-mcp-")));
  home = join(root, "home");
  projectA = join(root, "code", "lifeway");
  projectB = join(root, "code", "lifeway-discipleship");
  elsewhere = join(root, "elsewhere");
  await mkdir(join(projectA, "sub"), { recursive: true });
  await mkdir(projectB, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  // A repo whose main checkout is a project key, and a worktree of it outside that folder.
  repo = join(root, "code", "repo");
  worktree = join(root, "worktrees", "story");
  await mkdir(join(repo, "packages", "app"), { recursive: true });
  await writeFile(join(repo, "packages", "app", "index.ts"), "export {};\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  git("worktree", "add", "-q", "-b", "story", worktree);
  await writeJson(join(home, ".claude.json"), {
    mcpServers: { global: { command: "global-cmd", alwaysLoad: true } },
    projects: {
      [projectA]: { mcpServers: { alpha: { command: "alpha-cmd", alwaysLoad: true } } },
      [repo]: { mcpServers: { gamma: { command: "gamma-cmd" } } },
      [join(repo, "packages", "app")]: { mcpServers: { app: { command: "app-cmd" } } },
      // Same name as a ~/.mcp.json server: out of scope, it must not hide that one.
      [projectB]: {
        mcpServers: {
          beta: { url: "https://beta.example/mcp", alwaysLoad: true },
          "home-mcp": { command: "b-cmd" },
          "mcp-atlassian": {
            command: "uvx",
            env: { JIRA_URL: "jira.example.test", JIRA_USERNAME: "fake@example.test", JIRA_API_TOKEN: "fake-token" },
          },
        },
      },
    },
  });
  await writeJson(join(home, ".mcp.json"), { mcpServers: { "home-mcp": { command: "home-cmd" } } });
  await writeJson(join(home, ".cursor", "mcp.json"), { mcpServers: { "cursor-one": { command: "cursor-cmd" } } });
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const GLOBALS = ["cursor-one", "global", "home-mcp"];

test("readHostMcpServers inside a project adds that project's servers to the globals", async () => {
  const servers = await withFixtureHome(() => readHostMcpServers(join(projectA, "sub")));
  assert.deepEqual(Object.keys(servers).sort(), ["alpha", ...GLOBALS].sort());
});

test("readHostMcpServers outside every project gives only the globals", async () => {
  const servers = await withFixtureHome(() => readHostMcpServers(elsewhere));
  assert.deepEqual(Object.keys(servers).sort(), GLOBALS);
  const homeMcp = servers["home-mcp"];
  assert.equal(homeMcp?.type === "stdio" ? homeMcp.command : null, "home-cmd");
});

test("readHostMcpServers with no cwd gives only the globals", async () => {
  const servers = await withFixtureHome(() => readHostMcpServers());
  assert.deepEqual(Object.keys(servers).sort(), GLOBALS);
});

test("readHostMcpServers counts a worktree as inside the project it was created from", async () => {
  const atRoot = await withFixtureHome(() => readHostMcpServers(worktree));
  assert.deepEqual(Object.keys(atRoot).sort(), ["gamma", ...GLOBALS].sort());
  const inApp = await withFixtureHome(() => readHostMcpServers(join(worktree, "packages", "app")));
  assert.deepEqual(Object.keys(inApp).sort(), ["app", "gamma", ...GLOBALS].sort());
});

test("readAtlassianMcpEnv finds Jira credentials in a project scope from anywhere", async () => {
  const env = await withFixtureHome(() => readAtlassianMcpEnv());
  assert.deepEqual(env, {
    JIRA_URL: "https://jira.example.test",
    JIRA_USERNAME: "fake@example.test",
    JIRA_API_TOKEN: "fake-token",
  });
});

test("no attached server carries alwaysLoad, so tool loading stays deferred", async () => {
  for (const cwd of [join(projectA, "sub"), projectB, elsewhere]) {
    const servers = await withFixtureHome(() => readHostMcpServers(cwd));
    for (const [name, server] of Object.entries(servers)) {
      assert.equal("alwaysLoad" in server, false, `${name} carries alwaysLoad`);
    }
  }
});
