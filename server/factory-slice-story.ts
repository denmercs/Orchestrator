import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readFactory } from "./factory-layout";
import { buildContext } from "./factory-tick";
import { frontmatter } from "./harness-layout";

// The story a factory slice agent's labels point at, found through the slice's state.md and the factory root;
// null when there is no factory, or the slice or its story is gone. No initiative is involved, and no Paseo.
export async function sliceStory(readFactoryRoot: () => Promise<string | null>, labels: Record<string, string>) {
  const [slice, mission] = [labels["factory-slice"], labels["factory-mission"]];
  if (labels.kind !== "factory-seat" || !slice || !mission) return null;
  const root = await readFactoryRoot();
  const state = root ? readFactory(root).missions.find((item) => item.id === mission)?.slices.find((item) => item.id === slice) : null;
  if (!root || !state?.state.story) return null;
  const path = resolve(root, state.state.story);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const meta = frontmatter(text);
  const story = { path, id: meta.id || slice, meta, body: text.replace(/^---\n[\s\S]*?\n---\n?/, "") };
  return { root, mission, slice: state, story, ctx: buildContext(state) };
}
