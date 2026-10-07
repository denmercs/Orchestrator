import type { RegistrySearch, SkillSource } from "../shared/belt";

type Options = { fetch: typeof fetch; sources: SkillSource[] };

// skills.sh registry adapter. Stub until S3.
export async function searchSkillsSh(_query: string, _options: Options): Promise<RegistrySearch> {
  return { results: [], error: null };
}
