/**
 * `<cli> gate` (issue 144 GATE-SLOT): one machine, many heavy test runs,
 * taken in turn. The slots are the machine's (gates/store.ts), shared by
 * every install and repo here, and need no running Den.
 *
 *   run [--kind browser|cpu|release] [--estimate 6m] [--label <l>]
 *       [--tag <tag> [--repo <dir>]] -- <cmd> [args]
 *       waits for a slot (saying who holds it and until when, each
 *       minute), runs the command in its own process group, gives the slot
 *       back when it ends however it ends; exits with the command's code.
 *       Issue 498: --kind release is a release candidate's run, proven by
 *       --tag (gates/release-proof.ts); it has its own reserved slot
 *   status [--json]          who holds, who waits, overruns, the release slot
 *   end <id>                 a person ends a slot early (refused for an
 *                            agent); recorded with who; the run goes on
 *   cancel <id>              issue 585: the slot's owner or a person
 *                            withdraws it: a queued ask is removed, a
 *                            running one is stopped (TERM, a grace, KILL)
 *                            and freed when its process group is gone
 *   settings [--cpu-slots N] [--overrun-margin-minutes N] [--release-slots N]
 *            [--release-quiet-wait-minutes N] [--release-tag-max-age-hours N]
 *            [--cancel-grace-seconds N]
 *                            the machine's; a person changes them
 */
import { spawn } from "child_process";
import * as path from "path";
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import { cancelSlot, stopRun } from "../../shared/gates/cancel.js";
import { proveReleaseTag } from "../../shared/gates/release-proof.js";
import {
  expectedEnd,
  expectedStart,
  overrun,
  type Canceller,
  type GateEntry,
  type GateKind,
} from "../../shared/gates/rules.js";
import {
  GateStore,
  checkGatePatch,
  type GateEventRow,
  type GateSettingsPatch,
} from "../../shared/gates/store.js";
import { gateView } from "../../shared/gates/view.js";
import { product } from "../../shared/product.js";
import { AGENT_ACTOR_ENV } from "../../shared/sessions/env.js";

export const GATE_HELP = {
  usage: "gate <run|status|end|cancel|settings> ...",
  lines: [
    "Heavy test runs on this machine, taken in turn: a browser suite runs",
    "alone; unit suites share (2 at a time by default). Every repo and install",
    "on the machine shares the same queue. A run is never stopped by another.",
    "A release candidate's run (--kind release --tag <its tag>) has its own",
    "reserved slot and goes ahead of ordinary runs.",
    "",
    "{cli} gate run [--kind browser|cpu|release] [--estimate 6m] [--label <l>] [--tag <tag>] -- <cmd>",
    "    waits for a slot, runs <cmd>, gives the slot back when it ends",
    "{cli} gate status [--json]      who holds a slot, who waits",
    "{cli} gate end <id>             end a slot early (a person's only); the run goes on",
    "{cli} gate cancel <id>          withdraw a slot and stop its run (its owner or a person)",
    "{cli} gate settings [--cpu-slots N] [--overrun-margin-minutes N] [--release-slots N]",
    "    [--release-quiet-wait-minutes N] [--release-tag-max-age-hours N] [--cancel-grace-seconds N]",
  ],
};

/** The command gate run started. */
export interface GateRun {
  pid: number | undefined;
  /** Signals the command (its whole process group, when `group`). */
  kill: (s: NodeJS.Signals) => void;
  /** Resolves with its exit code when it ends. */
  done: Promise<number>;
  /** Issue 585: the command leads its own process group. */
  group?: boolean;
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
  /** Issue 585: signals a pid (negative: a process group). */
  kill?: (pid: number, s: NodeJS.Signals) => void;
}

const signalCode = (s: NodeJS.Signals | null) =>
  s === "SIGINT" ? 130 : s === "SIGHUP" ? 129 : 143;

/**
 * Issue 585: the command leads its own process group, so a cancel stops
 * it and everything it started, and nothing else. (Windows has no process
 * groups to signal: there the command alone is stopped.)
 */
const realExec = (cmd: string, args: string[]): GateRun => {
  const groups = process.platform !== "win32";
  const k = spawn(cmd, args, { stdio: "inherit", detached: groups });
  return {
    pid: k.pid,
    group: groups && k.pid !== undefined,
    kill: (s) => {
      if (k.pid === undefined) return;
      try {
        if (!groups) throw new Error("no process groups");
        process.kill(-k.pid, s);
      } catch {
        if (k.exitCode === null && k.signalCode === null) k.kill(s);
      }
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
    kill: (p, s) => process.kill(p, s),
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

const kindWords = (e: GateEntry) =>
  e.kind === "release" && e.tag ? `release (${e.tag})` : e.kind;

/** One line for a holder or waiter. */
export function slotLine(
  e: GateEntry,
  all: GateEntry[],
  now: number,
  margin: { overrunMarginMinutes: number },
): string {
  if (e.grantedAt) {
    const late = overrun(e, margin, now) ? " (past its estimate)" : "";
    const stopping = e.cancelled ? ` (cancelled by ${e.cancelled.by})` : "";
    return `${e.id}  holds ${kindWords(e)}  ${e.who}  "${e.label}"  until about ${hm(expectedEnd(e))}${late}${stopping}`;
  }
  return `${e.id}  waits for ${kindWords(e)}  ${e.who}  "${e.label}"  starts about ${hm(expectedStart(all, e.id, now))}`;
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

/** Issue 498: a release run's load line, from its slot-log row. */
function loadLine(row: GateEventRow | undefined): string {
  const load = row?.load?.length
    ? row.load.map((n) => n.toFixed(2)).join(" ")
    : "unknown";
  const beside = row?.alongside?.length
    ? row.alongside.map((a) => `${a.id} ${a.kind} "${a.label}"`).join(", ")
    : "none";
  return `load ${load}; runs alongside: ${beside}${row?.ranAnyway ? " (started after the quiet wait)" : ""}`;
}

const lastRow = (s: GateStore, id: string, event: GateEventRow["event"]) =>
  s
    .events()
    .filter((r) => r.id === id && r.event === event)
    .at(-1);

async function run(args: string[], d: GateDeps): Promise<number> {
  const { f, pos, rest } = flags(args, {
    "--kind": true,
    "--estimate": true,
    "--label": true,
    "--tag": true,
    "--repo": true,
  });
  if (!rest || pos.length === 0)
    throw new GateUsage("gate run needs -- <command> [args]");
  const kind = (f["--kind"] ?? "cpu") as string;
  if (kind !== "browser" && kind !== "cpu" && kind !== "release")
    throw new GateUsage("--kind is browser, cpu or release");
  const estimateMin = parseEstimate(
    typeof f["--estimate"] === "string" ? f["--estimate"] : "10m",
  );
  const label =
    typeof f["--label"] === "string" ? f["--label"] : path.basename(pos[0]!);
  const s = d.store;
  // Issue 498: only a proven release candidate takes the release slot.
  let proof: { tag: string; commit: string } | undefined;
  if (kind === "release") {
    if (typeof f["--tag"] !== "string")
      throw new GateUsage(
        "--kind release needs --tag <the release candidate's tag>",
      );
    const repo = path.resolve(
      d.cwd,
      typeof f["--repo"] === "string" ? f["--repo"] : ".",
    );
    const p = proveReleaseTag(
      f["--tag"],
      repo,
      s.settings().releaseTagMaxAgeHours,
      d.now(),
    );
    if (!p.ok) throw new GateUsage(`not a release candidate: ${p.error}`);
    proof = { tag: p.tag, commit: p.commit };
  } else if (f["--tag"] !== undefined || f["--repo"] !== undefined)
    throw new GateUsage("--tag and --repo are for --kind release only");
  const actor = d.env[AGENT_ACTOR_ENV]?.trim();
  let e: GateEntry | null = s.ask({
    kind: kind as GateKind,
    who: whoAsks(d.env, d.cwd),
    label,
    pid: d.pid,
    estimateMin,
    agent: isAgentEnv(d.env),
    ...(actor ? { actor } : {}),
    ...(proof ?? {}),
  });
  const id = e.id;
  if (!e.grantedAt)
    d.err(`gate: ${id} waits for ${kind} (gate cancel ${id} withdraws it)`);
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
      if (!e) {
        // Issue 585: withdrawn while it waited: the command never starts.
        const by = s.cancelledBy(id);
        released = true;
        if (by) {
          d.err(`gate: ${id} cancelled by ${by}; ${label} never started`);
          return 1;
        }
        throw new Error(`the slot ${id} was ended while waiting`);
      }
    }
    d.err(`gate: ${id} holds ${kindWords(e)}; running ${label}`);
    if (kind === "release")
      d.err(`gate: release run starts: ${loadLine(lastRow(s, id, "granted"))}`);
    child = d.exec(pos[0]!, pos.slice(1));
    const group = child.group === true;
    if (child.pid !== undefined && !s.setRunPid(id, child.pid, group)) {
      // Cancelled between its grant and its start: stop what just started.
      const grace = s.settings().cancelGraceSeconds * 1000;
      const kill = d.kill;
      if (kill)
        void stopRun(child.pid, group, grace, {
          alive: (p) => s.isAlive(p),
          kill,
          sleep: d.sleep,
          now: d.now,
        });
      else child.kill("SIGTERM");
    }
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
    let code: number;
    try {
      code = await child.done;
    } finally {
      stop();
    }
    // Issue 585: cancelled while it ran. The slot frees only when the
    // command's whole group is gone (the canceller stops it, and either
    // of us frees the slot after).
    const cur = s.peek(id);
    const by = cur ? (cur.cancelled?.by ?? null) : s.cancelledBy(id);
    if (by) {
      released = true;
      if (cur && child.pid !== undefined) {
        const target = group ? -child.pid : child.pid;
        const until =
          d.now() + (s.settings().cancelGraceSeconds * 2 + 5) * 1000;
        while (s.isAlive(target) && d.now() < until) await d.sleep(250);
        if (!s.isAlive(target)) s.releaseCancelled(id);
      }
      d.err(`gate: ${label} cancelled by ${by}`);
      return code === 0 ? 1 : code;
    }
    if (kind === "release") {
      release();
      d.err(`gate: release run ended: ${loadLine(lastRow(s, id, "released"))}`);
    }
    return code;
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
  // Issue 498: the release slot, and who holds it.
  if (all.some((e) => e.kind === "release")) {
    const held = all.filter((e) => e.kind === "release" && e.grantedAt);
    d.out(
      held.length
        ? `Release slot: held by ${held.map((e) => `${e.who} (${e.tag ?? "?"})`).join(", ")}; ${set.releaseSlots} reserved`
        : `Release slot: free (${set.releaseSlots} reserved); a release run waits for the machine to go quiet`,
    );
  }
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

/** Issue 585: the slot's owner (this agent) or a person withdraws it. */
async function cancel(args: string[], d: GateDeps): Promise<number> {
  const [id, extra] = flags(args, {}).pos;
  if (!id || extra) throw new GateUsage("gate cancel needs one <id>");
  const canceller: Canceller = isAgentEnv(d.env)
    ? { agent: d.env[AGENT_ACTOR_ENV]?.trim() ?? "" }
    : { person: true };
  const s = d.store;
  const kill =
    d.kill ?? ((p: number, sig: NodeJS.Signals) => process.kill(p, sig));
  const r = /^[a-z0-9-]{1,64}$/.test(id)
    ? cancelSlot(s, id, canceller, whoAsks(d.env, d.cwd), {
        alive: (p) => s.isAlive(p),
        kill,
        sleep: d.sleep,
        now: d.now,
      })
    : ({ ok: false, code: "no_slot" } as const);
  if (!r.ok) {
    d.err(
      r.code === "no_slot"
        ? `gate cancel: no slot ${id}`
        : `gate cancel: ${id} isn't yours; only the agent that asked for it, or a person, can cancel it`,
    );
    return 1;
  }
  if (r.was === "queued") {
    d.out(`Cancelled ${id}; it was waiting, and its command never starts.`);
    return 0;
  }
  if (r.runPid === undefined) {
    d.out(`Cancelled ${id}; its slot is free.`);
    return 0;
  }
  d.out(`Stopping ${id}'s run (TERM, then KILL after the grace)...`);
  if (!(await r.done)) {
    d.err(
      `gate cancel: ${id}'s run is still going after KILL; its slot stays held until it ends`,
    );
    return 1;
  }
  d.out(`Cancelled ${id}; its run stopped and its slot is free.`);
  return 0;
}

const SETTING_FLAGS = [
  ["--cpu-slots", "cpu_slots"],
  ["--overrun-margin-minutes", "overrun_margin_minutes"],
  ["--release-slots", "release_slots"],
  ["--release-quiet-wait-minutes", "release_quiet_wait_minutes"],
  ["--release-tag-max-age-hours", "release_tag_max_age_hours"],
  ["--cancel-grace-seconds", "cancel_grace_seconds"],
] as const;

function settings(args: string[], d: GateDeps): number {
  const { f } = flags(
    args,
    Object.fromEntries(SETTING_FLAGS.map(([flag]) => [flag, true])),
  );
  const raw: Record<string, number> = {};
  for (const [flag, key] of SETTING_FLAGS) {
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
    `release slots ${s.releaseSlots} · release waits ${s.releaseQuietWaitMinutes} min for quiet · candidate tags up to ${s.releaseTagMaxAgeHours} h old · cancel grace ${s.cancelGraceSeconds} s`,
  );
  d.out(
    `cpu slots ${s.cpuSlots} · flagged ${s.overrunMarginMinutes} min past its estimate`,
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
      case "cancel":
        return await cancel(args.slice(1), d);
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
