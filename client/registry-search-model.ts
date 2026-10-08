import type { RegistryHit } from "../shared/pipeline";

// "1 install", "999 installs", "1.2k installs", "1.5M installs".
export function installsLabel(installs: number) {
  if (installs === 1) {
    return "1 install";
  }
  const short = (n: number, unit: string) => `${Number(n.toFixed(1))}${unit}`;
  const count =
    installs >= 1_000_000 ? short(installs / 1_000_000, "M") : installs >= 1_000 ? short(installs / 1_000, "k") : String(installs);
  return `${count} installs`;
}

// `connecting` is the location being connected right now from either card, if any. Only one
// connects at a time, since each connect saves the whole sources list. `connected` comes from the
// server.
export function rowState(hit: RegistryHit, connecting: string | null) {
  if (hit.connected) {
    return { label: "Connected", canConnect: false };
  }
  if (connecting === hit.source) {
    return { label: "Connecting…", canConnect: false };
  }
  return { label: "Connect", canConnect: connecting === null };
}
