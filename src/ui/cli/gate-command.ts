/**
 * `<cli> gate` (issue 144 GATE-SLOT): one machine, many heavy test runs,
 * taken in turn. The slots are the machine's (gates/store.ts), shared by
 * every install and repo here, and need no running Den.
 *
 *   run [--kind browser|cpu] [--estimate 6m] [--label <l>]
 *       [--priority release --reason <why>] -- <cmd> [args]
 *       waits for a slot (saying who holds it and until when, each
 *       minute), runs the command, gives the slot back when it ends however
 *       it ends; exits with the command's code. Issue 715: --priority
 *       release puts a release run a person waits on at the front of its
 *       kind's queue (never ahead of a holder), recorded with why
 *       Issue 625: --box any lets a browser run take a test box's slot
 *       (whichever frees first); the run gets DEN_GATE_BOX, DEN_PW_WS.
 *       Issue 1033: with no --box it does so by default (the setting
 *       browser_box_default, any or local); one that can't go to a box
 *       (no --base-url, no matching Playwright, host-only) stays here and
 *       says why in one line
 *       --browser-endpoint ws://…|self: where a browser run's browser
 *       runs (a container's Playwright endpoint, or a container the run
 *       starts itself); also read from DEN_PW_WS, HUB_PW_WEBKIT_WS,
 *       E2E_WEBKIT_WS. On macOS a browser run without one is refused
 *       (gates/browser-container.ts; a Setting)
 *   status [--json]          who holds, who waits, overruns, test boxes
 *   box <list|add|remove|enable|disable>  the test boxes (a person's)
 *   end <id>                 a person ends a slot early (refused for an
 *                            agent); recorded with who
 *   yield <my-id> --to <id>  issue 795: your waiting entry lets another
 *                            waiting entry go just ahead of it (yours only)
 *   settings [--cpu-slots N] [--cpu-slots-beside-browser N]
 *            [--local-browser-slots N] [--cpu-hold-load N]
 *            [--max-start-load N] [--max-start-wait-minutes N]
 *            [--reap-grace-seconds N]   issue 1132
 *            [--overrun-margin-minutes N] [--overrun-bell-multiple X]
 *            [--remote-renew-seconds N] [--remote-lapse-seconds N]
 *            [--remote-max-slots N] [--remote-max-asks N]
 *            [--priority-max N] [--priority-pass-limit-minutes N]
 *            [--priority-agents 0|1] [--priority-runners 0|1]
 *            [--claim-minutes N]
 *            [--mcp-renew-minutes N] [--mcp-lapse-minutes N]
 *            [--mcp-grace-minutes N]
 *            [--box-check-timeout-seconds N] [--box-recheck-seconds N]
 *            [--class-order <l>] [--class-map <l>] [--class-windows <l>]
 *            [--browser-requires-container 0|1]
 *            [--browser-box-default any|local] [--browser-host-only <l>]
 *                            the machine's; a person changes them. Issue
 *                            803: priority classes per project ("" clears)
 */
import { execFileSync, spawn } from "child_process";
import {
  boxRunName,
  boxSecretRefusal,
  gitTree,
  scanSet,
  shipPlan,
  startBoxCpuRun,
  type BoxCpuRun,
  type BoxTree,
} from "../../shared/gates/box-cpu.js";
import * as os from "os";
import * as path from "path";
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import {
  personServerFor,
  throughServer,
  type PersonServer,
} from "./person-server.js";
import { classOf, windowHeld } from "../../shared/gates/classes.js";
import {
  gateWorkers,
  type LoadHold,
  MEMORY_NOT_MEASURED_WORDS,
  type MemoryHold,
  type SwapHold,
  expectedStart,
  GATE_DEFAULTS,
  loadHold,
  startHold,
  memoryHold,
  swapHold,
  queueEnd,
  queueMinOf,
  overrun,
  priorityIds,
  yieldedTo,
  type GateEntry,
  type GateKind,
  type GateSettings,
} from "../../shared/gates/rules.js";
import {
  GatePriorityRefused,
  GateStore,
  GateYieldRefused,
  checkGatePatch,
  realCores,
  type GateSettingsPatch,
} from "../../shared/gates/store.js";
import {
  GATE_CHECKOUT_ENV,
  GATE_STORE_ENV,
  checkoutOf,
  checkoutTag,
  cleanRun,
  realDocker,
  storeTag,
  type Docker,
} from "../../shared/gates/ephemeral.js";
import * as fs from "fs";
import {
  boxCouldServe,
  boxEnv,
  checkBox,
  defaultPlace,
  hostOnlyMatch,
  type GateBox,
} from "../../shared/gates/boxes.js";
import {
  SELF,
  browserSlotCheck,
  browserSlotRefusal,
  endpointFromEnv,
  personLanguage,
  type UiLanguage,
} from "../../shared/gates/browser-container.js";
import {
  GATE_MEANINGS,
  KEPT_PLACE_WORDS,
  PRIORITY_OFF_RUN,
  PRIORITY_OFF_STATUS,
  PRIORITY_OFF_WARNING,
  LEFTOVER_WORDS,
  START_HOLD_WORDS,
} from "../../shared/gates/meanings.js";
import { descendsFrom } from "../../shared/peer-process.js";
import {
  allowOf,
  checkBaseUrl,
  isLoopbackHost,
} from "../../shared/gates/pw-guard.js";
import {
  boxOffWords,
  gateBoxesView,
  gateView,
  type GateMachineView,
  removedView,
} from "../../shared/gates/view.js";
import { localDateTime } from "../../shared/local-time.js";
import { product } from "../../shared/product.js";
import { AGENT_ACTOR_ENV } from "../../shared/sessions/env.js";

export const GATE_HELP = {
  usage: "gate <run|status|end|yield|box|settings> ...",
  lines: [
    "Heavy test runs on this machine, taken in turn: one browser suite at a",
    "time; unit suites share (2 at a time by default, 2 of them beside a browser",
    "suite). Browser and unit runs wait in separate lines. Every repo and install",
    "on the machine shares the same queue. A run is never stopped by another.",
    "",
    "{cli} gate run [--kind browser|cpu] [--estimate 6m] [--label <l>] -- <cmd>",
    "    waits for a slot, runs <cmd>, gives the slot back when it ends",
    "    --priority release --reason <why>: a release run a person waits on",
    "    goes to the front of its kind's queue (one at a time; recorded)",
    "    a browser run takes whichever browser slot frees first, here or on a",
    "    test box (DEN_PW_WS is set); --box local keeps it here, --box <name>",
    "    sends it to one box. One with no --base-url, its own browser, no box",
    "    for its Playwright version, or marked host-only stays here, saying why",
    "    --browser-endpoint ws://…: the container browser a browser run uses",
    "    (or DEN_PW_WS, HUB_PW_WEBKIT_WS, E2E_WEBKIT_WS); =self: the run starts",
    "    its own. On macOS a browser run needs one (a Setting)",
    "    a cpu run with --box <name>|any runs on a test box with cpu slots:",
    "    git's files ship over ssh (secret files left out), npm ci from the",
    "    lockfile there, and none of this machine's environment but CI and",
    "    --env NAME (repeat it). One that names a secret is refused there",
    "{cli} gate status [--json]      who holds a slot, who waits",
    "{cli} gate box <list|add|remove|enable|disable> <name> [--ssh login@host] [--ssh-port N]",
    "    [--ssh-identity <key file>] [--playwright ws://…] [--slots N] [--cpu-slots N]",
    "    [--hold-file <path>] [--time-scale X] [--min-free-mem-mb N]",
    "    [--playwright-version X.Y.Z]   test boxes (a person's)",
    "    [--pw <version>=ws://…] (repeat it): a box with a Playwright address",
    "    per version; a run gets the one for its version (--pw-version, else",
    "    the installed Playwright, looking up to the repo's top folder)",
    "    [--window HH:MM-HH:MM] when it may be used, this machine's time",
    "    [--off] added turned off; [--recheck-seconds N] least time between",
    "    checks of a box that says no. Off or outside its window: no slot, no contact",
    "    a box run: --base-url http://<name>.localhost:<port>, or http://127.0.0.1:* for the ports the run opens (never 80/443);",
    "    127.0.0.1, localhost and <name>.localhost are one host there",
    "{cli} gate end <id>             end a slot early (a person's only)",
    "{cli} gate yield <my-id> --to <id>",
    "    your waiting run lets another waiting run go just ahead of it",
    "{cli} gate settings [--cpu-slots N] [--cpu-slots-beside-browser N] [--local-browser-slots N] [--cpu-hold-load N] [--max-start-load N] [--max-start-wait-minutes N] [--reap-grace-seconds N]",
    "    [--overrun-margin-minutes N] [--overrun-bell-multiple X]",
    "    [--remote-renew-seconds N] [--remote-lapse-seconds N]",
    "    [--remote-max-slots N] [--remote-max-asks N]",
    "    [--priority-max N] [--priority-pass-limit-minutes N] [--priority-agents 0|1]",
    "    [--priority-runners 0|1]   (--priority-max 0 needs --yes: it turns release priority off)",
    "    [--claim-minutes N] [--mcp-renew-minutes N] [--mcp-lapse-minutes N] [--mcp-grace-minutes N]",
    "    [--box-check-timeout-seconds N] [--box-recheck-seconds N]",
    '    [--class-order "release, lane, other"] [--class-map "<project>=<class>, label:<pattern>=<class>, *=<class>"]',
    '    [--class-windows "<class>=22:00-06:00/30"]   priority classes per project ("" clears)',
    "    [--browser-requires-container 0|1]   a browser run declares a container browser",
    "    [--browser-box-default any|local]   where a browser run with no --box goes",
    '    [--browser-host-only "<project>, label:<pattern>"]   browser runs kept here ("" clears)',
    "A CI job in a runner VM takes a slot over HTTP with a gate-only runner",
    "token (an agent asks for one; you allow it): docs/gate-slots.md.",
  ],
};

/** The command gate run started. */
export interface GateRun {
  pid: number | undefined;
  kill: (s: NodeJS.Signals) => void;
  /** Resolves with its exit code when it ends. */
  done: Promise<number>;
  /**
   * Issue 1023: true once the command can run no more, though it has not
   * ended: it is writing a core dump (SIGQUIT, on Linux). Its threads are
   * stopped for good, and the dump can take seconds (a crash handler reads
   * all of it), so its slot is given back then, not at its exit.
   */
  dumping?: () => boolean;
  /**
   * Issue 1132: the process group the command leads (it was started in
   * its own), stopped when the slot ends. Absent: none was made.
   */
  group?: number;
}

export interface GateDeps {
  store: GateStore;
  /** Issue 1048: this machine's cores (the worker cap); default the host's. */
  cores?: number;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Starts the command (issue 625: `env` adds to the environment). */
  exec: (cmd: string, args: string[], env?: Record<string, string>) => GateRun;
  /** Runs `fn` every `ms` until the returned stop is called. */
  every: (ms: number, fn: () => void) => () => void;
  /** Calls `h` on each of GATE_RUN_SIGNALS; returns a stop. */
  onSignal: (h: (signal: NodeJS.Signals) => void) => () => void;
  /** Leaves at once with `code` (a signal while waiting). */
  exit: (code: number) => void;
  pid: number;
  cwd: string;
  /** The language refusals are in (default: the person's, from user.yml). */
  lang?: UiLanguage;
  /** Issue 928: whether process `pid` runs under `root` (default: ps). */
  descends?: (pid: number, root: number) => boolean;
  /**
   * Issue 1132: whether the run's folder was deleted, or the process that
   * started gate run is gone. Absent: not watched.
   */
  watch?: { folderGone: () => boolean; parentGone: () => boolean };
  /** Issue 989: the running server (default: this install's). */
  server?: PersonServer;
  /** Issue 790: starts a cpu run on a test box (tests pass a fake). */
  boxCpu?: typeof startBoxCpuRun;
  /** Issue 790: git in the run's folder (its output), for the tree. */
  git?: (args: string[]) => string;
  /**
   * Issue 1263: the docker CLI, to remove the run's throwaway containers
   * when its slot ends (absent: nothing is removed; tests pass a fake).
   */
  docker?: Docker;
}

/**
 * Issue 989: a person's change sent to the running server: true when it
 * made it, false when it refused (said here), null with no server (the
 * CLI changes the store itself, as before).
 */
async function viaServer(
  d: GateDeps,
  where: string,
  p: string,
  body: unknown,
): Promise<boolean | null> {
  try {
    const r = await throughServer(
      d.server ?? personServerFor(),
      "POST",
      p,
      body,
    );
    return r === null ? null : true;
  } catch (e) {
    d.err(`${where}: ${(e as Error).message}; nothing was changed`);
    return false;
  }
}

/** Issue 928: how often a nested run checks its slot still holds. */
const NESTED_LOOK_MS = 5_000;

/** Issue 1132: how often a run looks whether its folder or parent is gone. */
const WATCH_LOOK_MS = 1_000;

/** Issue 1132: how often a held run looks at the load again. */
const HOLD_LOOK_MS = 2_000;

/**
 * Issue 1198: a default pick's base URL when the run gives none: any port
 * on 127.0.0.1 but 80 and 443, and in the box guard (issue 991) only the
 * ports the run itself opens.
 */
const DEFAULT_BASE = "http://127.0.0.1:*";

/** Whether a Playwright endpoint is on this machine's loopback. */
function loopbackEndpoint(raw: string): boolean {
  try {
    return isLoopbackHost(new URL(raw).hostname);
  } catch {
    return false;
  }
}

/** Issue 1023: how often a run looks whether its command is dumping core. */
const DUMP_LOOK_MS = 100;

/**
 * Issue 1023: whether a process is writing a core dump, from Linux's
 * /proc/<pid>/status ("CoreDumping: 1"). False where there is no /proc.
 */
export function coreDumping(pid: number, read = fs.readFileSync): boolean {
  try {
    return /^CoreDumping:\s*1\s*$/m.test(
      String(read(`/proc/${pid}/status`, "utf8")),
    );
  } catch {
    return false;
  }
}

/** Issue 928: what `gate run` tells its command about the slot it holds. */
export const GATE_SLOT_ENV = "DEN_GATE_SLOT";
export const GATE_SLOT_KIND_ENV = "DEN_GATE_SLOT_KIND";
export const GATE_SLOT_BOX_ENV = "DEN_GATE_SLOT_BOX";

/**
 * Issue 928: the slot this run is nested in, when it may run inside it:
 * DEN_GATE_SLOT names a slot that holds, of this kind and place, and this
 * process runs under that slot's run (naming the id alone is not enough).
 */
function heldSlotFor(
  d: GateDeps,
  kind: GateKind,
  where: string | undefined,
): GateEntry | undefined {
  const id = d.env[GATE_SLOT_ENV]?.trim();
  if (!id) return undefined;
  const e = d.store.get(id);
  if (!e?.grantedAt || e.kind !== kind) return undefined;
  const place = e.box ?? "local";
  const want = where ?? "local";
  if (want !== "any" && want !== place) return undefined;
  const under = d.descends ?? ((p, r) => descendsFrom(p, r));
  const roots = [e.runPid, e.pid].filter((p): p is number => !!p && p > 1);
  return roots.some((r) => under(d.pid, r)) ? e : undefined;
}

/** Issue 1033: whether a --box name is this machine's own. */
function isThisMachine(name: string): boolean {
  const full = os.hostname().toLowerCase();
  const n = name.toLowerCase();
  return n === full || n === full.split(".")[0];
}

/**
 * The machine a held slot is on, in words: a box's name; this machine
 * for a browser run that could have gone to a box (issue 1033); else
 * nothing, as before.
 */
function machineWords(e: GateEntry): string {
  if (e.box) return ` on box ${e.box}`;
  return e.kind === "browser" && (e.where || e.hostWhy)
    ? " on this machine"
    : "";
}

/** A signal's exit code, as a shell gives it (128 + its number). */
const signalCode = (s: NodeJS.Signals | null) => {
  const n = s ? os.constants.signals[s] : undefined;
  return typeof n === "number" ? 128 + n : 143;
};

/**
 * Issue 1023: the signals `gate run` passes to its command (or, while it
 * waits, that give its place back). Each one that would end it: any of
 * them reaching gate run ends its command, and so frees its slot.
 */
export const GATE_RUN_SIGNALS: NodeJS.Signals[] = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGQUIT",
];

const realExec = (
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): GateRun => {
  // Issue 1132: in its own process group (it leads it), so what it
  // starts can be stopped with it, and nothing else is. Signals reach it
  // through gate run, which passes them on to the whole group.
  const k = spawn(cmd, args, {
    stdio: "inherit",
    detached: true,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  const running = () => k.exitCode === null && k.signalCode === null;
  const group = process.platform === "win32" ? undefined : k.pid;
  return {
    pid: k.pid,
    ...(group !== undefined ? { group } : {}),
    kill: (s) => {
      if (!running()) return;
      if (group === undefined) return void k.kill(s);
      try {
        process.kill(-group, s);
      } catch {
        k.kill(s);
      }
    },
    ...(process.platform === "linux"
      ? {
          dumping: () => running() && k.pid !== undefined && coreDumping(k.pid),
        }
      : {}),
    done: new Promise<number>((resolve) => {
      k.on("error", () => resolve(127));
      k.on("exit", (code, signal) => resolve(code ?? signalCode(signal)));
    }),
  };
};

const realOnSignal = (h: (s: NodeJS.Signals) => void) => {
  for (const s of GATE_RUN_SIGNALS) process.on(s, h);
  // Issue 1023: a closed stdout or stderr (the terminal or the agent that
  // started it went away) never ends gate run before its command, so the
  // slot is still given back when the command ends.
  const quiet = () => {};
  process.stdout.on("error", quiet);
  process.stderr.on("error", quiet);
  return () => {
    for (const s of GATE_RUN_SIGNALS) process.off(s, h);
    process.stdout.off("error", quiet);
    process.stderr.off("error", quiet);
  };
};

export function realGateDeps(): GateDeps {
  return {
    store: new GateStore(),
    env: process.env,
    out: (l) => process.stdout.write(l + "\n"),
    err: (l) => process.stderr.write(l + "\n"),
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    exec: realExec,
    docker: realDocker(),
    every: (ms, fn) => {
      const h = setInterval(fn, ms);
      h.unref();
      return () => clearInterval(h);
    },
    onSignal: realOnSignal,
    exit: (code) => process.exit(code),
    pid: process.pid,
    cwd: process.cwd(),
    watch: realWatch(process.cwd(), process.ppid),
  };
}

/**
 * Issue 1132: the run's folder deleted (it was where gate run started),
 * or the process that started gate run gone (gate run was handed to
 * another parent).
 */
function realWatch(cwd: string, ppid: number): GateDeps["watch"] {
  return {
    folderGone: () => !fs.existsSync(cwd),
    parentGone: () => ppid > 1 && process.ppid !== ppid,
  };
}

class GateUsage extends Error {}

const PW_PACKAGES = ["playwright-core", "@playwright/test", "playwright"];

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The Playwright version installed for `dir` (its node_modules, or above). */
function installedPlaywright(dir: string, stop: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    for (const p of PW_PACKAGES) {
      const v = readJson(
        path.join(d, "node_modules", p, "package.json"),
      )?.version;
      if (typeof v === "string") return v;
    }
    if (d === stop || path.dirname(d) === d) return undefined;
  }
}

/** Whether a package.json depends on Playwright (its range; never a version). */
function declaredPlaywright(dir: string): string | undefined | null {
  const pkg = readJson(path.join(dir, "package.json"));
  if (!pkg) return null;
  for (const k of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const deps = pkg[k];
    if (!deps || typeof deps !== "object") continue;
    for (const p of PW_PACKAGES) {
      const r = (deps as Record<string, unknown>)[p];
      if (typeof r === "string") return r;
    }
  }
  return null;
}

/** The repo's top folder: the nearest at or above `dir` with a .git; else `dir`. */
function repoTop(dir: string): string {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return path.resolve(dir);
  }
}

/**
 * Clause 11, issue 1017: the run's exact Playwright client version, from
 * an installed package.json only. First installed for the run's folder:
 * its node_modules, or one above it up to the repo's top folder (a
 * workspace run with Playwright hoisted to the root). Else installed for
 * the nearest package.json below it that depends on Playwright (a repo
 * whose Playwright lives in web/). Nearest is fewest folders down;
 * node_modules and dot folders are never looked in. A range in a
 * package.json is never read as a version: with nothing installed, the
 * version is unknown (undefined).
 */
export function playwrightVersion(cwd: string): string | undefined {
  const top = repoTop(cwd);
  const here = installedPlaywright(cwd, top);
  if (here) return here;
  let level = [cwd];
  while (level.length) {
    for (const dir of level) {
      const range = declaredPlaywright(dir);
      if (typeof range !== "string") continue;
      const v = installedPlaywright(dir, cwd);
      if (v) return v;
    }
    const next: string[] = [];
    for (const dir of level) {
      let names: fs.Dirent[] = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const n of names)
        if (
          n.isDirectory() &&
          n.name !== "node_modules" &&
          !n.name.startsWith(".")
        )
          next.push(path.join(dir, n.name));
    }
    level = next.sort();
  }
  return undefined;
}

/** "6m", "90s", "1h", "10" (minutes) → minutes. */
export function parseEstimate(v: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(v.trim());
  if (!m) throw new GateUsage(`--estimate is a time like 6m, 90s or 1h`);
  const n = Number(m[1]);
  const min = m[2] === "s" ? n / 60 : m[2] === "h" ? n * 60 : n;
  if (!(min > 0)) throw new GateUsage(`--estimate must be above 0`);
  return min;
}

/** An agent runs this (its token, or Den's agent marker), not a person. */
export const isAgentEnv = (env: NodeJS.ProcessEnv): boolean =>
  isAgentTokenEnv(env) || !!env[AGENT_ACTOR_ENV]?.trim();

/** Who asks, in words: the install, the repo folder, an agent or a person. */
export function whoAsks(env: NodeJS.ProcessEnv, cwd: string): string {
  const agent = env[AGENT_ACTOR_ENV]?.trim();
  const by = agent ? agent : isAgentTokenEnv(env) ? "an agent" : "a person";
  let title = "Den";
  try {
    title = product().title;
  } catch {
    /* no profile: the default */
  }
  return `${title} · ${path.basename(cwd)} · ${by}`;
}

const hm = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Issue 715: a marked run's words: why, and whether it holds priority. */
function priorityWords(
  e: GateEntry,
  all: GateEntry[],
  s: Partial<GateSettings>,
): string {
  if (!e.priority) return "";
  const why = `release priority: "${e.priority.reason}"`;
  if (e.grantedAt || priorityIds(all, s).has(e.id)) return `  ${why}`;
  return `  ${why} (waits behind the one ahead)`;
}

/** Issue 1048: the workers a cpu slot's run may use. */
export const GATE_WORKERS_ENV = "DEN_GATE_WORKERS";

/** Issues 1009, 1048: why a cpu run waits on the load, in words. */
export function holdWords(h: LoadHold): string {
  return h.why === "release"
    ? `waiting: load ${Math.round(h.load)} ≥ ${h.limit} while a release run holds the browser slot`
    : `waiting: this machine's load is ${h.load.toFixed(1)}, over ${h.perCore} × ${h.cores} cores (${h.limit}), while another unit test run is going; it starts once the load drops or that run ends`;
}

/** Issue 1274: why a run here waits on swap, in words. */
export function swapHoldWords(h: SwapHold): string {
  if (h.unavailable) return memoryUnavailableHoldWords();
  return `waiting: this machine has ${h.usedGb} GB of swap in use, over ${h.limitGb} GB, while another run here is going; it starts once swap drops or that run ends (test boxes still take runs)`;
}

/** Issue 1274: why a run here waits on memory, in words. */
export function memoryHoldWords(h: MemoryHold): string {
  if (h.unavailable) return memoryUnavailableHoldWords();
  return `waiting: this machine has ${Math.round(h.free)}% of its memory free, under ${h.limit}%, while another run here is going; it starts once memory frees or that run ends (test boxes still take runs)`;
}

/** Issue 1349: an unknown memory reading holds; why, in words. */
export function memoryUnavailableHoldWords(): string {
  return "waiting: memory reading unavailable (this machine's free memory or swap couldn't be read), while another run here is going; it starts once a reading comes back or that run ends (test boxes still take runs)";
}

const gbWords = (b: number) => `${Math.round(b / 1024 ** 3)} GB`;

/** Issue 1274: gate status's lines for this machine's memory and VMs. */
export function machineLines(m: GateMachineView | undefined): string[] {
  if (!m) return [];
  const out: string[] = [];
  // Issue 1349: the guard is off here, or its reading is unknown: say so.
  if (m.notMeasured) out.push(`This machine: ${MEMORY_NOT_MEASURED_WORDS}.`);
  else if (m.unavailable)
    out.push(
      "This machine: memory reading unavailable; new runs here wait while another run here is going.",
    );
  if (m.freeMemory !== undefined)
    out.push(
      `This machine: ${m.freeMemory}% of memory free` +
        (m.swapUsedGb ? `, ${m.swapUsedGb} GB of swap in use.` : "."),
    );
  if (m.vms && m.ramBytes !== undefined && m.promisedBytes !== undefined) {
    const limit = gbWords(Math.round(m.ramBytes * (m.share ?? 1)));
    const of = `${m.share ?? 1} × ${gbWords(m.ramBytes)} RAM`;
    if (m.vms.length || m.notCounted?.length)
      out.push(
        m.over
          ? `⚠ VMs here promise ${gbWords(m.promisedBytes)}, over ${limit} (${of}): the machine can run out of memory`
          : `VMs here promise ${gbWords(m.promisedBytes)} of ${limit} (${of}).`,
      );
    for (const v of m.vms)
      out.push(
        `  ${v.name} (${v.runtime}) ${gbWords(v.memBytes)}, ${v.cpus} cpus`,
      );
    for (const n of m.notCounted ?? [])
      out.push(`  ${n}: not counted (couldn't read it)`);
  }
  return out;
}

/** One line for a holder or waiter. */
export function slotLine(
  e: GateEntry,
  all: GateEntry[],
  now: number,
  margin: { overrunMarginMinutes: number } & Partial<GateSettings> & {
      /** Issue 1009: the machine's 5-minute load, when read. */
      load?: number;
      /** Issue 867: the person's language, for the kept-place words. */
      lang?: UiLanguage;
      /** Issue 1048: the machine's cores. */
      cores?: number;
      /** Issue 1274: this machine's free memory, percent. */
      freeMemory?: number | null;
      /** Issue 1274: swap in use here, GB. */
      swapUsedGb?: number | null;
    },
): string {
  const yields = yieldedTo(e, all);
  // Issue 1009: a cpu waiter held by the load under a release run.
  const hold =
    !e.grantedAt && e.kind === "cpu" && !e.priority
      ? loadHold(all, margin, margin.load, margin.cores)
      : undefined;
  // Issue 1274: a run here held by low memory.
  const mem =
    !e.grantedAt && (!e.where || e.where === "local" || e.where === "any")
      ? memoryHold(all, margin, margin.freeMemory)
      : undefined;
  const swap =
    !e.grantedAt && (!e.where || e.where === "local" || e.where === "any")
      ? swapHold(all, margin, margin.swapUsedGb)
      : undefined;
  // Issue 803: its class, and a wait for its class's window.
  const cls = classOf(e, margin.classes);
  const win = windowHeld(all, margin.classes, now).get(e.id);
  const pri =
    priorityWords(e, all, margin) +
    (cls ? `  class ${cls}` : "") +
    (win ? `  waits for its ${win.text} window` : "") +
    (hold ? `  ${holdWords(hold)}` : "") +
    (mem ? `  ${memoryHoldWords(mem)}` : "") +
    (swap ? `  ${swapHoldWords(swap)}` : "") +
    // Issue 1132: granted, its command waiting for the load to drop.
    (e.grantedAt && e.startHold
      ? `  ${START_HOLD_WORDS[margin.lang ?? "en"](e.startHold.load, e.startHold.limit)}`
      : "") +
    (yields.length ? `  let ${yields.join(", ")} go ahead` : "") +
    (e.browserEndpoint ? `  browser ${e.browserEndpoint}` : "") +
    (e.hostWhy ? `  stays here: ${e.hostWhy}` : "") +
    // Issue 999: a padded estimate, and what the queue uses instead.
    (e.padded && e.expectedMin !== undefined
      ? `  estimate ${e.estimateMin} min; this usually takes ${e.expectedMin}`
      : "");
  if (e.grantedAt) {
    const late = overrun(e, margin, now) ? " (past its estimate)" : "";
    const on = machineWords(e);
    return `${e.id}  holds ${e.kind}${on}  ${e.who}  "${e.label}"  until about ${hm(queueEnd(e))}${late}${pri}`;
  }
  // Issue 625: a waiter that may go to a test box says so.
  const where =
    e.where === "any"
      ? " (this machine or a test box)"
      : e.where
        ? ` (box ${e.where})`
        : "";
  // Issue 867: a waiter whose run is gone, its place kept a while.
  const kept = e.orphanedAt
    ? `  ${KEPT_PLACE_WORDS[margin.lang ?? "en"].kept(hm(Date.parse(e.orphanedAt) + (margin.waiterReturnMinutes ?? GATE_DEFAULTS.waiterReturnMinutes) * 60_000))}`
    : "";
  return `${e.id}  waits for ${e.kind}${where}  ${e.who}  "${e.label}"  starts about ${hm(expectedStart(all, e.id, now, margin))}${pri}${kept}`;
}

/** Issue 625: one line per test box: its slots, or why it is skipped. */
export function boxStatusLines(store: GateStore, all: GateEntry[]): string[] {
  return gateBoxesView(
    store,
    all.map((e) => ({ granted: !!e.grantedAt, box: e.box })),
  ).map((b) => {
    const base = `box ${b.name}: ${b.held} of ${b.slots} browser slots held`;
    // Issue 1017: the Playwright versions it serves.
    const pw = b.playwrightVersions?.length
      ? `, playwright ${b.playwrightVersions.join(", ")}`
      : "";
    // A run already on it finishes; it shows beside why the box is skipped.
    const still = b.held ? `; ${b.held} of ${b.slots} browser slots held` : "";
    const off = boxOffWords(b);
    if (off) return `box ${b.name}: skipped, ${off}${still}${pw}`;
    if (
      b.state === "held" ||
      b.state === "unreachable" ||
      b.state === "low" ||
      b.state === "unknown"
    )
      return `box ${b.name}: skipped, ${b.state}${b.reason ? `: ${b.reason}` : ""}${pw}`;
    return (b.state === "unchecked" ? `${base}, not checked yet` : base) + pw;
  });
}

/** Issue 1017: `--pw <version>=<ws>`, repeated, as version → address. */
function pwPairs(v: string | true | string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of Array.isArray(v) ? v : [String(v)]) {
    const eq = p.indexOf("=");
    if (eq < 1 || eq === p.length - 1)
      throw new GateUsage(
        `--pw is <version>=<ws address>, like 1.61=ws://box:3931 (got ${p.slice(0, 80)})`,
      );
    map[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
  }
  return map;
}

/** A flag that takes no value (false), one (true), or repeats ("many"). */
function flags(args: string[], known: Record<string, boolean | "many">) {
  const f: Record<string, string | true | string[]> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      pos.push(...args.slice(i + 1));
      return { f, pos, rest: true };
    }
    if (a.startsWith("--")) {
      // --flag=value, for a flag that takes one.
      const eq = a.indexOf("=");
      const put = (k: string, v: string) => {
        if (known[k] !== "many") return void (f[k] = v);
        const was = f[k];
        f[k] = [...(Array.isArray(was) ? was : []), v];
      };
      if (eq > 2 && known[a.slice(0, eq)]) {
        put(a.slice(0, eq), a.slice(eq + 1));
        continue;
      }
      if (!(a in known)) throw new GateUsage(`unknown option ${a}`);
      if (known[a]) {
        const v = args[++i];
        if (v === undefined) throw new GateUsage(`${a} needs a value`);
        put(a, v);
      } else f[a] = true;
    } else pos.push(a);
  }
  return { f, pos, rest: false };
}

/** Issue 790: the run's tree, from git in its folder. */
async function boxCpuTreeOf(d: GateDeps): Promise<BoxTree> {
  const git =
    d.git ??
    ((a: string[]) =>
      execFileSync("git", a, {
        cwd: d.cwd,
        encoding: "utf-8",
        maxBuffer: 256 * 1024 * 1024,
      }));
  return gitTree(d.cwd, git);
}

/**
 * Issue 790: why this cpu run can't go to a test box (the arguments, the
 * --env values, the tree), or the tree it would ship.
 */
async function boxCpuRefusal(
  argv: string[],
  env: Record<string, string>,
  d: GateDeps,
): Promise<string | { tree: BoxTree }> {
  const why = boxSecretRefusal(argv, env);
  if (why) return why;
  let tree: BoxTree;
  try {
    tree = await boxCpuTreeOf(d);
  } catch {
    return "this folder isn't in a git checkout: a test box gets git's files only. It can run on this machine instead: --box local.";
  }
  const plan = shipPlan(
    tree.files,
    scanSet(tree),
    (f) => {
      try {
        return fs.readFileSync(path.join(tree.root, f));
      } catch {
        return null;
      }
    },
    tree.gitlinks,
  );
  return plan.refused ?? { tree };
}

/** Issue 790: the box run as gate run's command (no process here). */
function boxCpuChild(d: GateDeps, box: GateBox, r: BoxCpuRun): GateRun {
  const st = (d.boxCpu ?? startBoxCpuRun)(box, r, {
    say: (line) => d.err(`gate: ${line}`),
  });
  if (!st.ok) {
    d.err(`gate: not on test box ${box.name}: ${st.error}`);
    return { pid: undefined, kill: () => {}, done: Promise.resolve(2) };
  }
  return { pid: undefined, kill: st.kill, done: st.done };
}

async function run(args: string[], d: GateDeps): Promise<number> {
  const { f, pos, rest } = flags(args, {
    "--kind": true,
    "--estimate": true,
    "--label": true,
    "--priority": true,
    "--reason": true,
    "--box": true,
    "--base-url": true,
    "--pw-version": true,
    "--browser-endpoint": true,
    "--env": "many",
  });
  if (!rest || pos.length === 0)
    throw new GateUsage("gate run needs -- <command> [args]");
  const kind = (f["--kind"] ?? "cpu") as string;
  if (kind !== "browser" && kind !== "cpu")
    throw new GateUsage("--kind is browser or cpu");
  // Issue 625: a browser run that can use a test box's browser says so.
  let where = typeof f["--box"] === "string" ? f["--box"] : undefined;
  // Issue 1033: this machine's own name (not a box's) is local.
  if (
    where !== undefined &&
    isThisMachine(where) &&
    !d.store.boxes().some((b) => b.name === where)
  )
    where = "local";
  if (where !== undefined) {
    if (
      where !== "any" &&
      where !== "local" &&
      !d.store.boxes().some((b) => b.name === where)
    )
      throw new GateUsage(
        `--box is any, local, or a test box's name (${
          d.store
            .boxes()
            .map((b) => b.name)
            .join(", ") || "none set: gate box add"
        })`,
      );
  }
  // Issue 790: a cpu run on a test box: what may go, checked before the ask.
  const envNames = Array.isArray(f["--env"]) ? f["--env"] : [];
  let boxTree: BoxTree | undefined;
  const envVals: Record<string, string> = {};
  if (kind === "cpu" && where !== undefined && where !== "local") {
    const fit = d.store
      .boxes()
      .filter((b) => (b.cpu_slots ?? 0) > 0 && !!b.ssh);
    if (where !== "any" && !fit.some((b) => b.name === where))
      throw new GateUsage(
        `test box ${where} takes no cpu runs (it needs ssh and cpu_slots: gate box add ${where} --cpu-slots N)`,
      );
    for (const n of envNames) {
      const v = d.env[n];
      if (v !== undefined) envVals[n] = v;
    }
    const why = await boxCpuRefusal(pos, envVals, d);
    if (typeof why === "string") {
      if (where !== "any") throw new GateUsage(`not on a test box: ${why}`);
      d.err(`gate: this run stays on this machine: ${why}`);
      where = "local";
    } else boxTree = why.tree;
  } else if (envNames.length)
    throw new GateUsage(
      "--env goes with --kind cpu --box <name|any> (a run here has this machine's environment)",
    );
  const label =
    typeof f["--label"] === "string" ? f["--label"] : path.basename(pos[0]!);
  // Issue 1033: with no --box, a browser run may go anywhere (the
  // setting browser_box_default).
  const anyByDefault =
    where === undefined &&
    kind === "browser" &&
    d.store.settings().browserBoxDefault === "any";
  // Issue 1033: a host-only run never goes to a box, nor runs inside a
  // box's slot: checked before the nested look.
  const hostOnly =
    anyByDefault &&
    !!hostOnlyMatch(
      { label, project: path.basename(d.cwd) },
      d.store.settings().browserHostOnly,
    );
  // Issue 928: inside a held slot of this kind and place: run in it, at
  // once. The outer run checked the browser and keeps the slot.
  const inside = heldSlotFor(
    d,
    kind as GateKind,
    where ?? (anyByDefault && !hostOnly ? "any" : undefined),
  );
  if (inside) {
    d.err(
      `gate: inside ${inside.id} (holds ${kind}${inside.box ? ` on box ${inside.box}` : ""}); running ${label} in it`,
    );
    if (typeof f["--browser-endpoint"] === "string")
      d.err(
        `gate: --browser-endpoint is not used inside ${inside.id}: the held slot's browser is`,
      );
    const child = d.exec(pos[0]!, pos.slice(1));
    const off = d.onSignal((sig) => child.kill(sig));
    // Never past its slot: when the outer run gives it back (it ended),
    // this command stops too, so two runs never share a slot unheld.
    // A command that ignores TERM gets KILL at the next look.
    let gone = false;
    let ended = false;
    void child.done.then(() => (ended = true));
    const look = d.every(NESTED_LOOK_MS, () => {
      if (gone) {
        if (!ended) child.kill("SIGKILL");
        return;
      }
      if (d.store.get(inside.id)?.grantedAt) return;
      gone = true;
      d.err(
        `gate: ${inside.id}'s run ended and gave its slot back; stopping ${label}`,
      );
      child.kill("SIGTERM");
    });
    try {
      return await child.done;
    } finally {
      look();
      off();
    }
  }
  // On macOS a browser run declares a container browser (a Setting):
  // --browser-endpoint, else the run's environment. Checked before it asks.
  const flagEndpoint =
    typeof f["--browser-endpoint"] === "string"
      ? f["--browser-endpoint"].trim()
      : undefined;
  const fromEnv =
    flagEndpoint === undefined && kind === "browser"
      ? endpointFromEnv(d.env)
      : undefined;
  const endpoint = flagEndpoint ?? fromEnv?.endpoint;
  const urls = (typeof f["--base-url"] === "string" ? f["--base-url"] : "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  // Issue 1198: a loopback container named in the run's environment is
  // what this machine's browser runs use here; a box replaces it. One on
  // another host, or one given with --browser-endpoint, the run keeps.
  const envLoopback =
    flagEndpoint === undefined &&
    fromEnv !== undefined &&
    loopbackEndpoint(fromEnv.endpoint);
  const pwFlag =
    typeof f["--pw-version"] === "string" ? f["--pw-version"] : undefined;
  // Issue 1033: no --box: the first free browser slot, here or on a test
  // box; or here, saying why in one line (never a failure for it).
  let hostWhy: string | undefined;
  let onlyBoxes: string[] | undefined;
  if (anyByDefault && d.store.boxes().length) {
    const badUrl = urls.map(checkBaseUrl).find(Boolean);
    const pick = badUrl
      ? { why: `--base-url ${badUrl}, so a test box can't reach the app` }
      : defaultPlace({
          setting: "any",
          hostOnly: d.store.settings().browserHostOnly,
          label,
          project: path.basename(d.cwd),
          boxes: d.store.boxes(),
          // Issue 1198: none given: the ports the run opens (DEFAULT_BASE).
          baseUrl: true,
          pwVersion: pwFlag ?? playwrightVersion(d.cwd),
          // A run that brings its own browser (the flag, or its
          // environment) keeps it: a box would only change DEN_PW_WS.
          ...(endpoint !== undefined && !envLoopback
            ? {
                ownBrowser:
                  endpoint === SELF
                    ? "it starts its own browser container"
                    : `it brings its own browser (${fromEnv?.from ?? "--browser-endpoint"})`,
              }
            : {}),
        });
    where = pick.where;
    hostWhy = pick.why;
    onlyBoxes = pick.only;
    if (where === "any" && !urls.length) urls.push(DEFAULT_BASE);
    if (hostWhy) d.err(`gate: stays on this machine: ${hostWhy}`);
    if (pick.skipped) d.err(`gate: skips ${pick.skipped}`);
  }
  const verdict = browserSlotCheck({
    kind: kind as GateKind,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(where ? { where } : {}),
    platform: d.store.platform,
    requiresContainer: d.store.settings().browserRequiresContainer,
    // Issue 1198: "any" with none of its own waits only for a box that
    // could ever take it; else it is refused at once.
    ...(where === "any"
      ? {
          boxCouldServe: boxCouldServe(
            d.store.boxes(),
            pwFlag ?? playwrightVersion(d.cwd),
            onlyBoxes,
          ),
        }
      : {}),
  });
  if (!verdict.ok)
    throw new GateUsage(
      browserSlotRefusal(verdict, {
        lang: d.lang ?? personLanguage(),
        surface: "cli",
        cli: product().cli,
        ...(fromEnv ? { from: fromEnv.from } : {}),
        ...(endpoint !== undefined ? { value: endpoint } : {}),
      }),
    );
  // Clause 9: a run that may use a box's browser declares its base URLs,
  // each loopback with an explicit port other than 80 or 443. The run is
  // handed them (DEN_GATE_ALLOW) to guard every browser context.
  const allow: string[] = [];
  // Issue 790: a cpu run on a box opens no browser (no base URLs).
  if (kind === "browser" && where && where !== "local") {
    if (!urls.length)
      throw new GateUsage(
        "a box run needs --base-url http://<name>.localhost:<port>[,…] (or http://127.0.0.1:* for the ports the run opens itself): the app's loopback addresses, never port 80 or 443",
      );
    for (const u of urls) {
      const bad = checkBaseUrl(u);
      if (bad) throw new GateUsage(`--base-url ${bad}`);
      allow.push(allowOf(u));
    }
  }
  // Clause 11: the run's Playwright client version (a box whose server
  // differs is skipped, saying why).
  const pwVersion =
    pwFlag !== undefined
      ? pwFlag
      : where && where !== "local"
        ? playwrightVersion(d.cwd)
        : undefined;
  // Issue 1017: a box with several Playwright servers can't pick one for a
  // run whose version is unknown: said plainly, before it asks.
  const named =
    where && where !== "any" && where !== "local"
      ? d.store.boxes().find((b) => b.name === where)
      : undefined;
  if (named?.playwright_endpoints && !pwVersion)
    throw new GateUsage(
      `box ${named.name} serves Playwright ${Object.keys(named.playwright_endpoints).join(", ")} and this run's Playwright version is unknown: pass --pw-version`,
    );
  // Issue 999: none given: the gate measures it from the label's runs.
  const estimateMin =
    typeof f["--estimate"] === "string"
      ? parseEstimate(f["--estimate"])
      : undefined;
  // Issue 715: a release run a person waits on, and why.
  const priority = f["--priority"];
  const reason = typeof f["--reason"] === "string" ? f["--reason"].trim() : "";
  if (priority !== undefined && priority !== "release")
    throw new GateUsage("--priority is release");
  if (priority && !reason)
    throw new GateUsage(
      '--priority release needs --reason "<why>" (who waits on it)',
    );
  if (reason && !priority)
    throw new GateUsage("--reason goes with --priority release");
  const s = d.store;
  const actor = d.env[AGENT_ACTOR_ENV]?.trim();
  // Issue 1289: the checkout this run is in (its kept containers' owner).
  const checkout = checkoutTag(checkoutOf(d.cwd));
  let e: GateEntry | null;
  try {
    e = s.ask({
      kind: kind as GateKind,
      who: whoAsks(d.env, d.cwd),
      label,
      pid: d.pid,
      estimateMin,
      agent: isAgentEnv(d.env),
      project: path.basename(d.cwd),
      checkout,
      ...(actor ? { actor } : {}),
      ...(priority ? { priority: { reason } } : {}),
      ...(where ? { where } : {}),
      ...(pwVersion ? { pwVersion } : {}),
      ...(verdict.declared ? { browserEndpoint: verdict.declared } : {}),
      ...(hostWhy ? { hostWhy } : {}),
      ...(onlyBoxes ? { onlyBoxes } : {}),
      ...(verdict.ok && verdict.boxesOnly ? { boxesOnly: true } : {}),
    });
  } catch (err) {
    if (err instanceof GatePriorityRefused) throw new GateUsage(err.message);
    throw err;
  }
  // Issue 867: back in a place kept since a restart, or told what became
  // of the earlier one.
  const kw = KEPT_PLACE_WORDS[d.lang ?? personLanguage()];
  if (s.lastAskReattached)
    d.err(`gate: ${kw.back(e.id, hm(Date.parse(e.askedAt)))}`);
  else {
    const was = s.droppedFor(e);
    if (was)
      d.err(
        `gate: ${kw.letGo(hm(Date.parse(was.askedAt)), hm(Date.parse(was.at)), s.settings().waiterReturnMinutes)}`,
      );
  }
  // Issue 963: asked for release priority, but it is off here.
  if (priority && s.settings().priorityMax === 0)
    d.err(`gate: ${PRIORITY_OFF_RUN[d.lang ?? personLanguage()]}`);
  const id = e.id;
  const onBox = !!e.box;
  let child: GateRun | undefined;
  let released = false;
  let dumped = false;
  let cancelled: number | undefined;
  const release = () => {
    if (!released) s.release(id);
    released = true;
  };
  // While waiting, a signal gives the place back and leaves. While the
  // command runs, it goes to the command, whose end gives the slot back:
  // a slot is never free while the run it was for goes on.
  // Issue 867: a hang-up or terminate while waiting (a restart ending
  // this run) keeps the place for the run's return; Ctrl-C gives it back.
  const off = d.onSignal((sig) => {
    if (child) return child.kill(sig);
    const keep =
      (sig === "SIGHUP" || sig === "SIGTERM") &&
      s.settings().waiterReturnMinutes > 0;
    if (keep) released = true;
    else release();
    cancelled = signalCode(sig);
    d.exit(cancelled);
  });
  try {
    let said = 0;
    while (!e.grantedAt) {
      if (d.now() - said >= 60_000) {
        const all = s.list();
        const set = s.settings();
        for (const h of all.filter((x) => x.grantedAt))
          d.err(`waiting: ${slotLine(h, all, d.now(), set)}`);
        // Issue 1009: a cpu run held by the load says so.
        const hold =
          e.kind === "cpu" && !e.priority
            ? loadHold(all, set, s.load(), s.cores())
            : undefined;
        if (hold) d.err(holdWords(hold));
        // Issue 1274: a run here held by low memory says so.
        const mem =
          !where || where === "local"
            ? memoryHold(all, set, s.freeMemory())
            : undefined;
        if (mem) d.err(memoryHoldWords(mem));
        const sw =
          !where || where === "local"
            ? swapHold(all, set, s.swapUsedGb())
            : undefined;
        if (sw) d.err(swapHoldWords(sw));
        said = d.now();
      }
      await d.sleep(2_000);
      if (cancelled !== undefined) return cancelled;
      // Issue 625: a box a slot is about to be given on is checked first.
      if (where && where !== "local") await s.checkBoxes();
      e = s.get(id);
      if (!e) throw new Error(`the slot ${id} was ended while waiting`);
    }
    const box = e.box ? s.boxes().find((b) => b.name === e!.box) : undefined;
    // Issue 1132: no start at or over the load ceiling; past the wait
    // limit it starts anyway, recorded as busy. Issue 790: a cpu run on a
    // box doesn't load this machine.
    const cpuOnBox = kind === "cpu" && !!box;
    const held = cpuOnBox ? "start" : await waitForLoad(d, id, label);
    if (cancelled !== undefined) return cancelled;
    if (held === "gone")
      throw new Error(`the slot ${id} was ended while waiting`);
    d.err(`gate: ${id} holds ${kind}${machineWords(e)}; running ${label}`);
    // Issue 928: the command knows the slot it runs in.
    const slotEnv: Record<string, string> = {
      [GATE_SLOT_ENV]: id,
      [GATE_SLOT_KIND_ENV]: kind,
      [GATE_SLOT_BOX_ENV]: e.box ?? "local",
      // Issue 1263: the store's tag, for a throwaway container's labels.
      [GATE_STORE_ENV]: storeTag(s.dir),
      // Issue 1289: the checkout's tag, for a kept container's label.
      [GATE_CHECKOUT_ENV]: checkout,
    };
    // Issue 1048: a cpu run here uses its share of the cores, no more.
    if (kind === "cpu" && !e.box)
      slotEnv[GATE_WORKERS_ENV] = String(
        gateWorkers(d.cores ?? realCores(), s.settings().cpuSlots),
      );
    child = cpuOnBox
      ? boxCpuChild(d, box!, {
          // Issue 790: the folder on the box is this install's (its tag).
          id: boxRunName(storeTag(s.dir), id),
          tag: storeTag(s.dir),
          argv: pos,
          env: { CI: "true", [GATE_WORKERS_ENV]: "1", ...slotEnv },
          pass: envVals,
          tree: boxTree ?? (await boxCpuTreeOf(d)),
          live: s
            .list()
            .filter((x) => x.box === box!.name && x.grantedAt)
            .map((x) => boxRunName(storeTag(s.dir), x.id)),
        })
      : box
        ? d.exec(pos[0]!, pos.slice(1), {
            // Issue 1017: the box's endpoint for this run's version.
            ...boxEnv(box, e.pwVersion),
            DEN_GATE_ALLOW: allow.join(","),
            ...slotEnv,
          })
        : flagEndpoint && flagEndpoint !== "self" && kind === "browser"
          ? // The address given on the command line reaches the run.
            d.exec(pos[0]!, pos.slice(1), {
              DEN_PW_WS: flagEndpoint,
              ...slotEnv,
            })
          : d.exec(pos[0]!, pos.slice(1), slotEnv);
    if (child.pid !== undefined)
      s.setRunPid(id, child.pid, { group: child.group, cmd: pos[0] });
    // Issue 1132: the group as the store recorded it (with its leader's
    // record and the boot), for a reap after a dump gave the slot back.
    const recorded = s.get(id);
    const mine = {
      id,
      kind: e.kind,
      who: e.who,
      label: e.label,
      ...(recorded?.group !== undefined
        ? {
            group: recorded.group,
            groupRec: recorded.groupRec,
            boot: recorded.boot,
          }
        : {}),
      cmd: path.basename(pos[0]!).slice(0, 60),
    };
    // Issue 1132: the run's folder deleted, or its parent gone: the slot
    // ends with that reason, and its group is stopped (the command too).
    const watch = d.watch;
    const noWatch = watch
      ? d.every(WATCH_LOOK_MS, () => {
          if (released) return;
          const why = watch.folderGone()
            ? "folder-gone"
            : watch.parentGone()
              ? "parent-gone"
              : undefined;
          if (!why) return;
          d.err(
            `gate: ${label}: ${why === "folder-gone" ? "its folder was deleted" : "the process that started it is gone"}; stopping it and what it started`,
          );
          s.release(id, { reason: why });
          released = true;
        })
      : () => {};
    // Issue 1023: a command that took SIGQUIT (from gate run or anyone)
    // and is dumping core can run no more: its slot is given back then,
    // not after the dump, which a crash handler may take seconds to read.
    const dumping = child.dumping;
    const noDump = dumping
      ? d.every(DUMP_LOOK_MS, () => {
          // Its dump is left to finish: what it started is stopped after.
          if (!released && dumping()) {
            s.release(id, { reap: false });
            released = true;
            dumped = true;
          }
        })
      : () => {};
    // Past its estimate plus the margin, it says so once; never stopped.
    let flagged = false;
    const stop = d.every(60_000, () => {
      const now = s.get(id);
      if (!now || flagged || !now.flaggedAt) return;
      flagged = true;
      d.err(
        `gate: ${label} is past its estimate (${queueMinOf(now)} min${now.padded ? `, measured; ${now.estimateMin} min was given` : ""}); it is not stopped, and the slot stays its own until it ends`,
      );
    });
    let code: number;
    try {
      code = await child.done;
    } finally {
      noDump();
      noWatch();
      stop();
    }
    // Issue 1132: the slot ends, and what the command left in its group
    // is stopped: TERM now, KILL after the grace. gate run stays until it
    // is done (or a little past the grace), so its end means the tree's.
    release();
    if (dumped) s.reap(mine, "ended");
    if (mine.group !== undefined) {
      const until = d.now() + (s.settings().reapGraceSeconds + 2) * 1000;
      while (s.stopLeftovers(id) && d.now() < until) await d.sleep(200);
    }
    return code;
  } finally {
    off();
    release();
    // Issue 1263: the run's throwaway containers go with its slot (a box
    // run's are on the box, swept there). Never fails the run.
    if (d.docker && !onBox) await cleanRun(s, id, d.docker, checkout);
  }
}

/**
 * Issue 1132: before a granted run's command starts, it waits while the
 * machine's load is at or over gates.max_start_load, saying why (and in
 * its record, for gate status and the Gate page). Past
 * gates.max_start_wait_minutes it starts anyway, recorded as busy.
 * "gone": the slot was ended while it waited.
 */
async function waitForLoad(
  d: GateDeps,
  id: string,
  label: string,
): Promise<"start" | "busy" | "gone"> {
  const s = d.store;
  const t0 = d.now();
  let said = -Infinity;
  for (;;) {
    const set = s.settings();
    const hold = startHold(set, s.load());
    if (!hold) {
      s.setStartHold(id);
      return "start";
    }
    const waitMs = set.maxStartWaitMinutes * 60_000;
    if (set.maxStartWaitMinutes > 0 && d.now() - t0 >= waitMs) {
      s.startedBusy(id, hold);
      d.err(
        `gate: ${label}: the load (${round1(hold.load)}) is still at or over ${hold.limit} after ${set.maxStartWaitMinutes} min; starting anyway (recorded as busy)`,
      );
      return "busy";
    }
    s.setStartHold(id, hold);
    if (d.now() - said >= 60_000) {
      d.err(
        `gate: ${id} holds its slot; ${START_HOLD_WORDS[d.lang ?? personLanguage()](round1(hold.load), hold.limit)} (gates.max_start_load)`,
      );
      said = d.now();
    }
    await d.sleep(HOLD_LOOK_MS);
    if (!s.get(id)) return "gone";
  }
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function status(args: string[], d: GateDeps): number {
  const { f } = flags(args, { "--json": false });
  if (f["--json"]) {
    d.out(JSON.stringify(gateView(d.store, d.now()), null, 2));
    return 0;
  }
  const all = d.store.list();
  // Issue 1009: the load, so a held cpu waiter's line says why.
  const set = {
    ...d.store.settings(),
    load: d.store.load(),
    cores: d.store.cores(),
    freeMemory: d.store.freeMemory(),
    swapUsedGb: d.store.swapUsedGb(),
    lang: d.lang ?? personLanguage(),
  };
  if (all.length === 0) d.out("No gate runs hold or wait.");
  for (const e of all) d.out(slotLine(e, all, d.now(), set));
  for (const l of boxStatusLines(d.store, all)) d.out(l);
  // Issue 1274: free memory, and what running VMs reserve.
  for (const l of machineLines(
    gateView(d.store, d.now(), { vmsNow: true }).machine,
  ))
    d.out(l);
  // Issue 1263: throwaway containers removed after their run ended.
  for (const r of removedView(d.store, d.now()))
    d.out(
      `Gate: removed ${r.count} container${r.count === 1 ? "" : "s"} for ${r.label} (${r.id}) at ${localDateTime(r.at)}${r.images.length ? `: ${r.images.join(", ")}` : ""}`,
    );
  // Issue 1132: what was stopped of ended runs in the last hour.
  for (const r of d.store.stoppedLeftovers(d.now() - 60 * 60_000))
    if (r.signal !== "KILL")
      d.out(
        `${hm(Date.parse(r.at))}  ${LEFTOVER_WORDS[set.lang](r.count ?? 0, r.label, r.cmd ?? "")}${r.reason && r.reason !== "ended" ? `  (${r.reason})` : ""}`,
      );
  // Issue 963: said plainly, so a release run waiting in line has a why.
  if (set.priorityMax === 0)
    d.out(PRIORITY_OFF_STATUS[d.lang ?? personLanguage()]);
  return 0;
}

/**
 * Issue 625: the test boxes. `box list`; `box add <name> --ssh <dest>
 * [--ssh-port N] [--ssh-identity <key file>] [--playwright ws://…]
 * [--slots N] [--hold-file <path>] [--time-scale X] [--window HH:MM-HH:MM]
 * [--off] [--recheck-seconds N]` (adds or replaces); `box remove <name>`;
 * `box enable|disable <name>`. Changing them is a person's.
 */
async function boxCmd(args: string[], d: GateDeps): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === "list" || verb === undefined) {
    const boxes = d.store.boxes();
    if (!boxes.length) d.out("No test boxes set (gate box add).");
    for (const b of boxes)
      d.out(
        `${b.name}  ${b.browser_slots} browser slot${b.browser_slots === 1 ? "" : "s"}` +
          (b.ssh ? `  ssh ${b.ssh}${b.ssh_port ? `:${b.ssh_port}` : ""}` : "") +
          (b.playwright ? `  playwright ${b.playwright}` : "") +
          (b.playwright_endpoints
            ? `  playwright ${Object.entries(b.playwright_endpoints)
                .map(([v, ws]) => `${v}=${ws}`)
                .join(", ")}`
            : "") +
          (b.hold_file ? `  hold file ${b.hold_file}` : "") +
          (b.time_scale && b.time_scale !== 1
            ? `  time scale ${b.time_scale}`
            : "") +
          (b.window ? `  window ${b.window} (this machine's time)` : "") +
          (b.recheck_seconds
            ? `  rechecked after ${b.recheck_seconds} s`
            : "") +
          (b.enabled === false ? "  turned off" : ""),
      );
    return 0;
  }
  if (
    verb !== "add" &&
    verb !== "remove" &&
    verb !== "enable" &&
    verb !== "disable"
  )
    throw new GateUsage("gate box <list|add|remove|enable|disable> ...");
  if (isAgentEnv(d.env))
    throw new GateUsage(
      `gate box ${verb}: only a person can change the test boxes (this is an agent)`,
    );
  const { f, pos } = flags(rest, {
    "--ssh": true,
    "--ssh-port": true,
    "--ssh-identity": true,
    "--playwright": true,
    "--slots": true,
    "--cpu-slots": true,
    "--hold-file": true,
    "--time-scale": true,
    "--min-free-mem-mb": true,
    "--playwright-version": true,
    "--pw": "many",
    "--window": true,
    "--recheck-seconds": true,
    "--off": false,
  });
  const [name, extra] = pos;
  if (!name || extra) throw new GateUsage(`gate box ${verb} needs one <name>`);
  if (verb === "enable" || verb === "disable") {
    const via = await viaServer(
      d,
      `gate box ${verb}`,
      "/api/gate-slots/boxes/enable",
      {
        name,
        enabled: verb === "enable",
      },
    );
    if (via === false) return 1;
    if (via) {
      d.out(
        verb === "enable"
          ? `Box ${name} turned on.`
          : `Box ${name} turned off: no new slots and no contact. Its running slots finish.`,
      );
      return 0;
    }
    const b = d.store.setBoxEnabled(name, verb === "enable");
    if (!b) {
      d.err(`gate box ${verb}: no box ${name}`);
      return 1;
    }
    d.out(
      verb === "enable"
        ? `Box ${name} turned on${b.window ? `: slots within ${b.window}, this machine's time` : ""}.`
        : `Box ${name} turned off: no new slots and no contact. Its running slots finish.`,
    );
    return 0;
  }
  if (verb === "remove") {
    const via = await viaServer(
      d,
      "gate box remove",
      "/api/gate-slots/boxes/remove",
      {
        name,
      },
    );
    if (via === false) return 1;
    if (!via && !d.store.removeBox(name)) {
      d.err(`gate box remove: no box ${name}`);
      return 1;
    }
    d.out(`Removed box ${name}. Its running slots finish.`);
    return 0;
  }
  const num = (k: string) =>
    typeof f[k] === "string" ? Number(f[k]) : undefined;
  const c = checkBox({
    name,
    ssh: f["--ssh"],
    ssh_port: num("--ssh-port"),
    ssh_identity: f["--ssh-identity"],
    playwright: f["--playwright"],
    browser_slots: num("--slots"),
    cpu_slots: num("--cpu-slots"),
    hold_file: f["--hold-file"],
    time_scale: num("--time-scale"),
    min_free_mem_mb: num("--min-free-mem-mb"),
    playwright_version: f["--playwright-version"],
    ...(f["--pw"] ? { playwright_endpoints: pwPairs(f["--pw"]) } : {}),
    window: f["--window"],
    recheck_seconds: num("--recheck-seconds"),
    ...(f["--off"] ? { enabled: false } : {}),
  });
  if (!c.ok) throw new GateUsage(c.error);
  const via = await viaServer(d, "gate box add", "/api/gate-slots/boxes", {
    box: c.box,
  });
  if (via === false) return 1;
  if (!via) d.store.setBox(c.box);
  d.out(
    `Box ${name} set: ${c.box.browser_slots} browser slot${c.box.browser_slots === 1 ? "" : "s"}${c.box.cpu_slots ? `, ${c.box.cpu_slots} cpu slot${c.box.cpu_slots === 1 ? "" : "s"} (gate run --kind cpu --box ${name})` : ""}. A browser run with --base-url takes it when it is free (gate settings --browser-box-default local: only with --box).`,
  );
  return 0;
}

async function end(args: string[], d: GateDeps): Promise<number> {
  if (isAgentEnv(d.env))
    throw new GateUsage(
      "gate end: only a person can end a slot early (this is an agent)",
    );
  const [id, extra] = flags(args, {}).pos;
  if (!id || extra) throw new GateUsage("gate end needs one <id>");
  if (/^[a-z0-9-]{1,64}$/.test(id)) {
    const via = await viaServer(d, "gate end", "/api/gate-slots/end", { id });
    if (via === false) return 1;
    if (via) {
      d.out(`Ended ${id}. Whoever ran it was not stopped; its slot is free.`);
      return 0;
    }
  }
  if (
    !/^[a-z0-9-]{1,64}$/.test(id) ||
    !d.store.endEarly(id, whoAsks(d.env, d.cwd))
  ) {
    d.err(`gate end: no slot ${id}`);
    return 1;
  }
  d.out(`Ended ${id}. Whoever ran it was not stopped; its slot is free.`);
  return 0;
}

/**
 * Issue 795: your waiting entry lets another waiting entry go just ahead
 * of it. Yours: an agent's (its DEN_AGENT) or, for a person, one no agent
 * asked for. It only moves your own place back, so it is not a person's
 * only.
 */
function yieldPlace(args: string[], d: GateDeps): number {
  const { f, pos } = flags(args, { "--to": true });
  const [id, extra] = pos;
  const to = f["--to"];
  if (!id || extra || typeof to !== "string")
    throw new GateUsage("gate yield needs <my-id> --to <their-id>");
  const actor = d.env[AGENT_ACTOR_ENV]?.trim();
  const agent = isAgentEnv(d.env);
  const owns = (e: GateEntry) =>
    !e.remote && (agent ? !!actor && e.actor === actor : !e.agent);
  try {
    d.store.yieldTo(id, to, owns);
  } catch (err) {
    if (err instanceof GateYieldRefused) {
      d.err(`gate yield: ${err.message}`);
      return 1;
    }
    throw err;
  }
  d.out(`${to} goes just ahead of ${id}; ${id} keeps its place otherwise.`);
  return 0;
}

async function settings(args: string[], d: GateDeps): Promise<number> {
  const { f } = flags(args, {
    "--cpu-slots": true,
    "--overrun-margin-minutes": true,
    "--overrun-bell-multiple": true,
    "--remote-renew-seconds": true,
    "--remote-lapse-seconds": true,
    "--remote-max-slots": true,
    "--remote-max-asks": true,
    "--cpu-slots-beside-browser": true,
    "--cpu-slots-beside-release-browser": true,
    "--local-browser-slots": true,
    "--cpu-hold-load": true,
    "--load-hold-per-core": true,
    "--max-start-load": true,
    "--max-start-wait-minutes": true,
    "--reap-grace-seconds": true,
    "--memory-free-min-percent": true,
    "--swap-hold-gb": true,
    "--vm-memory-share": true,
    "--priority-max": true,
    "--priority-pass-limit-minutes": true,
    "--priority-agents": true,
    "--priority-runners": true,
    "--claim-minutes": true,
    "--mcp-renew-minutes": true,
    "--mcp-lapse-minutes": true,
    "--mcp-grace-minutes": true,
    "--waiter-return-minutes": true,
    "--box-check-timeout-seconds": true,
    "--box-recheck-seconds": true,
    "--class-order": true,
    "--class-map": true,
    "--class-windows": true,
    "--browser-requires-container": true,
    "--browser-box-default": true,
    "--browser-host-only": true,
    "--yes": false,
    // Issue 1395: an agent's ask says why.
    "--reason": true,
  });
  const raw: Record<string, number | string | null> = {};
  for (const [flag, key] of [
    ["--cpu-slots", "cpu_slots"],
    ["--cpu-slots-beside-browser", "cpu_slots_beside_browser"],
    ["--cpu-slots-beside-release-browser", "cpu_slots_beside_release_browser"],
    ["--local-browser-slots", "local_browser_slots"],
    ["--cpu-hold-load", "cpu_hold_load"],
    ["--load-hold-per-core", "load_hold_per_core"],
    ["--max-start-load", "max_start_load"],
    ["--max-start-wait-minutes", "max_start_wait_minutes"],
    ["--reap-grace-seconds", "reap_grace_seconds"],
    ["--memory-free-min-percent", "memory_free_min_percent"],
    ["--swap-hold-gb", "swap_hold_gb"],
    ["--memory-reading-keep-seconds", "memory_reading_keep_seconds"],
    ["--vm-memory-share", "vm_memory_share"],
    ["--overrun-margin-minutes", "overrun_margin_minutes"],
    ["--overrun-bell-multiple", "overrun_bell_multiple"],
    ["--remote-renew-seconds", "remote_renew_seconds"],
    ["--remote-lapse-seconds", "remote_lapse_seconds"],
    ["--remote-max-slots", "remote_max_slots"],
    ["--remote-max-asks", "remote_max_asks"],
    ["--priority-max", "priority_max"],
    ["--priority-pass-limit-minutes", "priority_pass_limit_minutes"],
    ["--priority-agents", "priority_agents"],
    ["--priority-runners", "priority_runners"],
    ["--claim-minutes", "claim_minutes"],
    ["--mcp-renew-minutes", "mcp_renew_minutes"],
    ["--mcp-lapse-minutes", "mcp_lapse_minutes"],
    ["--mcp-grace-minutes", "mcp_grace_minutes"],
    ["--waiter-return-minutes", "waiter_return_minutes"],
    ["--box-check-timeout-seconds", "box_check_timeout_seconds"],
    ["--box-recheck-seconds", "box_recheck_seconds"],
    ["--browser-requires-container", "browser_requires_container"],
  ] as const) {
    const v = f[flag];
    if (typeof v === "string") raw[key] = Number(v);
  }
  // Issue 803: a line of text each; "" clears it.
  for (const [flag, key] of [
    ["--class-order", "class_order"],
    ["--class-map", "class_map"],
    ["--class-windows", "class_windows"],
    // Issue 1033: where a browser run with no --box goes.
    ["--browser-box-default", "browser_box_default"],
    ["--browser-host-only", "browser_host_only"],
  ] as const) {
    const v = f[flag];
    if (typeof v === "string") raw[key] = v.trim() || null;
  }
  if (Object.keys(raw).length) {
    const c = checkGatePatch(raw);
    if (!c.ok) throw new GateUsage(c.error);
    // Issue 1395: an agent asks for gate_settings_set; never writes here.
    if (isAgentEnv(d.env)) {
      const done = await askGateSettings(d, c.patch, f["--reason"]);
      if (done !== 0) return done;
      return showSettings(d);
    }
    // Issue 963: turning release priority off warns first; --yes goes on.
    const lang = d.lang ?? personLanguage();
    if (
      (c.patch as GateSettingsPatch).priority_max === 0 &&
      d.store.settings().priorityMax !== 0 &&
      !f["--yes"]
    ) {
      d.err(`gate settings: ${PRIORITY_OFF_WARNING[lang]}`);
      return 1;
    }
    // Issue 1182: the running server saves it, audited as the person
    // (POST /api/settings, which refuses agents); with none listening the
    // CLI writes it as before.
    const via = await viaServer(d, "gate settings", "/api/settings", {
      gate_slots: c.patch,
    });
    if (via === false) return 1;
    if (via === null)
      d.store.writeSettings(
        c.patch as GateSettingsPatch,
        whoAsks(d.env, d.cwd),
      );
  }
  return showSettings(d);
}

/**
 * Issue 1395: an agent's `gate settings` change, asked of Den as the held
 * write gate_settings_set (the approval policy decides: written at once,
 * or held for the person's Allow). 0 when written or held; 1 when refused
 * or no server answered. The CLI writes nothing itself for an agent.
 */
async function askGateSettings(
  d: GateDeps,
  patch: GateSettingsPatch,
  reasonFlag: string | boolean | string[] | undefined,
): Promise<number> {
  const reason = typeof reasonFlag === "string" ? reasonFlag.trim() : "";
  if (!reason)
    throw new GateUsage(
      'gate settings: an agent asks the person for a change: add --reason "<why>"',
    );
  let r: Awaited<ReturnType<PersonServer>>;
  try {
    r = await (d.server ?? personServerFor())("POST", "/api/approvals", {
      action: "gate_settings_set",
      args: { settings: patch, reason },
    });
  } catch (e) {
    d.err(`gate settings: ${(e as Error).message}; nothing was changed`);
    return 1;
  }
  if (r === null) {
    d.err(
      "gate settings: Den's web app isn't answering, so nothing was asked or changed",
    );
    return 1;
  }
  const j = r.json ?? {};
  const result = (j.result ?? {}) as Record<string, unknown>;
  if ((r.status !== 200 && r.status !== 202) || j.ok === false) {
    d.err(`gate settings: ${String(j.error ?? `Den answered ${r.status}`)}`);
    return 1;
  }
  if (j.state === "done" && result.ok === false) {
    d.err(`gate settings: ${String(result.error ?? "it failed")}`);
    return 1;
  }
  if (j.state === "done") {
    const changed = Array.isArray(result.changed) ? result.changed : [];
    d.out(
      changed.length
        ? `✓ gate settings changed: ${changed.join(", ")}`
        : `✓ gate settings: ${String(result.note ?? "already in effect")}`,
    );
    return 0;
  }
  d.out(
    `gate settings: waiting for the person's Allow in Den (request ${String(j.id ?? "")}); check it with the MCP tool approval_check`,
  );
  return 0;
}

/** The settings, each with its meaning and value, and the summary line. */
function showSettings(d: GateDeps): number {
  const s = d.store.settings();
  // Issue 963: each setting, its value and what it means.
  const meanings = GATE_MEANINGS[d.lang ?? personLanguage()];
  for (const [k, m] of Object.entries(meanings)) {
    const camel = k.replace(/_([a-z])/g, (_x, c: string) => c.toUpperCase());
    const v = (s as unknown as Record<string, unknown>)[camel];
    const shown =
      typeof v === "boolean" ? (v ? 1 : 0) : v === undefined ? "" : v;
    d.out(`  ${k}: ${m} · now ${shown === "" ? "unset" : String(shown)}`);
  }
  d.out(
    `cpu slots ${s.cpuSlots}, ${s.cpuSlotsBesideBrowser ? `${s.cpuSlotsBesideBrowser} beside a browser run` : "none beside a browser run"}, ${s.cpuSlotsBesideReleaseBrowser ? `${s.cpuSlotsBesideReleaseBrowser} beside a release one` : "none beside a release one"} · browser runs at once here ${s.localBrowserSlots} · ${s.cpuHoldLoad ? `cpu runs wait at load ${s.cpuHoldLoad} while a release browser run holds` : "no load hold (cpu_hold_load 0)"} · ${s.loadHoldPerCore ? `new cpu runs wait over a load of ${s.loadHoldPerCore} × the cores while one is going` : "no per-core load hold (load_hold_per_core 0)"} · ${s.maxStartLoad ? `no run starts at a load of ${s.maxStartLoad} or more (starts anyway after ${s.maxStartWaitMinutes ? `${s.maxStartWaitMinutes} min` : "no limit"})` : "no start ceiling (max_start_load 0)"} · leftovers killed ${s.reapGraceSeconds} s after a run ends · flagged ${s.overrunMarginMinutes} min past its estimate, in the bell past ${s.overrunBellMultiple}× it · CI runners renew every ${s.remoteRenewSeconds} s, taken back after ${s.remoteLapseSeconds} s, at most ${s.remoteMaxSlots} slots and ${s.remoteMaxAsks} asks each · ${s.priorityMax === 0 ? "release priority: off (priority_max 0)" : `release priority: ${s.priorityMax} per kind at a time, ${s.priorityPassLimitMinutes ? `never past a marked run waiting ${s.priorityPassLimitMinutes} min` : "never past another marked run"}, ${s.priorityAgents ? "agents and people" : "people only"} may ask`} · test boxes checked within ${s.boxCheckTimeoutSeconds} s, a held or unreachable one checked again after ${s.boxRecheckSeconds} s · browser runs need a container: ${s.browserRequiresContainer ? "yes" : "no"} · a browser run with no --box: ${s.browserBoxDefault === "any" ? "here or a test box" : "here only"}${s.browserHostOnly ? `, kept here: ${s.browserHostOnly}` : ""}${
      s.classes
        ? ` · classes, highest first: ${s.classes.order.join(", ")}${s.classMap ? ` (${s.classMap})` : ""}${s.classWindows ? `, windows ${s.classWindows}` : ""}`
        : ""
    }`,
  );
  return 0;
}

export async function cmdGate(
  args: string[],
  d: GateDeps = realGateDeps(),
): Promise<number> {
  try {
    switch (args[0]) {
      case "run":
        return await run(args.slice(1), d);
      case "status":
        return status(args.slice(1), d);
      case "end":
        return await end(args.slice(1), d);
      case "box":
        return await boxCmd(args.slice(1), d);
      case "yield":
        return yieldPlace(args.slice(1), d);
      case "settings":
        return await settings(args.slice(1), d);
      default:
        d.err(`usage: ${GATE_HELP.usage}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof GateUsage) {
      d.err(`gate: ${e.message}`);
      return 2;
    }
    d.err(`gate: ${(e as Error).message}`);
    return 1;
  }
}
