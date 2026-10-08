import { z } from "zod";
import type { RegistrySearch, SkillSource } from "../shared/pipeline";
import { sourceId } from "./skill-sources";

type Options = { fetch: typeof fetch; sources: SkillSource[] };

const SEARCH_URL = "https://skills.sh/api/search?q=";
const TIMEOUT_MS = 8_000;

// Only the fields we show; skills.sh sends more and those are ignored.
const searchResponse = z.object({
  skills: z.array(
    z.object({
      source: z.string(),
      skillId: z.string(),
      name: z.string(),
      installs: z.number(),
    }),
  ),
});

// skills.sh registry adapter: discovery only, nothing is installed from here.
export async function searchSkillsSh(query: string, options: Options): Promise<RegistrySearch> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { results: [], error: null };
  }
  try {
    const response = await options.fetch(SEARCH_URL + encodeURIComponent(trimmed), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      return failed(`skills.sh returned ${response.status}.`);
    }
    const parsed = searchResponse.safeParse(await response.json());
    if (!parsed.success) {
      return failed("skills.sh sent an unexpected response.");
    }
    return {
      results: parsed.data.skills.map((hit) => ({
        source: hit.source,
        skillId: hit.skillId,
        name: hit.name,
        installs: hit.installs,
        connected: isConnected(hit.source, options.sources),
      })),
      error: null,
    };
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return failed("skills.sh did not answer in time.");
    }
    return failed(error instanceof Error ? error.message : String(error));
  }
}

function failed(error: string): RegistrySearch {
  return { results: [], error };
}

// A repo added as a GitHub URL ("https://github.com/owner/repo" or "git@github.com:owner/repo")
// gets the id of "github.com/owner/repo", so both forms count as the same repo.
function isConnected(source: string, sources: SkillSource[]) {
  const ids = new Set([sourceId(source), sourceId(`github.com/${source}`)]);
  return sources.some((s) => ids.has(s.id));
}
