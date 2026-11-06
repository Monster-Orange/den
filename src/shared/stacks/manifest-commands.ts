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
import { containerName, parseTarget, projectName } from "./render.js";

import { product } from "../product.js";
type CommandDef = string | { cmd: string; detachable?: boolean };

/** Whether `subsystem` is the repo's primary service (the one the stack belongs to). */
export function isPrimary(manifest: RawManifest, subsystem: string): boolean {
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
  if (!manifest.compose) return {};
  // `docker compose up -d` returns once the containers are started, so these
  // finish on their own: never daemonize them.
  const stack = (sub: string) => ({
    cmd: `${denBin()} stack ${sub} ${manifestStackName(manifest, repoName)} -w ${workspace}`,
    detachable: false,
  });
  // Any other manifest service names a compose service: it restarts on its
  // own (`docker compose restart`, same container and env). Up and down stay
  // the stack's, through the primary service.
  if (!isPrimary(manifest, subsystem))
    return {
      restart: {
        ...stack("restart"),
        cmd: `${stack("restart").cmd} --service ${JSON.stringify(subsystem)}`,
      },
    };
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

/**
 * The containers a compose-stack service runs as, best match first ([] when
 * the repo isn't a compose stack). Any other manifest service names a compose
 * service; the primary one also falls back to its routes' target services.
 * `stackWorkspace` is the Compose project suffix (see resolveStackWorkspaces).
 */
export function composeServiceContainers(
  manifest: RawManifest,
  subsystem: string,
  repoName: string,
  stackWorkspace: string,
): string[] {
  if (!manifest.compose) return [];
  const project = projectName(
    manifestStackName(manifest, repoName),
    stackWorkspace,
  );
  const services = [subsystem];
  if (isPrimary(manifest, subsystem))
    for (const target of Object.values(manifest.compose.routes ?? {})) {
      try {
        services.push(parseTarget(target).service);
      } catch {
        /* a malformed route is reported by the stack commands */
      }
    }
  return [...new Set(services)].map((svc) => containerName(project, svc));
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
