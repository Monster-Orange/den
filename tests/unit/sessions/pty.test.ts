/**
 * The PTY module is optional (Q-AG-1): loadPty says why it is unavailable
 * instead of throwing, and wraps the module it finds behind PtyFactory
 * (binary data in and out, the signal sent to the session's process group).
 */
import { describe, expect, it } from "@jest/globals";
import { loadPty, PTY_MODULE } from "../../../src/shared/sessions/pty.js";

function notFound(id: string): never {
  const e = new Error(`Cannot find module '${id}'`) as NodeJS.ErrnoException;
  e.code = "MODULE_NOT_FOUND";
  throw e;
}

describe("loadPty", () => {
  it("names the module and how to get it when it is not installed", () => {
    const r = loadPty((id) => notFound(id));
    expect(r.available).toBe(false);
    if (r.available) return;
    expect(r.reason).toMatch(new RegExp(`${PTY_MODULE} is not installed`));
    expect(r.reason).toMatch(/optional dependency/);
    expect(r.reason).toMatch(/--omit=optional/);
  });

  it("gives the module's own first line when it is there but cannot load", () => {
    const r = loadPty(() => {
      throw new Error(
        "The @lydell/node-pty package supports your platform, but it could not find the binary\n\nmore help",
      );
    });
    expect(r).toEqual({
      available: false,
      reason:
        "The @lydell/node-pty package supports your platform, but it could not find the binary",
    });
  });

  it("refuses a module without spawn", () => {
    const r = loadPty(() => ({}));
    expect(r.available).toBe(false);
  });

  it("wraps spawn: binary encoding, data as Buffers, signals to the group", () => {
    const calls: unknown[][] = [];
    let dataFn: (d: unknown) => void = () => undefined;
    let exitFn: (e: unknown) => void = () => undefined;
    const written: unknown[] = [];
    const fake = {
      spawn: (...args: unknown[]) => {
        calls.push(args);
        return {
          pid: 4242,
          onData: (fn: (d: unknown) => void) => (dataFn = fn),
          onExit: (fn: (e: unknown) => void) => (exitFn = fn),
          write: (d: unknown) => written.push(d),
          resize: () => undefined,
          kill: () => undefined,
        };
      },
    };
    const r = loadPty(() => fake);
    expect(r.available).toBe(true);
    if (!r.available) return;
    const p = r.factory("sh", ["-c", "true"], {
      cwd: "/tmp",
      env: { PATH: "/bin" },
      cols: 100,
      rows: 30,
    });
    expect(calls[0]).toEqual([
      "sh",
      ["-c", "true"],
      expect.objectContaining({
        cwd: "/tmp",
        env: { PATH: "/bin" },
        cols: 100,
        rows: 30,
        encoding: null,
        name: "xterm-256color",
      }),
    ]);
    expect(p.pid).toBe(4242);
    const got: Buffer[] = [];
    p.onData((d) => got.push(d));
    dataFn("text");
    dataFn(Buffer.from("bytes"));
    expect(got.map((b) => Buffer.isBuffer(b) && b.toString())).toEqual([
      "text",
      "bytes",
    ]);
    let exit: unknown;
    p.onExit((e) => (exit = e));
    exitFn({ exitCode: 0, signal: 15 });
    expect(exit).toEqual({ exitCode: 0, signal: 15 });
    p.write(Buffer.from("x"));
    expect(Buffer.isBuffer(written[0])).toBe(true);
  });
});
