import assert from "node:assert/strict";
import { test } from "node:test";
import type { SkillSource } from "../shared/belt";
import { sourceId } from "./skill-sources";
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

test("search gives an error and no results when the body is not JSON", async () => {
  const fetch = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON at position 0");
    },
  }));

  const result = await searchSkillsSh("react", { fetch, sources: [connected] });

  assert.deepEqual(result.results, []);
  assert.ok(result.error, "expected an error message");
});

test("search gives an error and no results when the body has the wrong shape", async () => {
  const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({ skills: "nope" }) }));

  const result = await searchSkillsSh("react", { fetch, sources: [connected] });

  assert.deepEqual(result, { results: [], error: "skills.sh sent an unexpected response." });
});

test("search says skills.sh did not answer when the request times out", async () => {
  const fetch = stubFetch(async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });

  const result = await searchSkillsSh("react", { fetch, sources: [connected] });

  assert.deepEqual(result, { results: [], error: "skills.sh did not answer in time." });
});

test("a blank query returns no results without calling skills.sh", async () => {
  let calls = 0;
  const fetch = stubFetch(async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => response };
  });

  assert.deepEqual(await searchSkillsSh("", { fetch, sources: [connected] }), { results: [], error: null });
  assert.deepEqual(await searchSkillsSh("   ", { fetch, sources: [connected] }), { results: [], error: null });
  assert.equal(calls, 0);
});

test("search encodes the trimmed query and sets a timeout signal", async () => {
  const requests: { url: string; signal: unknown }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url, signal: init?.signal });
    return { ok: true, status: 200, json: async () => ({ skills: [] }) };
  }) as unknown as typeof globalThis.fetch;

  await searchSkillsSh("  react hooks&x ", { fetch, sources: [] });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://skills.sh/api/search?q=react%20hooks%26x");
  assert.ok(requests[0].signal instanceof AbortSignal, "expected a timeout signal");
});

test("a source added by its GitHub URL counts as connected", async () => {
  const byUrl: SkillSource = {
    ...connected,
    id: sourceId("https://github.com/vercel-labs/agent-skills"),
    location: "https://github.com/vercel-labs/agent-skills",
  };
  const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => response }));

  const result = await searchSkillsSh("react", { fetch, sources: [byUrl] });

  assert.deepEqual(
    result.results.map((hit) => hit.connected),
    [true, false],
  );
});

test("a repo whose owner is a hyphen-suffix of a connected owner is not connected", async () => {
  const myOrg: SkillSource = { ...connected, id: sourceId("my-org/skills"), location: "my-org/skills" };
  const hits = { skills: ["org/skills", "labs/agent-skills"].map((source) => ({ source, skillId: "s", name: "s", installs: 1 })) };
  const fetch = stubFetch(async () => ({ ok: true, status: 200, json: async () => hits }));

  const result = await searchSkillsSh("skills", { fetch, sources: [myOrg, connected] });

  assert.deepEqual(
    result.results.map((hit) => hit.connected),
    [false, false],
  );
});
