/**
 * Issue 707: while Den's web server runs silent (as a service), its
 * warning lines also go to a file in Den's state folder, so they survive
 * a restart. Capped by a Setting (server_log.max_mb, 20 by default) and
 * rotated once: server.log, then server.log.1, never more.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  SERVER_LOG_LIMITS,
  serverLogMaxBytes,
  serverLogPath,
  serverLogWriter,
} from "../../../src/shared/server-log-file.js";
import { patchCliRows } from "../../../src/shared/settings-cli-rows.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const state = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-707-"));
  dirs.push(d);
  return d;
};
const NOW = new Date("2026-11-22T12:00:00.000Z");

describe("issue 707: the server's warning lines on disk", () => {
  it("is <state>/logs/server.log", () => {
    expect(serverLogPath("/st")).toBe(path.join("/st", "logs", "server.log"));
  });

  it("writes warn and error lines, with the time and level; info and lifecycle lines stay in memory", () => {
    const st = state();
    const write = serverLogWriter({
      stateDir: () => st,
      maxBytes: () => 1024 * 1024,
      now: () => NOW,
    });
    write("lifecycle", "Den is up");
    write("info", "a request");
    write("warn", "  hub delivery: holding 2 Hub items for planner");
    write("error", "something broke");
    expect(fs.readFileSync(serverLogPath(st), "utf8")).toBe(
      "2026-11-22T12:00:00.000Z warn   hub delivery: holding 2 Hub items for planner\n" +
        "2026-11-22T12:00:00.000Z error something broke\n",
    );
    // Only the person reads it: the folder and the file are theirs alone.
    expect(fs.statSync(serverLogPath(st)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(serverLogPath(st))).mode & 0o777).toBe(
      0o700,
    );
  });

  it("a secret that slips into a line is redacted before it reaches the disk", () => {
    const st = state();
    const write = serverLogWriter({
      stateDir: () => st,
      maxBytes: () => 1024 * 1024,
      now: () => NOW,
    });
    const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    write("warn", `hub delivery: call failed with ${token}`);
    const text = fs.readFileSync(serverLogPath(st), "utf8");
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED]");
  });

  it("rotates once at its cap: server.log.1 holds the older lines, and the next rotation replaces it", () => {
    const st = state();
    const write = serverLogWriter({
      stateDir: () => st,
      maxBytes: () => 100,
      now: () => NOW,
    });
    const line = (n: number) => `line ${n} ${"x".repeat(30)}`;
    for (let n = 1; n <= 7; n++) write("warn", line(n));
    const cur = fs.readFileSync(serverLogPath(st), "utf8");
    const old = fs.readFileSync(`${serverLogPath(st)}.1`, "utf8");
    expect(cur.length).toBeLessThanOrEqual(100);
    expect(old.length).toBeLessThanOrEqual(100);
    expect(cur).toContain(line(7));
    expect(old).not.toContain(line(1));
    expect(fs.existsSync(`${serverLogPath(st)}.2`)).toBe(false);
    expect(fs.readdirSync(path.dirname(serverLogPath(st))).sort()).toEqual([
      "server.log",
      "server.log.1",
    ]);
  });

  it("a file it can't write never stops the server", () => {
    const st = state();
    fs.writeFileSync(path.join(st, "logs"), "not a folder");
    const write = serverLogWriter({
      stateDir: () => st,
      maxBytes: () => 100,
    });
    expect(() => write("warn", "a line")).not.toThrow();
  });
});

describe("issue 707: server_log.max_mb is a Setting with a permissive default", () => {
  it("20 MB unless set; out of range or not a number: the default", () => {
    const MB = 1024 * 1024;
    expect(SERVER_LOG_LIMITS.max_mb).toEqual({ def: 20, min: 1, max: 1024 });
    expect(serverLogMaxBytes({})).toBe(20 * MB);
    expect(serverLogMaxBytes({ server_log: { max_mb: 50 } })).toBe(50 * MB);
    expect(serverLogMaxBytes({ server_log: { max_mb: 0 } })).toBe(20 * MB);
    expect(serverLogMaxBytes({ server_log: { max_mb: "big" } })).toBe(20 * MB);
    expect(serverLogMaxBytes(null)).toBe(20 * MB);
  });

  it("Settings and config write it to user.yml server_log.max_mb, checked", () => {
    const user: Record<string, unknown> = {};
    expect(patchCliRows(user, { server_log: { max_mb: 50 } })).toEqual({
      ok: true,
    });
    expect(user.server_log).toEqual({ max_mb: 50 });
    expect(patchCliRows(user, { server_log: { max_mb: 0 } }).ok).toBe(false);
    expect(patchCliRows(user, { server_log: { max_mb: 2000 } }).ok).toBe(false);
    expect(patchCliRows(user, { server_log: { other: 1 } }).ok).toBe(false);
    expect(patchCliRows(user, { server_log: { max_mb: null } })).toEqual({
      ok: true,
    });
    expect(user.server_log).toBeUndefined();
  });
});
