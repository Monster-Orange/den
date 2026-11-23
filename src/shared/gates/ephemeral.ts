/**
 * Issue 1263: throwaway containers a gate run starts (a test's database, a
 * cache) are removed when the run's slot ends, and leftovers never outlive
 * their run.
 *
 * `gate run` names the run in DEN_GATE_SLOT (issue 928). A test helper that
 * starts a container adds ephemeralLabels(process.env) to `docker run`:
 *   den.ephemeral=1          a throwaway container (never a service)
 *   den.gate.run=<slot id>   the run it belongs to (inside a gate run)
 *   den.gate.store=<tag>     the slot store that run is in (a short hash
 *                            of its folder), so a sweep never judges a run
 *                            from another store (another machine user, or a
 *                            run with its own DEN_GATE_DIR) as gone
 *
 * Who removes them:
 *   - `gate run`, when its command ends and its slot is released (cleanRun);
 *   - the server's sweeper (ThrowawaySweeper), for any throwaway container
 *     whose run has no live slot: taken back, lapsed, ended by a person, or
 *     a run killed before it could clean up. It looks when a slot ended,
 *     at server start, and every 10 minutes; an orphan goes only when two
 *     looks at least a minute apart both found it orphaned, and never when
 *     the slots can't be read for sure.
 *
 * Only containers carrying den.ephemeral=1, a run label and this store's
 * tag are ever removed.
 *
 * Issue 1289: den.ephemeral=stop marks a container kept per checkout (a
 * test database slow to make). It carries den.gate.checkout (gate run's
 * DEN_GATE_CHECKOUT) and is stopped, never removed, when it is running and
 * no live slot comes from its checkout. Its run label is never used to
 * judge it: labels can't change, so a later run reusing it would still
 * carry the first run's id.
 * A throwaway container with no run label (started outside a gate run) is
 * listed by `den doctor`, never removed. The slot log records the count and
 * image names, never a command line or environment.
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { gateDir, type GateStore } from "./store.js";

export const EPHEMERAL_LABEL = "den.ephemeral";
export const RUN_LABEL = "den.gate.run";
export const STORE_LABEL = "den.gate.store";
/** `gate run` gives its command its store's tag in this variable. */
export const GATE_STORE_ENV = "DEN_GATE_STORE";
/** Issue 1289: a kept container's checkout (den.ephemeral=stop). */
export const CHECKOUT_LABEL = "den.gate.checkout";
/** Issue 1289: `gate run` gives its command its checkout's tag here. */
export const GATE_CHECKOUT_ENV = "DEN_GATE_CHECKOUT";

const TAG = /^[0-9a-f]{12}$/;

/**
 * Issue 1289: the checkout `dir` is in: the nearest folder up holding
 * `.git` (a folder, or a worktree's file); `dir` itself when none is.
 */
export function checkoutOf(dir: string): string {
  let d = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, ".git"))) return d;
    const up = path.dirname(d);
    if (up === d) return path.resolve(dir);
    d = up;
  }
}

/** Issue 1289: a checkout's tag: a short hash of its top folder. */
export const checkoutTag = (dir: string): string =>
  createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 12);

/** A slot store's tag: a short hash of its folder (never the path itself). */
export const storeTag = (dir: string): string =>
  createHash("sha256").update(path.resolve(dir)).digest("hex").slice(0, 12);

/** A slot id as the store makes it (`cpu-0a1b2c3d4e`); nothing else is used. */
const SLOT_ID = /^[a-z]+-[0-9a-f]{6,32}$/;

/** Runs `docker <args>`; resolves with its exit code and stdout. */
export type Docker = (args: string[]) => Promise<{ code: number; out: string }>;

/** A throwaway container as `docker ps` lists it. */
export interface Throwaway {
  id: string;
  image: string;
  /** The run (slot id) it belongs to; null when started outside a gate run. */
  run: string | null;
  /** The slot store its run is in (storeTag); null when not labelled. */
  store: string | null;
  /** Issue 1289: "remove" (den.ephemeral=1) or "stop" (=stop: kept). */
  mode?: "remove" | "stop";
  /** Issue 1289: docker's state ("running", "exited", …). */
  state?: string;
  /** Issue 1289: a kept container's checkout tag; null when not labelled. */
  checkout?: string | null;
  /** Docker's own created time, as it prints it. */
  created: string;
}

/** What one run's cleanup removed. */
export interface Removed {
  count: number;
  images: string[];
}

/** The run's store tag: as `gate run` gave it, else this env's store. */
const storeOf = (env: NodeJS.ProcessEnv): string => {
  const given = env[GATE_STORE_ENV]?.trim();
  return given && /^[0-9a-f]{12}$/.test(given) ? given : storeTag(gateDir(env));
};

/**
 * The labels a helper adds to `docker run` (in argv form). `keep` (issue
 * 1289): a container kept per checkout: stopped when its checkout's runs
 * end, never removed.
 */
export function ephemeralLabels(
  env: NodeJS.ProcessEnv,
  o: { keep?: boolean } = {},
): string[] {
  const run = env.DEN_GATE_SLOT;
  const inRun = !!run && SLOT_ID.test(run);
  const checkout = env[GATE_CHECKOUT_ENV]?.trim();
  return [
    "--label",
    `${EPHEMERAL_LABEL}=${o.keep ? "stop" : "1"}`,
    ...(inRun
      ? [
          "--label",
          `${RUN_LABEL}=${run}`,
          "--label",
          `${STORE_LABEL}=${storeOf(env)}`,
        ]
      : []),
    ...(o.keep && inRun && checkout && TAG.test(checkout)
      ? ["--label", `${CHECKOUT_LABEL}=${checkout}`]
      : []),
  ];
}

/** The real docker CLI, each call bounded by `timeoutMs`. */
export function realDocker(timeoutMs = 5_000): Docker {
  return (args) =>
    new Promise((resolve) => {
      execFile(
        "docker",
        args,
        { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          const code =
            err && typeof (err as { code?: unknown }).code === "number"
              ? ((err as { code: number }).code as number)
              : err
                ? 127
                : 0;
          resolve({ code, out: String(stdout ?? "") });
        },
      );
    });
}

const FORMAT = `{{.ID}}\t{{.Image}}\t{{.Label "${RUN_LABEL}"}}\t{{.CreatedAt}}\t{{.Label "${STORE_LABEL}"}}\t{{.Label "${EPHEMERAL_LABEL}"}}\t{{.State}}\t{{.Label "${CHECKOUT_LABEL}"}}`;

/**
 * Throwaway containers (running or stopped), optionally one run's; null
 * when docker can't be asked (not installed, not running, timed out).
 */
export async function listThrowaway(
  docker: Docker,
  run?: string,
): Promise<Throwaway[] | null> {
  if (run !== undefined && !SLOT_ID.test(run)) return [];
  // Issue 1289: both modes (=1 and =stop); others are skipped below.
  const args = ["ps", "-a", "--filter", `label=${EPHEMERAL_LABEL}`];
  if (run !== undefined) args.push("--filter", `label=${RUN_LABEL}=${run}`);
  args.push("--format", FORMAT);
  let r: { code: number; out: string };
  try {
    r = await docker(args);
  } catch {
    return null;
  }
  if (r.code !== 0) return null;
  return r.out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p) => p[0])
    .filter((p) => p[5] === undefined || p[5] === "1" || p[5] === "stop")
    .map(([id, image, label, created, store, mode, state, checkout]) => ({
      id: id!,
      image: image ?? "",
      run: label && SLOT_ID.test(label) ? label : null,
      created: created ?? "",
      store: store && TAG.test(store) ? store : null,
      mode: mode === "stop" ? ("stop" as const) : ("remove" as const),
      state: state ?? "",
      checkout: checkout && TAG.test(checkout) ? checkout : null,
    }));
}

/** Stops and removes `boxes`; what went. Never throws. */
async function removeAll(docker: Docker, boxes: Throwaway[]): Promise<Removed> {
  if (!boxes.length) return { count: 0, images: [] };
  try {
    const r = await docker(["rm", "-f", ...boxes.map((b) => b.id)]);
    if (r.code !== 0) return { count: 0, images: [] };
  } catch {
    return { count: 0, images: [] };
  }
  const images = [...new Set(boxes.map((b) => b.image.slice(0, 200)))]
    .filter(Boolean)
    .sort()
    .slice(0, 10);
  return { count: boxes.length, images };
}

/** Issue 1289: stops `boxes` (kept: never removed); what stopped. */
async function stopAll(docker: Docker, boxes: Throwaway[]): Promise<Removed> {
  if (!boxes.length) return { count: 0, images: [] };
  try {
    const r = await docker(["stop", ...boxes.map((b) => b.id)]);
    if (r.code !== 0) return { count: 0, images: [] };
  } catch {
    return { count: 0, images: [] };
  }
  const images = [...new Set(boxes.map((b) => b.image.slice(0, 200)))]
    .filter(Boolean)
    .sort()
    .slice(0, 10);
  return { count: boxes.length, images };
}

/** Issue 1289: a kept container of this store, running, with a checkout. */
const keptRunning = (b: Throwaway, tag: string) =>
  b.mode === "stop" && b.state === "running" && b.store === tag && !!b.checkout;

/**
 * Removes run `id`'s throwaway containers and logs what went. Called once
 * its slot is released, outside the store's lock. Never throws.
 */
export async function cleanRun(
  store: GateStore,
  id: string,
  docker: Docker,
  /** Issue 1289: the run's checkout tag: its kept containers stop too. */
  checkout?: string,
): Promise<Removed> {
  const tag = storeTag(store.dir);
  const boxes = (await listThrowaway(docker, id)) ?? [];
  const r = await removeAll(
    docker,
    boxes.filter((b) => b.mode !== "stop" && b.run === id && b.store === tag),
  );
  if (r.count) store.noteContainersRemoved(id, r);
  if (checkout && TAG.test(checkout))
    await stopCheckout(store, docker, checkout);
  return r;
}

/**
 * Issue 1289: stops `checkout`'s kept containers when no live slot has that
 * checkout (the run that ended has given its slot back). Read strictly:
 * when the slots can't be read for sure, nothing is stopped.
 */
async function stopCheckout(
  store: GateStore,
  docker: Docker,
  checkout: string,
): Promise<void> {
  const live = store.liveSlots();
  if (!live || live.some((e) => e.checkout === checkout)) return;
  const tag = storeTag(store.dir);
  const all = (await listThrowaway(docker)) ?? [];
  await stopAll(
    docker,
    all.filter((b) => keptRunning(b, tag) && b.checkout === checkout),
  );
}

/** Issue 1263 review: an orphan is removed only when seen this long apart. */
export const CONFIRM_MS = 60_000;

/**
 * Removes throwaway containers whose run has no live slot (any slot in the
 * queue, held or waiting, counts as live). It lists first and reads the
 * slots after, so a run that starts in between is live by the time its
 * container is judged. The slots are read strictly (store.liveIds): when
 * they can't be read for sure, nothing is removed. An orphan is removed
 * only when this sweep and an earlier one at least `confirmMs` before both
 * found it orphaned; `seen` (container id → first sighting) carries that
 * between sweeps. Null when docker didn't answer; never throws.
 */
export async function sweepThrowaway(
  store: GateStore,
  docker: Docker,
  seen: Map<string, number>,
  now: number,
  confirmMs = CONFIRM_MS,
): Promise<Swept[] | null> {
  const boxes = await listThrowaway(docker);
  if (boxes === null) return null;
  const slots = store.liveSlots();
  if (slots === null) return [];
  const live = new Set(slots.map((e) => e.id));
  const busy = new Set(slots.flatMap((e) => (e.checkout ? [e.checkout] : [])));
  const tag = storeTag(store.dir);
  const orphans = boxes.filter(
    (b) => b.mode !== "stop" && b.run && b.store === tag && !live.has(b.run),
  );
  // Issue 1289: kept containers running with no live run from their checkout.
  const idle = boxes.filter(
    (b) => keptRunning(b, tag) && !busy.has(b.checkout!),
  );
  const orphanIds = new Set([...orphans, ...idle].map((b) => b.id));
  for (const id of [...seen.keys()]) if (!orphanIds.has(id)) seen.delete(id);
  const byRun = new Map<string, Throwaway[]>();
  for (const b of orphans) {
    const first = seen.get(b.id);
    if (first === undefined) {
      seen.set(b.id, now);
      continue;
    }
    if (now - first < confirmMs) continue;
    byRun.set(b.run!, [...(byRun.get(b.run!) ?? []), b]);
  }
  const out: Swept[] = [];
  for (const [id, list] of byRun) {
    const r = await removeAll(docker, list);
    for (const b of list) seen.delete(b.id);
    if (!r.count) continue;
    store.noteContainersRemoved(id, r);
    out.push({ id, ...r });
  }
  // Issue 1289: idle kept ones stop on the same two-look rule.
  const byCheckout = new Map<string, Throwaway[]>();
  for (const b of idle) {
    const first = seen.get(b.id);
    if (first === undefined) {
      seen.set(b.id, now);
      continue;
    }
    if (now - first < confirmMs) continue;
    byCheckout.set(b.checkout!, [...(byCheckout.get(b.checkout!) ?? []), b]);
  }
  for (const [checkout, list] of byCheckout) {
    const r = await stopAll(docker, list);
    for (const b of list) seen.delete(b.id);
    if (r.count) out.push({ id: checkout, ...r, stopped: true });
  }
  return out;
}

/** One sweep's result: a run's containers removed, or a checkout's stopped. */
export type Swept = { id: string; stopped?: true } & Removed;

/** When the server's sweeper looks: cheap on a loaded machine. */
export interface SweeperTiming {
  /** A look with no slot ended meanwhile, at most this often (ms). */
  fallbackMs: number;
  /** After docker failed: the first wait (ms), doubled each failure. */
  backoffMs: number;
  /** The longest wait after failures (ms). */
  backoffMaxMs: number;
}

export const SWEEPER_TIMING: SweeperTiming = {
  fallbackMs: 10 * 60_000,
  backoffMs: 30_000,
  backoffMaxMs: 10 * 60_000,
};

/**
 * Issue 1263: the server's sweeper. Its tick (from the gate tick, never
 * awaited there) looks only when a slot ended since its last look, when an
 * orphan seen once is due its second look, or at the slow fallback; after
 * docker fails it backs off. One look at a time. The first tick (server
 * start) looks.
 */
export class ThrowawaySweeper {
  private seen = new Map<string, number>();
  private nextFallback = 0;
  private holdUntil = 0;
  private failures = 0;
  private busy = false;

  constructor(
    private readonly store: () => GateStore,
    private readonly docker: Docker,
    private readonly now: () => number = Date.now,
    private readonly timing: SweeperTiming = SWEEPER_TIMING,
  ) {}

  /** Whether a look is due now; `ended`: a slot ended since the last tick. */
  due(ended: boolean): boolean {
    const t = this.now();
    if (this.busy || t < this.holdUntil) return false;
    if (ended || t >= this.nextFallback) return true;
    for (const first of this.seen.values())
      if (t - first >= CONFIRM_MS) return true;
    return false;
  }

  /** Looks if due; what it removed (empty when it didn't look). */
  async tick(ended: boolean): Promise<Swept[]> {
    if (!this.due(ended)) return [];
    this.busy = true;
    try {
      const t = this.now();
      const r = await sweepThrowaway(this.store(), this.docker, this.seen, t);
      if (r === null) {
        this.failures++;
        this.holdUntil =
          t +
          Math.min(
            this.timing.backoffMaxMs,
            this.timing.backoffMs * 2 ** (this.failures - 1),
          );
        return [];
      }
      this.failures = 0;
      this.nextFallback = t + this.timing.fallbackMs;
      return r;
    } finally {
      this.busy = false;
    }
  }
}
