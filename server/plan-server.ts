import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PLAN_MD } from "./plan-render";

// Paseo's in-app browser only opens http(s) URLs, so phase plans are served from here: one
// loopback-only server, one random token per phase, nothing else readable. The page reloads
// itself when architecture.md changes, so it follows the architecture session as it writes.

type Phase = { render(): string | null; epicDir: string };

const phases = new Map<string, Phase>();
const tokens = new Map<string, string>();
let server: Server | null = null;
let port: Promise<number> | null = null;

const RELOAD = `<script>
(() => {
  let seen = null;
  setInterval(async () => {
    try {
      const v = await (await fetch(location.pathname + "/version", { cache: "no-store" })).text();
      if (seen !== null && v !== seen) location.reload();
      seen = v;
    } catch {}
  }, 2000);
})();
</script>`;

const version = (epicDir: string) => {
  const file = join(epicDir, PLAN_MD);
  return existsSync(file) ? String(statSync(file).mtimeMs) : "";
};

function start() {
  port ??= new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const m = /^\/plan\/([a-f0-9]{48})(\/version)?$/.exec(req.url?.split("?")[0] ?? "");
      const phase = m ? phases.get(m[1]) : undefined;
      if (req.method !== "GET" || !phase) {
        res.writeHead(404).end();
        return;
      }
      if (m?.[2]) {
        res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end(version(phase.epicDir));
        return;
      }
      const file = phase.render();
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain" }).end("This phase has no architecture.md yet.");
        return;
      }
      const html = readFileSync(file, "utf8").replace("</body>", `${RELOAD}\n</body>`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
  });
  return port;
}

// The URL that shows this phase's plan; the same phase always gets the same URL.
export async function planUrl(key: string, phase: Phase) {
  let token = tokens.get(key);
  if (!token) {
    token = randomBytes(24).toString("hex");
    tokens.set(key, token);
  }
  phases.set(token, phase);
  return `http://127.0.0.1:${await start()}/plan/${token}`;
}

export function stopPlanServer() {
  server?.close();
  server = null;
  port = null;
}
