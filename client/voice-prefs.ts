// Reads and writes the persisted voice.micOff setting: used once at launch (voice.start()) and by the drawer's mic
// toggle (voice.setMic()). No React: this runs from plain TypeScript, so it calls settingsRpc directly rather than
// the useSettings() hook.
import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { voiceSettings } from "../shared/settings";

const voiceSettingsRpc = settingsRpc(voiceSettings.id);

export function createVoicePrefs(rpc: PluginClientContext["rpc"]) {
  return {
    // `unreadable`: the stored value is invalid (corrupt), so the mic defaults to on. `transient`: the read itself failed
    // (rejected), which says nothing about the value, so the caller keeps its last one or waits and retries.
    async read(): Promise<{ micOff: boolean; unreadable: boolean; transient?: boolean }> {
      try {
        const result = await rpc(voiceSettingsRpc.read, {});
        if (result.status !== "ready") return { micOff: false, unreadable: true };
        return { micOff: voiceSettings.schema.parse(result.values).micOff, unreadable: false };
      } catch {
        return { micOff: false, unreadable: false, transient: true };
      }
    },
    /** Re-saves a value over a setting that can't be read: the last known one, or false when none was ever read. */
    async repair(lastKnown?: boolean): Promise<unknown> {
      return this.write(lastKnown ?? false);
    },
    async write(micOff: boolean): Promise<unknown> {
      const current = await rpc(voiceSettingsRpc.read, {});
      const values = current.status === "ready" ? voiceSettings.schema.parse(current.values) : voiceSettings.schema.parse({});
      return rpc(voiceSettingsRpc.write, { revision: current.revision, values: { ...values, micOff } });
    },
  };
}
