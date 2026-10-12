import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, readdirSync, statSync } from "node:fs";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { spokenLine } from "../shared/voice-lines";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

export type SpeakPorts = {
  script: string;
  // Fire and forget: runs the script with `args`, `stdin` as its text. Never throws.
  run: (args: string[], stdin?: string) => void;
  scriptReady: () => Promise<boolean>;
};

// Paseo bundles the plugin as CJS, which has no module URL, so find the script by install path.
// Installs land in plugins/orchestrator/<install id>/checkout/; the old layout had scripts/ directly under plugins/orchestrator/.
export function findSpeakScript(home = process.env.PASEO_HOME ?? join(homedir(), ".paseo")): string {
  const root = join(home, "plugins", "orchestrator");
  const legacy = join(root, "scripts", "speak");
  const installs: { script: string; mtime: number }[] = [];
  try {
    for (const id of readdirSync(root)) {
      const script = join(root, id, "checkout", "scripts", "speak");
      try {
        accessSync(script, fsConstants.X_OK);
        installs.push({ script, mtime: statSync(script).mtimeMs });
      } catch {}
    }
  } catch {}
  installs.sort((a, b) => b.mtime - a.mtime);
  return installs[0]?.script ?? legacy;
}

export const SPEAK_SCRIPT = findSpeakScript();

export function realSpeakPorts(script = SPEAK_SCRIPT): SpeakPorts {
  return {
    script,
    run(args, stdin) {
      const child = spawn(script, args, { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "ignore"], detached: true });
      child.on("error", (error) => console.warn("orchestrator: speak failed", error));
      if (stdin !== undefined) child.stdin?.end(stdin);
      child.unref();
    },
    scriptReady: () => access(script, constants.X_OK).then(
      () => true,
      () => false,
    ),
  };
}

function lastReply(timeline: TurnEnded["timeline"]): string {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "assistant_message") return item.text;
  }
  return "";
}

// The sessions switched on to speak their replies. In memory only, so a daemon restart turns them all off.
export function createSpeakReplies(ports: SpeakPorts) {
  const on = new Set<string>();
  return {
    agentIds: () => [...on],
    async set(agentId: string, enabled: boolean) {
      if (!enabled) {
        on.delete(agentId);
        return;
      }
      if (!(await ports.scriptReady())) {
        throw new Error(`The speak script is missing or not executable: ${ports.script}`);
      }
      ports.run(["--warm"]);
      on.add(agentId);
    },
    onTurnEnded(event: TurnEnded) {
      if (!on.has(event.agent.id) || event.outcome.kind !== "completed") return;
      const line = spokenLine(lastReply(event.timeline));
      if (line) ports.run([], line);
    },
    // A new turn means the user sent something: stop talking over it.
    onTurnStarted(agentId: string) {
      if (on.has(agentId)) ports.run(["--hush"]);
    },
  };
}
