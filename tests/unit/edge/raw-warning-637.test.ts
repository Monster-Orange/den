import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readAccessLogConfig } from "../../../src/shared/edge/access-log.js";
import {
  accessPaths,
  edgeAccessHealthy,
  edgeAccessWarnings,
  prepareAccessRaw,
  rawAccessWarning,
  sweepAccessLog,
} from "../../../src/shared/edge/access-sweep.js";

const on = readAccessLogConfig(true);
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-637-"));
  prepareAccessRaw(dir);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const line = (i: number) =>
  JSON.stringify({
    StartUTC: "2026-11-22T12:00:00Z",
    RequestMethod: "GET",
    RequestHost: "app.example.localhost",
    RequestPath: `/p${i}?code=${"x".repeat(200)}`,
    DownstreamStatus: 200,
    Duration: 1000,
    RouterName: "app@file",
  }) + "\n";
function arrive(kb: number): void {
  let s = "";
  for (let i = 0; s.length < kb * 1024; i++) s += line(i);
  fs.appendFileSync(accessPaths(dir).raw, s);
}
function sweptAt(): number {
  return fs.statSync(path.join(accessPaths(dir).dir, "swept")).mtimeMs;
}

describe("issue 637: a busy edge with Den sweeping", () => {
  it("20 KB between sweeps: no raw-log warning", () => {
    sweepAccessLog(dir, on);
    arrive(20);
    expect(rawAccessWarning(dir, sweptAt() + 1_000)).toBeNull();
    expect(
      edgeAccessWarnings({ args: [], stateDir: dir }, sweptAt() + 1_000),
    ).toEqual([]);
  });

  it("each sweep leaves its heartbeat, even with nothing to mask", () => {
    sweepAccessLog(dir, on);
    const first = sweptAt();
    fs.utimesSync(
      path.join(accessPaths(dir).dir, "swept"),
      new Date(first - 5_000),
      new Date(first - 5_000),
    );
    sweepAccessLog(dir, on);
    expect(sweptAt()).toBeGreaterThan(first - 5_000);
  });
});

describe("issue 637: Den's server stopped, lines arriving", () => {
  it("past the stale limit: nothing is masking them, with the last sweep's age", () => {
    sweepAccessLog(dir, on);
    arrive(1);
    expect(rawAccessWarning(dir, sweptAt() + 5_000)).toBeNull();
    const w = rawAccessWarning(dir, sweptAt() + 11_000);
    expect(w).toMatch(/nothing is masking/);
    expect(w).toMatch(/last swept 11 s ago/);
  });

  it("never swept (no heartbeat): nothing is masking them", () => {
    arrive(1);
    expect(rawAccessWarning(dir)).toMatch(/nothing is masking/);
  });
});

describe("issue 637: the size limit is a Setting", () => {
  it("edge.access_log.raw_warn_kb: 1024 by default; a whole number in range", () => {
    expect(readAccessLogConfig(true).rawWarnKb).toBe(1024);
    expect(readAccessLogConfig({ raw_warn_kb: 64 }).rawWarnKb).toBe(64);
    expect(() => readAccessLogConfig({ raw_warn_kb: 0 })).toThrow(
      /raw_warn_kb/,
    );
    expect(() => readAccessLogConfig({ raw_warn_kb: "big" })).toThrow(
      /raw_warn_kb/,
    );
  });

  it("past it, while sweeping: says the file is large, not that nothing masks it", () => {
    sweepAccessLog(dir, on);
    arrive(20);
    const w = rawAccessWarning(dir, sweptAt() + 1_000, 16);
    expect(w).toMatch(/edge\.access_log\.raw_warn_kb/);
    expect(w).not.toMatch(/nothing is masking/);
    expect(
      edgeAccessWarnings(
        { args: [], stateDir: dir, accessLog: { rawWarnKb: 16 } },
        sweptAt() + 1_000,
      ),
    ).toHaveLength(1);
  });
});

describe("issue 637: doctor says when Den last swept", () => {
  it("the healthy line gives the last sweep's age", () => {
    sweepAccessLog(dir, on);
    const cfg = { args: [], stateDir: dir, accessLog: { enabled: true } };
    expect(edgeAccessHealthy(cfg, sweptAt() + 2_000)).toMatch(
      /Den is sweeping it \(last sweep 2 s ago\)/,
    );
  });
});

describe("issue 637: the sweep runs but isn't emptying the file", () => {
  it("fresh heartbeat, a part line last written 11 s ago: warns", () => {
    sweepAccessLog(dir, on);
    const raw = accessPaths(dir).raw;
    fs.appendFileSync(raw, line(1).trimEnd());
    sweepAccessLog(dir, on);
    const now = sweptAt() + 1_000;
    fs.utimesSync(raw, new Date(now - 11_000), new Date(now - 11_000));
    const w = rawAccessWarning(dir, now);
    expect(w).toMatch(/the sweep runs but isn't emptying it/);
    expect(w).toMatch(/last written 11 s ago/);
    fs.utimesSync(raw, new Date(now - 500), new Date(now - 500));
    expect(rawAccessWarning(dir, now)).toBeNull();
  });
});
