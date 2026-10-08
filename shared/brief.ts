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
    const subtest = i - 1;
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
    // A file that crashes on load has `exitCode` and only `error: 'test failed'`; the cause is in the
    // `# ` comments node prints just before its `# Subtest:` line.
    const comment = failure[1] + "# ";
    if (fields.some((f) => f.key === "exitCode") && lines[subtest]?.startsWith(comment + "Subtest: ")) {
      let from = subtest;
      while (from > 0 && lines[from - 1].startsWith(comment) && !lines[from - 1].startsWith(comment + "Subtest: ")) from--;
      picked.push(...lines.slice(from, subtest).filter((line) => !/^\s*#\s+at /.test(line)));
    }
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

// The runner half of `.harness/bin/brief`. Plain JS kept as a string so it ships inside the script.
// Dynamic `import()` works whether the host repo's package.json makes the script CommonJS or ESM.
const RUNNER = `(async () => {
  const { spawn } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: brief <command…>");
    process.exit(2);
  }
  const stdio = ["ignore", "pipe", "pipe"];
  const child = args.length === 1 && args[0].includes(" ")
    ? spawn(args[0], { shell: true, stdio })
    : spawn(args[0], args.slice(1), { stdio });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const code = await new Promise((resolve) => {
    child.on("error", (error) => {
      output += error.message + "\\n";
      resolve(127);
    });
    child.on("close", (exit) => resolve(exit ?? 1));
  });

  const logs = path.resolve(path.dirname(process.argv[1]), "..", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const file = STEP + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".log";
  fs.writeFileSync(path.join(logs, file), output);
  const old = fs
    .readdirSync(logs)
    .filter((name) => name.endsWith(".log"))
    .map((name) => ({ name, mtime: fs.statSync(path.join(logs, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(20);
  for (const log of old) fs.rmSync(path.join(logs, log.name), { force: true });

  const lines = output.split("\\n");
  if (lines[lines.length - 1] === "") lines.pop();
  console.log("brief: exit " + code + " · " + lines.length + " lines · full log .harness/logs/" + file);
  for (const line of pickLines(output)) console.log(line);
  process.exit(code);
})();
`;

// The standalone `.harness/bin/brief` script for one step: shebang, the picker's own source, the runner.
export function briefScript(step: string): string {
  return `#!/usr/bin/env node\nconst STEP = ${JSON.stringify(step)};\n${pickLines.toString()}\n${RUNNER}`;
}
