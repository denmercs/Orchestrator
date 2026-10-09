import assert from "node:assert/strict";
import { test } from "node:test";
import { planUsageRows } from "../shared/plan-usage";
import { kiroUsageSource, parseKiroUsage } from "./kiro-usage";

const ESC = "\u001b";
const sample = [
  `${ESC}[1mEstimated Usage${ESC}[0m | resets on 2026-11-01 | ${ESC}[32mKIRO PRO+${ESC}[0m`,
  `Credits (1000.00 of 2000 covered in plan), 50.0%`,
  `Your plan is managed by your organization's administrator.`,
  "",
].join("\n");

test("parses the real /usage output, ANSI escapes and all", () => {
  assert.deepEqual(parseKiroUsage(sample), {
    status: "available",
    planLabel: "KIRO PRO+",
    windows: [],
    balances: [
      {
        id: "credits",
        label: "Credits",
        used: 1000,
        limit: 2000,
        unit: "credits",
        resetsAt: new Date(2026, 10, 1).toISOString(),
        tone: "ok",
      },
    ],
  });
});

test("fills S18's Kiro row when listed as providerId kiro", () => {
  const report = parseKiroUsage(sample);
  assert.equal(report.status, "available");
  const now = new Date(2026, 9, 9);
  const rows = planUsageRows(
    { providers: [{ providerId: "kiro", status: "available", planLabel: "KIRO PRO+", windows: [], balances: report.status === "available" ? report.balances : [] }], error: null },
    now,
  );
  const kiro = rows.find((row) => row.provider === "kiro");
  assert.equal(kiro?.state, "available");
  if (kiro?.state !== "available") return;
  assert.equal(kiro.plan, "KIRO PRO+");
  assert.equal(kiro.meters[0].percent, "50%");
  assert.equal(kiro.meters[0].amount, "1000 credits of 2000 credits");
});

const usage = (credits: string) =>
  `Estimated Usage | resets on 2026-11-01 | KIRO PRO+\nCredits (${credits} covered in plan), 75.0%\n`;

const toneOfCredits = (credits: string) => {
  const report = parseKiroUsage(usage(credits));
  assert.equal(report.status, "available");
  return report.status === "available" ? report.balances?.[0].tone : undefined;
};

test("tone is warning at 70% and danger above 90%", () => {
  assert.equal(toneOfCredits("1500.00 of 2000"), "warning");
  assert.equal(toneOfCredits("1900.00 of 2000"), "danger");
  assert.equal(toneOfCredits("1800.00 of 2000"), "warning");
});

test("a decimal used amount is kept", () => {
  const report = parseKiroUsage(usage("12.50 of 2000"));
  assert.equal(report.status === "available" && report.balances?.[0].used, 12.5);
});

test("text with no Credits line is an error report", () => {
  assert.deepEqual(parseKiroUsage("Estimated Usage | resets on 2026-11-01 | KIRO FREE\n"), {
    status: "error",
    error: "Unrecognised kiro-cli /usage output",
  });
  assert.equal(parseKiroUsage("").status, "error");
});

const global = { kind: "global" } as const;
const session = (provider: string) => ({ kind: "session", provider, env: {} }) as const;
const account = { key: "default", harness: "Kiro", input: {} };

test("the source is registered as kiro, with one default account when the CLI is found", async () => {
  const source = kiroUsageSource({ findCli: async () => "/bin/kiro-cli", run: async () => sample });
  assert.equal(source.id, "kiro");
  assert.equal(source.label, "Kiro");
  assert.deepEqual(await source.discover(global), [account]);
  assert.deepEqual(await source.discover(session("kiro")), [account]);
});

test("no account when kiro-cli is missing, or for another provider's session", async () => {
  const missing = kiroUsageSource({ findCli: async () => null, run: async () => sample });
  assert.deepEqual(await missing.discover(global), []);
  const found = kiroUsageSource({ findCli: async () => "/bin/kiro-cli", run: async () => sample });
  assert.deepEqual(await found.discover(session("claude")), []);
});

test("fetch runs the CLI and parses its output; a rejected run is an error report", async () => {
  const calls: string[] = [];
  const source = kiroUsageSource({
    findCli: async () => "/bin/kiro-cli",
    run: async (cli) => {
      calls.push(cli);
      return sample;
    },
  });
  assert.equal((await source.fetch({})).status, "available");
  assert.deepEqual(calls, ["/bin/kiro-cli"]);
  const failing = kiroUsageSource({
    findCli: async () => "/bin/kiro-cli",
    run: async () => {
      throw new Error("timed out");
    },
  });
  assert.deepEqual(await failing.fetch({}), { status: "error", error: "timed out" });
  const gone = kiroUsageSource({ findCli: async () => null, run: async () => sample });
  assert.equal((await gone.fetch({})).status, "error");
});
