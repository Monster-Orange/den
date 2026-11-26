/**
 * The running container that holds a service's logs. A compose-stack service
 * runs as `<stack>-<workspace>-<service>-1` (the stacks naming helpers); any
 * other container-run service is found by opctl's naming convention.
 */
import { readManifest } from "../manifest/read-manifest.js";
import { composeServiceContainers } from "../stacks/manifest-commands.js";
import { resolveStackWorkspaces } from "../stacks/status.js";
import {
  findConventionalContainer,
  pickConventionalContainer,
  runningDockerNames,
  runningDockerNamesAsync,
} from "./opctl.js";

/** The stack's container for `subsystem` when one is running, else null. */
export function findStackServiceContainer(
  repoName: string,
  repoPath: string | undefined,
  subsystem: string | undefined,
): string | null {
  const candidates = stackCandidates(repoName, repoPath, subsystem);
  if (!candidates?.length) return null;
  let running: string[];
  try {
    running = runningDockerNames();
  } catch {
    return null;
  }
  return candidates.find((c) => running.includes(c)) ?? null;
}

function stackCandidates(
  repoName: string,
  repoPath: string | undefined,
  subsystem: string | undefined,
): string[] | null {
  if (!repoPath || !subsystem) return null;
  const manifest = readManifest(repoPath);
  if (!manifest?.compose) return null;
  try {
    const { stackWorkspace } = resolveStackWorkspaces();
    return composeServiceContainers(
      manifest,
      subsystem,
      repoName,
      stackWorkspace,
    );
  } catch {
    return null; // bad workspace name
  }
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

export async function findServiceContainerAsync(
  repoName: string,
  repoPath?: string,
  subsystem?: string,
): Promise<string | null> {
  const running = await runningDockerNamesAsync();
  if (!running) return null;
  const stack = stackCandidates(repoName, repoPath, subsystem);
  return (
    stack?.find((c) => running.includes(c)) ??
    pickConventionalContainer(running, repoName, repoPath, subsystem)
  );
}
