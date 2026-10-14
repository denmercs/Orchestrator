// Reads and writes the persisted voice.micOff setting: used once at launch (voice.start()) and by the drawer's mic
// toggle (voice.setMic()). No React: this runs from plain TypeScript, so it calls settingsRpc directly rather than
// the useSettings() hook.
import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { voiceSettings } from "../shared/settings";

const voiceSettingsRpc = settingsRpc(voiceSettings.id);

export function createVoicePrefs(rpc: PluginClientContext["rpc"]) {
  return {
    async read(): Promise<{ micOff: boolean }> {
      const result = await rpc(voiceSettingsRpc.read, {});
      if (result.status !== "ready") return { micOff: false };
      return voiceSettings.schema.parse(result.values);
    },
    async write(micOff: boolean): Promise<unknown> {
      const current = await rpc(voiceSettingsRpc.read, {});
      const values = current.status === "ready" ? voiceSettings.schema.parse(current.values) : voiceSettings.schema.parse({});
      return rpc(voiceSettingsRpc.write, { revision: current.revision, values: { ...values, micOff } });
    },
  };
}
