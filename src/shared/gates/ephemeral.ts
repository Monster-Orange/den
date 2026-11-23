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
 *   - the server's gate tick, for any throwaway container whose run has no
 *     live slot: taken back, lapsed, ended by a person, or a run killed
 *     before it could clean up (sweepThrowaway). The same sweep runs once at
 *     server start, before services are restored, so a container Docker
 *     brings back after a restart is removed instead of left running.
 *
 * Only containers carrying den.ephemeral=1, a run label and this store's
 * tag are ever removed.
 * A throwaway container with no run label (started outside a gate run) is
 * listed by `den doctor`, never removed. The slot log records the count and
 * image names, never a command line or environment.
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import * as path from "path";
import { gateDir, type GateStore } from "./store.js";

export const EPHEMERAL_LABEL = "den.ephemeral";
export const RUN_LABEL = "den.gate.run";
export const STORE_LABEL = "den.gate.store";
/** `gate run` gives its command its store's tag in this variable. */
export const GATE_STORE_ENV = "DEN_GATE_STORE";

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

/** The labels a helper adds to `docker run` (in argv form). */
export function ephemeralLabels(env: NodeJS.ProcessEnv): string[] {
  const run = env.DEN_GATE_SLOT;
  return [
    "--label",
    `${EPHEMERAL_LABEL}=1`,
    ...(run && SLOT_ID.test(run)
      ? [
          "--label",
          `${RUN_LABEL}=${run}`,
          "--label",
          `${STORE_LABEL}=${storeOf(env)}`,
        ]
      : []),
  ];
}

/** The real docker CLI, each call bounded by `timeoutMs`. */
export function realDocker(timeoutMs = 30_000): Docker {
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

const FORMAT = `{{.ID}}\t{{.Image}}\t{{.Label "${RUN_LABEL}"}}\t{{.CreatedAt}}\t{{.Label "${STORE_LABEL}"}}`;

/**
 * Throwaway containers (running or stopped), optionally one run's; null
 * when docker can't be asked (not installed, not running, timed out).
 */
export async function listThrowaway(
  docker: Docker,
  run?: string,
): Promise<Throwaway[] | null> {
  if (run !== undefined && !SLOT_ID.test(run)) return [];
  const args = ["ps", "-a", "--filter", `label=${EPHEMERAL_LABEL}=1`];
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
    .map(([id, image, label, created, store]) => ({
      id: id!,
      image: image ?? "",
      run: label && SLOT_ID.test(label) ? label : null,
      created: created ?? "",
      store: store && /^[0-9a-f]{12}$/.test(store) ? store : null,
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

/**
 * Removes run `id`'s throwaway containers and logs what went. Called once
 * its slot is released, outside the store's lock. Never throws.
 */
export async function cleanRun(
  store: GateStore,
  id: string,
  docker: Docker,
): Promise<Removed> {
  const tag = storeTag(store.dir);
  const boxes = (await listThrowaway(docker, id)) ?? [];
  const r = await removeAll(
    docker,
    boxes.filter((b) => b.run === id && b.store === tag),
  );
  if (r.count) store.noteContainersRemoved(id, r);
  return r;
}

/**
 * Removes throwaway containers whose run has no live slot (any slot in the
 * queue, held or waiting, counts as live). It lists first and reads the
 * slots after, so a run that starts in between is live by the time its
 * container could be judged. Never throws.
 */
export async function sweepThrowaway(
  store: GateStore,
  docker: Docker,
): Promise<({ id: string } & Removed)[]> {
  const boxes = await listThrowaway(docker);
  if (!boxes?.length) return [];
  const live = new Set(store.list().map((e) => e.id));
  const tag = storeTag(store.dir);
  const byRun = new Map<string, Throwaway[]>();
  for (const b of boxes) {
    if (!b.run || b.store !== tag || live.has(b.run)) continue;
    byRun.set(b.run, [...(byRun.get(b.run) ?? []), b]);
  }
  const out: ({ id: string } & Removed)[] = [];
  for (const [id, list] of byRun) {
    const r = await removeAll(docker, list);
    if (!r.count) continue;
    store.noteContainersRemoved(id, r);
    out.push({ id, ...r });
  }
  return out;
}
