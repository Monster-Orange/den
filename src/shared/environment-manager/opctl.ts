/**
 * opctl runtime helpers.
 *
 * opctl, when installed, is a container control plane; Den leans on it for
 * the parts that would otherwise need stale per-repo
 * declarations:
 *   - shutting a service down  → `opctl container down <name>` (invariant: every
 *     service's containers can be cleanly stopped this way)
 *   - identifying a service's containers → the `container.name` declared in the
 *     repo's dev/up op, captured at spawn time and/or parsed on demand.
 */

import { execFile, execFileSync, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/** Candidate dev/up op manifests for a repo, in resolution order. */
function devOpManifestPaths(repoPath: string): string[] {
  return [
    path.join(repoPath, ".opspec", "dev", "op.yml"),
    path.join(repoPath, ".opspec", "up", "op.yml"),
    path.join(repoPath, ".opspec", "local", "up", "op.yml"), // infra-stack
    path.join(repoPath, "apps", "backend", ".opspec", "up", "op.yml"), // monorepo (shop)
    path.join(repoPath, "apps", "backend", ".opspec", "dev", "op.yml"),
  ];
}

/** Recursively collect every `container.name` string in an opctl op tree. */
function collectContainerNames(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectContainerNames(item, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  const container = obj.container;
  if (container && typeof container === "object" && !Array.isArray(container)) {
    const name = (container as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim()) out.add(name.trim());
  }
  for (const value of Object.values(obj)) collectContainerNames(value, out);
}

/**
 * The opctl container names a repo's dev/up op declares (e.g. ["links-api"]).
 * These are the short `container.name` labels `opctl container down` matches on.
 * Returns [] when no op manifest is found or it can't be parsed.
 */
export function devOpContainerNames(repoPath: string): string[] {
  for (const manifestPath of devOpManifestPaths(repoPath)) {
    try {
      if (!fs.existsSync(manifestPath)) continue;
      const op = parseYaml(fs.readFileSync(manifestPath, "utf-8"));
      const names = new Set<string>();
      collectContainerNames(op, names);
      if (names.size > 0) return [...names];
    } catch {
      /* unparseable — try the next candidate */
    }
  }
  return [];
}

let opctlAvailableCache: boolean | null = null;

/** Whether the `opctl` CLI is on PATH (cached for the process lifetime). */
export function isOpctlAvailable(): boolean {
  if (opctlAvailableCache !== null) return opctlAvailableCache;
  try {
    execSync("command -v opctl", { stdio: "ignore" });
    opctlAvailableCache = true;
  } catch {
    opctlAvailableCache = false;
  }
  return opctlAvailableCache;
}

/**
 * Docker names opctl-spawned containers `opctl_<base>_<8-hex>`. Capture the
 * base so down can find them even when `opctl container ls` is empty or
 * opctl itself can't elevate (`sudo -E` rejected).
 */
const DOCKER_OPCTL_NAME = /^opctl_(.+)_([0-9a-f]{8})$/i;

/**
 * Whether a docker container name is opctl's container for exactly `base`.
 *
 * A bare `startsWith("opctl_<base>_")` test is ambiguous whenever one base is a
 * prefix of another that contains an underscore — base `api` would claim
 * `opctl_api_v2_<hash>` — and these names feed `docker rm -f`, so a wrong match
 * tears down someone else's service. Requiring the remainder to be a single
 * trailing segment (opctl's hash never contains `_`) makes the base comparison
 * exact without depending on the hash's length or alphabet.
 */
export function isOpctlContainerFor(name: string, base: string): boolean {
  const prefix = `opctl_${base}_`;
  if (!name.startsWith(prefix)) return false;
  const suffix = name.slice(prefix.length);
  return suffix.length > 0 && !suffix.includes("_");
}

/** Names of the running docker containers (throws when docker is unavailable). */
export function runningDockerNames(): string[] {
  return execSync('docker ps --format "{{.Names}}"', {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Running opctl containers discovered via the docker socket (no sudo).
 * `name` is the full docker name; `base` is the opctl `container.name`.
 */
export function listRunningDockerOpctlContainers(): {
  name: string;
  base: string;
}[] {
  try {
    const rows: { name: string; base: string }[] = [];
    for (const name of runningDockerNames()) {
      const m = name.match(DOCKER_OPCTL_NAME);
      if (!m) continue;
      rows.push({ name, base: m[1] });
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Names of currently-running opctl containers.
 *
 * Prefers `opctl container ls` (NAME column, trailing `-<hash>` stripped to
 * the base `container.name`), and unions in anything docker still shows as
 * `opctl_<base>_<hash>`. Docker is the source of truth when opctl can't
 * elevate or its ls is empty while containers keep running — exactly the
 * failure mode that made links-api / notes-api look "already stopped"
 * (or report a successful scripted down) while their containers stayed up.
 */
export function listRunningOpctlContainers(): { name: string; base: string }[] {
  const byBase = new Map<string, { name: string; base: string }>();

  if (isOpctlAvailable()) {
    try {
      const out = execSync("opctl container ls", {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const lines = out.split("\n");
      // Skip the first line only when it is actually a header row.
      const firstToken = lines[0]?.trim().split(/\s+/)[0];
      const body =
        firstToken === "NAME" || firstToken === "ID" ? lines.slice(1) : lines;
      for (const line of body) {
        const name = line.trim().split(/\s+/)[0];
        if (!name) continue;
        const base = name.replace(/-[0-9a-f]{8}$/i, "");
        byBase.set(base, { name, base });
      }
    } catch {
      /* fall through to docker */
    }
  }

  for (const c of listRunningDockerOpctlContainers()) {
    if (!byBase.has(c.base)) byBase.set(c.base, c);
  }
  return [...byBase.values()];
}

/**
 * Resolve a service's RUNNING docker container purely by opctl naming
 * convention — docker names opctl-spawned containers `opctl_<base>_<hash>`.
 *
 * Candidates for `<base>`, in order: the repo's op-manifest container name
 * matching the subsystem, any op-manifest container name, then the repo name
 * itself. Returns the full docker container name, or null when nothing
 * matches (not running, not containerized, or docker unavailable).
 */
export function findConventionalContainer(
  repoName: string,
  repoPath?: string,
  subsystem?: string,
): string | null {
  let running: string[];
  try {
    running = runningDockerNames();
  } catch {
    return null;
  }
  const declared = repoPath ? devOpContainerNames(repoPath) : [];
  // Only candidates with NAME AFFINITY to the request — a blind scan of the
  // declared list would hand a sidecar (e.g. shop-postgres) to an api
  // request. The full declared list is only trusted when it's unambiguous.
  const candidates = [
    ...(subsystem
      ? declared.filter(
          (n) =>
            n === subsystem ||
            n === `${repoName}-${subsystem}` ||
            n.endsWith(`-${subsystem}`),
        )
      : []),
    repoName,
    ...(declared.length === 1 ? declared : []),
  ];
  for (const base of candidates) {
    const hit = running.find((n) => isOpctlContainerFor(n, base));
    if (hit) return hit;
  }
  return null;
}

/** The running opctl containers for one `container.name`, and their origin. */
export interface OpctlContainerInfo {
  /** Full docker names (`opctl_<base>_<hash>`) — usually one, see below. */
  names: string[];
  /** Host paths bind-mounted into any of those containers. */
  mountSources: string[];
  /** Earliest container start time, or null when docker didn't report one. */
  startedAt: Date | null;
}

/**
 * Inspect the running containers for an opctl `container.name`.
 *
 * Bind-mount sources are the only trail back to the checkout a container was
 * started from — opctl's labels record the container name, not the source repo.
 * That distinction is what lets a caller tell "my own checkout is already
 * running, untracked" apart from "another checkout occupies this name".
 *
 * A base normally has exactly one container, but a leaked container from an
 * earlier run can coexist with the current one under a different hash. All of
 * them are inspected and their mounts unioned: deciding adoption from whichever
 * one `docker ps` happened to list first would make the answer depend on
 * container age. Returns null when nothing runs or docker can't be reached.
 */
export function inspectOpctlContainer(base: string): OpctlContainerInfo | null {
  try {
    const names = runningDockerNames().filter((n) =>
      isOpctlContainerFor(n, base),
    );
    if (names.length === 0) return null;

    const mountSources = new Set<string>();
    let startedAt: Date | null = null;
    for (const name of names) {
      const raw = execFileSync("docker", ["inspect", name], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      });
      const entry = (JSON.parse(raw) as unknown[])[0] as
        | {
            Mounts?: { Source?: unknown }[];
            State?: { StartedAt?: unknown };
          }
        | undefined;
      for (const m of entry?.Mounts ?? []) {
        if (typeof m.Source === "string" && m.Source)
          mountSources.add(m.Source);
      }
      const startedRaw = entry?.State?.StartedAt;
      const started =
        typeof startedRaw === "string" ? new Date(startedRaw) : null;
      if (started && !Number.isNaN(started.getTime())) {
        if (!startedAt || started < startedAt) startedAt = started;
      }
    }
    return { names, mountSources: [...mountSources], startedAt };
  } catch {
    return null;
  }
}

/**
 * Force-stop docker containers for opctl `container.name` bases when
 * `opctl container down` cannot elevate (typical: sudoers grants NOPASSWD for
 * opctl but not SETENV, so opctl's `sudo -E` is rejected).
 *
 * Docker names opctl containers `opctl_<base>_<hash>`; `docker rm -f` stops and
 * removes them without needing sudo when the user can talk to the docker socket.
 */
export function forceStopOpctlContainers(bases: string[]): {
  stopped: string[];
  failed: string[];
} {
  const stopped: string[] = [];
  const failed: string[] = [];
  if (bases.length === 0) return { stopped, failed };

  let running: string[];
  try {
    running = runningDockerNames();
  } catch {
    return { stopped, failed: [...bases] };
  }

  const names = running.filter((n) =>
    bases.some((base) => isOpctlContainerFor(n, base)),
  );
  for (const name of names) {
    try {
      execFileSync("docker", ["rm", "-f", name], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 30_000,
      });
      stopped.push(name);
    } catch {
      failed.push(name);
    }
  }
  return { stopped, failed };
}

/**
 * Base container names that newly appeared between two `opctl container ls`
 * snapshots — i.e. the containers an `up` just spawned.
 */
export function diffSpawnedContainers(
  before: { base: string }[],
  after: { base: string }[],
): string[] {
  const had = new Set(before.map((c) => c.base));
  const fresh = new Set<string>();
  for (const c of after) if (!had.has(c.base)) fresh.add(c.base);
  return [...fresh];
}

// ── Async variants (the web server) ──────────────────────────────────────────
// The sync calls above block the event loop for the whole `docker ps` /
// `opctl container ls` (hundreds of ms on a loaded machine). The server uses
// these instead; concurrent callers share one in-flight call.

function execOut(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { encoding: "utf-8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

function shared<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () =>
    (inFlight ??= run().finally(() => {
      inFlight = null;
    }));
}

/** Whether `opctl` is on PATH, without spawning a shell. Cached. */
export async function isOpctlAvailableAsync(): Promise<boolean> {
  if (opctlAvailableCache !== null) return opctlAvailableCache;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      await fs.promises.access(path.join(dir, "opctl"), fs.constants.X_OK);
      return (opctlAvailableCache = true);
    } catch {
      /* next */
    }
  }
  return (opctlAvailableCache = false);
}

/** runningDockerNames, async; null when docker is unavailable. */
export const runningDockerNamesAsync = shared(
  async (): Promise<string[] | null> => {
    const out = await execOut("docker", ["ps", "--format", "{{.Names}}"]);
    return out === null
      ? null
      : out
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
  },
);

/** listRunningOpctlContainers, async. */
export const listRunningOpctlContainersAsync = shared(
  async (): Promise<{ name: string; base: string }[]> => {
    const byBase = new Map<string, { name: string; base: string }>();
    const [opctlOut, dockerNames] = await Promise.all([
      isOpctlAvailableAsync().then((ok) =>
        ok ? execOut("opctl", ["container", "ls"]) : null,
      ),
      runningDockerNamesAsync(),
    ]);
    if (opctlOut !== null) {
      const lines = opctlOut.split("\n");
      const firstToken = lines[0]?.trim().split(/\s+/)[0];
      const body =
        firstToken === "NAME" || firstToken === "ID" ? lines.slice(1) : lines;
      for (const line of body) {
        const name = line.trim().split(/\s+/)[0];
        if (!name) continue;
        const base = name.replace(/-[0-9a-f]{8}$/i, "");
        byBase.set(base, { name, base });
      }
    }
    for (const name of dockerNames ?? []) {
      const m = name.match(DOCKER_OPCTL_NAME);
      if (m && !byBase.has(m[1])) byBase.set(m[1], { name, base: m[1] });
    }
    return [...byBase.values()];
  },
);
