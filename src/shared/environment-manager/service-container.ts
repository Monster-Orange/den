/**
 * The running container that holds a service's logs. A compose-stack service
 * runs as `<stack>-<workspace>-<service>-1` (the stacks naming helpers); any
 * other container-run service is found by opctl's naming convention.
 */
import { readManifest } from "../manifest/read-manifest.js";
import { composeServiceContainers } from "../stacks/manifest-commands.js";
import { resolveStackWorkspaces } from "../stacks/status.js";
import { findConventionalContainer, runningDockerNames } from "./opctl.js";

/** The stack's container for `subsystem` when one is running, else null. */
export function findStackServiceContainer(
  repoName: string,
  repoPath: string | undefined,
  subsystem: string | undefined,
): string | null {
  if (!repoPath || !subsystem) return null;
  const manifest = readManifest(repoPath);
  if (!manifest?.compose) return null;
  let candidates: string[];
  let running: string[];
  try {
    const { stackWorkspace } = resolveStackWorkspaces();
    candidates = composeServiceContainers(
      manifest,
      subsystem,
      repoName,
      stackWorkspace,
    );
    running = runningDockerNames();
  } catch {
    return null; // bad workspace name, or docker unavailable
  }
  return candidates.find((c) => running.includes(c)) ?? null;
}

/** A service's running container: its compose stack's, else opctl's. */
export function findServiceContainer(
  repoName: string,
  repoPath?: string,
  subsystem?: string,
): string | null {
  return (
    findStackServiceContainer(repoName, repoPath, subsystem) ??
    findConventionalContainer(repoName, repoPath, subsystem)
  );
}
