/**
 * `<cli> gate` (0.4.49 GATE-SLOT, den#144): one machine, many heavy test
 * runs, taken in turn. The slots are the machine's (gates/store.ts), shared
 * by every install and repo here, and need no running Den.
 *
 *   run [--kind browser|cpu] [--estimate 6m] [--label <l>] -- <cmd> [args]
 *       waits for a slot (saying who holds it and until when, each
 *       minute), runs the command, gives the slot back when it ends however
 *       it ends; exits with the command's code
 *   status [--json]          who holds, who waits, overruns
 *   end <id>                 a person ends a slot early (refused for an
 *                            agent); recorded with who
 *   settings [--cpu-slots N] [--lease-minutes N] [--overrun-margin-minutes N]
 *                            the machine's; a person's only
 */
import { spawn, type ChildProcess } from "child_process";
import * as path from "path";
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import {
  expectedEnd,
  expectedStart,
  overrun,
  type GateEntry,
  type GateKind,
} from "../../shared/gates/rules.js";
import { GateStore } from "../../shared/gates/store.js";
import { product } from "../../shared/product.js";

export const GATE_HELP = {
  usage: "gate <run|status|end|settings> ...",
  lines: [
    "Heavy test runs on this machine, taken in turn: a browser suite runs",
    "alone; unit suites share (2 at a time by default). Every repo and install",
    "on the machine shares the same queue.",
    "",
    "{cli} gate run [--kind browser|cpu] [--estimate 6m] [--label <l>] -- <cmd>",
    "    waits for a slot, runs <cmd>, gives the slot back when it ends",
    "{cli} gate status [--json]      who holds a slot, who waits",
    "{cli} gate end <id>             end a slot early (a person's only)",
    "{cli} gate settings [--cpu-slots N] [--lease-minutes N]",
    "                    [--overrun-margin-minutes N]",
  ],
};

export interface GateDeps {
  store: GateStore;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Runs the command; resolves with its exit code. */
  exec: (cmd: string, args: string[]) => Promise<number>;
  /** Called with a function that gives the slot back on SIGINT/SIGTERM. */
  onSignal: (release: (signal: NodeJS.Signals) => void) => () => void;
  pid: number;
  cwd: string;
}

/** The command `gate run` started, so a signal reaches it too. */
let running: ChildProcess | undefined;

const realExec = (cmd: string, args: string[]) =>
  new Promise<number>((resolve) => {
    const k = spawn(cmd, args, { stdio: "inherit" });
    running = k;
    k.on("error", () => resolve(127));
    k.on("exit", (code, signal) =>
      resolve(code ?? (signal === "SIGINT" ? 130 : 143)),
    );
  });

const realOnSignal = (release: (s: NodeJS.Signals) => void) => {
  // The command gets the signal too: a slot is never free while the run
  // it was for still goes on.
  const h = (s: NodeJS.Signals) => {
    if (running && running.exitCode === null) running.kill(s);
    release(s);
    process.exit(s === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", h);
  process.on("SIGTERM", h);
  return () => {
    process.off("SIGINT", h);
    process.off("SIGTERM", h);
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
    onSignal: realOnSignal,
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

/** Who asks, in words: the install, the repo folder, an agent or a person. */
export function whoAsks(env: NodeJS.ProcessEnv, cwd: string): string {
  const agent = env.DEN_AGENT?.trim();
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
    const late = overrun(e, { cpuSlots: 0, leaseMinutes: 0, ...margin }, now)
      ? " (past its estimate)"
      : "";
    return `${e.id}  holds ${e.kind}  ${e.who}  "${e.label}"  until about ${hm(expectedEnd(e))}${late}`;
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
  let e = s.ask({
    kind: kind as GateKind,
    who: whoAsks(d.env, d.cwd),
    label,
    pid: d.pid,
    estimateMin,
    agent: isAgentTokenEnv(d.env),
  });
  let done = false;
  const off = d.onSignal(() => {
    if (!done) s.release(e.id);
    done = true;
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
      const now = s.renew(e.id);
      if (!now) throw new Error(`the slot ${e.id} was ended while waiting`);
      e = now;
    }
    d.err(`gate: ${e.id} holds ${kind}; running ${label}`);
    // Alive each minute while the command runs; the lease takes back a
    // holder that goes quiet.
    const heart = setInterval(() => s.renew(e.id), 60_000);
    heart.unref();
    const code = await d
      .exec(pos[0]!, pos.slice(1))
      .finally(() => clearInterval(heart));
    return code;
  } finally {
    off();
    if (!done) s.release(e.id);
    done = true;
  }
}

function status(args: string[], d: GateDeps): number {
  const { f } = flags(args, { "--json": false });
  const all = d.store.list();
  const set = d.store.settings();
  if (f["--json"]) {
    d.out(
      JSON.stringify(
        {
          settings: set,
          slots: all.map((e) => ({
            ...e,
            expectedEnd: new Date(expectedEnd(e)).toISOString(),
            overrun: overrun(e, set, d.now()),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (all.length === 0) {
    d.out("No gate runs hold or wait.");
    return 0;
  }
  const order = [...all].sort(
    (a, b) => Number(!a.grantedAt) - Number(!b.grantedAt),
  );
  for (const e of order) d.out(slotLine(e, all, d.now(), set));
  return 0;
}

function end(args: string[], d: GateDeps): number {
  if (isAgentTokenEnv(d.env))
    throw new GateUsage(
      "gate end: only a person can end a slot early (this is an agent)",
    );
  const [id, extra] = flags(args, {}).pos;
  if (!id || extra) throw new GateUsage("gate end needs one <id>");
  if (!d.store.endEarly(id, whoAsks(d.env, d.cwd))) {
    d.err(`gate end: no slot ${id}`);
    return 1;
  }
  d.out(`Ended ${id}. Whoever ran it was not stopped; its slot is free.`);
  return 0;
}

function settings(args: string[], d: GateDeps): number {
  const { f } = flags(args, {
    "--cpu-slots": true,
    "--lease-minutes": true,
    "--overrun-margin-minutes": true,
  });
  const keys: [
    string,
    "cpu_slots" | "lease_minutes" | "overrun_margin_minutes",
    number,
  ][] = [
    ["--cpu-slots", "cpu_slots", 1],
    ["--lease-minutes", "lease_minutes", 1],
    ["--overrun-margin-minutes", "overrun_margin_minutes", 0],
  ];
  const patch: Record<string, number> = {};
  for (const [flag, key, min] of keys) {
    const v = f[flag];
    if (typeof v !== "string") continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min)
      throw new GateUsage(`${flag} must be a number of at least ${min}`);
    patch[key] = key === "cpu_slots" ? Math.floor(n) : n;
  }
  if (Object.keys(patch).length) {
    if (isAgentTokenEnv(d.env))
      throw new GateUsage(
        "gate settings: only a person can change them (this is an agent)",
      );
    d.store.writeSettings(patch);
  }
  const s = d.store.settings();
  d.out(
    `cpu slots ${s.cpuSlots} · lease ${s.leaseMinutes} min · flagged ${s.overrunMarginMinutes} min past its estimate`,
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
