import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillSource } from "../shared/belt";
import { searchSkillsSh } from "./skills-sh";

const connected: SkillSource = {
  id: "vercel-labs-agent-skills",
  label: "vercel-labs/agent-skills",
  location: "vercel-labs/agent-skills",
  kind: "imported",
  enabled: true,
  pin: "0123456789abcdef0123456789abcdef01234567",
};

// The shape https://skills.sh/api/search?q= returns.
const response = {
  query: "react",
  searchType: "fuzzy",
  skills: [
    {
      id: "vercel-labs/agent-skills/vercel-react-best-practices",
      source: "vercel-labs/agent-skills",
      skillId: "vercel-react-best-practices",
      name: "vercel-react-best-practices",
      installs: 1234,
    },
    {
      id: "acme/react-skills/react-testing",
      source: "acme/react-skills",
      skillId: "react-testing",
      name: "react-testing",
      installs: 56,
    },
  ],
};

function stubFetch(result: () => Promise<unknown>) {
  return (async () => result()) as unknown as typeof fetch;
}

test("search maps skills.sh hits and marks the connected repo", async () => {
  const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => response }));

  const result = await searchSkillsSh("react", { fetch, sources: [connected] });

  assert.deepEqual(result, {
    results: [
      {
        source: "vercel-labs/agent-skills",
        skillId: "vercel-react-best-practices",
        name: "vercel-react-best-practices",
        installs: 1234,
        connected: true,
      },
      { source: "acme/react-skills", skillId: "react-testing", name: "react-testing", installs: 56, connected: false },
    ],
    error: null,
  });
});

test("search gives an error and no results when fetch rejects", async () => {
  const fetch = stubFetch(async () => {
    throw new Error("getaddrinfo ENOTFOUND skills.sh");
  });

  const result = await searchSkillsSh("react", { fetch, sources: [connected] });

  assert.deepEqual(result.results, []);
  assert.ok(result.error, "expected an error message");
});

test("search gives an error and no results on a non-200 response", async () => {
  const fetch = stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));

  const result = await searchSkillsSh("react", { fetch, sources: [connected] });

  assert.deepEqual(result.results, []);
  assert.ok(result.error, "expected an error message");
});
