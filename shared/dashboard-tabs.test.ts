import assert from "node:assert/strict";
import { test } from "node:test";
import { TABS } from "./dashboard-tabs";

test("the dashboard has five tabs in order: Initiatives, Today, Todos, Board, Pulse", () => {
  assert.deepEqual(
    TABS.map((tab) => [tab.id, tab.label]),
    [
      ["initiatives", "Initiatives"],
      ["today", "Today"],
      ["todos", "Todos"],
      ["board", "Board"],
      ["pulse", "Pulse"],
    ],
  );
});
