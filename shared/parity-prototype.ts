// PROTOTYPE — wipe me. Answers: "what should a 1:1 iOS/Android parity panel look like?"
// Mock data and the panel's arithmetic for client/parity-prototype.tsx. Nothing reads real
// reports yet; once a layout wins, the types move to shared/parity.ts and this file goes.

export type Platform = "ios" | "android";
export const PLATFORMS: readonly Platform[] = ["ios", "android"];

export type Status = "pass" | "fail" | "skip";

// One platform's side of a check. `value` is what was measured (ms, %, an event name…).
export type Side = { status: Status; value?: string; note?: string };

// The things that have to match for two apps to be "the same app". Each is one row group.
export type Dimension =
  | "behavior" // TS contracts run through Maestro on both simulators
  | "logic" // business rules as data, checked by each platform's runner (KMP covers both)
  | "visual" // screenshot diff against the RN baseline
  | "ids" // test IDs from specs/ids.ts present in each platform's code
  | "copy" // string keys from one catalog present on both
  | "analytics" // same event names and props fired during the contract run
  | "routes" // deep links resolve to the same screen
  | "a11y" // labels, screen reader order, large text
  | "tokens" // colors/spacing come from design tokens, not literals
  | "flags" // same feature-flag keys read
  | "perf"; // render time inside a shared budget

export const DIMENSIONS: readonly { key: Dimension; label: string; hint: string }[] = [
  { key: "behavior", label: "Behavior", hint: "TS contracts → Maestro on both simulators" },
  { key: "logic", label: "Logic", hint: "Rules as data, checked by the KMP runner" },
  { key: "visual", label: "Visual", hint: "Screenshot diff vs the RN baseline" },
  { key: "ids", label: "Test IDs", hint: "specs/ids.ts → TestIds.swift / TestIds.kt" },
  { key: "copy", label: "Copy", hint: "One string catalog → Localizable / strings.xml" },
  { key: "analytics", label: "Analytics", hint: "Events captured during the contract run" },
  { key: "routes", label: "Deep links", hint: "Same URL lands on the same screen" },
  { key: "a11y", label: "Accessibility", hint: "Labels, reader order, large text" },
  { key: "tokens", label: "Design tokens", hint: "No hard-coded colors or spacing" },
  { key: "flags", label: "Feature flags", hint: "Same flag keys read on both" },
  { key: "perf", label: "Performance", hint: "First render under budget" },
];

export type Check = {
  id: string;
  dimension: Dimension;
  title: string;
  ios: Side;
  android: Side;
  // An approved, intentional difference (see `exceptions`): not drift, doesn't block.
  exception?: string;
};

export type FilePair = { area: string; ios: string; android: string; iosLines: number; androidLines: number };

export type ParityReport = {
  storyId: string;
  title: string;
  ranAt: string;
  // The KMP store version each app was built against; a mismatch means they read different state.
  sharedCore: Record<Platform, string>;
  screenshots: { baseline: string; ios: string; android: string; diff: Record<Platform, number>; budget: number };
  files: FilePair[];
  checks: Check[];
  exceptions: { id: string; reason: string; approvedBy: string }[];
};

const pass = (value?: string): Side => ({ status: "pass", value });
const fail = (note: string, value?: string): Side => ({ status: "fail", note, value });

export const MOCK_REPORT: ParityReport = {
  storyId: "S10",
  title: "Port the Home screen to SwiftUI and Compose",
  ranAt: "2026-10-08T14:32:00Z",
  sharedCore: { ios: "shared 1.4.0", android: "shared 1.4.0" },
  screenshots: {
    baseline: "RN 4.12 · Home",
    ios: "HomeView",
    android: "HomeScreen",
    diff: { ios: 0.4, android: 3.1 },
    budget: 1.5,
  },
  files: [
    { area: "Screen", ios: "iosApp/Home/HomeView.swift", android: "androidApp/home/HomeScreen.kt", iosLines: 84, androidLines: 91 },
    { area: "Row", ios: "iosApp/Home/FeedRow.swift", android: "androidApp/home/FeedRow.kt", iosLines: 42, androidLines: 38 },
    { area: "Binding", ios: "iosApp/Home/HomeViewModel.swift", android: "androidApp/home/HomeViewModel.kt", iosLines: 31, androidLines: 27 },
  ],
  checks: [
    { id: "login", dimension: "behavior", title: "Sign in lands on Home", ios: pass("4.1s"), android: pass("3.8s") },
    {
      id: "home-shows-feed",
      dimension: "behavior",
      title: "Home shows the feed",
      ios: pass("2.2s"),
      android: fail('"feed-list" not found — Compose root is missing testTagsAsResourceId'),
    },
    { id: "pull-to-refresh", dimension: "behavior", title: "Pull to refresh reloads", ios: pass("1.9s"), android: pass("2.0s") },
    { id: "cart-total", dimension: "logic", title: "Cart total (5 cases)", ios: pass("5/5"), android: pass("5/5") },
    { id: "feed-order", dimension: "logic", title: "Feed sorts newest first (3 cases)", ios: pass("3/3"), android: pass("3/3") },
    {
      id: "home-visual",
      dimension: "visual",
      title: "Home vs RN baseline",
      ios: pass("Δ 0.4%"),
      android: fail("Row spacing 12dp vs 16pt baseline", "Δ 3.1%"),
    },
    { id: "home.screen", dimension: "ids", title: "home-screen", ios: pass(), android: pass() },
    { id: "home.feed", dimension: "ids", title: "feed-list", ios: pass(), android: fail("Declared but not exposed to UI tests") },
    { id: "home.empty", dimension: "ids", title: "feed-empty", ios: fail("Missing in HomeView.swift"), android: pass() },
    { id: "home.title", dimension: "copy", title: "home.title", ios: pass(), android: pass() },
    { id: "home.empty.body", dimension: "copy", title: "home.empty.body", ios: pass(), android: fail("Hard-coded string in HomeScreen.kt:58") },
    {
      id: "screen_view",
      dimension: "analytics",
      title: "screen_view { name: home }",
      ios: pass("1×"),
      android: fail("Fired twice (recomposition)", "2×"),
    },
    { id: "feed_item_tap", dimension: "analytics", title: "feed_item_tap { id, position }", ios: pass(), android: pass() },
    { id: "route-home", dimension: "routes", title: "app://home", ios: pass("HomeView"), android: pass("HomeScreen") },
    { id: "route-item", dimension: "routes", title: "app://item/:id", ios: pass("ItemView"), android: pass("ItemScreen") },
    { id: "a11y-labels", dimension: "a11y", title: "Every tappable has a label", ios: pass(), android: pass() },
    { id: "a11y-large-text", dimension: "a11y", title: "Largest text size, no clipping", ios: fail("Row title truncates at AX5"), android: pass() },
    { id: "tokens-color", dimension: "tokens", title: "No literal colors", ios: pass(), android: pass() },
    { id: "tokens-spacing", dimension: "tokens", title: "No literal spacing", ios: pass(), android: fail("12.dp in FeedRow.kt:21") },
    { id: "flag-new-feed", dimension: "flags", title: "home.newFeed", ios: pass("read"), android: pass("read") },
    { id: "perf-first-render", dimension: "perf", title: "First render ≤ 400 ms", ios: pass("212 ms"), android: pass("348 ms") },
    {
      id: "share-sheet",
      dimension: "behavior",
      title: "Share opens the system sheet",
      ios: pass("UIActivityViewController"),
      android: pass("Intent.ACTION_SEND"),
      exception: "share-sheet",
    },
    {
      id: "back-gesture",
      dimension: "behavior",
      title: "Back from Item returns to Home",
      ios: pass("edge swipe"),
      android: { status: "skip", note: "Predictive back covered by system" },
      exception: "back-gesture",
    },
  ],
  exceptions: [
    { id: "share-sheet", reason: "Each platform uses its own share UI", approvedBy: "architecture.md · D4" },
    { id: "back-gesture", reason: "Android back is system-owned", approvedBy: "architecture.md · D5" },
  ],
};

// A check is in parity when both sides pass, or when it's an approved exception.
export function inParity(check: Check): boolean {
  if (check.exception) return true;
  return check.ios.status === "pass" && check.android.status === "pass";
}

// Which platform is behind on a check: the side(s) that failed.
export function behind(check: Check): Platform[] {
  return PLATFORMS.filter((platform) => check[platform].status === "fail");
}

export type DimensionSummary = { key: Dimension; label: string; hint: string; total: number; green: number; checks: Check[] };

export function byDimension(report: ParityReport): DimensionSummary[] {
  return DIMENSIONS.map((dimension) => {
    const checks = report.checks.filter((check) => check.dimension === dimension.key);
    return { ...dimension, total: checks.length, green: checks.filter(inParity).length, checks };
  }).filter((summary) => summary.total > 0);
}

export type PanelSummary = {
  total: number;
  green: number;
  drift: Check[];
  failing: Record<Platform, number>;
  coreMatch: boolean;
  visualOver: Platform[];
  gate: { open: boolean; reason: string };
};

export function parityPanel(report: ParityReport): PanelSummary {
  const drift = report.checks.filter((check) => !inParity(check));
  const failing = {
    ios: report.checks.filter((check) => !check.exception && check.ios.status === "fail").length,
    android: report.checks.filter((check) => !check.exception && check.android.status === "fail").length,
  };
  const coreMatch = report.sharedCore.ios === report.sharedCore.android;
  const visualOver = PLATFORMS.filter((platform) => report.screenshots.diff[platform] > report.screenshots.budget);
  const reason = !coreMatch
    ? "the apps were built against different shared cores"
    : drift.length
      ? `${drift.length} check${drift.length === 1 ? "" : "s"} out of parity — first: ${drift[0].id}`
      : "every check matches on both platforms";
  return {
    total: report.checks.length,
    green: report.checks.length - drift.length,
    drift,
    failing,
    coreMatch,
    visualOver,
    gate: { open: coreMatch && drift.length === 0, reason },
  };
}
