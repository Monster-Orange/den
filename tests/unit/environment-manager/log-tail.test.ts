/**
 * log-tail: tail-source tiering (manifest logs.local → conventional container
 * → daemon startup log) and the quick-exit fallback chain used by
 * `den logs`.
 */
import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

import {
  tailSourceCandidates,
  followTailSources,
  type TailSource,
  type TailSourceInputs,
} from "../../../src/shared/environment-manager/log-tail.js";
import type { spawnStreaming } from "../../../src/shared/process/spawn-streaming.js";

const DAEMON_LOG = "/home/dev/.den/logs/shop/api.log";

function inputs(overrides: Partial<TailSourceInputs> = {}): TailSourceInputs {
  return {
    repoPath: "/repos/shop",
    logSource: undefined,
    container: null,
    daemonLogPath: DAEMON_LOG,
    daemonLogExists: false,
    ...overrides,
  };
}

describe("tailSourceCandidates", () => {
  it("orders sources: manifest cmd, then container, then daemon file", () => {
    const candidates = tailSourceCandidates(
      inputs({
        logSource: { type: "shell", cmd: "docker logs -f shop-api" },
        container: "opctl_shop_abc123",
        daemonLogExists: true,
      }),
    );
    expect(candidates.map((c) => c.kind)).toEqual([
      "manifest",
      "docker",
      "file",
    ]);
  });

  it("runs the manifest command from the repo, in shell mode (args empty)", () => {
    const [manifest] = tailSourceCandidates(
      inputs({ logSource: { type: "shell", cmd: "make tail-logs" } }),
    );
    expect(manifest).toMatchObject({
      kind: "manifest",
      cmd: "make tail-logs",
      args: [],
      cwd: "/repos/shop",
    });
  });

  it("ignores non-shell manifest log sources", () => {
    const candidates = tailSourceCandidates(
      inputs({ logSource: { type: "process" }, daemonLogExists: true }),
    );
    expect(candidates.map((c) => c.kind)).toEqual(["file"]);
  });

  it("builds an argv-mode docker logs command honoring the line count", () => {
    const [docker] = tailSourceCandidates(
      inputs({ container: "opctl_shop_abc123" }),
      250,
    );
    expect(docker.cmd).toBe("docker");
    expect(docker.args).toEqual([
      "logs",
      "-f",
      "--tail",
      "250",
      "opctl_shop_abc123",
    ]);
  });

  it("tails the daemon file only when it exists, in argv mode", () => {
    expect(tailSourceCandidates(inputs())).toEqual([]);
    const [file] = tailSourceCandidates(inputs({ daemonLogExists: true }));
    expect(file.cmd).toBe("tail");
    expect(file.args).toEqual(["-F", "-n", "500", DAEMON_LOG]);
  });

  it("never shell-interpolates hostile manifest-derived names (argv mode)", () => {
    const hostile = "/home/dev/.den/logs/evil/$(touch pwned).log";
    const [file] = tailSourceCandidates(
      inputs({ daemonLogPath: hostile, daemonLogExists: true }),
    );
    // The path rides as a single argv element — args non-empty means
    // spawnStreaming runs WITHOUT a shell, so $(…) is never interpreted.
    expect(file.args).toContain(hostile);
    expect(file.args.length).toBeGreaterThan(0);
  });
});

type SpawnedFake = {
  source: string;
  args: string[];
  cwd: string | undefined;
  pid?: number;
  onLine: (line: string) => void;
  onClose: (exitCode: number) => void;
  kill: jest.Mock;
};

describe("followTailSources", () => {
  const QUICK_EXIT_MS = 3_000;
  let spawned: SpawnedFake[];
  let onLine: jest.Mock;
  let onMeta: jest.Mock;

  const fakeSpawn = ((
    command: string,
    args: string[],
    _env: NodeJS.ProcessEnv,
    lineCb: (line: string) => void,
    closeCb: (exitCode: number) => void,
    cwd?: string,
  ) => {
    const proc: SpawnedFake = {
      source: command,
      args,
      cwd,
      onLine: lineCb,
      onClose: closeCb,
      kill: jest.fn(),
    };
    spawned.push(proc);
    return proc as unknown as ReturnType<typeof spawnStreaming>;
  }) as unknown as typeof spawnStreaming;

  const sources: TailSource[] = [
    {
      kind: "manifest",
      cmd: "make tail",
      args: [],
      cwd: "/repos/shop",
      label: "manifest",
    },
    {
      kind: "docker",
      cmd: "docker",
      args: ["logs", "-f", "c1"],
      label: "container c1",
    },
    {
      kind: "file",
      cmd: "tail",
      args: ["-F", "-n", "500", DAEMON_LOG],
      label: "startup log",
    },
  ];

  const follow = (candidates: TailSource[] = sources) =>
    followTailSources(
      candidates,
      {
        onLine: onLine as unknown as (line: string) => void,
        onMeta: onMeta as unknown as (line: string) => void,
      },
      { spawn: fakeSpawn, quickExitMs: QUICK_EXIT_MS },
    );

  beforeEach(() => {
    jest.useFakeTimers();
    spawned = [];
    onLine = jest.fn();
    onMeta = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("buffers early lines and flushes them once the source survives the quick-exit window", () => {
    follow();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].cwd).toBe("/repos/shop");

    spawned[0].onLine("boot line 1");
    spawned[0].onLine("boot line 2");
    expect(onLine).not.toHaveBeenCalled();

    jest.advanceTimersByTime(QUICK_EXIT_MS);
    expect(onMeta).toHaveBeenCalledWith("── manifest ──");
    expect(onLine.mock.calls.map((c) => c[0])).toEqual([
      "boot line 1",
      "boot line 2",
    ]);

    spawned[0].onLine("live line");
    expect(onLine).toHaveBeenLastCalledWith("live line");
  });

  it("falls through the tiers on quick exit, discarding buffered error spew", async () => {
    const handle = follow();

    spawned[0].onLine("Error: no such container");
    spawned[0].onClose(1); // quick exit → tier 2
    expect(spawned).toHaveLength(2);
    expect(spawned[1].source).toBe("docker");
    expect(spawned[1].args).toEqual(["logs", "-f", "c1"]);

    spawned[1].onClose(1); // quick exit → tier 3
    expect(spawned).toHaveLength(3);
    expect(spawned[2].source).toBe("tail");
    expect(spawned[2].args).toEqual(["-F", "-n", "500", DAEMON_LOG]);

    jest.advanceTimersByTime(QUICK_EXIT_MS);
    spawned[2].onLine("daemon line");
    expect(onLine.mock.calls.map((c) => c[0])).toEqual(["daemon line"]);

    spawned[2].onClose(0);
    await expect(handle.done).resolves.toBe(0);
    expect(onMeta).toHaveBeenLastCalledWith("── log stream ended (0) ──");
  });

  it("resolves 1 when every candidate quick-exits", async () => {
    const handle = follow();
    spawned[0].onClose(1);
    spawned[1].onClose(1);
    spawned[2].onClose(1);
    await expect(handle.done).resolves.toBe(1);
    expect(onMeta).toHaveBeenLastCalledWith(
      "── no live log stream available ──",
    );
    expect(onLine).not.toHaveBeenCalled();
  });

  it("resolves 1 immediately with no candidates", async () => {
    const handle = follow([]);
    await expect(handle.done).resolves.toBe(1);
    expect(spawned).toHaveLength(0);
  });

  it("propagates a non-zero exit of a confirmed stream", async () => {
    const handle = follow();
    jest.advanceTimersByTime(QUICK_EXIT_MS);
    spawned[0].onClose(2);
    await expect(handle.done).resolves.toBe(2);
    expect(onMeta).toHaveBeenLastCalledWith("── log stream ended (2) ──");
  });

  it("stop() kills the current stream and resolves 0 without falling back", async () => {
    const handle = follow();
    jest.advanceTimersByTime(QUICK_EXIT_MS);
    handle.stop();
    expect(spawned[0].kill).toHaveBeenCalledWith("SIGTERM");
    spawned[0].onClose(1); // SIGTERM'd child closes non-zero
    await expect(handle.done).resolves.toBe(0);
    expect(spawned).toHaveLength(1);
  });

  it("stop() SIGTERMs the child's whole process group when it has a pid", () => {
    const killSpy = jest
      .spyOn(process, "kill")
      .mockImplementation(() => true as never);
    try {
      const handle = follow();
      spawned[0].pid = 4242;
      handle.stop();
      expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM");
      expect(spawned[0].kill).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});
