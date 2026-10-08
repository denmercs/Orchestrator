import assert from "node:assert/strict";
import { test } from "node:test";
import type { RegistryHit } from "../shared/pipeline";
import { installsLabel, rowState } from "./registry-search-model";

const hit = (over: Partial<RegistryHit> = {}): RegistryHit => ({
  source: "vercel-labs/agent-skills",
  skillId: "vercel-react-best-practices",
  name: "vercel-react-best-practices",
  installs: 1234,
  connected: false,
  ...over,
});

test("install counts read as short labels", () => {
  assert.equal(installsLabel(1), "1 install");
  assert.equal(installsLabel(999), "999 installs");
  assert.equal(installsLabel(1234), "1.2k installs");
  assert.equal(installsLabel(2000), "2k installs");
  assert.equal(installsLabel(1_500_000), "1.5M installs");
});

test("a row offers Connect, shows Connecting… for its repo, and Connected once the server says so", () => {
  assert.deepEqual(rowState(hit(), null), { label: "Connect", canConnect: true });
  assert.deepEqual(rowState(hit(), "vercel-labs/agent-skills"), { label: "Connecting…", canConnect: false });
  // One connect at a time: each one saves the whole sources list.
  assert.deepEqual(rowState(hit(), "other/repo"), { label: "Connect", canConnect: false });
  assert.deepEqual(rowState(hit({ connected: true }), null), { label: "Connected", canConnect: false });
});
