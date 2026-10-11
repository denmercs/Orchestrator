// Starts something from a file, so a Claude session can start it without a click. The plugin polls the start
// file, removes it, and writes what happened next to it (`<name>.result.json`).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { z } from "zod";

export type StartResult<O extends object = object> = ({ ok: true } & O) | { ok: false; error: string };

export const resultFile = (file: string) => file.replace(/\.json$/, "") + ".result.json";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function writeStartResult<O extends object>(file: string, result: StartResult<O>): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(resultFile(file), JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2) + "\n");
}

// The start request, removed as it is read so it can never start twice; null when there is none.
// A bad request is written to the result file and comes back as an error.
export function takeStartFile<I>(file: string, schema: z.ZodType<I>): { ok: true; input: I } | { ok: false; error: string } | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  rmSync(file, { force: true });
  let failed: string;
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (parsed.success) return { ok: true, input: parsed.data };
    failed = `${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`;
  } catch (error) {
    failed = `${file}: ${message(error)}`;
  }
  writeStartResult(file, { ok: false, error: failed });
  return { ok: false, error: failed };
}

// One poll: nothing without a start file, and the file waits while there is no Paseo API to start with.
// The start's own fields go after `ok: true`, so a start that answers `ok: false` is written as one.
export async function tickStartFile<I, O extends object>(
  file: string,
  schema: z.ZodType<I>,
  ready: () => boolean,
  start: (input: I) => Promise<O>,
): Promise<void> {
  if (!ready()) return;
  const taken = takeStartFile(file, schema);
  if (!taken?.ok) return;
  try {
    writeStartResult(file, { ok: true, ...(await start(taken.input)) });
  } catch (error) {
    writeStartResult(file, { ok: false, error: message(error) });
  }
}
