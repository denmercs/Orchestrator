import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { createHarnessEpicRpc, startTicketRpc } from "../shared/orchestration";
import { harnessSettings } from "../shared/settings";
import { detectLabel, routeStart, START_HINTS, type StartRoute } from "../shared/start-route";
import { repoForKey } from "./start-jira-session";

type Theme = PluginSurfaceProps["theme"];

// The start input at the top of the Initiatives tab (see CONTEXT.md, "Start input"). A bare Jira
// key or a URL holding one starts that ticket's one-story initiative in the repo its prefix maps
// to (else the harness repo); anything else starts a new initiative's architecture session in the
// harness repo. On success the input clears, the started agent opens and the boards re-read.
export function StartInput({
  theme,
  compact,
  navigation,
  onStarted,
}: {
  theme: Theme;
  compact: boolean;
  navigation: PluginSurfaceProps["navigation"];
  onStarted(): Promise<void>;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const paseo = usePaseo();
  const settings = useSettings(harnessSettings);
  const startTicket = useRpc(startTicketRpc);
  const createEpic = useRpc(createHarnessEpicRpc);
  const toast = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const route = routeStart(text);
  const label = route ? detectLabel(route) : null;
  const harnessRepo = settings.status === "ready" ? settings.values.repo : "";
  const disabled = busy || !route;

  async function start() {
    if (!route || busy) return;
    setBusy(true);
    try {
      const agentId = await run(route);
      if (agentId === undefined) return;
      setText("");
      if (agentId && navigation) navigation.openAgent({ agentId });
      await onStarted();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not start.");
    } finally {
      setBusy(false);
    }
  }

  // The started agent's id (null when none started), or undefined when nothing was started.
  async function run(next: StartRoute): Promise<string | null | undefined> {
    if (next.kind === "jira") {
      const repo = repoForKey(await paseo.projects.list(), next.key, harnessRepo);
      if (!repo) {
        toast.error(`No repo for ${next.key.split("-")[0]}: add it in Paseo or pick a harness repo`);
        return undefined;
      }
      const result = await startTicket({ repo, key: next.key });
      if (!result.ok) {
        toast.error(result.error ?? `Could not start ${next.key}.`);
        return undefined;
      }
      const track = result.track === "diagnose" ? "Diagnose" : "Plan";
      toast.show(`Started ${next.key} (${track}).`, { variant: "success" });
      return result.agentId;
    }
    if (!harnessRepo) {
      toast.error("Pick a harness repo for the initiative.");
      return undefined;
    }
    const result = await createEpic({
      repo: harnessRepo,
      initiative: "",
      initiativeTitle: next.title,
      epicTitle: next.title,
      tracker: "local",
    });
    if (!result.ok) {
      toast.error(result.error ?? "Could not create the initiative.");
      return undefined;
    }
    if (result.warning) {
      toast.error(`Created ${result.epic}, but the architecture session didn't start: ${result.warning}`);
    } else {
      toast.show(`Created ${result.epic}. Architecture session started.`, { variant: "success" });
    }
    return result.agentId;
  }

  return (
    <View style={styles.card}>
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Start a Jira ticket or a new initiative"
          placeholder="Paste a Jira key or URL, or describe a new initiative"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => void start()}
          editable={!busy}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        {label ? (
          <View style={[styles.pill, { borderColor: theme.colors[label.color] }]}>
            <Text style={[styles.pillText, { color: theme.colors[label.color] }]} numberOfLines={1}>
              {label.text}
            </Text>
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Start"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={() => void start()}
          style={[styles.button, disabled ? styles.disabled : null]}
        >
          <Text style={styles.buttonText}>{busy ? "Starting…" : "Start"}</Text>
        </Pressable>
      </View>
      <View style={styles.hints}>
        {START_HINTS.map((hint) => (
          <View key={hint.text} style={styles.hint}>
            <View style={[styles.dot, { backgroundColor: theme.colors[hint.color] }]} />
            <Text style={styles.hintText}>{hint.text}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    card: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      backgroundColor: c.surface1,
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: compact ? 12 : 16,
      marginBottom: 12,
    },
    row: {
      flexDirection: compact ? ("column" as const) : ("row" as const),
      alignItems: compact ? ("stretch" as const) : ("center" as const),
      gap: compact ? 8 : 10,
    },
    input: {
      flex: compact ? undefined : 1,
      minWidth: 0,
      height: 32,
      paddingHorizontal: 10,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
      backgroundColor: c.surface0,
      color: c.foreground,
      fontSize: 13,
    },
    pill: {
      alignSelf: compact ? ("flex-start" as const) : ("center" as const),
      paddingVertical: 2,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderRadius: 999,
    },
    pillText: { fontSize: 11.5, fontWeight: "600" as const },
    button: {
      height: 32,
      paddingHorizontal: 14,
      borderRadius: 6,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      backgroundColor: c.accent,
    },
    buttonText: { fontSize: 12.5, fontWeight: "600" as const, color: c.surface0 },
    disabled: { opacity: 0.5 },
    hints: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 14 },
    hint: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    dot: { width: 7, height: 7, borderRadius: 3.5 },
    hintText: { fontSize: 11.5, color: c.foregroundMuted },
  };
}
