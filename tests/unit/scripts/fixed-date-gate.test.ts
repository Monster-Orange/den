import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, "scripts", "fixed-date-gate.mjs");
const FIX = path.join(ROOT, "tests", "fixtures", "fixed-date-gate");

function hits(name: string): number[] {
  const r = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(SCRIPT)}); process.stdout.write(JSON.stringify(m.fixedDateHits(process.env.SRC)));`,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        SRC: fs.readFileSync(path.join(FIX, name), "utf-8"),
      },
    },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as number[];
}

describe("fixed-date gate", () => {
  it("flags a case that plants a fixed date and passes new Date()", () => {
    expect(hits("red.txt")).toEqual([1]);
  });

  it("flags a case that plants a fixed date and reads Date.now()", () => {
    expect(hits("red-date-now.txt")).toEqual([1]);
  });

  it("passes a fixed date read against a fixed now", () => {
    expect(hits("green-fixed-now.txt")).toEqual([]);
  });

  it("passes dates placed from the real clock", () => {
    expect(hits("green-real-clock.txt")).toEqual([]);
  });

  it("passes a file that fakes the clock", () => {
    expect(hits("green-fake-timers.txt")).toEqual([]);
  });

  it("passes a case that says why it is safe", () => {
    expect(hits("green-exempt.txt")).toEqual([]);
  });

  it("an exemption with no reason does not count", () => {
    expect(hits("red-empty-exempt.txt")).toEqual([1]);
  });

  it("judges each case alone", () => {
    expect(hits("green-other-case.txt")).toEqual([]);
  });

  it("the command fails with the file and line, and passes a clean tree", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fixed-date-"));
    const t = path.join(dir, "tests");
    fs.mkdirSync(t);
    fs.copyFileSync(path.join(FIX, "red.txt"), path.join(t, "a.test.ts"));
    const red = spawnSync("node", [SCRIPT, path.relative(ROOT, t)], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(red.status).toBe(1);
    expect(red.stdout).toMatch(/a\.test\.ts:1: this case plants a fixed date/);
    fs.copyFileSync(
      path.join(FIX, "green-fixed-now.txt"),
      path.join(t, "a.test.ts"),
    );
    const green = spawnSync("node", [SCRIPT, path.relative(ROOT, t)], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(green.status).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
