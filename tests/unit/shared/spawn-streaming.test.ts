/**
 * Unit tests for spawn-streaming.ts
 *
 * Covers spawnStreaming (standard and daemon modes), spawnDaemon,
 * spawnInteractive, and getServiceLogPath.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { EventEmitter } from "events";

// Mock child_process.spawn before the module is imported
jest.mock("child_process", () => ({ spawn: jest.fn() }));
// Mock fs to avoid touching the real filesystem
jest.mock("fs", () => ({
  default: {
    mkdirSync: jest.fn(),
    openSync: jest.fn(() => 3),
    closeSync: jest.fn(),
    appendFileSync: jest.fn(),
    statSync: jest.fn(() => ({ size: 41 })),
  },
  mkdirSync: jest.fn(),
  openSync: jest.fn(() => 3),
  closeSync: jest.fn(),
  appendFileSync: jest.fn(),
  statSync: jest.fn(() => ({ size: 41 })),
}));

import { spawn } from "child_process";
import fs from "fs";
import {
  spawnStreaming,
  spawnDaemon,
  spawnInteractive,
  getServiceLogPath,
} from "../../../src/shared/process/spawn-streaming.js";

const mockFs = fs as jest.Mocked<typeof fs>;

const mockSpawn = spawn as jest.Mock;

/** Create a minimal mock ChildProcess-like EventEmitter with piped stdout/stderr. */
function makeMockProc() {
  const proc = new EventEmitter() as ReturnType<typeof spawn>;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  (proc as unknown as Record<string, unknown>).stdout = stdout;
  (proc as unknown as Record<string, unknown>).stderr = stderr;
  (proc as unknown as Record<string, unknown>).unref = jest.fn();
  return proc;
}

beforeEach(() => {
  mockSpawn.mockReset();
});

describe("getServiceLogPath", () => {
  it("returns a path under ~/.den/logs/<repo>/<subsystem>.log", () => {
    const p = getServiceLogPath("my-repo", "api");
    expect(p).toMatch(/\.den[/\\]logs[/\\]my-repo[/\\]api\.log$/);
  });
});

describe("spawnStreaming — standard mode", () => {
  it("streams stdout lines and calls onClose with exit code", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    const lines: string[] = [];
    const closes: number[] = [];
    spawnStreaming(
      "echo",
      ["hello"],
      {},
      (l) => lines.push(l),
      (c) => closes.push(c),
    );

    // Simulate stdout data
    (proc.stdout as EventEmitter).emit("data", Buffer.from("hello world\n"));
    proc.emit("close", 0);

    expect(lines).toEqual(["hello world"]);
    expect(closes).toEqual([0]);
  });

  it("streams stderr lines", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    const lines: string[] = [];
    spawnStreaming(
      "cmd",
      ["arg"],
      {},
      (l) => lines.push(l),
      () => {},
    );

    (proc.stderr as EventEmitter).emit("data", Buffer.from("error line\n"));
    expect(lines).toEqual(["error line"]);
  });

  it("calls onClose(1) on process error", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    const closes: number[] = [];
    const lines: string[] = [];
    spawnStreaming(
      "bad",
      [],
      {},
      (l) => lines.push(l),
      (c) => closes.push(c),
    );

    proc.emit("error", new Error("ENOENT"));
    expect(closes).toEqual([1]);
    expect(lines[0]).toMatch(/ENOENT/);
  });

  it("defaults null exit code to 1", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    const closes: number[] = [];
    spawnStreaming(
      "cmd",
      [],
      {},
      () => {},
      (c) => closes.push(c),
    );

    proc.emit("close", null);
    expect(closes).toEqual([1]);
  });

  it("uses shell mode when args array is empty", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    spawnStreaming(
      "make up",
      [],
      {},
      () => {},
      () => {},
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "make up",
      [],
      expect.objectContaining({ shell: true }),
    );
  });

  it("does not use shell mode when args are provided", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    spawnStreaming(
      "node",
      ["--version"],
      {},
      () => {},
      () => {},
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "node",
      ["--version"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("calls proc.unref() when detached=true without logPath", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    spawnStreaming(
      "cmd",
      [],
      {},
      () => {},
      () => {},
      undefined,
      true,
    );

    expect((proc as unknown as { unref: jest.Mock }).unref).toHaveBeenCalled();
  });

  it("strips ANSI escape codes from output", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    const lines: string[] = [];
    spawnStreaming(
      "cmd",
      [],
      {},
      (l) => lines.push(l),
      () => {},
    );

    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from("\x1b[32mgreen text\x1b[0m\n"),
    );
    expect(lines).toEqual(["green text"]);
  });

  it("handles carriage-return overwrite lines (docker log style)", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    const lines: string[] = [];
    spawnStreaming(
      "cmd",
      [],
      {},
      (l) => lines.push(l),
      () => {},
    );

    // docker logs emit lines as "text\r\n" — should not produce blank lines
    (proc.stdout as EventEmitter).emit(
      "data",
      Buffer.from("progress\r\ndone\r\n"),
    );
    expect(lines).toContain("done");
    expect(lines.every((l) => l.trim() !== "")).toBe(true);
  });
});

describe("spawnDaemon", () => {
  /** Make a mock proc for the service spawn (detached, no stdout pipe). */
  function makeDaemonSvcProc() {
    const proc = new EventEmitter() as ReturnType<typeof spawn>;
    (proc as unknown as Record<string, unknown>).unref = jest.fn();
    return proc;
  }

  it("creates log directory, writes start marker, opens/closes fd", () => {
    const svcProc = makeDaemonSvcProc();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    spawnDaemon(
      "make up",
      {},
      "/tmp/test.log",
      () => {},
      () => {},
    );

    expect(mockFs.mkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true });
    expect(mockFs.appendFileSync).toHaveBeenCalledWith(
      "/tmp/test.log",
      expect.stringContaining("den start"),
    );
    // MUST be "a" (O_APPEND). Rotation truncates this file in place while the
    // detached child still holds this fd; only O_APPEND recomputes the offset
    // to EOF, so a plain write-mode fd would leave a huge sparse hole of NULs.
    // See src/shared/process/log-rotation.ts.
    expect(mockFs.openSync).toHaveBeenCalledWith("/tmp/test.log", "a");
    expect(mockFs.closeSync).toHaveBeenCalledWith(3); // fd returned by mock
  });

  it("spawns service detached with log fd, then spawns tail", () => {
    const svcProc = makeDaemonSvcProc();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    spawnDaemon(
      "make up",
      {},
      "/tmp/test.log",
      () => {},
      () => {},
    );

    // First call: service process
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "make up",
      [],
      expect.objectContaining({
        detached: true,
        shell: true,
        stdio: ["ignore", 3, 3],
      }),
    );
    // Second call: tail process
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      "tail",
      // From this run's first byte (log size after the stamp, plus one).
      ["-F", "-c", "+42", "/tmp/test.log"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "ignore"] }),
    );
  });

  it("unrefs the service process", () => {
    const svcProc = makeDaemonSvcProc();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    spawnDaemon(
      "make up",
      {},
      "/tmp/test.log",
      () => {},
      () => {},
    );

    expect(
      (svcProc as unknown as { unref: jest.Mock }).unref,
    ).toHaveBeenCalled();
  });

  it("returns the tail process (not the service process)", () => {
    const svcProc = makeDaemonSvcProc();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    const result = spawnDaemon(
      "make up",
      {},
      "/tmp/test.log",
      () => {},
      () => {},
    );
    expect(result).toBe(tailProc);
  });

  it("streams tail stdout lines via onLine callback", () => {
    const svcProc = makeDaemonSvcProc();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    const lines: string[] = [];
    spawnDaemon(
      "make up",
      {},
      "/tmp/test.log",
      (l) => lines.push(l),
      () => {},
    );

    (tailProc.stdout as EventEmitter).emit(
      "data",
      Buffer.from("service started\n"),
    );
    expect(lines).toEqual(["service started"]);
  });

  it("calls onClose when tail process closes", () => {
    const svcProc = makeDaemonSvcProc();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    const closes: number[] = [];
    spawnDaemon(
      "make up",
      {},
      "/tmp/test.log",
      () => {},
      (c) => closes.push(c),
    );

    tailProc.emit("close");
    expect(closes).toEqual([0]);
  });

  it("calls onClose when tail process errors", () => {
    const svcProc = makeDaemonSvcProc();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    const closes: number[] = [];
    spawnDaemon(
      "make up",
      {},
      "/tmp/test.log",
      () => {},
      (c) => closes.push(c),
    );

    tailProc.emit("error", new Error("read error"));
    expect(closes).toEqual([0]);
  });

  it("calls onServiceExit when provided and service process exits", () => {
    const svcProc = makeDaemonSvcProc();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    const exits: number[] = [];
    spawnDaemon(
      "make up",
      {},
      "/tmp/test.log",
      () => {},
      () => {},
      undefined,
      (code) => exits.push(code),
    );

    svcProc.emit("exit", 0);
    expect(exits).toEqual([0]);
  });

  it("defaults null exit code to 0 for onServiceExit", () => {
    const svcProc = makeDaemonSvcProc();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    const exits: number[] = [];
    spawnDaemon(
      "make up",
      {},
      "/tmp/test.log",
      () => {},
      () => {},
      undefined,
      (code) => exits.push(code),
    );

    svcProc.emit("exit", null);
    expect(exits).toEqual([0]);
  });

  it("does not register onServiceExit handler when not provided", () => {
    const svcProc = makeDaemonSvcProc();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    spawnDaemon(
      "make up",
      {},
      "/tmp/test.log",
      () => {},
      () => {},
    );

    expect(svcProc.listenerCount("exit")).toBe(0);
  });

  it("passes cwd to the service spawn", () => {
    const svcProc = makeDaemonSvcProc();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    spawnDaemon(
      "make up",
      {},
      "/tmp/test.log",
      () => {},
      () => {},
      "/my/repo",
    );

    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "make up",
      [],
      expect.objectContaining({ cwd: "/my/repo" }),
    );
  });
});

describe("spawnStreaming — daemon mode", () => {
  it("delegates to spawnDaemon when detached=true and logPath is provided", () => {
    const svcProc = new EventEmitter() as ReturnType<typeof spawn>;
    (svcProc as unknown as Record<string, unknown>).unref = jest.fn();
    const tailProc = makeMockProc();
    mockSpawn.mockReturnValueOnce(svcProc).mockReturnValueOnce(tailProc);

    const result = spawnStreaming(
      "make up",
      [],
      {},
      () => {},
      () => {},
      "/my/repo",
      true,
      "/tmp/daemon.log",
    );

    // Should have spawned two processes (service + tail)
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(result).toBe(tailProc);
  });
});

describe("spawnInteractive", () => {
  it("calls onClose with exit code", () => {
    const proc = makeMockProc();
    (proc as unknown as Record<string, unknown>).unref = jest.fn();
    mockSpawn.mockReturnValue(proc);

    const closes: number[] = [];
    spawnInteractive("bash", {}, (c) => closes.push(c));

    proc.emit("close", 0);
    expect(closes).toEqual([0]);
  });

  it("calls onClose(1) on process error", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    const closes: number[] = [];
    spawnInteractive("missing", {}, (c) => closes.push(c));

    proc.emit("error", new Error("ENOENT"));
    expect(closes).toEqual([1]);
  });

  it("defaults null exit code to 1", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    const closes: number[] = [];
    spawnInteractive("bash", {}, (c) => closes.push(c));

    proc.emit("close", null);
    expect(closes).toEqual([1]);
  });

  it("spawns with inherited stdio", () => {
    const proc = makeMockProc();
    mockSpawn.mockReturnValue(proc);

    spawnInteractive("bash", {}, () => {});

    expect(mockSpawn).toHaveBeenCalledWith(
      "bash",
      [],
      expect.objectContaining({ stdio: "inherit" }),
    );
  });
});
