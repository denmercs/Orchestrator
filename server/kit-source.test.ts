import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { kitDir } from "./kit-source";

function withPaseoHome(run: (home: string) => void) {
  const saved = process.env.PASEO_HOME;
  const home = mkdtempSync(join(tmpdir(), "kit-home-"));
  process.env.PASEO_HOME = home;
  try {
    run(home);
  } finally {
    if (saved === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = saved;
  }
}

test("kitDir finds the skills folder in Paseo's git install checkout, the newest install first", () => {
  withPaseoHome((home) => {
    const old = join(home, "plugins", "orchestrator", "old-id", "checkout", "skills");
    const fresh = join(home, "plugins", "orchestrator", "new-id", "checkout", "skills");
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    utimesSync(old, new Date(1000), new Date(1000));
    assert.equal(kitDir(), fresh);
  });
});

test("kitDir prefers the folder Paseo's config.json records for the plugin, so a local-folder install is found", () => {
  withPaseoHome((home) => {
    const local = join(home, "dev", "Orchestrator");
    mkdirSync(join(local, "skills"), { recursive: true });
    mkdirSync(join(home, "plugins", "orchestrator", "old-id", "checkout", "skills"), { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify({ plugins: { orchestrator: { path: local } } }));
    assert.equal(kitDir(), join(local, "skills"));
  });
});

test("kitDir throws when no install has a skills folder, so the catalog leaves the kit out", () => {
  withPaseoHome((home) => {
    mkdirSync(join(home, "plugins", "orchestrator", "id", "checkout"), { recursive: true });
    assert.throws(() => kitDir(), /Kit skills folder missing/);
  });
});
