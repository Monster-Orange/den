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
 *       (whichever frees first); the run gets DEN_GATE_BOX, DEN_PW_WS
 *       --browser-endpoint ws://…|self: where a browser run's browser
 *       runs (a container's Playwright endpoint, or a container the run
 *       starts itself); also read from DEN_PW_WS, HUB_PW_WEBKIT_WS,
 *       E2E_WEBKIT_WS. On macOS a browser run without one is refused
 *       (gates/browser-container.ts; a Setting)
 *   status [--json]          who holds, who waits, overruns, test boxes
 *   box <list|add|remove>    the test boxes (a person changes them)
 *   end <id>                 a person ends a slot early (refused for an
 *                            agent); recorded with who
 *   yield <my-id> --to <id>  issue 795: your waiting entry lets another
 *                            waiting entry go just ahead of it (yours only)
 *   settings [--cpu-slots N] [--cpu-slots-beside-browser N]
 *            [--local-browser-slots N]
 *            [--overrun-margin-minutes N]
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
 *                            the machine's; a person changes them. Issue
 *                            803: priority classes per project ("" clears)
 */
import { spawn } from "child_process";
import * as path from "path";
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import { classOf, windowHeld } from "../../shared/gates/classes.js";
import {
  expectedEnd,
  expectedStart,
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
  type GateSettingsPatch,
} from "../../shared/gates/store.js";
import * as fs from "fs";
import { boxEnv, checkBox } from "../../shared/gates/boxes.js";
import {
  browserSlotCheck,
  browserSlotRefusal,
  endpointFromEnv,
  personLanguage,
  type UiLanguage,
} from "../../shared/gates/browser-container.js";
import { descendsFrom } from "../../shared/peer-process.js";
import { allowOf, checkBaseUrl } from "../../shared/gates/pw-guard.js";
import { gateBoxesView, gateView } from "../../shared/gates/view.js";
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
    "    --box any: a browser run that can use a test box's browser takes",
    "    whichever slot frees first, here or on a box (DEN_PW_WS is set)",
    "    --browser-endpoint ws://…: the container browser a browser run uses",
    "    (or DEN_PW_WS, HUB_PW_WEBKIT_WS, E2E_WEBKIT_WS); =self: the run starts",
    "    its own. On macOS a browser run needs one (a Setting)",
    "{cli} gate status [--json]      who holds a slot, who waits",
    "{cli} gate box <list|add|remove> <name> [--ssh login@host] [--ssh-port N]",
    "    [--ssh-identity <key file>] [--playwright ws://…] [--slots N]",
    "    [--hold-file <path>] [--time-scale X] [--min-free-mem-mb N]",
    "    [--playwright-version X.Y.Z]   test boxes (a person's)",
    "    a box run: --base-url http://<name>.localhost:<port> (never 80/443)",
    "{cli} gate end <id>             end a slot early (a person's only)",
    "{cli} gate yield <my-id> --to <id>",
    "    your waiting run lets another waiting run go just ahead of it",
    "{cli} gate settings [--cpu-slots N] [--cpu-slots-beside-browser N] [--local-browser-slots N]",
    "    [--overrun-margin-minutes N]",
    "    [--remote-renew-seconds N] [--remote-lapse-seconds N]",
    "    [--remote-max-slots N] [--remote-max-asks N]",
    "    [--priority-max N] [--priority-pass-limit-minutes N] [--priority-agents 0|1]",
    "    [--priority-runners 0|1]",
    "    [--claim-minutes N] [--mcp-renew-minutes N] [--mcp-lapse-minutes N] [--mcp-grace-minutes N]",
    "    [--box-check-timeout-seconds N] [--box-recheck-seconds N]",
    '    [--class-order "release, lane, other"] [--class-map "<project>=<class>, label:<pattern>=<class>, *=<class>"]',
    '    [--class-windows "<class>=22:00-06:00/30"]   priority classes per project ("" clears)',
    "    [--browser-requires-container 0|1]   a browser run declares a container browser",
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
}

export interface GateDeps {
  store: GateStore;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Starts the command (issue 625: `env` adds to the environment). */
  exec: (cmd: string, args: string[], env?: Record<string, string>) => GateRun;
  /** Runs `fn` every `ms` until the returned stop is called. */
  every: (ms: number, fn: () => void) => () => void;
  /** Calls `h` on SIGINT, SIGTERM or SIGHUP; returns a stop. */
  onSignal: (h: (signal: NodeJS.Signals) => void) => () => void;
  /** Leaves at once with `code` (a signal while waiting). */
  exit: (code: number) => void;
  pid: number;
  cwd: string;
  /** The language refusals are in (default: the person's, from user.yml). */
  lang?: UiLanguage;
  /** Issue 928: whether process `pid` runs under `root` (default: ps). */
  descends?: (pid: number, root: number) => boolean;
}

/** Issue 928: how often a nested run checks its slot still holds. */
const NESTED_LOOK_MS = 5_000;

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

const signalCode = (s: NodeJS.Signals | null) =>
  s === "SIGINT" ? 130 : s === "SIGHUP" ? 129 : 143;

const realExec = (
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): GateRun => {
  const k = spawn(cmd, args, {
    stdio: "inherit",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return {
    pid: k.pid,
    kill: (s) => {
      if (k.exitCode === null && k.signalCode === null) k.kill(s);
    },
    done: new Promise<number>((resolve) => {
      k.on("error", () => resolve(127));
      k.on("exit", (code, signal) => resolve(code ?? signalCode(signal)));
    }),
  };
};

const realOnSignal = (h: (s: NodeJS.Signals) => void) => {
  const sigs: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of sigs) process.on(s, h);
  return () => {
    for (const s of sigs) process.off(s, h);
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
    every: (ms, fn) => {
      const h = setInterval(fn, ms);
      h.unref();
      return () => clearInterval(h);
    },
    onSignal: realOnSignal,
    exit: (code) => process.exit(code),
    pid: process.pid,
    cwd: process.cwd(),
  };
}

class GateUsage extends Error {}

/** Clause 11: the Playwright client version installed where the run is. */
export function playwrightVersion(cwd: string): string | undefined {
  for (const p of ["playwright-core", "@playwright/test", "playwright"])
    try {
      const v = (
        JSON.parse(
          fs.readFileSync(
            path.join(cwd, "node_modules", p, "package.json"),
            "utf-8",
          ),
        ) as { version?: unknown }
      ).version;
      if (typeof v === "string") return v;
    } catch {
      /* not this one */
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

/** One line for a holder or waiter. */
export function slotLine(
  e: GateEntry,
  all: GateEntry[],
  now: number,
  margin: { overrunMarginMinutes: number } & Partial<GateSettings>,
): string {
  const yields = yieldedTo(e, all);
  // Issue 803: its class, and a wait for its class's window.
  const cls = classOf(e, margin.classes);
  const win = windowHeld(all, margin.classes, now).get(e.id);
  const pri =
    priorityWords(e, all, margin) +
    (cls ? `  class ${cls}` : "") +
    (win ? `  waits for its ${win.text} window` : "") +
    (yields.length ? `  let ${yields.join(", ")} go ahead` : "") +
    (e.browserEndpoint ? `  browser ${e.browserEndpoint}` : "");
  if (e.grantedAt) {
    const late = overrun(e, margin, now) ? " (past its estimate)" : "";
    const on = e.box ? ` on box ${e.box}` : "";
    return `${e.id}  holds ${e.kind}${on}  ${e.who}  "${e.label}"  until about ${hm(expectedEnd(e))}${late}${pri}`;
  }
  // Issue 625: a waiter that may go to a test box says so.
  const where =
    e.where === "any"
      ? " (this machine or a test box)"
      : e.where
        ? ` (box ${e.where})`
        : "";
  return `${e.id}  waits for ${e.kind}${where}  ${e.who}  "${e.label}"  starts about ${hm(expectedStart(all, e.id, now, margin))}${pri}`;
}

/** Issue 625: one line per test box: its slots, or why it is skipped. */
export function boxStatusLines(store: GateStore, all: GateEntry[]): string[] {
  return gateBoxesView(
    store,
    all.map((e) => ({ granted: !!e.grantedAt, box: e.box })),
  ).map((b) => {
    const base = `box ${b.name}: ${b.held} of ${b.slots} browser slots held`;
    if (b.state === "held" || b.state === "unreachable" || b.state === "low")
      return `box ${b.name}: skipped, ${b.state}${b.reason ? `: ${b.reason}` : ""}`;
    return b.state === "unchecked" ? `${base}, not checked yet` : base;
  });
}

function flags(args: string[], known: Record<string, boolean>) {
  const f: Record<string, string | true> = {};
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
      if (eq > 2 && known[a.slice(0, eq)] === true) {
        f[a.slice(0, eq)] = a.slice(eq + 1);
        continue;
      }
      if (!(a in known)) throw new GateUsage(`unknown option ${a}`);
      if (known[a]) {
        const v = args[++i];
        if (v === undefined) throw new GateUsage(`${a} needs a value`);
        f[a] = v;
      } else f[a] = true;
    } else pos.push(a);
  }
  return { f, pos, rest: false };
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
  });
  if (!rest || pos.length === 0)
    throw new GateUsage("gate run needs -- <command> [args]");
  const kind = (f["--kind"] ?? "cpu") as string;
  if (kind !== "browser" && kind !== "cpu")
    throw new GateUsage("--kind is browser or cpu");
  // Issue 625: a browser run that can use a test box's browser says so.
  const where = typeof f["--box"] === "string" ? f["--box"] : undefined;
  if (where !== undefined) {
    if (kind !== "browser")
      throw new GateUsage("--box goes with --kind browser");
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
  // Issue 928: inside a held slot of this kind and place: run in it, at
  // once. The outer run checked the browser and keeps the slot.
  const inside = heldSlotFor(d, kind as GateKind, where);
  if (inside) {
    const label =
      typeof f["--label"] === "string" ? f["--label"] : path.basename(pos[0]!);
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
    let gone = false;
    const look = d.every(NESTED_LOOK_MS, () => {
      if (gone || d.store.get(inside.id)?.grantedAt) return;
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
  const verdict = browserSlotCheck({
    kind: kind as GateKind,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(where ? { where } : {}),
    platform: d.store.platform,
    requiresContainer: d.store.settings().browserRequiresContainer,
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
  if (where && where !== "local") {
    const raw = typeof f["--base-url"] === "string" ? f["--base-url"] : "";
    const urls = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!urls.length)
      throw new GateUsage(
        "a box run needs --base-url http://<name>.localhost:<port>[,…]: the app's loopback addresses, never port 80 or 443",
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
    typeof f["--pw-version"] === "string"
      ? f["--pw-version"]
      : where && where !== "local"
        ? playwrightVersion(d.cwd)
        : undefined;
  const estimateMin = parseEstimate(
    typeof f["--estimate"] === "string" ? f["--estimate"] : "10m",
  );
  const label =
    typeof f["--label"] === "string" ? f["--label"] : path.basename(pos[0]!);
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
      ...(actor ? { actor } : {}),
      ...(priority ? { priority: { reason } } : {}),
      ...(where ? { where } : {}),
      ...(pwVersion ? { pwVersion } : {}),
      ...(verdict.declared ? { browserEndpoint: verdict.declared } : {}),
    });
  } catch (err) {
    if (err instanceof GatePriorityRefused) throw new GateUsage(err.message);
    throw err;
  }
  const id = e.id;
  let child: GateRun | undefined;
  let released = false;
  let cancelled: number | undefined;
  const release = () => {
    if (!released) s.release(id);
    released = true;
  };
  // While waiting, a signal gives the place back and leaves. While the
  // command runs, it goes to the command, whose end gives the slot back:
  // a slot is never free while the run it was for goes on.
  const off = d.onSignal((sig) => {
    if (child) return child.kill(sig);
    release();
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
    d.err(
      `gate: ${id} holds ${kind}${e.box ? ` on box ${e.box}` : ""}; running ${label}`,
    );
    // Issue 928: the command knows the slot it runs in.
    const slotEnv = {
      [GATE_SLOT_ENV]: id,
      [GATE_SLOT_KIND_ENV]: kind,
      [GATE_SLOT_BOX_ENV]: e.box ?? "local",
    };
    child = box
      ? d.exec(pos[0]!, pos.slice(1), {
          ...boxEnv(box),
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
    if (child.pid !== undefined) s.setRunPid(id, child.pid);
    // Past its estimate plus the margin, it says so once; never stopped.
    let flagged = false;
    const stop = d.every(60_000, () => {
      const now = s.get(id);
      if (!now || flagged || !now.flaggedAt) return;
      flagged = true;
      d.err(
        `gate: ${label} is past its estimate (${now.estimateMin} min); it is not stopped, and the slot stays its own until it ends`,
      );
    });
    try {
      return await child.done;
    } finally {
      stop();
    }
  } finally {
    off();
    release();
  }
}

function status(args: string[], d: GateDeps): number {
  const { f } = flags(args, { "--json": false });
  if (f["--json"]) {
    d.out(JSON.stringify(gateView(d.store, d.now()), null, 2));
    return 0;
  }
  const all = d.store.list();
  const set = d.store.settings();
  if (all.length === 0) d.out("No gate runs hold or wait.");
  for (const e of all) d.out(slotLine(e, all, d.now(), set));
  for (const l of boxStatusLines(d.store, all)) d.out(l);
  return 0;
}

/**
 * Issue 625: the test boxes. `box list`; `box add <name> --ssh <dest>
 * [--ssh-port N] [--ssh-identity <key file>] [--playwright ws://…]
 * [--slots N] [--hold-file <path>] [--time-scale X]` (adds or replaces);
 * `box remove <name>`. Adding and removing are a person's.
 */
function boxCmd(args: string[], d: GateDeps): number {
  const [verb, ...rest] = args;
  if (verb === "list" || verb === undefined) {
    const boxes = d.store.boxes();
    if (!boxes.length) d.out("No test boxes set (gate box add).");
    for (const b of boxes)
      d.out(
        `${b.name}  ${b.browser_slots} browser slot${b.browser_slots === 1 ? "" : "s"}` +
          (b.ssh ? `  ssh ${b.ssh}${b.ssh_port ? `:${b.ssh_port}` : ""}` : "") +
          (b.playwright ? `  playwright ${b.playwright}` : "") +
          (b.hold_file ? `  hold file ${b.hold_file}` : "") +
          (b.time_scale && b.time_scale !== 1
            ? `  time scale ${b.time_scale}`
            : ""),
      );
    return 0;
  }
  if (verb !== "add" && verb !== "remove")
    throw new GateUsage("gate box <list|add|remove> ...");
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
    "--hold-file": true,
    "--time-scale": true,
    "--min-free-mem-mb": true,
    "--playwright-version": true,
  });
  const [name, extra] = pos;
  if (!name || extra) throw new GateUsage(`gate box ${verb} needs one <name>`);
  if (verb === "remove") {
    if (!d.store.removeBox(name)) {
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
    hold_file: f["--hold-file"],
    time_scale: num("--time-scale"),
    min_free_mem_mb: num("--min-free-mem-mb"),
    playwright_version: f["--playwright-version"],
  });
  if (!c.ok) throw new GateUsage(c.error);
  d.store.setBox(c.box);
  d.out(
    `Box ${name} set: ${c.box.browser_slots} browser slot${c.box.browser_slots === 1 ? "" : "s"}. A run takes it with gate run --kind browser --box any.`,
  );
  return 0;
}

function end(args: string[], d: GateDeps): number {
  if (isAgentEnv(d.env))
    throw new GateUsage(
      "gate end: only a person can end a slot early (this is an agent)",
    );
  const [id, extra] = flags(args, {}).pos;
  if (!id || extra) throw new GateUsage("gate end needs one <id>");
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

function settings(args: string[], d: GateDeps): number {
  const { f } = flags(args, {
    "--cpu-slots": true,
    "--overrun-margin-minutes": true,
    "--remote-renew-seconds": true,
    "--remote-lapse-seconds": true,
    "--remote-max-slots": true,
    "--remote-max-asks": true,
    "--cpu-slots-beside-browser": true,
    "--local-browser-slots": true,
    "--priority-max": true,
    "--priority-pass-limit-minutes": true,
    "--priority-agents": true,
    "--priority-runners": true,
    "--claim-minutes": true,
    "--mcp-renew-minutes": true,
    "--mcp-lapse-minutes": true,
    "--mcp-grace-minutes": true,
    "--box-check-timeout-seconds": true,
    "--box-recheck-seconds": true,
    "--class-order": true,
    "--class-map": true,
    "--class-windows": true,
    "--browser-requires-container": true,
  });
  const raw: Record<string, number | string | null> = {};
  for (const [flag, key] of [
    ["--cpu-slots", "cpu_slots"],
    ["--cpu-slots-beside-browser", "cpu_slots_beside_browser"],
    ["--local-browser-slots", "local_browser_slots"],
    ["--overrun-margin-minutes", "overrun_margin_minutes"],
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
  ] as const) {
    const v = f[flag];
    if (typeof v === "string") raw[key] = v.trim() || null;
  }
  if (Object.keys(raw).length) {
    if (isAgentEnv(d.env))
      throw new GateUsage(
        "gate settings: only a person can change them (this is an agent)",
      );
    const c = checkGatePatch(raw);
    if (!c.ok) throw new GateUsage(c.error);
    d.store.writeSettings(c.patch as GateSettingsPatch);
  }
  const s = d.store.settings();
  d.out(
    `cpu slots ${s.cpuSlots}, ${s.cpuSlotsBesideBrowser ? `${s.cpuSlotsBesideBrowser} beside a browser run` : "none beside a browser run"} · browser runs at once here ${s.localBrowserSlots} · flagged ${s.overrunMarginMinutes} min past its estimate · CI runners renew every ${s.remoteRenewSeconds} s, taken back after ${s.remoteLapseSeconds} s, at most ${s.remoteMaxSlots} slots and ${s.remoteMaxAsks} asks each · release priority: ${s.priorityMax} per kind at a time, ${s.priorityPassLimitMinutes ? `never past a marked run waiting ${s.priorityPassLimitMinutes} min` : "never past another marked run"}, ${s.priorityAgents ? "agents and people" : "people only"} may ask · test boxes checked within ${s.boxCheckTimeoutSeconds} s, a held or unreachable one checked again after ${s.boxRecheckSeconds} s · browser runs need a container: ${s.browserRequiresContainer ? "yes" : "no"}${
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
        return end(args.slice(1), d);
      case "box":
        return boxCmd(args.slice(1), d);
      case "yield":
        return yieldPlace(args.slice(1), d);
      case "settings":
        return settings(args.slice(1), d);
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
