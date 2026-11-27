import { spawn as nodeSpawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import type { Readable } from "stream";
import { writeFileAtomic } from "../atomic-write.js";

export interface WatchChild {
  stdout: Readable | null;
  on(
    event: "exit",
    fn: (code: number | null, sig: string | null) => void,
  ): unknown;
  on(event: "error", fn: (err: Error) => void): unknown;
  kill(): unknown;
  unref(): unknown;
}

export type SpawnWatch = (
  cmd: string,
  args: string[],
  opts: { shell: false; stdio: ["ignore", "pipe", "ignore"] },
) => WatchChild;

const defaultSpawn: SpawnWatch = (cmd, args, opts) =>
  nodeSpawn(cmd, args, opts);

const FULL_ID = /^[0-9a-f]{64}$/;

const LOST_ACTIONS = new Set(["die", "stop", "kill", "destroy"]);

export const EDGE_EVENTS_ARGS: readonly string[] = [
  "events",
  "--format",
  "{{json .}}",
  "--filter",
  "type=container",
  "--filter",
  "type=network",
  "--filter",
  "event=die",
  "--filter",
  "event=stop",
  "--filter",
  "event=kill",
  "--filter",
  "event=destroy",
  "--filter",
  "event=disconnect",
];

export function edgeEventLost(line: string, id: string): boolean {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return false;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const e = v as {
    Type?: unknown;
    Action?: unknown;
    Actor?: { ID?: unknown; Attributes?: Record<string, unknown> };
  };
  if (e.Type === "container")
    return (
      typeof e.Action === "string" &&
      LOST_ACTIONS.has(e.Action) &&
      e.Actor?.ID === id
    );
  if (e.Type === "network")
    return e.Action === "disconnect" && e.Actor?.Attributes?.container === id;
  return false;
}

// No shell and fixed args; the full container ID is checked in every event.
export function watchEdgeContainer(
  id: string,
  on: { lost: () => void; ended: () => void },
  spawn: SpawnWatch = defaultSpawn,
  sinceMs?: number,
): () => void {
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    on.ended();
  };
  if (
    !FULL_ID.test(id) ||
    (sinceMs !== undefined && !(Number.isFinite(sinceMs) && sinceMs >= 0))
  ) {
    end();
    return () => undefined;
  }
  let child: WatchChild;
  try {
    const args = [...EDGE_EVENTS_ARGS];
    if (sinceMs !== undefined)
      args.push("--since", String(Math.floor(sinceMs / 1000)));
    child = spawn("docker", args, {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    end();
    return () => undefined;
  }
  child.on("error", end);
  child.on("exit", end);
  child.unref();
  if (child.stdout) {
    (child.stdout as Readable & { unref?: () => void }).unref?.();
    readline
      .createInterface({ input: child.stdout })
      .on("line", (l: string) => {
        if (!done && edgeEventLost(l, id)) on.lost();
      });
  } else end();
  return () => {
    if (done) return;
    done = true;
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };
}

export const edgeWatchFile = (edgeStateDir: string): string =>
  path.join(edgeStateDir, "edge-watch.json");

export function writeEdgeWatchState(
  edgeStateDir: string,
  state: "none" | "up" | "down",
  now = new Date(),
): void {
  const f = edgeWatchFile(edgeStateDir);
  if (state === "none") {
    fs.rmSync(f, { force: true });
    return;
  }
  writeFileAtomic(f, JSON.stringify({ state, at: now.toISOString() }) + "\n", {
    mode: 0o600,
  });
}

export function readEdgeWatchState(
  edgeStateDir: string,
): { state: "up" | "down"; at: string | null } | null {
  try {
    const v = JSON.parse(fs.readFileSync(edgeWatchFile(edgeStateDir), "utf8"));
    if (v?.state !== "up" && v?.state !== "down") return null;
    return { state: v.state, at: typeof v.at === "string" ? v.at : null };
  } catch {
    return null;
  }
}
