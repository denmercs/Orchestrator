import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { sultiStripRead, sultiStripSend } from "../shared/sulti-strip";
import { SULTI_STRIP_POLL_MS } from "../shared/timing";
import { canSend, statusLine } from "./sulti-strip-model";

export type SultiStripReading = { sultiId: string | null; reply: string | null; error: string | null };

export function useSultiStrip() {
  const read = useRpc(sultiStripRead);
  const send = useRpc(sultiStripSend);
  const toast = useToast();
  const [reading, setReading] = useState<SultiStripReading>({ sultiId: null, reply: null, error: null });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const mounted = useRef(true);
  const sendEnabled = canSend(text, busy);

  const refresh = useCallback(async () => {
    try {
      const next = await read({});
      if (mounted.current) setReading(next);
    } catch (cause) {
      if (mounted.current) {
        setReading((prev) => ({
          ...prev,
          error: cause instanceof Error ? cause.message : "Could not read Sulti.",
        }));
      }
    }
  }, [read]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), SULTI_STRIP_POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const submit = useCallback(async () => {
    if (!canSend(text, busy)) return;
    setBusy(true);
    try {
      const result = await send({ text });
      if (!mounted.current) return;
      setText("");
      setStatus(statusLine(result));
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not send to Sulti.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [text, busy, send, refresh, toast]);

  return { reading, text, setText, busy, status, sendEnabled, refresh, submit };
}