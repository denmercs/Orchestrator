import assert from "node:assert/strict";
import { test } from "node:test";
import { readPlanUsage } from "./plan-usage";

// The live `paseo.providers.listUsage()` payload (2026-10-08), trimmed to Claude and Cursor, with
// the extra fields the daemon sends (`displayName`, `shortLabel`, `fetchedAt`, …).
const live = {
  fetchedAt: "2026-10-08T14:06:00.000Z",
  providers: [
    {
      providerId: "claude",
      displayName: "Claude (someone@example.com)",
      status: "available",
      planLabel: "Max",
      fetchedAt: "2026-10-08T14:06:00.000Z",
      windows: [
        {
          id: "five_hour",
          label: "Session",
          shortLabel: "5h",
          usedPct: 39,
          resetsAt: "2026-10-08T18:00:00.000Z",
          tone: "ok",
        },
      ],
    },
    {
      providerId: "cursor",
      displayName: "Cursor",
      status: "available",
      planLabel: null,
      windows: [],
      balances: [
        {
          id: "plan_usage",
          label: "Plan usage",
          shortLabel: "Plan",
          used: 569.46,
          limit: 70,
          unit: "usd",
          resetsAt: "2026-10-31T00:00:00.000Z",
          tone: "danger",
        },
      ],
    },
  ],
};

const fakePaseo = (listUsage: () => Promise<unknown>) =>
  ({ providers: { listUsage } }) as unknown as Parameters<typeof readPlanUsage>[0];

test("readPlanUsage returns the daemon's providers, parsed to the subset the rows read", async () => {
  const result = await readPlanUsage(fakePaseo(async () => live));
  assert.deepEqual(result, {
    error: null,
    providers: [
      {
        providerId: "claude",
        status: "available",
        planLabel: "Max",
        windows: [
          { id: "five_hour", label: "Session", usedPct: 39, resetsAt: "2026-10-08T18:00:00.000Z", tone: "ok" },
        ],
      },
      {
        providerId: "cursor",
        status: "available",
        planLabel: null,
        windows: [],
        balances: [
          {
            id: "plan_usage",
            label: "Plan usage",
            used: 569.46,
            limit: 70,
            unit: "usd",
            resetsAt: "2026-10-31T00:00:00.000Z",
            tone: "danger",
          },
        ],
      },
    ],
  });
});

test("readPlanUsage returns providers null and the reason when the daemon call rejects", async () => {
  const result = await readPlanUsage(
    fakePaseo(async () => {
      throw new Error("Update the host to list provider usage.");
    }),
  );
  assert.deepEqual(result, { providers: null, error: "Update the host to list provider usage." });
});
