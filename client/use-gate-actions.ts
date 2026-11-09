import { useState } from "react";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { gateAct, type Gate, type GateRowAction } from "../shared/gates";

export const gateKey = (gate: Gate) => `${gate.board}\n${gate.storyId}`;

// Runs a gate's row actions (d6). One action runs at a time per row; the row's buttons stay disabled until
// the boards have re-read after it, so an acted-on gate can't be sent twice before it leaves the queue.
export function useGateActions({
  navigation,
  onActed,
}: {
  navigation: PluginSurfaceProps["navigation"];
  onActed(): Promise<void>;
}) {
  const act = useRpc(gateAct);
  const toast = useToast();
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());

  function setRowBusy(key: string, on: boolean) {
    setBusy((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function run(gate: Gate, action: GateRowAction) {
    if (action.kind === "open-pr") {
      if (action.url) void openExternalUrl(action.url);
      else toast.error("No PR to open");
      return;
    }
    const key = gateKey(gate);
    if (busy.has(key)) return;
    setRowBusy(key, true);
    try {
      const result = await act({ board: gate.board, storyId: gate.storyId, action: action.kind });
      if (!result.ok) {
        toast.error(result.error ?? "Could not act on the gate.");
        return;
      }
      if (action.kind === "changes") {
        if (result.agentId && navigation) navigation.openAgent({ agentId: result.agentId });
        else toast.show("No session to open");
      }
      await onActed();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not act on the gate.");
    } finally {
      setRowBusy(key, false);
    }
  }

  return { run, isBusy: (gate: Gate) => busy.has(gateKey(gate)) };
}
