import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { RpcOutput } from "@getpaseo/plugin";
import type { getProdPulse } from "../shared/orchestration";

// The scheduled /ss-prod-pulse job writes page/data.json here and publishes the same file
// to the release health artifact. The drawer reads it locally, so it needs no Sentry token.
const PULSE_DIR = process.env.PROD_PULSE_DIR ?? path.join(homedir(), ".prod-pulse");
const STALE_HOURS = 30;

type ProdPulse = RpcOutput<typeof getProdPulse>;
type Card = ProdPulse["cards"][number];
type Issue = ProdPulse["issues"][number];
type Older = ProdPulse["older"][number];
type Row = Record<string, unknown>;

const PRODUCT_LABEL: Record<string, string> = { mobile: "Mobile", firetv: "TV", tv: "TV", roku: "Roku" };
const ORIGIN_ORDER: Record<Issue["origin"], number> = {
  regression: 0,
  new: 1,
  unchecked: 2,
  "seen-before": 3,
};
// Catch-all logger buckets collect unrelated messages under one title, so they're not listed.
const LOGGER_BUCKET = /^(SentryAdapter#log|Sentry\.withScope\$argument_\d+|log)$/;

export async function loadProdPulse(now = new Date()): Promise<ProdPulse> {
  const raw = await readJson(path.join(PULSE_DIR, "page", "data.json"));
  if (raw === undefined) {
    return emptyPulse(null);
  }
  const data = asRecord(raw);
  if (!data) {
    return emptyPulse("The prod pulse data file is not valid JSON.");
  }
  const config = asRecord(await readJson(path.join(PULSE_DIR, "config.json")));
  const meta = asRecord(data.meta);
  const products = asArray(data.products)
    .map(asRecord)
    .filter((row): row is Row => row !== null)
    .sort((left, right) => num(left.order, 9) - num(right.order, 9));
  const rawIssues = asArray(data.issues).map(asRecord).filter((row): row is Row => row !== null);

  const cardOrder = new Map<string, number>();
  const cardUsers = new Map<string, number>();
  const cards: Card[] = [];
  for (const product of products) {
    for (const card of asArray(product.cards).map(asRecord)) {
      if (!card) {
        continue;
      }
      const key = str(card.key) ?? `${str(product.key) ?? "product"}-${cards.length}`;
      const health = asRecord(card.health);
      const assessed = assess(health);
      cardOrder.set(key, num(product.order, 9) * 100 + cards.length);
      cardUsers.set(key, num(health?.users, 0));
      cards.push({
        key,
        product: str(product.label) ?? productLabel(str(product.key)),
        label: str(card.platform) ?? str(card.label) ?? str(product.label) ?? key,
        version: shortVersion(str(card.tag) ?? str(product.tag)),
        publishedAt: str(card.publishedAt),
        healthKey: assessed.key,
        healthLabel: assessed.label,
        healthWhy: assessed.why,
        crashFreeSessions: numOrNull(health?.crashFreeSessions),
        crashFreeUsers: numOrNull(health?.crashFreeUsers),
        sessions: numOrNull(health?.sessions),
        users: numOrNull(health?.users),
        newBugs: rawIssues.filter((issue) => issue.card === key && issue.origin !== "seen-before").length,
        caveat: str(card.caveat),
        url: str(health?.url),
      });
    }
  }

  const productOrder = (issue: Row) =>
    cardOrder.get(str(issue.card) ?? "") ??
    num(products.find((product) => product.key === firstProduct(issue))?.order, 9) * 100 + 99;
  const issues = rawIssues
    .sort(
      (left, right) =>
        ORIGIN_ORDER[originOf(left)] - ORIGIN_ORDER[originOf(right)] ||
        productOrder(left) - productOrder(right) ||
        rankOf(left) - rankOf(right) ||
        maxOf(right, "users") - maxOf(left, "users") ||
        maxOf(right, "events") - maxOf(left, "events"),
    )
    .map((issue, index) => toIssue(issue, index));

  const older: Older[] = products
    .flatMap((product) =>
      asArray(product.older)
        .map(asRecord)
        .filter((row): row is Row => row !== null)
        .map((row, index) => ({
          id: str(row.shortId) ?? `${str(product.key) ?? "older"}-${index}`,
          product: str(product.label) ?? productLabel(str(product.key)),
          title: str(row.title) ?? "Untitled issue",
          users: num(row.users, 0),
          events: num(row.events, 0),
          status: str(row.status) ?? "unresolved",
          sentryUrl: str(row.sentryUrl),
        })),
    )
    .filter((row) => !LOGGER_BUCKET.test(row.title))
    .sort((left, right) => right.users - left.users);

  const checkedAt = str(meta?.lastCheckAt) ?? str(meta?.lastRunAt);
  const checkedMs = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  return {
    available: true,
    error: null,
    dashboardUrl: str(config?.artifactUrl),
    outcome: outcomeOf(meta),
    checkedAt,
    changedAt: str(meta?.lastChangeAt) ?? str(meta?.lastRunAt),
    failReason: str(meta?.failReason),
    stale: Number.isFinite(checkedMs) && (now.getTime() - checkedMs) / 36e5 > STALE_HOURS,
    systemNotes: strings(meta?.systemNotes),
    cards,
    issues,
    older,
    actions: strings(meta?.actions),
  };

  function toIssue(issue: Row, index: number): Issue {
    const watch = asRecord(issue.watch);
    const watchKind = str(watch?.kind);
    const watchUrl = str(watch?.url);
    const findings = strings(issue.initialFindings);
    const likely = findings.find((line) => /^likely:/i.test(line));
    const members = asArray(issue.members);
    const card = str(issue.card);
    const share = card && cardUsers.get(card) ? maxOf(issue, "users") / (cardUsers.get(card) ?? 1) : null;
    return {
      id: str(issue.shortId) ?? str(issue.id) ?? `issue-${index}`,
      origin: originOf(issue),
      product: str(issue.platform) ?? productLabel(str(issue.product)),
      hit: str(issue.userHits) ?? str(issue.title) ?? "Untitled issue",
      rawTitle: str(issue.userHits) ? str(issue.title) : null,
      trend: issue.trend === "new" || issue.trend === "rising" ? issue.trend : "flat",
      top: issue.kind === "finding",
      users: range(issue, "users") + (share ? ` · ${formatShare(share)} of users` : ""),
      events: range(issue, "events"),
      firstSeen: str(issue.firstSeen),
      release: str(issue.release),
      shortId: str(issue.shortId),
      sentryUrl: str(issue.releaseUrl) ?? str(issue.sentryUrl),
      watchUrl,
      watchLabel: watchUrl
        ? watchKind === "fullstory"
          ? "FullStory session"
          : "Sentry replay"
        : watchKind === "n/a"
          ? "No session recording (TV/Roku)"
          : "No session recording",
      repro: strings(issue.repro),
      reproMissing: str(issue.reproMissing),
      findings: findings
        .filter((line) => line !== likely)
        .concat(strings(issue.notes)),
      likely: likely ? likely.replace(/^likely:\s*/i, "") : null,
      groupedCount: members.length,
    };
  }
}

function emptyPulse(error: string | null): ProdPulse {
  return {
    available: false,
    error,
    dashboardUrl: null,
    outcome: "none",
    checkedAt: null,
    changedAt: null,
    failReason: null,
    stale: false,
    systemNotes: [],
    cards: [],
    issues: [],
    older: [],
    actions: [],
  };
}

// Mirrors the release health page: crash-free sessions and users are judged on their 95%
// Wilson range against the healthy/watch lines, and the worse metric decides the label.
function assess(health: Row | null): { key: Card["healthKey"]; label: string; why: string } {
  const thresholds = asRecord(health?.thresholds);
  const healthy = num(thresholds?.healthy, 0.995);
  const watch = num(thresholds?.watch, 0.99);
  const minSessions = num(thresholds?.minSessions, 50);
  const sessions = num(health?.sessions, 0);
  if (!health || !sessions) {
    return { key: "none", label: "No sessions yet", why: "No sessions have been recorded on this release yet." };
  }
  if (health.crashedAnyVersion90d === 0) {
    return {
      key: "unverified",
      label: "Crash reporting unverified",
      why: "No crash recorded on any version in 90 days, so crashes are likely not reaching Sentry.",
    };
  }
  if (sessions < minSessions) {
    return {
      key: "early",
      label: "Too early",
      why: `Only ${sessions} sessions so far. The label waits for ${minSessions}.`,
    };
  }
  const candidates: Array<[string, number | null, number]> = [
    ["Crash-free sessions", numOrNull(health.crashFreeSessions), sessions],
    ["Crash-free users", numOrNull(health.crashFreeUsers), num(health.users, 0)],
  ];
  const metrics = candidates
    .flatMap(([name, rate, count]) => (rate === null ? [] : [{ name, rate, count }]))
    .map(({ name, rate, count }) => {
      const [low, high] = wilson(rate, count);
      return { name, rate, low, high, rank: high < watch ? 2 : low >= healthy ? 0 : 1 };
    })
    .sort((left, right) => right.rank - left.rank);
  const worst = metrics[0];
  if (!worst || worst.rank === 0) {
    return {
      key: "healthy",
      label: "Healthy",
      why: `Even the worst case stays at or above ${pct(healthy, 1)}%.`,
    };
  }
  const likely = `${pct(worst.low, 2)}–${pct(worst.high, 2)}%`;
  if (worst.rank === 2) {
    return {
      key: "unhealthy",
      label: "Unhealthy",
      why: `${worst.name} ${pct(worst.rate, 2)}%. Even the best case (${likely}) is under ${pct(watch, 1)}%.`,
    };
  }
  return {
    key: "watch",
    label: "Watch",
    why: `${worst.name} ${pct(worst.rate, 2)}%, likely ${likely}: between ${pct(watch, 1)}% and ${pct(healthy, 1)}%.`,
  };
}

function wilson(rate: number, count: number, z = 1.96): [number, number] {
  if (!count) {
    return [0, 1];
  }
  const denominator = 1 + (z * z) / count;
  const center = (rate + (z * z) / (2 * count)) / denominator;
  const width =
    (z * Math.sqrt((rate * (1 - rate)) / count + (z * z) / (4 * count * count))) / denominator;
  return [Math.max(0, center - width), Math.min(1, center + width)];
}

function outcomeOf(meta: Row | null): ProdPulse["outcome"] {
  const outcome = meta?.lastOutcome;
  return outcome === "changed" || outcome === "health" || outcome === "no-change" || outcome === "failed"
    ? outcome
    : meta
      ? "no-change"
      : "none";
}

function originOf(issue: Row): Issue["origin"] {
  const origin = issue.origin;
  return origin === "regression" || origin === "new" || origin === "seen-before" ? origin : "unchecked";
}

function rankOf(issue: Row) {
  return issue.kind === "finding" ? num(issue.rank, 50) : 99;
}

function maxOf(issue: Row, field: "users" | "events") {
  return num(issue[`${field}Max`], num(issue[field], 0));
}

function range(issue: Row, field: "users" | "events") {
  const low = numOrNull(issue[`${field}Min`]) ?? numOrNull(issue[field]);
  const high = numOrNull(issue[`${field}Max`]) ?? numOrNull(issue[field]);
  if (low === null) {
    return "–";
  }
  const unit = field === "users" ? "user" : "event";
  const text = high === null || high === low ? low.toLocaleString() : `${low.toLocaleString()}–${high.toLocaleString()}`;
  return `${text} ${high === 1 || (high === null && low === 1) ? unit : `${unit}s`}`;
}

function formatShare(share: number) {
  return share < 0.001 ? "<0.1%" : `${pct(share, share < 0.1 ? 1 : 0)}%`;
}

function firstProduct(issue: Row) {
  return (str(issue.product) ?? "").split("+")[0];
}

function productLabel(product: string | null) {
  return (product ?? "")
    .split("+")
    .map((key) => PRODUCT_LABEL[key] ?? key)
    .join(" + ");
}

// "mobile@2.2.0-build.58" → "2.2.0 (build 58)".
function shortVersion(tag: string | null) {
  const version = (tag ?? "").replace(/^[a-z]+@/i, "").replace(/^v(?=\d)/, "");
  const build = version.match(/^(.*?)-build\.(\d+)$/);
  return build ? `${build[1]} (build ${build[2]})` : version || "–";
}

function pct(value: number, digits: number) {
  return (value * 100).toFixed(digits);
}

async function readJson(file: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
  return asArray(value).filter((item): item is string => typeof item === "string" && item.length > 0);
}

function num(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
