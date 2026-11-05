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

type Listing = { rows: ComposeRow[] } | { error: string; pending?: boolean };

let inFlight: Promise<Listing> | null = null;

/**
 * Every compose container, from one `docker ps -a`. Concurrent callers share
 * the call in flight, so a health cycle lists once however many checks it has.
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
        "--filter",
        "label=com.docker.compose.project",
        "--format",
        '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Status}}',
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
            const [project = "", service = "", state = "", status = ""] =
              line.split("\t");
            return { project, service, state, status };
          });
        resolve({ rows });
      },
    );
  });
}

/** The health of one Den-generated compose check, from the shared listing. */
export async function composeHealth(
  target: ComposeHealthTarget,
): Promise<ComposeVerdict> {
  const listing = await composeListing();
  if ("error" in listing)
    return {
      ok: null,
      detail: `container state unknown: ${listing.error}`,
      ...(listing.pending ? { pending: true } : {}),
    };
  return judgeStackRows(listing.rows, target.project, target.service);
}
