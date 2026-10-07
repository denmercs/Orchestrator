import { pathToFileURL } from "node:url";
import type { PluginAttachmentItem, PluginAttachmentSearchPayload } from "@getpaseo/plugin";
import { MACHINE_SOURCE, type CatalogSkill, type SkillSource } from "../shared/belt";
import { loadCatalog, parseLocation, readSkills, type SkillContent } from "./skill-sources";

type Content = Exclude<SkillContent, { error: string }>;

// Each listed skill is read from disk, so a query reads at most this many. Each source is scanned
// once for the catalog and once more for the reads.
const LIMIT = 20;

// The composer's Skills attachment source. Skills are read from connected sources in place;
// nothing is copied or installed.
export async function attachSkills(
  query: string,
  sources: SkillSource[],
  { limit = LIMIT }: { limit?: number } = {},
): Promise<PluginAttachmentSearchPayload> {
  try {
    const { skills } = await loadCatalog(sources);
    const hits = matching(skills, query).slice(0, limit);
    const contents = await readSkills(
      hits.map((skill) => ({ name: skill.name, source: skill.source })),
      sources,
    );
    // A skill that can't be read is left out rather than failing the whole search.
    const items = hits.map((skill, i) => {
      const content = contents[i];
      return !content || "error" in content ? null : attachmentItem(skill, content, sources);
    });
    return { items: items.filter((item) => item !== null) };
  } catch (error) {
    console.warn("orchestrator: skills attach search failed", error);
    return { items: [] };
  }
}

// Name and folder matches come before description matches, each in catalog order. A blank query
// matches everything.
function matching(skills: CatalogSkill[], query: string) {
  const needle = query.trim().toLowerCase();
  const has = (value: string) => value.toLowerCase().includes(needle);
  const named = skills.filter((s) => has(s.name) || has(s.folder));
  const described = skills.filter((s) => !named.includes(s) && has(s.description));
  return [...named, ...described];
}

function attachmentItem(skill: CatalogSkill, content: Content, sources: SkillSource[]): PluginAttachmentItem {
  const source = sources.find((s) => s.id === skill.source);
  const label = skill.source === MACHINE_SOURCE ? "This machine" : (source?.label ?? skill.source);
  const id = `${skill.source}:${skill.name}`;
  return {
    id,
    identifier: id,
    title: skill.name,
    subtitle: content.description ? `${label} · ${content.description}` : label,
    url: source ? attachmentUrl(source.location, content.path) : pathToFileURL(content.path).href,
    text: attachmentText(skill, content, label),
    resourceType: skill.kind,
  };
}

// A GitHub source links to its repo (HEAD, not the pin; the text names the pin). Anything else,
// including git hosts without a web page we know, links to the skill folder on this machine.
export function attachmentUrl(location: string, path: string) {
  try {
    const parsed = parseLocation(location);
    const repo = parsed.type === "git" ? parsed.url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/) : null;
    if (repo) {
      return `https://github.com/${repo[1]}/${repo[2]}`;
    }
  } catch {
    // An unparseable location still has a folder on disk.
  }
  return pathToFileURL(path).href;
}

// A header naming the skill and where it came from, the SKILL.md body, then the skill's other files.
function attachmentText(skill: CatalogSkill, content: Content, label: string) {
  const pin = content.commit ? ` @ ${content.commit.slice(0, 7)}` : "";
  const kind = skill.kind === "command" ? "Command" : "Skill";
  const parts = [`${kind}: ${content.name} — from ${label}${pin}`, "", content.body.trimEnd()];
  if (content.files.length > 0) {
    parts.push("", "## Files in this skill", "", ...content.files.map((f) => `- ${f}`));
  }
  return `${parts.join("\n")}\n`;
}
