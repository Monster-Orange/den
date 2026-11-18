/**
 * The GitHub budget guard in Den's PreToolUse hook (issue 487). Agents on
 * one machine share one GitHub account and its hourly budget; an agent
 * that waits for CI by polling GitHub spends it for everyone. This blocks:
 *
 *   - `gh run watch` at a short interval (its default is 3 s): a slow one,
 *     `--interval N` with N at least the minimum (`--gh-watch-min`, the
 *     github_budget.watch_min_seconds setting, default 120), passes, unless
 *     the server's budget snapshot (`--gh-budget`) is below its reserve, or
 *     this agent (DEN_AGENT) already has a live watch of the same run;
 *   - `gh pr checks --watch`, at any interval (each poll is several calls);
 *   - gh called inside a while, until or for loop that sleeps, in the
 *     background too.
 * Each message names the MCP tool to use instead: ci_wait, where Den's
 * server watches once for every agent, with conditional requests.
 *
 * Plain Node, node:* only (the hook starts on every Bash call). Anything
 * that can't be read here (no snapshot, no process list) allows the call.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/** The least `gh run watch --interval` that passes, by default (seconds). */
export const WATCH_MIN_SECONDS = 120;

const CI_WAIT_HINT =
  "Use Den's MCP tool ci_wait instead (a run id, or a PR, and a timeout): " +
  "Den's server watches each run once for every agent that waits on it, " +
  "with conditional requests that cost nothing while nothing changes.";

const base = (w) => String(w).slice(String(w).lastIndexOf("/") + 1);

/** gh's subcommand words, its global -R/--repo and its value left out. */
function ghWords(args) {
  const out = [];
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (out.length < 2 && (a === "-R" || a === "--repo")) {
      j++;
      continue;
    }
    if (out.length < 2 && a.startsWith("--repo=")) continue;
    out.push(a);
  }
  return out;
}

/** `--interval N`, `--interval=N`, `-i N` or `-iN`, else null. */
function intervalOf(args) {
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    let v = null;
    if (a === "--interval" || a === "-i") v = args[j + 1];
    else if (a.startsWith("--interval=")) v = a.slice("--interval=".length);
    else if (/^-i\d+$/.test(a)) v = a.slice(2);
    if (v !== null && v !== undefined) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

/** The run id of `run watch <id>` (the first word after watch that isn't a flag). */
function runIdOf(rest) {
  for (let j = 0; j < rest.length; j++) {
    const a = rest[j];
    if (a === "--interval" || a === "-i") {
      j++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return /^\d+$/.test(a) ? a : null;
  }
  return null;
}

/** What a gh stage is: { watch: {run, interval} } | { prWatch } | null. */
export function ghKind(words) {
  if (base(words[0] ?? "") !== "gh") return null;
  const w = ghWords(words.slice(1));
  if (w[0] === "run" && w[1] === "watch") {
    const rest = w.slice(2);
    return { watch: { run: runIdOf(rest), interval: intervalOf(rest) } };
  }
  if (w[0] === "pr" && w[1] === "checks" && w.slice(2).includes("--watch"))
    return { prWatch: true };
  return { other: true };
}

/** The budget snapshot the server writes, or null (missing, unreadable). */
function readSnapshot(file) {
  if (!file) return null;
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf-8"));
    return s && typeof s === "object" ? s : null;
  } catch {
    return null;
  }
}

/** A reset time (epoch seconds) as the person reads it: local time. */
function clock(reset) {
  return new Date(reset * 1000).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Why the budget refuses a call now, or null (above, unknown, or reset). */
export function budgetRefusal(file, now = Date.now()) {
  const s = readSnapshot(file);
  if (!s) return null;
  const { remaining, reserve, reset } = s;
  if (
    typeof remaining !== "number" ||
    typeof reserve !== "number" ||
    typeof reset !== "number"
  )
    return null;
  if (reset * 1000 <= now) return null;
  if (remaining >= reserve) return null;
  return `the account's GitHub budget is at ${remaining} requests, below the reserve of ${reserve} kept for releases and people; it resets at ${clock(reset)}`;
}

/** The command lines of live processes, or [] when they can't be read. */
function processes() {
  if (process.platform === "linux") {
    const out = [];
    for (const p of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(p)) continue;
      try {
        const cmd = fs
          .readFileSync(`/proc/${p}/cmdline`, "utf-8")
          .split("\0")
          .filter(Boolean);
        if (cmd.length) out.push({ pid: Number(p), words: cmd });
      } catch {
        /* gone, or not ours */
      }
    }
    return out;
  }
  // This user's processes only: an agent's watch runs as its person.
  const text = execFileSync(
    "ps",
    ["-U", String(process.getuid()), "-ww", "-o", "pid=,command="],
    {
      encoding: "utf-8",
      timeout: 3000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return text
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), words: m[2].split(/\s+/) }));
}

/** Whether this process runs as `agent` (its DEN_AGENT). Never printed. */
function runsAs(pid, agent) {
  const want = `DEN_AGENT=${agent}`;
  try {
    if (process.platform === "linux")
      return fs
        .readFileSync(`/proc/${pid}/environ`, "utf-8")
        .split("\0")
        .includes(want);
    // macOS: ps -E puts the environment after the command (own processes).
    const text = execFileSync(
      "ps",
      ["-E", "-ww", "-o", "command=", "-p", String(pid)],
      {
        encoding: "utf-8",
        timeout: 3000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return text.split(/\s+/).includes(want);
  } catch {
    return false;
  }
}

/** Whether `agent` already has a live `gh run watch <run>`. */
export function watching(agent, run) {
  if (!agent || !run) return false;
  let procs;
  try {
    procs = processes();
  } catch {
    return false;
  }
  for (const p of procs) {
    if (p.pid === process.pid) continue;
    const at = p.words.findIndex((w) => base(w) === "gh");
    if (at < 0) continue;
    const k = ghKind(p.words.slice(at));
    if (k?.watch?.run === run && runsAs(p.pid, agent)) return true;
  }
  return false;
}

/**
 * The reason to block this command's gh polling, or null.
 * pipelines: parseShell's; loop: whether the command has a while, until or
 * for loop; sleeps: whether it runs sleep.
 */
export function ghDecision(pipelines, opts = {}) {
  const { loop = false, sleeps = false } = opts;
  const min =
    typeof opts.watchMin === "number" && opts.watchMin >= 0
      ? opts.watchMin
      : WATCH_MIN_SECONDS;
  for (const stages of pipelines)
    for (const st of stages) {
      const k = ghKind(st.words);
      if (!k) continue;
      const typed = st.words.join(" ");
      if (loop && sleeps)
        return `Den blocked \`${typed}\` in a loop that sleeps: polling GitHub spends the account's hourly budget for every agent and person on it. ${CI_WAIT_HINT}`;
      if (k.prWatch)
        return `Den blocked \`${typed}\`: it polls GitHub until the checks end, spending the account's hourly budget for every agent and person on it. ${CI_WAIT_HINT}`;
      if (!k.watch) continue;
      if (k.watch.interval === null || k.watch.interval < min)
        return `Den blocked \`${typed}\`: it polls GitHub every ${k.watch.interval ?? 3} s, spending the account's hourly budget for every agent and person on it. ${CI_WAIT_HINT} If you must watch, use --interval ${min} or more.`;
      const why = budgetRefusal(opts.budgetFile);
      if (why)
        return `Den refused \`${typed}\`: ${why}. Wait for the reset, or use ci_wait, which tells you the same.`;
      if (watching(opts.agent, k.watch.run))
        return `Den blocked \`${typed}\`: you already watch run ${k.watch.run}; wait for that watch to end. ${CI_WAIT_HINT}`;
    }
  return null;
}
