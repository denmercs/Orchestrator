import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyShell } from "./shell-steps";

test("splits a compound command and classifies each simple command", () => {
  assert.deepEqual(classifyShell("cd x; cat a.ts && grep -n foo b.ts | head -5"), [
    { kind: "read", paths: ["x/a.ts"], text: null },
    { kind: "search", paths: [], text: null },
    { kind: "other", paths: [], text: null },
  ]);
});

const read = (...paths: string[]) => [{ kind: "read", paths, text: null }];
const search = [{ kind: "search", paths: [], text: null }];
const other = [{ kind: "other", paths: [], text: null }];

test("read commands skip option values and the script operand", () => {
  const table: [string, unknown][] = [
    ["sed -n 185,225p f.ts", read("f.ts")],
    ["sed -n -e 1,5p -e 9p f.ts", read("f.ts")],
    ["sed -f script.sed f.ts g.ts", read("f.ts", "g.ts")],
    ["head -8 f.ts", read("f.ts")],
    ["head -n 5 f.ts", read("f.ts")],
    ["head -c 100 f.ts", read("f.ts")],
    ["tail -20 f.ts", read("f.ts")],
    ["tail -n +3 f.ts", read("f.ts")],
    ["cat a b", read("a", "b")],
    ["cat -- a", read("a")],
    ["cat server/*.ts a.ts", read("a.ts")],
    ["awk -F'|' '{print $1}' f.ts", read("f.ts")],
    ["awk -v n=2 'NR>n' f.ts g.ts", read("f.ts", "g.ts")],
    ["nl f.ts", read("f.ts")],
    ["cat", other],
    ["sed -n 1,5p", other],
    ["head -8", other],
    ["awk '{print}'", other],
  ];
  for (const [command, expected] of table) assert.deepEqual(classifyShell(command), expected, command);
});

test("search commands never carry paths", () => {
  const table: [string, unknown][] = [
    ['grep -rn "x\\|y" server/*.ts', search],
    ["grep -n -e foo -A 3 f.ts", search],
    ["rg foo", search],
    ["rg -g '*.ts' foo src", search],
    ["find . -name x", search],
    ["fd foo src", search],
    ["ls", search],
    ["ls -la shared", search],
    ["git grep x", search],
    ["git status", other],
  ];
  for (const [command, expected] of table) assert.deepEqual(classifyShell(command), expected, command);
});

test("grep and rg without a file operand search only as the first pipeline stage", () => {
  assert.deepEqual(classifyShell("grep foo"), search);
  assert.deepEqual(classifyShell("grep -e foo"), search);
  assert.deepEqual(classifyShell("ls | grep foo"), [...search, ...other]);
  assert.deepEqual(classifyShell("cat a | rg -n foo | head"), [...read("a"), ...other, ...other]);
  assert.deepEqual(classifyShell("ls | grep foo f.ts"), [...search, ...search]);
  assert.deepEqual(classifyShell("ls | grep -e foo"), [...search, ...other]);
});

const edit = (...paths: string[]) => [{ kind: "edit", paths, text: null }];
const write = (path: string | null, text: string | null = null) => [{ kind: "write", paths: path === null ? [] : [path], text }];

test("in-place edits take the file operands and skip the script and BSD suffix", () => {
  const table: [string, unknown][] = [
    ["sed -i '' 's/a/b/' .harness/state.md", edit(".harness/state.md")],
    ["sed -i .bak 's/a/b/' f", edit("f")],
    ["sed -i.bak 's/a/b/' f", edit("f")],
    ["sed --in-place 's/a/b/' f g", edit("f", "g")],
    ["sed -i -e 's/a/b/' f", edit("f")],
    ["sed -i 's/a/b/' src/*.ts", edit()],
    ["perl -i -pe 's/a/b/' f", edit("f")],
    ["perl -pi -e 's/a/b/' f", edit("f")],
    ["perl -i.bak -pe 's/a/b/' f g", edit("f", "g")],
    ["sed -i 's/a/b/'", other],
  ];
  for (const [command, expected] of table) assert.deepEqual(classifyShell(command), expected, command);
});

test("redirects, tee and cp write; scratch paths and fd dups do not", () => {
  const table: [string, unknown][] = [
    ["cat > src/a.ts <<'EOF'\nbody\nEOF", write("src/a.ts", "body\n")],
    ["echo x >> f", write("f")],
    ["echo x >f", write("f")],
    ["echo x 1> f", write("f")],
    ["echo x &> f", write("f")],
    ["tee -a f", write("f")],
    ["cat a | tee f g", [...read("a"), { kind: "write", paths: ["f", "g"], text: null }]],
    ["cp a src/b.ts", write("src/b.ts")],
    ["mv -f a src/b.ts", write("src/b.ts")],
    ["sed -n 1,5p a > b", [...read("a"), ...write("b")]],
    ["echo hi > /tmp/x", other],
    ["echo hi > /dev/null", other],
    ["echo hi >/dev/null 2>&1", other],
    ["cp a /tmp/b", other],
    ["tee /private/x", other],
    ["cat a > /var/folders/x/y", read("a")],
    ["ls 2>&1", search],
    ["cat a < b", read("a")],
    ["echo x > $OUT", write(null)],
  ];
  for (const [command, expected] of table) assert.deepEqual(classifyShell(command), expected, command);
});

test("heredoc bodies are consumed, not classified as commands", () => {
  assert.deepEqual(classifyShell("cat > a <<EOF\nls; rm -rf x\ngrep y z\nEOF\ncat b"), [...write("a", "ls; rm -rf x\ngrep y z\n"), ...read("b")]);
  assert.deepEqual(classifyShell('cat > a <<"EOF"\n$X\nEOF'), write("a", "$X\n"));
  assert.deepEqual(classifyShell("cat > a <<-EOF\n\tbody\n\tEOF\n"), write("a", "body\n"));
  assert.deepEqual(classifyShell("cat <<EOF > a\none\n\ntwo\nEOF"), write("a", "one\n\ntwo\n"));
  assert.deepEqual(classifyShell("python3 - <<EOF\nopen('f','w').write('x')\nEOF"), other);
  assert.deepEqual(classifyShell("cat > a <<EOF\nbody"), write("a", "body\n"));
});

test("assignments resolve $NAME and ${NAME}; unresolved paths are dropped but the step counts", () => {
  assert.deepEqual(classifyShell("D=/repo/x; cat > $D/09.md <<EOF\nbody\nEOF"), write("/repo/x/09.md", "body\n"));
  assert.deepEqual(classifyShell("D=/repo/x\ncat ${D}/a.ts \"$D/b.ts\""), read("/repo/x/a.ts", "/repo/x/b.ts"));
  assert.deepEqual(classifyShell("D=/repo cat $D/a.ts"), read("/repo/a.ts"));
  assert.deepEqual(classifyShell("D=/repo; cat '$D/a.ts' $E/b.ts c.ts"), read("c.ts"));
  assert.deepEqual(classifyShell("F=$(mktemp); cat > $F <<EOF\nx\nEOF"), write(null, "x\n"));
  assert.deepEqual(classifyShell("cat > $(mktemp) <<EOF\nx\nEOF"), write(null, "x\n"));
  assert.deepEqual(classifyShell("cat `ls`"), read());
});

test("cd and cwd resolve relative paths", () => {
  assert.deepEqual(classifyShell("cat a.ts ../b.ts ./c.ts", "/repo/x"), read("/repo/x/a.ts", "/repo/b.ts", "/repo/x/c.ts"));
  assert.deepEqual(classifyShell("cd sub && cat a.ts", "/repo"), read("/repo/sub/a.ts"));
  assert.deepEqual(classifyShell("cd /other; cat a.ts", "/repo"), read("/other/a.ts"));
  assert.deepEqual(classifyShell("cd .. | cat a.ts", "/repo/x"), read("/repo/a.ts"));
  assert.deepEqual(classifyShell("cat /abs/a.ts", "/repo"), read("/abs/a.ts"));
  assert.deepEqual(classifyShell("cat a.ts"), read("a.ts"));
});

test("bash -c style wrappers unwrap with the same state", () => {
  assert.deepEqual(classifyShell("bash -lc 'cat a.ts'"), read("a.ts"));
  assert.deepEqual(classifyShell('sh -c "cd x; grep foo y; sed -i s/a/b/ z"'), [...search, ...edit("x/z")]);
  assert.deepEqual(classifyShell("D=/r; zsh -ic 'cat $D/a.ts'"), read("/r/a.ts"));
  assert.deepEqual(classifyShell("bash -lc 'bash -c \"cat a.ts\"'", "/repo"), read("/repo/a.ts"));
  assert.deepEqual(classifyShell("bash script.sh"), other);
});

test("control-flow keywords and closers are not commands", () => {
  assert.deepEqual(classifyShell("for f in a b; do cat $f; done"), [...other, ...read()]);
  assert.deepEqual(classifyShell("if true; then cat a.ts; else ls; fi"), [...other, ...read("a.ts"), ...search]);
  assert.deepEqual(classifyShell("(cd x; cat a.ts)"), read("x/a.ts"));
  assert.deepEqual(classifyShell("{ cat a.ts; }"), read("a.ts"));
});

// Commands as the S1 to S8 loop agents ran them (paths anonymised to /repo, /tmp and /home/dev).
const R = "/repo";
const call = (kind: string, paths: string[] = [], text: string | null = null) => ({ kind, paths, text });

test("real loop-transcript commands", () => {
  const table: [string, string | undefined, unknown[]][] = [
    ["cat /home/dev/.claude/projects/p/s/tool-results/b1.txt | sed -n 1,400p", R, [call("read", ["/home/dev/.claude/projects/p/s/tool-results/b1.txt"]), call("other")]],
    ["cd docs/telemetry/agent-memory; grep -n \"labelKey = \\|lines.push\" verdict.mjs", R, [call("search")]],
    ["sed -n 25,50p shared/memory.test.ts; sed -n 221,275p shared/memory.test.ts", R, [call("read", ["/repo/shared/memory.test.ts"]), call("read", ["/repo/shared/memory.test.ts"])]],
    ["grep -n \"Cycle 5:\" .harness/state.md; grep -n \"export function\" shared/replay.ts; .harness/bin/brief node --import ./test-support/register.mjs --test shared/replay.test.ts | tail -7; npm run typecheck 2>&1 | tail -2", R, [call("search"), call("search"), call("other"), call("other"), call("other"), call("other")]],
    ["cat AGENTS.md 2>/dev/null | head -60; git diff origin/main...HEAD -- server/loop.ts", R, [call("read", ["/repo/AGENTS.md"]), call("other"), call("other")]],
    ["cd /repo/sub; grep -rn \"loopAgents\" docs/telemetry | head -3; cat ~/.paseo/agents/*/*.json 2>/dev/null | grep -o '\"loop-repo\":\"[^\"]*\"' | sort | uniq -c", R, [call("search"), call("other"), call("read"), call("other"), call("other"), call("other")]],
    ["perl -pi -e 's/^- \\[ \\] (Cycle 1 — )/- [x] $1/' .harness/state.md && grep -n \"^- \\[.\\] Cycle\" .harness/state.md | cut -c1-30", R, [call("edit", ["/repo/.harness/state.md"]), call("search"), call("other")]],
    ["sed -i '' 's/- \\[ \\] Cycle 2 /- [x] Cycle 2 /' .harness/state.md && grep -c \"Cycle 2:\" .harness/state.md", R, [call("edit", ["/repo/.harness/state.md"]), call("search")]],
    ["cat > shared/story-outcome.test.ts <<'EOF'\nimport { test } from \"node:test\";\nconst x = `a > b`;\nEOF", R, [call("write", ["/repo/shared/story-outcome.test.ts"], "import { test } from \"node:test\";\nconst x = `a > b`;\n")]],
    ["cat >> shared/memory.ts <<'EOF'\n\nconst MEMORY_DIR = join(\".harness\", \"memory\");\nEOF", R, [call("write", ["/repo/shared/memory.ts"], "\nconst MEMORY_DIR = join(\".harness\", \"memory\");\n")]],
    ["cp shared/memory.ts /tmp/s3/c5.ts; cp /tmp/s3/c4.ts shared/memory.ts\n.harness/bin/brief npm test -- shared/memory.test.ts 2>&1 | grep -E \"^# (pass|fail)\"\ncp /tmp/s3/c5.ts shared/memory.ts", R, [call("other"), call("write", ["/repo/shared/memory.ts"]), call("other"), call("other"), call("write", ["/repo/shared/memory.ts"])]],
    ["printf 'export const a=1;\\n' > shared/memory.ts\n.harness/bin/brief npm test 2>&1 | grep -E \"^# (pass|fail)\"", R, [call("write", ["/repo/shared/memory.ts"]), call("other"), call("other")]],
    ["python3 - <<'EOF'\np='.harness/state.md'\ns=open(p).read()\ns=s.replace('a','b')\nopen(p,'w').write(s)\nEOF\nsed -n 1,5p .harness/state.md", R, [call("other"), call("read", ["/repo/.harness/state.md"])]],
    ["cd /repo; git status --short; git stash list | grep s8r3; git diff --stat; sed -i 's/^- \\[ \\] yes — .*//' /dev/null; .harness/bin/brief npm test | tail -8", R, [call("other"), call("other"), call("other"), call("other"), call("other"), call("other"), call("other")]],
    ["S=/home/dev/init/stories; cat $S/09-*.md; sed -n 1,30p $S/07-replay.md | grep -iA3 \"exploration\\|baseline\"", R, [call("read"), call("read", ["/home/dev/init/stories/07-replay.md"]), call("other")]],
    ["ln -s /home/dev/Orchestrator/node_modules node_modules && .harness/bin/brief npm test 2>&1 | grep -E \"^# (pass|fail)|not ok\" | head; rm node_modules", R, [call("other"), call("other"), call("other"), call("other"), call("other")]],
    ["sed -n 80,200p .harness/state.md; ls -d node_modules node_modules/@getpaseo/plugin 2>&1 | head", R, [call("read", ["/repo/.harness/state.md"]), call("search"), call("other")]],
    ["mkdir -p /tmp/s3probe && cat > /tmp/s3probe/p.test.ts <<'EOF'\nimport { test } from \"node:test\";\nEOF", R, [call("other"), call("other")]],
    ["cd /home/dev/worktrees/s7; grep -rn \"loopAgents\" docs/telemetry --include=*.mjs | head -3; ls ~/.paseo/agents | wc -l", R, [call("search"), call("other"), call("search"), call("other")]],
    ["for f in server/a.ts shared/b.ts; do cp $f /tmp/$(basename $f); git show HEAD~1:$f > $f; done", R, [call("other"), call("other"), call("write")]],
  ];
  for (const [command, cwd, expected] of table) assert.deepEqual(classifyShell(command, cwd), expected, command);
});
