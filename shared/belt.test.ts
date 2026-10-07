import assert from "node:assert/strict";
import { test } from "node:test";
import { findRef, matchesRef, type CatalogSkill } from "./belt";

const skill: CatalogSkill = {
  name: "vercel-react-best-practices",
  folder: "react-best-practices",
  description: "",
  source: "vercel-labs-agent-skills",
  kind: "skill",
};

test("a ref matches a catalog skill by its name or its folder on the same source", () => {
  assert.equal(matchesRef(skill, { name: "vercel-react-best-practices", source: skill.source }), true);
  assert.equal(matchesRef(skill, { name: "react-best-practices", source: skill.source }), true);
  assert.equal(matchesRef(skill, { name: "something-else", source: skill.source }), false);
});

test("a ref on a different source does not match", () => {
  assert.equal(matchesRef(skill, { name: skill.name, source: "installed" }), false);
  assert.equal(matchesRef(skill, { name: skill.folder, source: "installed" }), false);
});

test("findRef picks the name match over a folder match on the same source", () => {
  const byFolder: CatalogSkill = { ...skill, name: "other", folder: "vercel-react-best-practices" };
  const catalog = [byFolder, skill];

  assert.equal(findRef(catalog, { name: "vercel-react-best-practices", source: skill.source }), skill);
  assert.equal(findRef(catalog, { name: "react-best-practices", source: skill.source }), skill);
  assert.equal(findRef(catalog, { name: "missing", source: skill.source }), undefined);
});
