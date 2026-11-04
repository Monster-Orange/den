/**
 * Live log tailing for a local service — the CLI-side counterpart of the web
 * /api/service/taillog SSE endpoint. Source resolution, in order:
 *   1. The service's manifest `logs.local` shell command (e.g. `docker logs -f`)
 *   2. Conventional container derivation: a running `opctl_<base>_<hash>`
 *      container → `docker logs -f` — real runtime logs with zero manifest config
 *   3. The den daemon startup log (~/.den/logs/<repo>/<subsystem>.log) —
 *      last resort, covers host-run processes with no container
 * A source whose command exits within the quick-exit window (container not
 * found, stale filter) is treated as broken and the next tier takes over.
 */

import * as fs from "fs";
import { DAEMON_QUICK_EXIT_MS, LIVE_TAIL_LINES } from "../constants.js";
import { readManifest } from "../manifest/read-manifest.js";
import { findConventionalContainer } from "./opctl.js";
import {
  getServiceLogPath,
  spawnStreaming,
} from "../process/spawn-streaming.js";
import type { LogSource, ResolvedService } from "../types/index.js";

export interface TailSource {
  kind: "manifest" | "docker" | "file";
  /** Executable (argv mode) or a full shell command (when args is empty). */
  cmd: string;
  /**
   * Argv for cmd. Empty → cmd runs through the shell (manifest `logs.local`
   * commands are arbitrary shell by design). Den-BUILT commands always use
   * argv mode so container/subsystem names from manifests or docker output
   * can never be shell-interpreted (`$(…)`, backticks, quotes).
   */
  args: string[];
  /** Working directory for the command (manifest commands run in the repo). */
  cwd?: string;
  /** Human-readable description for the stream header. */
  label: string;
}

export interface TailSourceInputs {
  repoPath?: string;
  /** The subsystem's manifest `logs.local` entry, if any. */
  logSource?: LogSource;
  /** A running conventional opctl container name, if any. */
  container: string | null;
  daemonLogPath: string;
  daemonLogExists: boolean;
}

/** Ordered tail-source candidates (best source first). Pure — see resolveTailSources. */
export function tailSourceCandidates(
  inputs: TailSourceInputs,
  lines: number = LIVE_TAIL_LINES,
): TailSource[] {
  const candidates: TailSource[] = [];
  if (inputs.logSource?.type === "shell" && inputs.logSource.cmd) {
    candidates.push({
      kind: "manifest",
      cmd: inputs.logSource.cmd,
      args: [],
      cwd: inputs.repoPath,
      label: `manifest log command: ${inputs.logSource.cmd}`,
    });
  }
  if (inputs.container) {
    candidates.push({
      kind: "docker",
      cmd: "docker",
      args: ["logs", "-f", "--tail", String(lines), inputs.container],
      label: `container logs: ${inputs.container}`,
    });
  }
  if (inputs.daemonLogExists) {
    candidates.push({
      kind: "file",
      cmd: "tail",
      args: ["-F", "-n", String(lines), inputs.daemonLogPath],
      label: `startup log: ${inputs.daemonLogPath}`,
    });
  }
  return candidates;
}

/** Gather live inputs for `resolved` and build its tail-source candidates. */
export function resolveTailSources(resolved: ResolvedService): TailSource[] {
  const manifest = readManifest(resolved.repoPath);
  const logSource = manifest?.services?.[resolved.subsystem]?.logs?.local;
  const container = findConventionalContainer(
    resolved.repoName,
    resolved.repoPath,
    resolved.subsystem,
  );
  const daemonLogPath = getServiceLogPath(
    resolved.repoName,
    resolved.subsystem,
  );
  return tailSourceCandidates({
    repoPath: resolved.repoPath,
    logSource,
    container,
    daemonLogPath,
    daemonLogExists: fs.existsSync(daemonLogPath),
  });
}

export interface FollowCallbacks {
  onLine: (line: string) => void;
  /** Stream headers / end-of-stream notices (rendered dim by the CLI). */
  onMeta: (line: string) => void;
}

export interface FollowHandle {
  /** Resolves with the final stream's exit code (0 after stop()). */
  done: Promise<number>;
  /** Stop tailing without stopping the service. */
  stop: () => void;
}

export interface FollowDeps {
  spawn?: typeof spawnStreaming;
  quickExitMs?: number;
}

/**
 * Follow the first working candidate, falling through the tiers when a
 * command quick-exits. Lines seen before a source survives the quick-exit
 * window are buffered (flushed on confirm, discarded on fallback) so a broken
 * tier's error spew never reaches the caller.
 */
export function followTailSources(
  candidates: TailSource[],
  { onLine, onMeta }: FollowCallbacks,
  deps: FollowDeps = {},
): FollowHandle {
  const spawn = deps.spawn ?? spawnStreaming;
  const quickExitMs = deps.quickExitMs ?? DAEMON_QUICK_EXIT_MS;

  let stopped = false;
  let current: ReturnType<typeof spawnStreaming> | null = null;
  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((resolve) => (resolveDone = resolve));

  const tryCandidate = (index: number): void => {
    if (index >= candidates.length) {
      onMeta("── no live log stream available ──");
      resolveDone(1);
      return;
    }
    const source = candidates[index];
    const buffer: string[] = [];
    let confirmed = false;
    let quickTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      quickTimer = null;
      confirmed = true;
      onMeta(`── ${source.label} ──`);
      for (const line of buffer) onLine(line);
      buffer.length = 0;
    }, quickExitMs);

    // Detached: the tail child leads its own process group, so stop() can
    // SIGTERM the whole tree. Shell-wrapped commands (e.g. `docker logs -f
    // $(docker ps …)`) keep `sh` as the parent — killing only its pid would
    // orphan a live `docker logs -f`. The child's stdio pipes keep the event
    // loop alive; killing it stops the stream, never the service.
    current = spawn(
      source.cmd,
      source.args,
      { ...process.env },
      (line) => (confirmed ? onLine(line) : buffer.push(line)),
      (exitCode) => {
        if (quickTimer !== null) {
          clearTimeout(quickTimer);
          quickTimer = null;
        }
        if (stopped) {
          resolveDone(0);
          return;
        }
        if (!confirmed) {
          buffer.length = 0;
          tryCandidate(index + 1);
          return;
        }
        onMeta(`── log stream ended (${exitCode}) ──`);
        resolveDone(exitCode);
      },
      source.cwd,
      true,
    );
  };

  tryCandidate(0);

  return {
    done,
    stop: (): void => {
      stopped = true;
      if (!current) return;
      try {
        // Negative pid → the child's whole process group (it is detached).
        if (current.pid) process.kill(-current.pid, "SIGTERM");
        else current.kill("SIGTERM");
      } catch {
        try {
          current.kill("SIGTERM");
        } catch {
          /* already exited */
        }
      }
    },
  };
}
