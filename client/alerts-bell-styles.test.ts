import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { createAlertsBellStyles } from "./alerts-bell-styles";

const theme = { colors: new Proxy({}, { get: (_, key) => String(key) }) } as unknown as PluginSurfaceProps["theme"];

test("the popover stacks above the header buttons that follow the bell", () => {
  for (const compact of [false, true]) {
    const styles = createAlertsBellStyles(theme, compact);
    assert.equal(styles.anchor.zIndex, 20);
    assert.equal(styles.popover.zIndex, 20);
    assert.equal(styles.popover.elevation, 8);
  }
});
