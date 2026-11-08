import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Factory, type FactoryMission, type FactorySlice, type SliceState, parseSeat, parseSliceState, runnableSlice } from "../shared/factory";
import { dirsIn, frontmatter, writeFrontmatter } from "./harness-layout";

export const factoryDir = (root: string) => join(root, ".harness", "factory");
export const sliceDir = (root: string, mission: string, slice: string) =>
  join(factoryDir(root), "missions", mission, "slices", slice);

const readText = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const body = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();

function readSlice(root: string, mission: string, id: string): FactorySlice {
  const dir = sliceDir(root, mission, id);
  return {
    id,
    mission,
    state: parseSliceState(frontmatter(readText(join(dir, "state.md")))),
    spec: body(readText(join(dir, "spec.md"))),
    design: body(readText(join(dir, "design.md"))),
    proof: body(readText(join(dir, "proof.md"))),
  };
}

function readMission(root: string, id: string): FactoryMission {
  const dir = join(factoryDir(root), "missions", id);
  return {
    id,
    outcome: body(readText(join(dir, "mission.md"))),
    slices: dirsIn(join(dir, "slices")).map((slice) => readSlice(root, id, slice)),
  };
}

export function readFactory(root: string): Factory {
  const home = factoryDir(root);
  const seatsDir = join(home, "seats");
  const seats = existsSync(seatsDir)
    ? readdirSync(seatsDir)
        .filter((name) => name.endsWith(".md"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((name) => {
          const text = readText(join(seatsDir, name));
          return parseSeat(name.slice(0, -3), frontmatter(text), body(text));
        })
    : [];
  return {
    project: body(readText(join(home, "project.md"))),
    manager: { agent: frontmatter(readText(join(home, "manager.md"))).agent ?? "" },
    culture: body(readText(join(home, "culture.md"))),
    seats,
    missions: dirsIn(join(home, "missions")).map((id) => readMission(root, id)),
  };
}

// The one slice that should run now, or null (no factory, or nothing set to run).
export const factoryTick = (root: string): FactorySlice | null => runnableSlice(readFactory(root));

// A story file's identity for the one-owner rule: resolved against `base`, then through symlinks when the file exists.
export function storyKey(file: string, base = "") {
  const path = resolve(base, file);
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// The story files the factory's slices name (real paths, relative ones taken from the factory root), so the initiative loop can leave them to the tick.
export const namedStories = (factoryRoot: string): Set<string> =>
  new Set(
    readFactory(factoryRoot)
      .missions.flatMap((mission) => mission.slices)
      .map((slice) => slice.state.story)
      .filter(Boolean)
      .map((story) => storyKey(story, factoryRoot)),
  );

type SliceStatePatch = { [K in keyof SliceState]?: SliceState[K] | null };

// Sets (or, with null, removes) machine fields in a slice's state.md; every other line stays as it was.
export function writeSliceState(root: string, mission: string, slice: string, patch: SliceStatePatch) {
  const fields: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    fields[key] = value === null ? null : Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "on" : "off") : value;
  }
  writeFrontmatter(join(sliceDir(root, mission, slice), "state.md"), fields);
}
