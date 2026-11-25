/**
 * A slow docker never blocks the server: its log routes' container lookup
 * and the log-history prune. The slow docker is child_process's: its sync
 * forms hold the thread for SLOW_MS, its async forms answer after it.
 */
import { describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const SLOW_MS = 3000;

jest.mock("child_process", () => {
  const actual =
    jest.requireActual<typeof import("child_process")>("child_process");
  const isDocker = (cmd: unknown) => String(cmd).trim().startsWith("docker");
  const hold = () => {
    const end = Date.now() + SLOW_MS;
    while (Date.now() < end) {
      /* a synchronous docker ps */
    }
  };
  return {
    ...actual,
    execSync: (cmd: string, ...rest: unknown[]) => {
      if (!isDocker(cmd)) return actual.execSync(cmd, ...(rest as []));
      hold();
      return "";
    },
    execFileSync: (cmd: string, ...rest: unknown[]) => {
      if (!isDocker(cmd)) return actual.execFileSync(cmd, ...(rest as []));
      hold();
      return "";
    },
    spawnSync: (cmd: string, ...rest: unknown[]) => {
      if (!isDocker(cmd)) return actual.spawnSync(cmd, ...(rest as []));
      hold();
      return { status: 0, stdout: "", stderr: "" };
    },
    execFile: (cmd: string, ...rest: unknown[]) => {
      if (!isDocker(cmd))
        return (actual.execFile as (...a: unknown[]) => unknown)(cmd, ...rest);
      const cb = rest.find((a) => typeof a === "function") as (
        e: Error | null,
        out: string,
      ) => void;
      setTimeout(() => cb(null, ""), SLOW_MS);
      return {};
    },
  };
});
jest.mock(
  "../../../src/shared/environment-manager/service-in-projects.js",
  () => ({
    resolveServiceInProjects: () => ({
      resolved: {
        repoName: "shop",
        subsystem: "api",
        repoPath: "/nonexistent/den-237/shop",
        mode: "dev-managed",
      },
    }),
  }),
);
jest.mock("../../../src/shared/process/spawn-streaming.js", () => ({
  getServiceLogPath: () => "/nonexistent/den-237/logs/api.log",
}));

import {
  pruneDeadSnapshots,
  resolveHistorySource,
} from "../../../src/ui/server/log-history.js";
import { getStateDir } from "../../../src/shared/paths.js";

describe("issue 237: the container lookup never blocks the server", () => {
  it("a timer due in 20 ms fires within 300 ms while a slow docker ps runs", async () => {
    const start = Date.now();
    let firedAt = -1;
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        firedAt = Date.now() - start;
        resolve();
      }, 20),
    );
    const lookup = resolveHistorySource("shop", "api", "local");
    await timer;
    expect(firedAt).toBeLessThan(300);
    const r = await lookup;
    expect(Date.now() - start).toBeGreaterThanOrEqual(SLOW_MS - 100);
    expect(r.kind).toBe("unsupported");
  });
});

describe("issue 237 follow-up: pruning snapshots at start never blocks", () => {
  it("a timer due in 20 ms fires within 300 ms while a slow docker ps -a runs; a dead container's snapshot goes", async () => {
    const dir = path.join(getStateDir(), "history");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "gone-1.log"), "old lines\n");
    const hourAgo = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(dir, "gone-1.log"), hourAgo, hourAgo);
    const start = Date.now();
    let firedAt = -1;
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        firedAt = Date.now() - start;
        resolve();
      }, 20),
    );
    const pruning = Promise.resolve(pruneDeadSnapshots());
    await timer;
    expect(firedAt).toBeLessThan(300);
    expect(await pruning).toBe(1);
    expect(Date.now() - start).toBeGreaterThanOrEqual(SLOW_MS - 100);
    expect(fs.existsSync(path.join(dir, "gone-1.log"))).toBe(false);
  });
});
