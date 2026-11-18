/**
 * `<cli> gate` (issue 144 GATE-SLOT): one machine, many heavy test runs,
 * taken in turn. The slots are the machine's (gates/store.ts), shared by
 * every install and repo here, and need no running Den.
 *
 *   run [--kind browser|cpu] [--estimate 6m] [--label <l>] -- <cmd> [args]
 *       waits for a slot (saying who holds it and until when, each
 *       minute), runs the command, gives the slot back when it ends however
 *       it ends; exits with the command's code
 *   status [--json]          who holds, who waits, overruns
 *   end <id>                 a person ends a slot early (refused for an
 *                            agent); recorded with who
 *   settings [--cpu-slots N] [--overrun-margin-minutes N]
 *                            the machine's; a person changes them
 */
import { spawn } from "child_process";
import * as path from "path";
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import {
  expectedEnd,
  expectedStart,
  overrun,
  type GateEntry,
  type GateKind,
} from "../../shared/gates/rules.js";
import {
  GateStore,
  checkGatePatch,
  type GateSettingsPatch,
} from "../../shared/gates/store.js";
import { gateView } from "../../shared/gates/view.js";
import { product } from "../../shared/product.js";
import { AGENT_ACTOR_ENV } from "../../shared/sessions/env.js";

export const GATE_HELP = {
  usage: "gate <run|status|end|settings> ...",
  lines: [
    "Heavy test runs on this machine, taken in turn: a browser suite runs",
    "alone but for one unit suite beside it that ends in time; unit suites",
    "share (2 at a time by default). Every repo and install",
    "on the machine shares the same queue. A run is never stopped by another.",
    "",
    "{cli} gate run [--kind browser|cpu] [--estimate 6m] [--label <l>] -- <cmd>",
    "    waits for a slot, runs <cmd>, gives the slot back when it ends",
    "{cli} gate status [--json]      who holds a slot, who waits",
    "{cli} gate end <id>             end a slot early (a person's only)",
    "{cli} gate settings [--cpu-slots N] [--overrun-margin-minutes N]",
    "                    [--cpu-beside-browser N] [--max-load-per-core N]",
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
  /** Starts the command. */
  exec: (cmd: string, args: string[]) => GateRun;
  /** Runs `fn` every `ms` until the returned stop is called. */
  every: (ms: number, fn: () => void) => () => void;
  /** Calls `h` on SIGINT, SIGTERM or SIGHUP; returns a stop. */
  onSignal: (h: (signal: NodeJS.Signals) => void) => () => void;
  /** Leaves at once with `code` (a signal while waiting). */
  exit: (code: number) => void;
  pid: number;
  cwd: string;
}

const signalCode = (s: NodeJS.Signals | null) =>
  s === "SIGINT" ? 130 : s === "SIGHUP" ? 129 : 143;

const realExec = (cmd: string, args: string[]): GateRun => {
  const k = spawn(cmd, args, { stdio: "inherit" });
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

/** One line for a holder or waiter. */
export function slotLine(
  e: GateEntry,
  all: GateEntry[],
  now: number,
  margin: { overrunMarginMinutes: number },
): string {
  if (e.grantedAt) {
    const late = overrun(e, margin, now) ? " (past its estimate)" : "";
    const beside = e.beside ? " beside a browser run" : "";
    return `${e.id}  holds ${e.kind}${beside}  ${e.who}  "${e.label}"  until about ${hm(expectedEnd(e))}${late}`;
  }
  return `${e.id}  waits for ${e.kind}  ${e.who}  "${e.label}"  starts about ${hm(expectedStart(all, e.id, now))}`;
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
  });
  if (!rest || pos.length === 0)
    throw new GateUsage("gate run needs -- <command> [args]");
  const kind = (f["--kind"] ?? "cpu") as string;
  if (kind !== "browser" && kind !== "cpu")
    throw new GateUsage("--kind is browser or cpu");
  const estimateMin = parseEstimate(
    typeof f["--estimate"] === "string" ? f["--estimate"] : "10m",
  );
  const label =
    typeof f["--label"] === "string" ? f["--label"] : path.basename(pos[0]!);
  const s = d.store;
  const actor = d.env[AGENT_ACTOR_ENV]?.trim();
  let e: GateEntry | null = s.ask({
    kind: kind as GateKind,
    who: whoAsks(d.env, d.cwd),
    label,
    pid: d.pid,
    estimateMin,
    agent: isAgentEnv(d.env),
    ...(actor ? { actor } : {}),
  });
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
      e = s.get(id);
      if (!e) throw new Error(`the slot ${id} was ended while waiting`);
    }
    d.err(`gate: ${id} holds ${kind}; running ${label}`);
    child = d.exec(pos[0]!, pos.slice(1));
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
  if (all.length === 0) {
    d.out("No gate runs hold or wait.");
    return 0;
  }
  for (const e of all) d.out(slotLine(e, all, d.now(), set));
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

function settings(args: string[], d: GateDeps): number {
  const { f } = flags(args, {
    "--cpu-slots": true,
    "--overrun-margin-minutes": true,
    "--cpu-beside-browser": true,
    "--max-load-per-core": true,
  });
  const raw: Record<string, number> = {};
  for (const [flag, key] of [
    ["--cpu-slots", "cpu_slots"],
    ["--overrun-margin-minutes", "overrun_margin_minutes"],
    ["--cpu-beside-browser", "cpu_beside_browser"],
    ["--max-load-per-core", "max_load_per_core"],
  ] as const) {
    const v = f[flag];
    if (typeof v === "string") raw[key] = Number(v);
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
    `cpu slots ${s.cpuSlots} · flagged ${s.overrunMarginMinutes} min past its estimate · ${s.cpuBesideBrowser} cpu beside a browser run, under load ${s.maxLoadPerCore} per core`,
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
