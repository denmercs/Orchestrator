import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLabel, routeStart, START_HINTS } from "./start-route";

test("routeStart: a bare key is a Jira start", () => {
  assert.deepEqual(routeStart("QUICK-123"), { kind: "jira", key: "QUICK-123" });
});

test("routeStart: a lowercase key is uppercased", () => {
  assert.deepEqual(routeStart("  quick-12 "), { kind: "jira", key: "QUICK-12" });
});

test("routeStart: a /browse/ URL holds the key", () => {
  assert.deepEqual(routeStart("https://lifeway.atlassian.net/browse/QUICK-45"), { kind: "jira", key: "QUICK-45" });
  assert.deepEqual(routeStart("https://jira.example.com/browse/ab2-7?focus=1"), { kind: "jira", key: "AB2-7" });
});

test("routeStart: a selectedIssue= URL holds the key", () => {
  assert.deepEqual(
    routeStart("https://lifeway.atlassian.net/jira/software/projects/QUICK/boards/1?selectedIssue=QUICK-9"),
    { kind: "jira", key: "QUICK-9" },
  );
});

test("routeStart: a sentence that mentions a key starts an initiative", () => {
  assert.deepEqual(routeStart("Fix QUICK-12 login"), { kind: "initiative", title: "Fix QUICK-12 login" });
});

test("routeStart: an Atlassian URL with no key starts an initiative", () => {
  const url = "https://lifeway.atlassian.net/jira/software/projects/QUICK/boards/1";
  assert.deepEqual(routeStart(url), { kind: "initiative", title: url });
});

test("routeStart: prose starts an initiative with whitespace collapsed", () => {
  assert.deepEqual(routeStart("  Add a   dark mode\n to the\tdashboard  "), {
    kind: "initiative",
    title: "Add a dark mode to the dashboard",
  });
});

test("routeStart: blank input routes nowhere", () => {
  assert.equal(routeStart(""), null);
  assert.equal(routeStart("   \n\t"), null);
});

test("detectLabel: names the route and its colour key", () => {
  assert.deepEqual(detectLabel({ kind: "jira", key: "QUICK-1" }), {
    text: "Jira ticket · track from issue type",
    color: "statusSuccess",
  });
  assert.deepEqual(detectLabel({ kind: "initiative", title: "Dark mode" }), {
    text: "New initiative → Architecture",
    color: "accent",
  });
});

test("START_HINTS: feature, bug and anything else, each with a colour key", () => {
  assert.deepEqual(
    START_HINTS.map((hint) => hint.color),
    ["statusSuccess", "statusDanger", "accent"],
  );
  assert.match(START_HINTS[0].text, /feature|story/i);
  assert.match(START_HINTS[0].text, /plan/i);
  assert.match(START_HINTS[1].text, /bug/i);
  assert.match(START_HINTS[1].text, /diagnose/i);
  assert.match(START_HINTS[2].text, /new initiative/i);
});
