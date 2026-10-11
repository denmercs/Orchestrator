import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, TextInput } from "@getpaseo/plugin/client/react-native";
import {
  DEFAULT_PHASES,
  MACHINE_SOURCE,
  THEN_CHOICES,
  addSkillSource,
  pipelineSettings,
  checkSkillSource,
  findRef,
  getSkillCatalog,
  matchesRef,
  phasePrompt,
  phaseSkills,
  removeSkillSource,
  searchSkillRegistry,
  type PipelineConfig,
  type CatalogSkill,
  type Phase,
  type PhaseId,
  type RegistryHit,
  type SkillRef,
  type SkillSource,
  type SourceStatus,
  type Then,
} from "../shared/pipeline";
import { LoadingState } from "./loading-state";
import { installsLabel, rowState } from "./registry-search-model";
import { SkeletonRows } from "./skeleton";

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

function usePipeline(open: boolean) {
  const settings = useSettings(pipelineSettings);
  const loadCatalog = useRpc(getSkillCatalog);
  const [catalog, setCatalog] = useState<CatalogSkill[]>([]);
  const [statuses, setStatuses] = useState<SourceStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const values: PipelineConfig | null = settings.status === "ready" ? settings.values : null;
  const settingsError = settings.status === "error" || settings.status === "invalid" ? settings.error : null;
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

  async function save(patch: Partial<PipelineConfig>) {
    if (settings.status !== "ready") {
      return false;
    }
    setError(null);
    const saved = await settings.save({ ...settings.values, ...patch }, settings.revision);
    if (!saved) {
      setError(settings.saveError ?? "Could not save the pipeline settings.");
    }
    return saved;
  }

  return { values, settingsError, catalog, statuses, loading, error, setError, reload, save };
}
type Pipeline = ReturnType<typeof usePipeline>;

// Header trigger for the Skills drawer. The four dots stand for the belt's phases; all green for now.
export function StoryPipelineButton({
  theme,
  pipelineOn,
  open,
  onPress,
}: {
  theme: Theme;
  pipelineOn: boolean;
  open: boolean;
  onPress(): void;
}) {
  const styles = useMemo(() => createStyles(theme, false), [theme]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`Story pipeline, belt ${pipelineOn ? "on" : "off"}`}
      onPress={onPress}
      style={[styles.pipeButton, open ? styles.pipeButtonOn : null]}
    >
      <View style={styles.pipeDots}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i} style={styles.pipeDot} />
        ))}
      </View>
      <Text style={styles.pipeButtonText}>Story pipeline</Text>
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
  const pipeline = usePipeline(open);
  const [tab, setTab] = useState<"phases" | "sources">("phases");

  if (!open) {
    return null;
  }
  const values = pipeline.values;
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
              accessibilityLabel="Use the Story pipeline when starting stories"
              disabled={!values}
              onPress={() => void pipeline.save({ enabled: !enabled })}
              style={[styles.headerButton, enabled ? styles.chipActive : null]}
            >
              <Text style={enabled ? styles.chipTextActive : styles.headerButtonText}>
                Pipeline {enabled ? "on" : "off"}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={pipeline.loading}
              onPress={() => void pipeline.reload()}
              style={styles.headerButton}
            >
              <Text style={styles.headerButtonText}>{pipeline.loading ? "Loading…" : "Reload"}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.headerButton}>
              <Text style={styles.headerButtonText}>Close</Text>
            </Pressable>
          </View>
        </View>
        <Text style={styles.hint}>
          {enabled
            ? "Start on a story card runs Plan in a fresh agent. Each phase starts the next when it writes <phase>-done under ## Status in .harness/state.md."
            : "Pipeline off: Start keeps the single-agent session. Changes here are still saved."}
        </Text>
        {pipeline.error ? <Text style={[styles.hint, styles.danger]}>{pipeline.error}</Text> : null}
        <View style={styles.tabs}>
          <Chip label="Phases · Story pipeline" active={tab === "phases"} styles={styles} onPress={() => setTab("phases")} />
          <Chip label="Sources" active={tab === "sources"} styles={styles} onPress={() => setTab("sources")} />
        </View>
        <ScrollView style={styles.flex1} contentContainerStyle={styles.bodyContent}>
          {!values ? (
            pipeline.settingsError ? (
              <Text style={[styles.muted, styles.danger]}>{pipeline.settingsError}</Text>
            ) : (
              <LoadingState theme={theme} compact={compact}>
                <SkeletonRows theme={theme} rows={5} />
              </LoadingState>
            )
          ) : tab === "phases" ? (
            <PhasesTab pipeline={pipeline} values={values} styles={styles} />
          ) : (
            <SourcesTab pipeline={pipeline} values={values} styles={styles} />
          )}
        </ScrollView>
      </View>
    </View>
  );
}

// ---------- Phases ----------

function PhasesTab({ pipeline, values, styles }: { pipeline: Pipeline; values: PipelineConfig; styles: Styles }) {
  function updatePhase(id: PhaseId, change: (phase: Phase) => Phase) {
    void pipeline.save({ phases: values.phases.map((phase) => (phase.id === id ? change(phase) : phase)) });
  }
  return (
    <>
      {values.phases.map((phase, index) => (
        <PhaseCard
          key={phase.id}
          index={index}
          phase={phase}
          pipeline={pipeline}
          values={values}
          styles={styles}
          onChange={(change) => updatePhase(phase.id, change)}
        />
      ))}
      <Pressable accessibilityRole="button" onPress={() => void pipeline.save({ phases: DEFAULT_PHASES })}>
        <Text style={styles.link}>Reset phases to defaults</Text>
      </Pressable>
    </>
  );
}

function PhaseCard({
  phase,
  index,
  pipeline,
  values,
  styles,
  onChange,
}: {
  phase: Phase;
  index: number;
  pipeline: Pipeline;
  values: PipelineConfig;
  styles: Styles;
  onChange(change: (phase: Phase) => Phase): void;
}) {
  const [picking, setPicking] = useState<"runs" | "extra" | null>(null);
  const [preview, setPreview] = useState(false);
  const skills = phaseSkills(phase);
  const known = (ref: SkillRef) => pipeline.loading || pipeline.catalog.some((s) => matchesRef(s, ref));

  return (
    <View style={styles.card}>
      <View style={styles.rowWrap}>
        <Text style={styles.cardTitle}>
          {index + 1} {phase.label}
        </Text>
        <Text style={[styles.muted, styles.pushRight]}>then {THEN_LABEL[phase.then]}</Text>
      </View>

      {phase.id === "done" ? null : (
        <>
          <View style={styles.rowWrap}>
            <Text style={styles.label}>Runs</Text>
            <Text style={styles.muted}>Story pipeline only</Text>
            <Chip
              label={phase.runs ? `${phase.runs.name} · ${sourceLabel(values, phase.runs.source)} ▾` : "built-in step ▾"}
              active
              styles={styles}
              onPress={() => setPicking(picking === "runs" ? null : "runs")}
            />
            {phase.runs && !known(phase.runs) ? <Text style={styles.warn}>not found</Text> : null}
            {phase.runs ? (
              <Pressable accessibilityRole="button" onPress={() => onChange((p) => ({ ...p, runs: null }))}>
                <Text style={styles.link}>use built-in</Text>
              </Pressable>
            ) : null}
          </View>
          {picking === "runs" ? (
            <SkillPicker
              pipeline={pipeline}
              values={values}
              styles={styles}
              current={phase.runs ?? undefined}
              onPick={(ref) => {
                onChange((p) => ({ ...p, runs: ref, extras: p.extras.filter((e) => !sameRef(e, ref)) }));
                setPicking(null);
              }}
              onCancel={() => setPicking(null)}
            />
          ) : null}

          <View style={styles.gap6}>
            <View style={styles.rowWrap}>
              <Text style={styles.label}>Also loads</Text>
              <Text style={styles.muted}>Story pipeline and initiative loop</Text>
            </View>
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
                pipeline={pipeline}
                values={values}
                styles={styles}
                onPick={(ref) => {
                  onChange((p) =>
                    (p.runs !== null && sameRef(p.runs, ref)) || p.extras.some((e) => sameRef(e, ref))
                      ? p
                      : { ...p, extras: [...p.extras, ref] },
                  );
                  setPicking(null);
                }}
                onCancel={() => setPicking(null)}
              />
            ) : null}
          </View>
        </>
      )}

      <PhaseSettings phase={phase} pipeline={pipeline} values={values} styles={styles} />

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
      {preview ? <Text style={styles.code}>{phasePrompt(phase, PREVIEW_TICKET)}</Text> : null}
    </View>
  );
}

function PhaseSettings({
  phase,
  pipeline,
  values,
  styles,
}: {
  phase: Phase;
  pipeline: Pipeline;
  values: PipelineConfig;
  styles: Styles;
}) {
  if (phase.id === "implement") {
    return (
      <View style={styles.rowWrap}>
        <Text style={styles.muted}>One fresh agent per cycle in ## Cycles; the plugin commits each one</Text>
      </View>
    );
  }
  if (phase.id === "review") {
    return (
      <View style={styles.rowWrap}>
        <Text style={styles.muted}>Findings → fresh Implement agent</Text>
        <Stepper label="max rounds" value={values.reviewRounds} styles={styles} onChange={(v) => void pipeline.save({ reviewRounds: v })} />
      </View>
    );
  }
  if (phase.id === "done") {
    return (
      <View style={styles.rowWrap}>
        <Text style={styles.muted}>Red CI → fresh Fix CI agent</Text>
        <Stepper label="max fixes" value={values.maxFixes} styles={styles} onChange={(v) => void pipeline.save({ maxFixes: v })} />
        <Text style={styles.muted}>After merge</Text>
        <Chip
          label={values.closeOnMerge ? "✓ close the Jira story" : "leave Jira alone"}
          active={values.closeOnMerge}
          styles={styles}
          onPress={() => void pipeline.save({ closeOnMerge: !values.closeOnMerge })}
        />
      </View>
    );
  }
  return null;
}

function SkillPicker({
  pipeline,
  values,
  styles,
  current,
  onPick,
  onCancel,
}: {
  pipeline: Pipeline;
  values: PipelineConfig;
  styles: Styles;
  current?: SkillRef;
  onPick(ref: SkillRef): void;
  onCancel(): void;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const list = pipeline.catalog.filter((skill) => skill.name.toLowerCase().includes(needle)).slice(0, 60);
  const selected = current ? findRef(pipeline.catalog, current) : undefined;
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
            {skill === selected ? "● " : "○ "}
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

function SourcesTab({ pipeline, values, styles }: { pipeline: Pipeline; values: PipelineConfig; styles: Styles }) {
  const machineCount = pipeline.catalog.filter((s) => s.source === MACHINE_SOURCE).length;
  const connector = useConnectSource(pipeline, values);

  function updateSource(id: string, change: (source: SkillSource) => SkillSource) {
    return pipeline.save({ sources: values.sources.map((s) => (s.id === id ? change(s) : s)) });
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
          status={pipeline.statuses.find((s) => s.id === source.id)}
          values={values}
          pipeline={pipeline}
          styles={styles}
          onChange={(change) => updateSource(source.id, change)}
        />
      ))}
      <RegistrySearch connector={connector} sources={values.sources} styles={styles} />
      <ConnectSource connector={connector} styles={styles} />
    </>
  );
}

function SourceCard({
  source,
  status,
  values,
  pipeline,
  styles,
  onChange,
}: {
  source: SkillSource;
  status: SourceStatus | undefined;
  values: PipelineConfig;
  pipeline: Pipeline;
  styles: Styles;
  onChange(change: (source: SkillSource) => SkillSource): Promise<boolean>;
}) {
  const check = useRpc(checkSkillSource);
  const remove = useRpc(removeSkillSource);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const usedBy = values.phases
    .filter((p) => [p.runs, ...p.extras].some((ref) => ref?.source === source.id))
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
    const saved = await pipeline.save({ sources: values.sources.filter((s) => s.id !== source.id) });
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

// Which card started a connect, so each card shows its own progress and error.
type ConnectFrom = "search" | "field";
type Connector = ReturnType<typeof useConnectSource>;

// Clones (or checks) a location and saves it as a pinned source. One per Sources tab, shared by the
// search card and the connect field: each connect saves the whole sources list, so only one runs
// at a time.
function useConnectSource(pipeline: Pipeline, values: PipelineConfig) {
  const add = useRpc(addSkillSource);
  const running = useRef(false);
  const [connecting, setConnecting] = useState<{ location: string; from: ConnectFrom } | null>(null);
  const [error, setError] = useState<{ message: string; from: ConnectFrom } | null>(null);

  async function connect(location: string, kind: SourceKind, from: ConnectFrom) {
    if (!location || running.current) {
      return false;
    }
    running.current = true;
    setConnecting({ location, from });
    setError(null);
    try {
      const result = await add({ location });
      if (!result.ok) {
        setError({ message: result.error ?? "Could not connect that source.", from });
        return false;
      }
      const next: SkillSource = {
        id: result.id,
        label: result.label,
        location: result.location,
        kind,
        enabled: true,
        pin: result.pin,
      };
      return await pipeline.save({
        sources: [...values.sources.filter((s) => s.id !== next.id), next],
      });
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : "Could not connect that source.", from });
      return false;
    } finally {
      running.current = false;
      setConnecting(null);
    }
  }

  return { connect, connecting, error };
}

const SEARCH_DEBOUNCE_MS = 300;

// skills.sh search. Connect adds the hit's repo as an imported source; whether a row shows as
// connected comes from the server, so the search re-runs when the sources change.
function RegistrySearch({
  connector,
  sources,
  styles,
}: {
  connector: Connector;
  sources: SkillSource[];
  styles: Styles;
}) {
  const search = useRpc(searchSkillRegistry);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RegistryHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourcesKey = JSON.stringify(sources);
  // Any connect in progress, from either card, holds every row back.
  const connecting = connector.connecting ? connector.connecting.location : null;
  const connectError = connector.error?.from === "search" ? connector.error.message : null;

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setError(null);
      setSearching(false);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      setSearching(true);
      search({ query: trimmed })
        .then((result) => {
          if (!stale) {
            setHits(result.results);
            setError(result.error);
          }
        })
        .catch((cause: unknown) => {
          if (!stale) {
            setError(cause instanceof Error ? cause.message : "Could not search skills.sh.");
          }
        })
        .finally(() => {
          if (!stale) {
            setSearching(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [query, search, sourcesKey]);

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Search skills.sh</Text>
      <Text style={styles.muted}>Find a skill, then connect the repo that holds it. Nothing is installed.</Text>
      <TextInput
        accessibilityLabel="Search skills.sh"
        placeholder="Search skills.sh"
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      {searching ? <Text style={styles.muted}>Searching…</Text> : null}
      {error ? <Text style={[styles.muted, styles.danger]}>{error}</Text> : null}
      {connectError ? <Text style={[styles.muted, styles.danger]}>{connectError}</Text> : null}
      {hits.map((hit) => {
        const row = rowState(hit, connecting);
        return (
          <View key={`${hit.source}/${hit.skillId}`} style={styles.rowWrap}>
            <View style={styles.flex1}>
              <Text style={styles.body}>{hit.name}</Text>
              <Text style={styles.muted}>
                {hit.source} · {installsLabel(hit.installs)}
              </Text>
            </View>
            <Chip
              label={row.label}
              active={hit.connected}
              styles={styles}
              onPress={row.canConnect ? () => void connector.connect(hit.source, "imported", "search") : undefined}
            />
          </View>
        );
      })}
    </View>
  );
}

function ConnectSource({ connector, styles }: { connector: Connector; styles: Styles }) {
  const busy = connector.connecting !== null;
  const error = connector.error?.from === "field" ? connector.error.message : null;
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<SourceKind>("personal");

  async function connect() {
    if (await connector.connect(draft.trim(), kind, "field")) {
      setDraft("");
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
        <Chip
          label={connector.connecting?.from === "field" ? "Connecting…" : "Connect"}
          styles={styles}
          onPress={busy ? undefined : () => void connect()}
        />
      </View>
      {error ? <Text style={[styles.muted, styles.danger]}>{error}</Text> : null}
    </View>
  );
}

// ---------- small bits ----------

function sourceLabel(values: PipelineConfig, id: string) {
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
    pipeButton: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      height: 30,
      paddingHorizontal: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 7,
      backgroundColor: "transparent",
    },
    pipeButtonOn: { borderColor: c.accent, backgroundColor: c.surface2 },
    pipeDots: { flexDirection: "row" as const, gap: 3 },
    pipeDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: c.statusSuccess },
    pipeButtonText: { color: c.foreground, fontSize: 12.5 },
    overlay: {
      // Above the dashboard header, which sits at zIndex 10 so its menus clear the tab body.
      zIndex: 20,
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
