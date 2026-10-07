import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import {
  DEFAULT_PHASES,
  MACHINE_SOURCE,
  THEN_CHOICES,
  addSkillSource,
  beltSettings,
  checkSkillSource,
  getSkillCatalog,
  phasePrompt,
  phaseSkills,
  removeSkillSource,
  type BeltConfig,
  type CatalogSkill,
  type Phase,
  type PhaseId,
  type SkillRef,
  type SkillSource,
  type SourceStatus,
  type Then,
} from "../shared/belt";

type Theme = PluginSurfaceProps["theme"];
type Styles = ReturnType<typeof createStyles>;
type SourceKind = SkillSource["kind"];
type UpdateCheck = {
  head: string | null;
  commits: Array<{ sha: string; subject: string }>;
  changedSkills: string[];
  error: string | null;
};

const THEN_LABEL: Record<Then, string> = {
  you: "✋ wait for you",
  auto: "⟳ auto",
  pass: "✓ on PASS",
  merge: "⏵ on merge",
};
const KIND_LABEL: Record<SourceKind, string> = {
  team: "Team",
  personal: "Personal",
  imported: "Imported",
};
const PREVIEW_TICKET = { key: "KEY-123", title: "Example story", url: null };

function sameRef(a: SkillRef, b: SkillRef) {
  return a.name === b.name && a.source === b.source;
}

function shortSha(sha: string | null) {
  return sha ? sha.slice(0, 7) : null;
}

function useBelt(open: boolean) {
  const settings = useSettings(beltSettings);
  const loadCatalog = useRpc(getSkillCatalog);
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [statuses, setStatuses] = useState<SourceStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const values: BeltConfig | null = settings.status === "ready" ? settings.values : null;
  const sourcesKey = JSON.stringify(values?.sources ?? []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await loadCatalog({});
      setCatalog(result.skills);
      setStatuses(result.sources);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load skills.");
    } finally {
      setLoading(false);
    }
  }, [loadCatalog]);

  useEffect(() => {
    if (open) {
      void reload();
    }
    // Sources changing (connect, toggle, update) changes the catalog.
  }, [open, reload, sourcesKey]);

  async function save(patch: Partial<BeltConfig>) {
    if (settings.status !== "ready") {
      return false;
    }
    setError(null);
    const saved = await settings.save({ ...settings.values, ...patch }, settings.revision);
    if (!saved) {
      setError(settings.saveError ?? "Could not save the belt settings.");
    }
    return saved;
  }

  return { values, catalog, statuses, loading, error, setError, reload, save };
}
type Belt = ReturnType<typeof useBelt>;

export function SkillsButton({
  theme,
  beltOn,
  onPress,
}: {
  theme: Theme;
  beltOn: boolean;
  onPress(): void;
}) {
  const styles = useMemo(() => createStyles(theme, false), [theme]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open skills and phases, Story belt ${beltOn ? "on" : "off"}`}
      onPress={onPress}
      style={styles.trigger}
    >
      <Text style={styles.triggerText}>Skills</Text>
      <Text style={styles.triggerCount}>belt {beltOn ? "on" : "off"}</Text>
    </Pressable>
  );
}

export function SkillsDrawer({
  theme,
  compact,
  open,
  onClose,
}: {
  theme: Theme;
  compact: boolean;
  open: boolean;
  onClose(): void;
}) {
  const styles = useMemo(() => createStyles(theme, compact), [theme, compact]);
  const belt = useBelt(open);
  const [tab, setTab] = useState<"phases" | "sources">("phases");

  if (!open) {
    return null;
  }
  const values = belt.values;
  const enabled = values?.enabled ?? false;

  return (
    <View style={styles.overlay}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close skills"
        onPress={onClose}
        style={styles.backdrop}
      />
      <View style={styles.drawer} accessibilityViewIsModal>
        <View style={styles.header}>
          <Text style={styles.title}>Skills</Text>
          <View style={styles.headerActions}>
            <Pressable
              accessibilityRole="switch"
              accessibilityState={{ checked: enabled }}
              accessibilityLabel="Use the Story belt when starting stories"
              disabled={!values}
              onPress={() => void belt.save({ enabled: !enabled })}
              style={[styles.headerButton, enabled ? styles.chipActive : null]}
            >
              <Text style={enabled ? styles.chipTextActive : styles.headerButtonText}>
                Belt {enabled ? "on" : "off"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={belt.loading}
              onPress={() => void belt.reload()}
              style={styles.headerButton}
            >
              <Text style={styles.headerButtonText}>{belt.loading ? "Loading…" : "Reload"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>Close</Text>
            </Pressable>
          </View>
        </View>
        <Text style={styles.hint}>
          {enabled
            ? "Start on a story card runs Plan in a fresh agent. Each phase starts the next when it writes <phase>-done under ## Status in .harness/state.md."
            : "Belt off: Start keeps the single-agent session. Changes here are still saved."}
        </Text>
        {belt.error ? <Text style={[styles.hint, styles.danger]}>{belt.error}</Text> : null}
        <View style={styles.tabs}>
          <Chip label="Phases · Story belt" active={tab === "phases"} styles={styles} onPress={() => setTab("phases")} />
          <Chip label="Sources" active={tab === "sources"} styles={styles} onPress={() => setTab("sources")} />
        </View>
        <ScrollView style={styles.flex1} contentContainerStyle={styles.bodyContent}>
          {!values ? (
            <Text style={styles.muted}>Loading settings…</Text>
          ) : tab === "phases" ? (
            <PhasesTab belt={belt} values={values} styles={styles} />
          ) : (
            <SourcesTab belt={belt} values={values} styles={styles} />
          )}
        </ScrollView>
      </View>
    </View>
  );
}

// ---------- Phases ----------

function PhasesTab({ belt, values, styles }: { belt: Belt; values: BeltConfig; styles: Styles }) {
  function updatePhase(id: PhaseId, change: (phase: Phase) => Phase) {
    void belt.save({ phases: values.phases.map((phase) => (phase.id === id ? change(phase) : phase)) });
  }
  return (
    <>
      {values.phases.map((phase, index) => (
        <PhaseCard
          key={phase.id}
          index={index}
          phase={phase}
          belt={belt}
          values={values}
          styles={styles}
          onChange={(change) => updatePhase(phase.id, change)}
        />
      ))}
      <Pressable accessibilityRole="button" onPress={() => void belt.save({ phases: DEFAULT_PHASES })}>
        <Text style={styles.link}>Reset phases to defaults</Text>
      </Pressable>
    </>
  );
}

function PhaseCard({
  phase,
  index,
  belt,
  values,
  styles,
  onChange,
}: {
  phase: Phase;
  index: number;
  belt: Belt;
  values: BeltConfig;
  styles: Styles;
  onChange(change: (phase: Phase) => Phase): void;
}) {
  const [picking, setPicking] = useState<"runs" | "extra" | null>(null);
  const [preview, setPreview] = useState(false);
  const skills = phaseSkills(phase);
  const known = (ref: SkillRef) => belt.loading || belt.catalog.some((s) => sameRef(s, ref));

  return (
    <View style={styles.card}>
      <View style={styles.rowWrap}>
        <Text style={styles.cardTitle}>
          {index + 1} {phase.label}
        </Text>
        <Text style={[styles.muted, styles.pushRight]}>then {THEN_LABEL[phase.then]}</Text>
      </View>

      <View style={styles.rowWrap}>
        <Text style={styles.label}>Runs</Text>
        <Chip
          label={`${phase.runs.name} · ${sourceLabel(values, phase.runs.source)} ▾`}
          active
          styles={styles}
          onPress={() => setPicking(picking === "runs" ? null : "runs")}
        />
        {!known(phase.runs) ? <Text style={styles.warn}>not found</Text> : null}
        {phase.id === "implement" && values.implementMode === "loop" ? (
          <Text style={styles.muted}>loop mode runs ss-loop</Text>
        ) : null}
      </View>
      {picking === "runs" ? (
        <SkillPicker
          belt={belt}
          values={values}
          styles={styles}
          current={phase.runs}
          onPick={(ref) => {
            onChange((p) => ({ ...p, runs: ref, extras: p.extras.filter((e) => !sameRef(e, ref)) }));
            setPicking(null);
          }}
          onCancel={() => setPicking(null)}
        />
      ) : null}

      <View style={styles.gap6}>
        <Text style={styles.label}>Also loads</Text>
        <View style={styles.chipRow}>
          {skills.extras.map((extra) => (
            <Chip
              key={`${extra.source}:${extra.name}`}
              label={`${extra.required ? "required · " : ""}${extra.name} · ${sourceLabel(values, extra.source)}${known(extra) ? "" : " · not found"}${extra.required ? "" : "  ×"}`}
              styles={styles}
              onPress={
                extra.required
                  ? undefined
                  : () => onChange((p) => ({ ...p, extras: p.extras.filter((e) => !sameRef(e, extra)) }))
              }
            />
          ))}
          <Chip label="+ add skill" styles={styles} onPress={() => setPicking(picking === "extra" ? null : "extra")} />
        </View>
        {picking === "extra" ? (
          <SkillPicker
            belt={belt}
            values={values}
            styles={styles}
            onPick={(ref) => {
              onChange((p) =>
                sameRef(p.runs, ref) || p.extras.some((e) => sameRef(e, ref))
                  ? p
                  : { ...p, extras: [...p.extras, ref] },
              );
              setPicking(null);
            }}
            onCancel={() => setPicking(null)}
          />
        ) : null}
      </View>

      <PhaseSettings phase={phase} belt={belt} values={values} styles={styles} />

      {THEN_CHOICES[phase.id].length > 1 ? (
        <View style={styles.gap6}>
          <Text style={styles.label}>Then</Text>
          <View style={styles.chipRow}>
            {THEN_CHOICES[phase.id].map((then) => (
              <Chip
                key={then}
                label={THEN_LABEL[then]}
                active={phase.then === then}
                styles={styles}
                onPress={() => onChange((p) => ({ ...p, then }))}
              />
            ))}
          </View>
        </View>
      ) : null}

      <Pressable accessibilityRole="button" onPress={() => setPreview((v) => !v)}>
        <Text style={styles.link}>{preview ? "Hide prompt" : "Preview prompt"}</Text>
      </Pressable>
      {preview ? <Text style={styles.code}>{phasePrompt(values, phase, PREVIEW_TICKET)}</Text> : null}
    </View>
  );
}

function PhaseSettings({
  phase,
  belt,
  values,
  styles,
}: {
  phase: Phase;
  belt: Belt;
  values: BeltConfig;
  styles: Styles;
}) {
  if (phase.id === "implement") {
    return (
      <View style={styles.rowWrap}>
        <Text style={styles.muted}>Mode</Text>
        <Chip label="step-by-step" active={values.implementMode === "step"} styles={styles} onPress={() => void belt.save({ implementMode: "step" })} />
        <Chip label="loop (AFK)" active={values.implementMode === "loop"} styles={styles} onPress={() => void belt.save({ implementMode: "loop" })} />
        {values.implementMode === "loop" ? (
          <Stepper label="max cycles" value={values.loopMax} styles={styles} onChange={(v) => void belt.save({ loopMax: v })} />
        ) : null}
      </View>
    );
  }
  if (phase.id === "review") {
    return (
      <View style={styles.rowWrap}>
        <Text style={styles.muted}>Findings → fresh Implement agent</Text>
        <Stepper label="max rounds" value={values.reviewRounds} styles={styles} onChange={(v) => void belt.save({ reviewRounds: v })} />
      </View>
    );
  }
  if (phase.id === "done") {
    return (
      <View style={styles.rowWrap}>
        <Text style={styles.muted}>After merge</Text>
        <Chip
          label={values.closeOnMerge ? "✓ run ss-close-story" : "leave Jira alone"}
          active={values.closeOnMerge}
          styles={styles}
          onPress={() => void belt.save({ closeOnMerge: !values.closeOnMerge })}
        />
      </View>
    );
  }
  return null;
}

function SkillPicker({
  belt,
  values,
  styles,
  current,
  onPick,
  onCancel,
}: {
  belt: Belt;
  values: BeltConfig;
  styles: Styles;
  current?: SkillRef;
  onPick(ref: SkillRef): void;
  onCancel(): void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const list = belt.catalog.filter((skill) => skill.name.toLowerCase().includes(needle)).slice(0, 60);
  return (
    <View style={styles.picker}>
      <TextInput
        accessibilityLabel="Search skills"
        placeholder="Search skills"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      {list.map((skill) => (
        <Pressable
          key={`${skill.source}:${skill.name}`}
          accessibilityRole="button"
          onPress={() => onPick({ name: skill.name, source: skill.source })}
          style={styles.pickerRow}
        >
          <Text style={styles.body}>
            {current && sameRef(current, skill) ? "● " : "○ "}
            {skill.name}
          </Text>
          <Text style={styles.muted}>
            {sourceLabel(values, skill.source)}
            {skill.kind === "command" ? " · command" : ""}
          </Text>
        </Pressable>
      ))}
      {list.length === 0 ? <Text style={styles.muted}>No skills match. Connect a repo under Sources?</Text> : null}
      <Pressable accessibilityRole="button" onPress={onCancel}>
        <Text style={styles.link}>Cancel</Text>
      </Pressable>
    </View>
  );
}

// ---------- Sources ----------

function SourcesTab({ belt, values, styles }: { belt: Belt; values: BeltConfig; styles: Styles }) {
  const machineCount = belt.catalog.filter((s) => s.source === MACHINE_SOURCE).length;

  function updateSource(id: string, change: (source: SkillSource) => SkillSource) {
    return belt.save({ sources: values.sources.map((s) => (s.id === id ? change(s) : s)) });
  }

  return (
    <>
      <View style={styles.card}>
        <View style={styles.rowWrap}>
          <Text style={styles.cardTitle}>This machine</Text>
          <Text style={[styles.muted, styles.pushRight]}>always on</Text>
        </View>
        <Text style={styles.muted}>
          ~/.claude/skills · ~/.agents/skills · ~/.claude/commands · {machineCount} skills · already global, nothing is copied
        </Text>
      </View>
      {values.sources.map((source) => (
        <SourceCard
          key={source.id}
          source={source}
          status={belt.statuses.find((s) => s.id === source.id)}
          values={values}
          belt={belt}
          styles={styles}
          onChange={(change) => updateSource(source.id, change)}
        />
      ))}
      <ConnectSource belt={belt} values={values} styles={styles} />
    </>
  );
}

function SourceCard({
  source,
  status,
  values,
  belt,
  styles,
  onChange,
}: {
  source: SkillSource;
  status: SourceStatus | undefined;
  values: BeltConfig;
  belt: Belt;
  styles: Styles;
  onChange(change: (source: SkillSource) => SkillSource): Promise<boolean>;
}) {
  const check = useRpc(checkSkillSource);
  const remove = useRpc(removeSkillSource);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const usedBy = values.phases
    .filter((p) => [p.runs, ...p.extras].some((ref) => ref.source === source.id))
    .map((p) => p.label);

  async function runCheck() {
    setChecking(true);
    try {
      const result = await check({ id: source.id });
      setUpdate({ head: result.head, commits: result.commits, changedSkills: result.changedSkills, error: result.error });
    } catch (cause) {
      setUpdate({ head: null, commits: [], changedSkills: [], error: cause instanceof Error ? cause.message : "Check failed." });
    } finally {
      setChecking(false);
    }
  }

  async function removeSource() {
    const saved = await belt.save({ sources: values.sources.filter((s) => s.id !== source.id) });
    if (saved) {
      await remove({ id: source.id }).catch(() => undefined);
    }
  }

  return (
    <View style={styles.card}>
      <View style={styles.rowWrap}>
        <Text style={styles.cardTitle}>{source.label}</Text>
        <Text style={styles.muted}>{KIND_LABEL[source.kind]}</Text>
        <View style={styles.pushRight}>
          <Chip
            label={source.enabled ? "On" : "Off"}
            active={source.enabled}
            styles={styles}
            onPress={() => void onChange((s) => ({ ...s, enabled: !s.enabled }))}
          />
        </View>
      </View>
      <Text style={styles.muted}>
        {source.location} · {source.pin ? `pinned ${shortSha(source.pin)}` : "live folder"}
        {status ? (status.ok ? ` · ${status.skillCount} skills` : "") : ""}
        {usedBy.length > 0 ? ` · used by ${usedBy.join(", ")}` : ""}
      </Text>
      {status && !status.ok ? <Text style={[styles.muted, styles.danger]}>{status.error}</Text> : null}

      <View style={styles.chipRow}>
        {(["team", "personal", "imported"] as const).map((kind) => (
          <Chip
            key={kind}
            label={KIND_LABEL[kind]}
            active={source.kind === kind}
            styles={styles}
            onPress={() => void onChange((s) => ({ ...s, kind }))}
          />
        ))}
      </View>

      <View style={styles.rowWrap}>
        {source.pin ? (
          <Chip label={checking ? "Checking…" : "Check for updates"} styles={styles} onPress={checking ? undefined : () => void runCheck()} />
        ) : null}
        {confirmRemove ? (
          <>
            <Text style={styles.warn}>
              Remove {source.label}?{usedBy.length > 0 ? ` ${usedBy.join(", ")} will show "not found".` : ""}
            </Text>
            <Chip label="Remove" styles={styles} onPress={() => void removeSource()} />
            <Chip label="Keep" styles={styles} onPress={() => setConfirmRemove(false)} />
          </>
        ) : (
          <Chip label="Remove" styles={styles} onPress={() => setConfirmRemove(true)} />
        )}
      </View>

      {update ? (
        <View style={styles.picker}>
          {update.error ? (
            <Text style={[styles.muted, styles.danger]}>{update.error}</Text>
          ) : update.commits.length === 0 ? (
            <Text style={styles.muted}>Up to date.</Text>
          ) : (
            <>
              <Text style={styles.body}>
                {update.commits.length} new commit{update.commits.length === 1 ? "" : "s"}
                {update.changedSkills.length > 0 ? ` · changes ${update.changedSkills.join(", ")}` : ""}
              </Text>
              {update.commits.slice(0, 10).map((commit) => (
                <Text key={commit.sha} style={styles.muted}>
                  {shortSha(commit.sha)} {commit.subject}
                </Text>
              ))}
              <Text style={styles.muted}>
                Skills are instructions agents follow, often with auto-accept. Read the changes before updating.
              </Text>
              <Chip
                label={`Update to ${shortSha(update.head)}`}
                styles={styles}
                onPress={() => {
                  const head = update.head;
                  void onChange((s) => ({ ...s, pin: head })).then((saved) => {
                    if (saved) {
                      setUpdate(null);
                    }
                  });
                }}
              />
            </>
          )}
        </View>
      ) : null}
    </View>
  );
}

function ConnectSource({ belt, values, styles }: { belt: Belt; values: BeltConfig; styles: Styles }) {
  const add = useRpc(addSkillSource);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<SourceKind>("personal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const location = draft.trim();
    if (!location || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await add({ location });
      if (!result.ok) {
        setError(result.error ?? "Could not connect that source.");
        return;
      }
      const next: SkillSource = {
        id: result.id,
        label: result.label,
        location: result.location,
        kind,
        enabled: true,
        pin: result.pin,
      };
      const saved = await belt.save({
        sources: [...values.sources.filter((s) => s.id !== next.id), next],
      });
      if (saved) {
        setDraft("");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect that source.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Connect a skill repo</Text>
      <Text style={styles.muted}>
        owner/repo, a git URL, or an absolute folder path. Git repos are cloned and pinned to the current
        commit; folders are read live.
      </Text>
      <View style={styles.chipRow}>
        {(["team", "personal", "imported"] as const).map((k) => (
          <Chip key={k} label={KIND_LABEL[k]} active={kind === k} styles={styles} onPress={() => setKind(k)} />
        ))}
      </View>
      <View style={styles.rowWrap}>
        <TextInput
          accessibilityLabel="Skill repo to connect"
          placeholder="owner/repo or /path/to/folder"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => void connect()}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.flex1]}
        />
        <Chip label={busy ? "Connecting…" : "Connect"} styles={styles} onPress={busy ? undefined : () => void connect()} />
      </View>
      {error ? <Text style={[styles.muted, styles.danger]}>{error}</Text> : null}
    </View>
  );
}

// ---------- small bits ----------

function sourceLabel(values: BeltConfig, id: string) {
  if (id === MACHINE_SOURCE) {
    return "This machine";
  }
  return values.sources.find((s) => s.id === id)?.label ?? `${id} (removed)`;
}

function Chip({
  label,
  active,
  styles,
  onPress,
}: {
  label: string;
  active?: boolean;
  styles: Styles;
  onPress?(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!onPress}
      onPress={onPress}
      style={[styles.chip, active ? styles.chipActive : null]}
    >
      <Text style={[styles.chipText, active ? styles.chipTextActive : null]}>{label}</Text>
    </Pressable>
  );
}

function Stepper({
  label,
  value,
  styles,
  onChange,
}: {
  label: string;
  value: number;
  styles: Styles;
  onChange(value: number): void;
}) {
  return (
    <View style={styles.rowWrap}>
      <Chip label="−" styles={styles} onPress={() => onChange(Math.max(1, value - 1))} />
      <Text style={styles.body}>
        {value} {label}
      </Text>
      <Chip label="+" styles={styles} onPress={() => onChange(Math.min(20, value + 1))} />
    </View>
  );
}

function createStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  const pad = compact ? 16 : 20;
  return {
    trigger: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      backgroundColor: c.surface1,
    },
    triggerText: { color: c.foreground, fontWeight: "600" as const },
    triggerCount: { color: c.foregroundMuted, fontSize: 12 },
    overlay: {
      position: "absolute" as const,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
    },
    backdrop: {
      position: "absolute" as const,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: "rgba(0, 0, 0, 0.32)",
    },
    drawer: {
      width: compact ? ("100%" as const) : 600,
      maxWidth: "100%" as const,
      height: "100%" as const,
      backgroundColor: c.surface0,
      borderLeftWidth: compact ? 0 : 1,
      borderLeftColor: c.border,
      paddingTop: compact ? 16 : 20,
      gap: 8,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      gap: 10,
      paddingHorizontal: pad,
    },
    title: { color: c.foreground, fontSize: 18, fontWeight: "600" as const },
    headerActions: { flexDirection: "row" as const, gap: 8, marginLeft: "auto" as const },
    headerButton: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    headerButtonText: { color: c.foregroundMuted, fontSize: 13 },
    hint: { color: c.foregroundMuted, fontSize: 12, paddingHorizontal: pad },
    danger: { color: c.statusDanger },
    tabs: { flexDirection: "row" as const, gap: 8, paddingHorizontal: pad },
    flex1: { flex: 1 },
    bodyContent: { padding: pad, gap: 12, paddingBottom: 40 },
    card: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 12,
      backgroundColor: c.surface1,
      padding: 14,
      gap: 10,
    },
    cardTitle: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
    label: {
      color: c.foregroundMuted,
      fontSize: 11,
      fontWeight: "700" as const,
      letterSpacing: 0.5,
      textTransform: "uppercase" as const,
    },
    body: { color: c.foreground, fontSize: 13 },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    warn: { color: c.foregroundMuted, fontSize: 12, fontStyle: "italic" as const },
    link: { color: c.accent, fontSize: 13 },
    rowWrap: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      flexWrap: "wrap" as const,
      gap: 8,
    },
    pushRight: { marginLeft: "auto" as const },
    gap6: { gap: 6 },
    chipRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
    chip: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 4,
      backgroundColor: c.surface0,
    },
    chipActive: { backgroundColor: c.surface2, borderColor: c.foregroundMuted },
    chipText: { color: c.foreground, fontSize: 12 },
    chipTextActive: { color: c.foreground, fontSize: 12, fontWeight: "600" as const },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      color: c.foreground,
      backgroundColor: c.surface0,
    },
    picker: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 10,
      padding: 10,
      gap: 6,
      backgroundColor: c.surface2,
    },
    pickerRow: {
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      paddingVertical: 4,
    },
    code: {
      fontFamily: "monospace",
      fontSize: 12,
      color: c.foreground,
      backgroundColor: c.surface2,
      borderRadius: 8,
      padding: 10,
    },
  };
}
