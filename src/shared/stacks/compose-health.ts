/**
 * Compose-stack health answered in-process, from one `docker ps` listing
 * shared by every check that runs at the same time.
 *
 * Den gives a compose repo with no declared check a `<cli> stack health`
 * shell check (composeHealthCmd), one per manifest service. Spawned, each
 * was a full CLI start: 17-19 tsx processes per health cycle for three
 * stacks, which on a loaded machine (load 35-55) ran past their budget and
 * read as down. The checks Den generates itself are now judged here, with
 * the verdict `stack health` gives; a distribution's own shell checks still
 * run as shell commands.
 */
import { execFile } from "child_process";
import type { RawManifest } from "../types/index.js";
import { manifestStackName } from "./config.js";
import { composeHealthCmd } from "./manifest-commands.js";
import { projectName } from "./render.js";
import { judgeStackRows, type ComposeRow } from "./runtime.js";
import { resolveStackWorkspaces } from "./status.js";

export { judgeStackRows, type ComposeRow };

/** A Den-generated compose health check: what to look for in the listing. */
export interface ComposeHealthTarget {
  /** The Compose project (`<stack>-<stack workspace>`). */
  project: string;
  /** A compose service to check on its own; unset: the whole stack. */
  service?: string;
  /** The equivalent `<cli> stack health` command (shown as the check). */
  cmd: string;
}

/** A health verdict; `ok: null` when docker could not be asked. */
export interface ComposeVerdict {
  ok: boolean | null;
  detail: string;
  /** With ok null: docker gave no answer within the budget. */
  pending?: boolean;
}

/** The compose health check Den generates for this service, or null. */
export function composeHealthTarget(
  manifest: RawManifest,
  subsystem: string,
  repoName: string,
  workspace: string,
): ComposeHealthTarget | null {
  const cmd = composeHealthCmd(manifest, subsystem, repoName, workspace);
  if (!cmd) return null;
  const project = projectName(
    manifestStackName(manifest, repoName),
    resolveStackWorkspaces(workspace).stackWorkspace,
  );
  const service = cmd.includes(" --service ") ? subsystem : undefined;
  return { project, ...(service ? { service } : {}), cmd };
}

/** Budget for the shared listing; past it the checks are pending. */
export const COMPOSE_LISTING_TIMEOUT_MS = 5_000;

/** The shared listing: every container, or why docker could not answer. */
export type ComposeListing =
  | { rows: ComposeRow[] }
  | { error: string; pending?: boolean };
type Listing = ComposeListing;

let inFlight: Promise<Listing> | null = null;

/**
 * Every container, from one `docker ps -a`. Concurrent callers share the
 * call in flight, so a health cycle lists once however many checks it has
 * (compose checks and `type: container` checks alike). Not filtered to
 * compose containers: a container check may name a plain container.
 */
export function composeListing(): Promise<Listing> {
  return (inFlight ??= listOnce().finally(() => {
    inFlight = null;
  }));
}

function listOnce(): Promise<Listing> {
  return new Promise((done) => {
    // Backstop: execFile reports only once the pipes close, which a killed
    // process's children can hold open; the checks must not wait on that.
    const guard = setTimeout(
      () =>
        resolve({
          error: `docker gave no answer within ${COMPOSE_LISTING_TIMEOUT_MS / 1000}s`,
          pending: true,
        }),
      COMPOSE_LISTING_TIMEOUT_MS + 500,
    );
    let settled = false;
    const resolve = (l: Listing): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      done(l);
    };
    execFile(
      "docker",
      [
        "ps",
        "-a",
        "--format",
        '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}\t{{.Names}}',
      ],
      {
        encoding: "utf-8",
        timeout: COMPOSE_LISTING_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const killed = (err as { killed?: boolean }).killed === true;
          return resolve(
            killed
              ? {
                  error: `docker gave no answer within ${COMPOSE_LISTING_TIMEOUT_MS / 1000}s`,
                  pending: true,
                }
              : {
                  error:
                    String(stderr || err.message).trim() || "docker ps failed",
                },
          );
        }
        const rows = stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [
              project = "",
              service = "",
              state = "",
              status = "",
              name = "",
            ] = line.split("\t");
            return { project, service, state, status, name };
          });
        resolve({ rows });
      },
    );
  });
}

/**
 * The verdict when docker gave no listing, shared by compose and container
 * checks so the two cannot drift: container state unknown is not "not
 * running" (`ok: null`, never down, however often it repeats). Only a
 * listing past its budget is `pending` (no answer in time), which, like any
 * timeout, is down when it repeats on the next cycle.
 */
export function unknownListingVerdict(listing: {
  error: string;
  pending?: boolean;
}): ComposeVerdict {
  return {
    ok: null,
    detail: `container state unknown: ${listing.error}`,
    ...(listing.pending ? { pending: true } : {}),
  };
}

/** The health of one Den-generated compose check, from the shared listing. */
export async function composeHealth(
  target: ComposeHealthTarget,
): Promise<ComposeVerdict> {
  const listing = await composeListing();
  if ("error" in listing) return unknownListingVerdict(listing);
  return judgeStackRows(listing.rows, target.project, target.service);
}

// ── `health: { type: container }` ───────────────────────────────────────────

/**
 * A declared container check: a compose container by its project and service
 * labels, or any container by name (`container_name`).
 */
export type ContainerHealthTarget =
  | { project: string; service: string; container_name?: undefined }
  | { container_name: string; project?: undefined; service?: undefined };

/** What a container check shows as its check: `container <project>/<service>`. */
export function containerCheckLabel(t: ContainerHealthTarget): string {
  return `container ${containerTargetName(t)}`;
}

function containerTargetName(t: ContainerHealthTarget): string {
  return t.container_name ?? `${t.project}/${t.service}`;
}

function matchesTarget(r: ComposeRow, t: ContainerHealthTarget): boolean {
  if (t.container_name)
    return (r.name ?? "")
      .split(",")
      .map((n) => n.trim().replace(/^\//, ""))
      .includes(t.container_name);
  return r.project === t.project && r.service === t.service;
}

/** One container's verdict: its healthcheck when it has one, else running. */
function rowVerdict(r: ComposeRow): ComposeVerdict & { rank: number } {
  const what = `${r.name || `${r.project}/${r.service}`}\t${r.state}\t${r.status}`;
  if (r.state !== "running") return { ok: false, detail: what, rank: 4 };
  if (/\(unhealthy\)/.test(r.status))
    return { ok: false, detail: what, rank: 3 };
  // Starting is pending, but not "no answer": it never turns down on repeat.
  if (/\(health: starting\)/.test(r.status))
    return { ok: null, detail: what, rank: 2 };
  if (/\(healthy\)/.test(r.status)) return { ok: true, detail: what, rank: 0 };
  return { ok: true, detail: what, rank: 1 };
}

/**
 * The verdict of a container check over the shared listing. More than one
 * match: the best one (healthy, then running). No match: down. No listing:
 * as a compose check (unknownListingVerdict), the reason in `detail`.
 */
export function judgeContainerListing(
  listing: ComposeListing,
  target: ContainerHealthTarget,
): ComposeVerdict {
  if ("error" in listing) return unknownListingVerdict(listing);
  const best = listing.rows
    .filter((r) => matchesTarget(r, target))
    .map(rowVerdict)
    .sort((a, b) => a.rank - b.rank)[0];
  if (!best)
    return {
      ok: false,
      detail: `${containerTargetName(target)}: no container`,
    };
  return { ok: best.ok, detail: best.detail };
}

/** The health of a declared container check, from the shared listing. */
export async function containerHealth(
  target: ContainerHealthTarget,
): Promise<ComposeVerdict> {
  return judgeContainerListing(await composeListing(), target);
}
