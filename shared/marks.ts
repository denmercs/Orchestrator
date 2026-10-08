// Workspace names are plain text, so the role mark is a text glyph. Monochrome on purpose: it takes
// the row's text color instead of competing with Paseo's colored status dot beside it.
// The server reads WORKER_MARK too: a new workspace named with it belongs to an epic loop's child.
export const HARNESS_MARK = "★";
export const WORKER_MARK = "↳";
