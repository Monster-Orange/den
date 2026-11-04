/**
 * Commands den supplies for a repo whose `.den.yml` has a `compose:`
 * section: the stack runs behind the edge with no host ports. A command the
 * repo declares itself (services.<svc>.commands.local) always wins.
 */
import * as path from "path";
import { getDistRoot } from "../paths.js";
import { readManifest } from "../manifest/read-manifest.js";
import type { RawManifest } from "../types/index.js";
import { manifestStackName } from "./config.js";

import { product } from "../product.js";
type CommandDef = string | { cmd: string; detachable?: boolean };

/** Whether `subsystem` is the repo's primary service (the one the stack belongs to). */
function isPrimary(manifest: RawManifest, subsystem: string): boolean {
  const keys = Object.keys(manifest.services ?? {});
  if (manifest.entrypoint) return manifest.entrypoint === subsystem;
  return keys.length <= 1;
}

function denBin(): string {
  return JSON.stringify(path.join(getDistRoot(), "bin", `${product().cli}`));
}

/** The synthesized stack commands, or {} when the repo isn't a compose stack. */
export function composeCommands(
  manifest: RawManifest,
  subsystem: string,
  repoName: string,
  workspace: string,
): Record<string, CommandDef> {
  if (!manifest.compose || !isPrimary(manifest, subsystem)) return {};
  // `docker compose up -d` returns once the containers are started, so these
  // finish on their own: never daemonize them.
  const stack = (sub: string) => ({
    cmd: `${denBin()} stack ${sub} ${manifestStackName(manifest, repoName)} -w ${workspace}`,
    detachable: false,
  });
  return {
    up: stack("up"),
    down: stack("down"),
    restart: stack("restart"),
    logs: stack("logs"),
  };
}

/**
 * Shell health check for a compose stack. The entry service is healthy when
 * every container is running and healthy; any other manifest service names a
 * compose service and is checked on its own (`--service`).
 */
export function composeHealthCmd(
  manifest: RawManifest,
  subsystem: string,
  repoName: string,
  workspace: string,
): string | null {
  if (!manifest.compose) return null;
  const base = `${denBin()} stack health ${manifestStackName(manifest, repoName)} -w ${workspace}`;
  return isPrimary(manifest, subsystem)
    ? base
    : `${base} --service ${JSON.stringify(subsystem)}`;
}

/** Declared local commands layered over the synthesized compose ones. */
export function effectiveLocalCommands(
  manifest: RawManifest,
  subsystem: string,
  repoName: string,
  workspace: string,
): Record<string, CommandDef> {
  return {
    ...composeCommands(manifest, subsystem, repoName, workspace),
    ...(manifest.services?.[subsystem]?.commands?.local ?? {}),
  };
}

/** Effective local commands for a resolved service, read from its manifest. */
export function localCommandsFor(
  svc: { repoPath: string; repoName: string; subsystem: string },
  workspace: string,
): Record<string, CommandDef> {
  const m = readManifest(svc.repoPath);
  return m
    ? effectiveLocalCommands(m, svc.subsystem, svc.repoName, workspace)
    : {};
}
