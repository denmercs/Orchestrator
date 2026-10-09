// loopAgents reuses S11's join: only this repo's loop agents, and only whitelisted fields leave the record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loopAgents } from "../s11/load.mjs";

const record = (id, repo) => ({
  id,
  cwd: "/w/x",
  createdAt: "2026-10-01T00:00:00Z",
  labels: { "loop-step": "review", "loop-repo": repo, "loop-initiative": "i", "loop-story": "S1", "loop-round": "2" },
  config: { model: "m", mcpServers: { x: { env: { SECRET: "hunter2-secret" } } } },
});

test("loopAgents keeps this repo's loop agents and copies only whitelisted fields", () => {
  const root = mkdtempSync(join(tmpdir(), "loop-agents-"));
  try {
    const agentsDir = join(root, "agents");
    mkdirSync(join(agentsDir, "p"), { recursive: true });
    writeFileSync(join(agentsDir, "p", "a.json"), JSON.stringify(record("a", "/repo/this")));
    writeFileSync(join(agentsDir, "p", "b.json"), JSON.stringify(record("b", "/repo/other")));
    const out = loopAgents({ agentsDir, projectsDir: join(root, "projects"), repo: "/repo/this", until: "2026-10-09T00:00:00Z" });
    assert.deepEqual(out.map((a) => a.id), ["a"]);
    assert.equal(out[0].round, 2);
    assert.equal(out[0].repo, "/repo/this");
    assert.equal(out[0].step, "review");
    const json = JSON.stringify(out);
    for (const s of ["env", "mcpServers", "hunter2-secret", "SECRET"]) assert.ok(!json.includes(s), s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
