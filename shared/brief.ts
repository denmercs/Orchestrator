// Picks the lines of command output worth showing a step agent: failing tests with their assertion,
// then the run summary. Self-contained (no imports, no module helpers) because `briefScript` embeds
// its source in the standalone `.harness/bin/brief` script.
export function pickLines(output: string, max = 80): string[] {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const keep = ["location", "error", "expected", "actual", "operator"];
  const picked: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const failure = /^(\s*)not ok \d+ - /.exec(lines[i]);
    if (!failure) continue;
    const pad = failure[1] + "  ";
    if (lines[i + 1] !== pad + "---") continue;
    const fields: { key: string; lines: string[] }[] = [];
    let j = i + 2;
    for (; j < lines.length && lines[j] !== pad + "..."; j++) {
      const key = lines[j].startsWith(pad) ? /^(\w+):/.exec(lines[j].slice(pad.length)) : null;
      if (key) fields.push({ key: key[1], lines: [lines[j]] });
      else if (fields.length > 0) fields[fields.length - 1].lines.push(lines[j]);
    }
    i = j;
    if (fields.some((f) => f.key === "failureType" && f.lines[0].includes("subtestsFailed"))) continue;
    picked.push(failure.input);
    for (const f of fields) if (keep.includes(f.key)) picked.push(...f.lines);
  }

  const failingTests = lines.indexOf("✖ failing tests:");
  if (failingTests >= 0) {
    let end = lines.length;
    while (end > failingTests && lines[end - 1].trim() === "") end--;
    picked.push(...lines.slice(failingTests, end).filter((line) => !/^\s+at /.test(line)));
  }

  let start = lines.length;
  while (start > 0 && /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(lines[start - 1])) start--;
  const summary = lines.slice(start);
  if (failingTests >= 0) summary.push(...lines.slice(0, failingTests).filter((line) => line.startsWith("ℹ ")));

  if (picked.length + summary.length === 0) return lines.slice(-max);
  if (picked.length + summary.length <= max) return [...picked, ...summary];
  const room = Math.max(0, max - summary.length - 1);
  return [...picked.slice(0, room), ...summary, `… ${picked.length - room} more lines in the log`].slice(-max);
}
