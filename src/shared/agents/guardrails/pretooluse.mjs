#!/usr/bin/env node
/**
 * Den's PreToolUse hook for Claude Code sessions it launches (den-claude).
 * Den passes it in the agent's own settings file (--settings); it never
 * touches the user's ~/.claude. Plain Node with no imports beyond node:*,
 * so it starts in a few tens of milliseconds on every Bash and Read call.
 *
 * Hook contract (https://code.claude.com/docs/en/hooks, "PreToolUse" and
 * "Exit code output"): the tool call arrives as JSON on stdin
 * ({ tool_name, tool_input, cwd, ... }). Exit 2 blocks the call, and Claude
 * gets stderr as the reason. Exit 0 with no output lets the normal
 * permission flow decide. Any error here exits 0: a broken hook never
 * blocks anything.
 *
 * It blocks exactly two things, and nothing else:
 *
 *   1. Whole-file reads of a log or a large file into the conversation:
 *      - Read with no `limit`;
 *      - Bash `cat` or `less` of it, when its output reaches the
 *        conversation (the last stage of a pipeline, stdout not redirected);
 *      - Bash `tail` from a line or byte (`tail +1`, `-n +1`, `--lines=+1`),
 *        which prints the whole rest of the file, likewise. A plain `tail`
 *        prints 10 lines, a slice, and passes.
 *      A log is `*.log` (or `*.log.<N>`), a `.jsonl` under `.dev-metrics/`,
 *      or a `.jsonl` under a `.claude/projects/` directory (a transcript).
 *      Large is over LARGE_BYTES.
 *   2. Foreground `sleep` in Bash: `sleep N` on its own or inside an
 *      `until ...; do sleep N; done` (or while/for) polling loop. A Bash call
 *      with run_in_background, or a `sleep ... &`, is not blocked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  apiOnlyDecision,
  apiOnlyMessage,
  audit,
  loadRules,
} from "./api-only.mjs";

/** Over this many bytes, a file is large (Claude Code's own Read cap). */
export const LARGE_BYTES = 256 * 1024;

const READ_HINT =
  "Read a slice instead: `tail -n 100 <file>`, `grep -n <pattern> <file>`, " +
  "or a Read with offset and limit. To go through all of it, hand it to a " +
  "subagent and ask it for the conclusion.";

const SLEEP_HINT =
  "Waiting with sleep is polling. Run the long command with " +
  "run_in_background (you are told when it ends), or use a wait primitive " +
  "(the Monitor tool with an until-condition, or the command's own --wait). " +
  "Do not loop on sleep.";

/** Is this path a log: *.log, .dev-metrics/*.jsonl, or a transcript? */
export function isLogPath(p) {
  const s = String(p).replace(/\\/g, "/");
  const base = s.slice(s.lastIndexOf("/") + 1);
  if (/\.log(\.\d+)?$/i.test(base)) return true;
  if (!/\.jsonl$/i.test(base)) return false;
  if (/(^|\/)\.dev-metrics\//.test(s)) return true;
  return /(^|\/)\.claude\/projects\//.test(s);
}

/** The file's size, or -1 when it can't be read (a glob, a variable). */
function sizeOf(p, cwd, home) {
  try {
    let f = String(p);
    if (home && (f === "~" || f.startsWith("~/")))
      f = path.join(home, f.slice(1));
    const st = fs.statSync(path.resolve(cwd || ".", f));
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

/** Why reading all of this file is blocked, or null. */
export function wholeReadReason(p, cwd, home) {
  if (isLogPath(p)) return "a log";
  const n = sizeOf(p, cwd, home);
  if (n > LARGE_BYTES) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return null;
}

/**
 * Split a shell command into pipelines of stages. Each stage is
 * { words, stdoutRedirected, background }. Quotes and backslashes are
 * honoured, `$( … )` stays inside its word, comments and heredoc bodies are
 * skipped. Not a full shell parser: anything it can't read is left alone.
 */
export function parseShell(src) {
  const pipelines = [];
  let stages = [];
  let words = [];
  let word = "";
  let inWord = false;
  const heredocs = [];

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endStage = () => {
    endWord();
    if (words.length) stages.push(stage(words));
    words = [];
  };
  const endPipeline = (background = false) => {
    endStage();
    if (stages.length) {
      if (background) stages[stages.length - 1].background = true;
      pipelines.push(stages);
    }
    stages = [];
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      if (src[i + 1] !== "\n") word += src[i + 1];
      inWord = inWord || src[i + 1] !== "\n";
      i += 2;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      word += src.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) {
          word += src[j + 1];
          j += 2;
        } else word += src[j++];
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) break;
      }
      word += src.slice(i, j + 1);
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      const end = j < 0 ? src.length : j;
      word += src.slice(i, end + 1);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      endPipeline();
      i++;
      // Skip heredoc bodies that start on this line.
      while (heredocs.length) {
        const delim = heredocs.shift();
        for (;;) {
          if (i >= src.length) break;
          const nl = src.indexOf("\n", i);
          const line = src.slice(i, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl + 1;
          if (line.replace(/^\t+/, "") === delim) break;
        }
      }
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      endWord();
      let j = i + 2;
      if (src[j] === "-") j++;
      while (src[j] === " " || src[j] === "\t") j++;
      let d = "";
      while (j < src.length && !/[\s;&|<>()]/.test(src[j])) d += src[j++];
      heredocs.push(d.replace(/['"\\]/g, ""));
      words.push("<<");
      i = j;
      continue;
    }
    if (c === "&" && src[i + 1] === "&") {
      endPipeline();
      i += 2;
      continue;
    }
    if (c === "|" && src[i + 1] === "|") {
      endPipeline();
      i += 2;
      continue;
    }
    if (c === "&" && src[i + 1] === ">") {
      endWord();
      words.push(src[i + 2] === ">" ? "&>>" : "&>");
      i += src[i + 2] === ">" ? 3 : 2;
      continue;
    }
    if (c === "|") {
      endStage();
      i += src[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      endPipeline(true);
      i++;
      continue;
    }
    if (c === ";" || c === "(" || c === ")") {
      endPipeline();
      i++;
      continue;
    }
    if (c === ">" || c === "<") {
      // A redirection operator: its own word, with any fd before it.
      const fd = inWord && /^\d+$/.test(word) ? word : "";
      if (fd) {
        word = "";
        inWord = false;
      } else endWord();
      let op = fd + c;
      let j = i + 1;
      if (src[j] === ">" || src[j] === "&") op += src[j++];
      words.push(op);
      i = j;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endPipeline();
  return pipelines;
}

const PREFIX = new Set([
  "do",
  "then",
  "else",
  "elif",
  "while",
  "until",
  "if",
  "!",
  "{",
  "}",
  "time",
  "exec",
  "command",
  "nohup",
]);

/** One stage: its command and arguments, with redirections taken out. */
function stage(raw) {
  let k = 0;
  const assigns = [];
  while (
    k < raw.length &&
    (PREFIX.has(raw[k]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw[k]))
  ) {
    if (!PREFIX.has(raw[k])) assigns.push(raw[k]);
    k++;
  }
  const words = [];
  const inputs = [];
  let stdoutRedirected = false;
  for (let j = k; j < raw.length; j++) {
    const w = raw[j];
    const r = /^(\d*|&)>>?(&?)$/.exec(w);
    if (r) {
      // Claude Code shows stdout and stderr both, so only stdout sent to a
      // file leaves the chat: `>f`, `1>f`, `&>f`. `2>f`, `2>&1`, `>&2` don't.
      const toFd = r[2] === "&" && /^\d+$/.test(raw[j + 1] ?? "");
      if ((r[1] === "" || r[1] === "1" || r[1] === "&") && !toFd)
        stdoutRedirected = true;
      j++;
      continue;
    }
    if (w === "<") {
      if (raw[j + 1] !== undefined) inputs.push(raw[j + 1]);
      j++;
      continue;
    }
    if (w === "<<") {
      j++;
      continue;
    }
    words.push(w);
  }
  return { words, inputs, stdoutRedirected, background: false, assigns };
}

const base = (w) => String(w).slice(String(w).lastIndexOf("/") + 1);

/**
 * tail reads the whole rest of the file only when it starts from a line or
 * byte (`+N`, `-n +N`, `-n+N`, `--lines=+N`, the same for -c/--bytes); a
 * plain tail prints 10 lines, and a count or a follow is a slice.
 */
function tailReadsAll(args) {
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (/^\+\d+$/.test(a)) return true;
    if (/^-[nc]\+\d+$/.test(a) || /^--(lines|bytes)=\+\d+$/.test(a))
      return true;
    if (
      (a === "-n" || a === "-c" || a === "--lines" || a === "--bytes") &&
      /^\+\d+$/.test(args[j + 1] ?? "")
    )
      return true;
  }
  return false;
}

/** The file arguments of cat, less or tail (options and their values out). */
function fileArgs(cmd, args) {
  const out = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (a === "--") {
      out.push(...args.slice(j + 1));
      break;
    }
    if (a === "-") continue;
    if (a.startsWith("-") || (cmd === "tail" && /^\+\d+$/.test(a))) {
      if (cmd === "tail" && (a === "-n" || a === "-c")) j++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** The reason to block this Bash command, or null. */
export function bashDecision(command, opts = {}) {
  const { cwd, home, background } = opts;
  let pipelines;
  try {
    pipelines = parseShell(String(command ?? ""));
  } catch {
    return null;
  }
  for (const stages of pipelines)
    for (let s = 0; s < stages.length; s++) {
      const st = stages[s];
      const cmd = base(st.words[0] ?? "");
      const args = st.words.slice(1);
      if (cmd === "sleep" && args.length && !background && !st.background)
        return `Den blocked \`sleep ${args.join(" ")}\`. ${SLEEP_HINT}`;
      if (cmd !== "cat" && cmd !== "less" && cmd !== "tail") continue;
      // Output that goes on to another command or a file never reaches the chat.
      if (s < stages.length - 1 || st.stdoutRedirected) continue;
      if (cmd === "tail" && !tailReadsAll(args)) continue;
      for (const f of [...fileArgs(cmd, args), ...st.inputs]) {
        const why = wholeReadReason(f, cwd, home);
        if (why)
          return `Den blocked \`${[cmd, ...args].join(" ")}\`: it reads all of ${f} (${why}) into the conversation. ${READ_HINT}`;
      }
    }
  return null;
}

/** The reason to block this tool call, or null. */
export function decide(input, env = process.env) {
  if (!input || typeof input !== "object") return null;
  const ti =
    input.tool_input && typeof input.tool_input === "object"
      ? input.tool_input
      : {};
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const home = env.HOME;
  if (input.tool_name === "Read") {
    if (ti.limit !== undefined && ti.limit !== null) return null;
    if (typeof ti.file_path !== "string") return null;
    const why = wholeReadReason(ti.file_path, cwd, home);
    return why
      ? `Den blocked a Read of all of ${ti.file_path} (${why}). ${READ_HINT}`
      : null;
  }
  if (input.tool_name === "Bash")
    return bashDecision(ti.command, {
      cwd,
      home,
      background: ti.run_in_background === true,
    });
  return null;
}

/** `--name value` from the hook's own arguments, or null. */
function arg(name, argv = process.argv) {
  const i = argv.indexOf(name);
  return i > 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}

async function main() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  let reason = null;
  try {
    const input = JSON.parse(text);
    // D47 first: a service agents may reach only through its API.
    const rules = loadRules(arg("--api-only"));
    if (rules) {
      const r = apiOnlyDecision(
        input,
        rules,
        {
          cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
          home: process.env.HOME,
          env: process.env,
        },
        parseShell,
      );
      if (r) {
        audit(arg("--audit"), r, input);
        reason = apiOnlyMessage(r);
      }
    }
    if (!process.argv.includes("--no-guardrails")) reason ??= decide(input);
  } catch {
    reason = null;
  }
  if (reason) {
    process.stderr.write(`${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

/** Run as a script (the hook), not imported. */
function isMain() {
  try {
    return (
      !!process.argv[1] &&
      fs.realpathSync(process.argv[1]) ===
        fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
if (isMain()) main().catch(() => process.exit(0));
