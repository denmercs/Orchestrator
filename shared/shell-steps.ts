// Classifies the simple commands inside one shell tool call (see CONTEXT.md, "Telemetry row"). Pure:
// no node imports, and it reads the command text alone.

export type ShellKind = "read" | "search" | "edit" | "write" | "other";

export type ShellCall = {
  kind: ShellKind;
  paths: string[];
  text: string | null;
};

// One word of a command line. `text` has quotes and backslashes removed; `quoted` is true when any
// part of the word was quoted or escaped, so later rules can tell `'-i'` or `'$X'` from a bare one.
export type Word = { text: string; quoted: boolean; literal?: boolean };

// One simple command: its words, and the index of its stage in the pipeline it belongs to
// (0 for the first stage, or a command not in a pipeline).
// `heredoc` holds the body of a `<<EOF` attached to the command, filled in when the tokenizer reaches
// the line break that starts the body.
export type Command = { words: Word[]; stage: number; heredoc?: { text: string } };

type Separator = ";" | "&&" | "||" | "&" | "|" | "\n";

// Splits a script into simple commands. Quotes (single, double) and backslashes keep operator
// characters inside a word. A `&` that touches `>` or `<` is a redirect (`2>&1`, `&>f`), not a
// separator, so it stays in the word.
export function tokenize(script: string): Command[] {
  const commands: Command[] = [];
  let words: Word[] = [];
  let stage = 0;
  let text = "";
  let quoted = false;
  let inWord = false;
  let literal = false;
  let box: { text: string } | undefined;
  let pending: { delimiter: string; strip: boolean; box: { text: string } }[] = [];

  const endWord = () => {
    if (inWord) words.push(literal ? { text, quoted, literal } : { text, quoted });
    text = "";
    quoted = false;
    literal = false;
    inWord = false;
  };
  const endCommand = (separator: Separator) => {
    endWord();
    if (words.length > 0) commands.push(box ? { words, stage, heredoc: box } : { words, stage });
    words = [];
    box = undefined;
    stage = separator === "|" ? stage + 1 : 0;
  };

  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (ch === "\\") {
      if (script[i + 1] === "\n") {
        i += 1;
        continue;
      }
      inWord = true;
      quoted = true;
      i += 1;
      if (i < script.length) text += script[i];
      literal = true;
    } else if (ch === "'") {
      inWord = true;
      quoted = true;
      const end = script.indexOf("'", i + 1);
      const stop = end === -1 ? script.length : end;
      text += script.slice(i + 1, stop);
      literal = true;
      i = stop;
    } else if (ch === '"') {
      inWord = true;
      quoted = true;
      i += 1;
      while (i < script.length && script[i] !== '"') {
        if (script[i] === "\\" && i + 1 < script.length && '"\\$`'.includes(script[i + 1])) i += 1;
        text += script[i];
        i += 1;
      }
    } else if (ch === ";") {
      endCommand(";");
    } else if (ch === "\n") {
      endCommand("\n");
      // Heredoc bodies start on the next line and run to their delimiter line; none of it is commands.
      let pos = i + 1;
      for (const heredoc of pending) {
        const lines: string[] = [];
        while (pos < script.length) {
          const end = script.indexOf("\n", pos);
          const raw = script.slice(pos, end === -1 ? script.length : end);
          pos = end === -1 ? script.length : end + 1;
          const line = heredoc.strip ? raw.replace(/^\t+/, "") : raw;
          if (line === heredoc.delimiter) break;
          lines.push(line);
        }
        heredoc.box.text = lines.map((line) => `${line}\n`).join("");
      }
      i = pos - 1;
      pending = [];
    } else if (ch === "<" && script[i + 1] === "<" && script[i + 2] !== "<") {
      endWord();
      i += 2;
      const strip = script[i] === "-";
      if (strip) i += 1;
      while (script[i] === " " || script[i] === "\t") i += 1;
      let delimiter = "";
      for (; i < script.length && !/[\s;&|<>]/.test(script[i]); i++) {
        if (script[i] === "'" || script[i] === '"') {
          const close = script.indexOf(script[i], i + 1);
          const stop = close === -1 ? script.length : close;
          delimiter += script.slice(i + 1, stop);
          i = stop;
        } else {
          delimiter += script[i];
        }
      }
      i -= 1;
      if (delimiter !== "") {
        box ??= { text: "" };
        pending.push({ delimiter, strip, box });
      }
    } else if (ch === "|") {
      if (script[i + 1] === "|") {
        i += 1;
        endCommand("||");
      } else {
        if (script[i + 1] === "&") i += 1;
        endCommand("|");
      }
    } else if (ch === "&") {
      if (script[i + 1] === "&") {
        i += 1;
        endCommand("&&");
      } else if (script[i + 1] === ">" || script[i - 1] === ">" || script[i - 1] === "<" || script[i + 1] === "<") {
        inWord = true;
        text += ch;
      } else {
        endCommand("&");
      }
    } else if (ch === "$" && script[i + 1] === "(") {
      // `$(…)` stays one word, spaces and all; `resolvable` drops it later.
      inWord = true;
      let depth = 0;
      for (; i < script.length; i++) {
        text += script[i];
        if (script[i] === "(") depth += 1;
        else if (script[i] === ")" && --depth === 0) break;
      }
    } else if (ch === " " || ch === "\t") {
      endWord();
    } else {
      inWord = true;
      text += ch;
    }
  }
  endCommand("\n");
  return commands;
}

// A small posix join: `base` is "" for "no base", and an absolute `path` ignores it.
function resolve(base: string, path: string): string {
  if (path.startsWith("/") || base === "") return path;
  const absolute = base.startsWith("/");
  const parts: string[] = [];
  for (const part of `${base}/${path}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(part);
  }
  return (absolute ? "/" : "") + parts.join("/");
}

const READ = new Set(["cat", "head", "tail", "nl", "bat", "less", "awk", "sed"]);
const SEARCH = new Set(["grep", "egrep", "rg", "find", "fd", "ls"]);
// Search commands that take a pattern first, so a file operand is what follows it.
const PATTERN_SEARCH = new Set(["grep", "egrep", "rg"]);

// Options that consume the next word, per command. A joined form (`-n5`, `--lines=5`) is one word
// and needs no entry.
const VALUE_OPTIONS: Record<string, string[]> = {
  cat: [],
  head: ["-n", "-c", "--lines", "--bytes"],
  tail: ["-n", "-c", "-s", "--lines", "--bytes", "--pid", "--sleep-interval"],
  nl: ["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"],
  bat: ["-l", "-r", "-H", "--language", "--line-range", "--highlight-line", "--theme", "--style"],
  less: ["-b", "-h", "-j", "-p", "-P", "-t", "-x", "-y", "-z"],
  awk: ["-F", "-v", "-f", "-e", "--file", "--source", "--assign", "--field-separator"],
  sed: ["-e", "-f", "-l", "--expression", "--file", "--line-length"],
  grep: ["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--include", "--exclude", "--exclude-dir", "--after-context", "--before-context", "--context", "--directories", "--devices"],
  rg: ["-e", "-f", "-g", "-t", "-T", "-m", "-A", "-B", "-C", "-j", "-M", "-E", "-r", "-d", "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--max-count", "--after-context", "--before-context", "--context", "--replace", "--threads", "--max-columns", "--max-depth", "--encoding"],
};
VALUE_OPTIONS.egrep = VALUE_OPTIONS.grep;

// Options that supply the script or pattern themselves, so no script or pattern operand follows.
const PROGRAM_OPTIONS: Record<string, string[]> = {
  sed: ["-e", "-f", "--expression", "--file"],
  awk: ["-f", "-e", "--file", "--source"],
  grep: ["-e", "-f", "--regexp", "--file"],
  rg: ["-e", "-f", "--regexp", "--file"],
};
PROGRAM_OPTIONS.egrep = PROGRAM_OPTIONS.grep;

const operands = (words: Word[]): Word[] => words.filter((word) => word.quoted || !word.text.startsWith("-"));

// A word is an option when it starts with `-` and is more than a bare `-` (stdin). A quoted word with
// a space in it is an operand, such as a pattern `"-x y"`.
const isOption = (word: Word): boolean =>
  word.text.length > 1 && word.text.startsWith("-") && !(word.quoted && /\s/.test(word.text));

// Splits the words after the command name into its operands, and whether an option already gave the
// script or pattern. `valueOptions` and `programOptions` come from the tables above.
function splitOperands(words: Word[], name: string): { operands: Word[]; hasProgram: boolean } {
  const valueOptions = VALUE_OPTIONS[name] ?? [];
  const programOptions = PROGRAM_OPTIONS[name] ?? [];
  const found: Word[] = [];
  let hasProgram = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word.text === "--" && !word.quoted) {
      found.push(...words.slice(i + 1));
      break;
    }
    if (!isOption(word)) {
      found.push(word);
      continue;
    }
    const optionName = word.text.split("=")[0];
    if (programOptions.includes(optionName) || (word.text.length > 2 && !word.text.startsWith("--") && programOptions.includes(word.text.slice(0, 2)))) hasProgram = true;
    if (valueOptions.includes(word.text)) i += 1;
  }
  return { operands: found, hasProgram };
}

// A path to keep: not stdin, and nothing left for the shell to expand.
const resolvable = (text: string): boolean => text !== "-" && !/[*?[\]{}$`~]/.test(text);

const other: ShellCall = { kind: "other", paths: [], text: null };
const search: ShellCall = { kind: "search", paths: [], text: null };

// Classifies a git invocation: only `git grep` counts, and it always searches the repo.
function classifyGit(words: Word[]): ShellCall {
  for (let i = 0; i < words.length; i++) {
    if (words[i].text === "-C" || words[i].text === "-c") i += 1;
    else if (!words[i].text.startsWith("-")) return words[i].text === "grep" ? search : other;
  }
  return other;
}

// Output that goes nowhere a later step could care about: devices and scratch directories.
const SCRATCH = ["/dev/", "/tmp/", "/private/", "/var/folders/"];
const isScratch = (path: string): boolean => SCRATCH.some((prefix) => path.startsWith(prefix));

// A write to a file; a scratch destination is `other`, and one that cannot be resolved has no path.
function writeCall(targets: Word[], dir: string, text: string | null): ShellCall {
  const resolved = targets.map((word) => resolve(dir, word.text));
  if (resolved.length > 0 && resolved.every(isScratch)) return other;
  const kept = targets.filter((word) => resolvable(word.text)).map((word) => resolve(dir, word.text)).filter((path) => !isScratch(path));
  return { kind: "write", paths: kept, text };
}

// Pulls redirects out of a command's words. Returns the remaining words and the output redirect
// targets; input redirects and fd dups (`2>&1`) are dropped.
function splitRedirects(words: Word[]): { words: Word[]; targets: Word[] } {
  const kept: Word[] = [];
  const targets: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const match = words[i].quoted ? null : /^(?:\d*|&)(>>|>\|?|<)(.*)$/.exec(words[i].text);
    if (!match) {
      kept.push(words[i]);
      continue;
    }
    let target: Word | undefined = { text: match[2], quoted: false };
    if (match[2] === "") {
      i += 1;
      target = words[i];
    }
    if (target && match[1] !== "<" && !target.text.startsWith("&")) targets.push(target);
  }
  return { words: kept, targets };
}

const IN_PLACE = /^(-[A-Za-z]*i|--in-place)/;

function classifyEdit(name: string, rest: Word[], dir: string): ShellCall {
  let args = rest;
  let files: Word[];
  if (name === "sed") {
    // BSD `-i ''` and `-i .bak`: the word after a bare `-i` is the suffix, not the script.
    const at = rest.findIndex((word) => !word.quoted && word.text === "-i");
    const next = rest[at + 1];
    if (at !== -1 && next && (next.text === "" || (!next.quoted && next.text.startsWith(".")))) args = [...rest.slice(0, at + 1), ...rest.slice(at + 2)];
    const split = splitOperands(args, name);
    files = split.hasProgram ? split.operands : split.operands.slice(1);
  } else {
    // perl: `-e`/`-E` (alone or ending a cluster like `-pe`) take the program as the next word.
    files = [];
    let hasProgram = false;
    for (let i = 0; i < args.length; i++) {
      const word = args[i];
      if (word.text === "--" && !word.quoted) {
        files.push(...args.slice(i + 1));
        break;
      }
      if (!isOption(word)) files.push(word);
      else if (/^-[A-Za-z]*[eE]$/.test(word.text)) {
        hasProgram = true;
        i += 1;
      }
    }
    if (!hasProgram) files = files.slice(1);
  }
  if (files.length === 0) return other;
  const resolved = files.map((word) => resolve(dir, word.text));
  if (resolved.every(isScratch)) return other;
  const kept = files.filter((word) => resolvable(word.text)).map((word) => resolve(dir, word.text)).filter((path) => !isScratch(path));
  return { kind: "edit", paths: kept, text: null };
}

function classifyCommand(words: Word[], stage: number, dir: string): ShellCall {
  if (words.length === 0) return other;
  const [first, ...rest] = words;
  const name = first.text.split("/").pop() ?? "";
  if (name === "git") return classifyGit(rest);
  if (name === "tee") {
    const files = operands(rest);
    return files.length === 0 ? other : writeCall(files, dir, null);
  }
  if (name === "cp" || name === "mv") {
    const files = splitOperands(rest, name).operands;
    return files.length < 2 ? other : writeCall([files[files.length - 1]], dir, null);
  }
  if (name === "perl" && rest.some((word) => !word.quoted && /^-[A-Za-z]*i/.test(word.text))) return classifyEdit(name, rest, dir);
  if (READ.has(name)) {
    if (name === "sed" && rest.some((word) => !word.quoted && IN_PLACE.test(word.text))) return classifyEdit(name, rest, dir);
    const split = splitOperands(rest, name);
    const files = split.hasProgram || !(name === "sed" || name === "awk") ? split.operands : split.operands.slice(1);
    if (files.length === 0 || files.every((word) => word.text === "-")) return other;
    return { kind: "read", paths: files.filter((word) => resolvable(word.text)).map((word) => resolve(dir, word.text)), text: null };
  }
  if (PATTERN_SEARCH.has(name)) {
    const split = splitOperands(rest, name);
    const files = split.hasProgram ? split.operands : split.operands.slice(1);
    return stage > 0 && files.length === 0 ? other : search;
  }
  if (SEARCH.has(name)) return search;
  return other;
}

function classify(command: Command, dir: string): ShellCall[] {
  const { words, targets } = splitRedirects(command.words);
  const base = classifyCommand(words, command.stage, dir);
  const writes = targets.map((target) => writeCall([target], dir, command.heredoc?.text ?? null)).filter((call) => call.kind === "write");
  if (base.kind !== "other") return [base, ...writes];
  return writes.length > 0 ? writes : [other];
}

type State = { dir: string; vars: Map<string, string> };

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
// Words that open or close a compound command and are not commands themselves.
const OPENERS = new Set(["do", "then", "else", "{", "("]);
const CLOSERS = new Set([")", "}", "done", "fi"]);

// Replaces `$NAME` and `${NAME}` that are known; anything else (`$(…)`, unknown names) is left for
// `resolvable` to drop. Single-quoted and escaped words are left alone.
function expand(word: Word, vars: Map<string, string>): Word {
  if (word.literal || !word.text.includes("$")) return word;
  const text = word.text.replace(/\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/g, (whole, a, b) => vars.get(a ?? b) ?? whole);
  return { ...word, text };
}

// Peels keywords, closers and a `(` glued to the first word off a command's words.
function peel(words: Word[]): Word[] {
  let list = words;
  for (;;) {
    const first = list[0];
    if (first && !first.quoted && OPENERS.has(first.text)) list = list.slice(1);
    else if (first && !first.quoted && first.text.length > 1 && first.text.startsWith("(")) list = [{ ...first, text: first.text.slice(1) }, ...list.slice(1)];
    else break;
  }
  // A `)` glued to the last word closes a subshell only when the word has no `(` to match it.
  const last = list[list.length - 1];
  if (last && !last.quoted && last.text.length > 1 && last.text.endsWith(")") && !last.text.includes("(")) list = [...list.slice(0, -1), { ...last, text: last.text.replace(/\)+$/, "") }];
  while (list.length > 0 && !list[list.length - 1].quoted && CLOSERS.has(list[list.length - 1].text)) list = list.slice(0, -1);
  return list;
}

const isShell = (name: string): boolean => name === "bash" || name === "sh" || name === "zsh";

function run(command: string, state: State, calls: ShellCall[]): void {
  for (const simple of tokenize(command)) {
    let words = peel(simple.words);
    while (words.length > 0 && !words[0].quoted) {
      const match = ASSIGNMENT.exec(words[0].text);
      if (!match) break;
      state.vars.set(match[1], expand({ text: match[2], quoted: false, literal: words[0].literal }, state.vars).text);
      words = words.slice(1);
    }
    if (words.length === 0) continue;
    words = words.map((word) => expand(word, state.vars));
    const name = words[0].text.split("/").pop() ?? "";
    if (words[0].text === "cd") {
      const target = operands(words.slice(1))[0];
      if (target) state.dir = resolvable(target.text) ? resolve(state.dir, target.text) : "";
      continue;
    }
    if (isShell(name)) {
      const at = words.findIndex((word, index) => index > 0 && !word.quoted && /^-[A-Za-z]*c$/.test(word.text));
      if (at !== -1 && words[at + 1]) {
        run(words[at + 1].text, state, calls);
        continue;
      }
    }
    calls.push(...classify({ ...simple, words }, state.dir));
  }
}

// One call per simple command (plus one per file it redirects into), in order. `cd` only moves the directory later paths resolve against,
// and gives no call; `NAME=value` words are remembered for `$NAME`, and `bash -c '…'` is classified as the script it runs.
// `cwd` is where the shell started, when the host says.
export function classifyShell(command: string, cwd?: string): ShellCall[] {
  const calls: ShellCall[] = [];
  run(command, { dir: cwd ?? "", vars: new Map() }, calls);
  return calls;
}
