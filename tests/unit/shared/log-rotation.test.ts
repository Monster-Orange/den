/**
 * Service logs are written by DETACHED children holding an inherited O_APPEND
 * fd that den cannot make reopen, so rotation has to keep the inode and
 * truncate in place. These tests pin the properties every reader depends on.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  rotateIfOversized,
  rotatedPathFor,
  sweepLogs,
} from "../../../src/shared/process/log-rotation.js";

const NUL = String.fromCharCode(0);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-logrot-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeLog(name: string, contents: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, contents);
  return p;
}

describe("rotateIfOversized", () => {
  it("leaves a file under the cap untouched", () => {
    const p = writeLog("small.log", "a\n".repeat(10));
    expect(rotateIfOversized(p, 1024)).toBe(false);
    expect(fs.readFileSync(p, "utf-8")).toBe("a\n".repeat(10));
    expect(fs.existsSync(rotatedPathFor(p))).toBe(false);
  });

  it("truncates to (near) ZERO rather than retaining a tail in place", () => {
    // Truncate-head would leave the retained bytes at offset 0, which makes
    // `tail -F` notice the shrink and re-flood every viewer from the start.
    const p = writeLog("big.log", "line\n".repeat(5000));
    expect(rotateIfOversized(p, 1024, 512)).toBe(true);
    const after = fs.readFileSync(p, "utf-8");
    expect(after).toContain("den rotated");
    expect(after.length).toBeLessThan(200);
  });

  it("preserves the tail in a .log.1 generation", () => {
    const p = writeLog("keep.log", "old\n".repeat(1000) + "FINAL-LINE\n");
    rotateIfOversized(p, 1024, 4096);
    expect(fs.readFileSync(rotatedPathFor(p), "utf-8")).toContain("FINAL-LINE");
  });

  it("keeps the SAME inode so the writer's fd stays valid", () => {
    // The whole design rests on this: a rename would leave the child writing
    // into the rotated file forever while readers tail an empty one.
    const p = writeLog("inode.log", "x\n".repeat(5000));
    const before = fs.statSync(p).ino;
    rotateIfOversized(p, 1024, 512);
    expect(fs.statSync(p).ino).toBe(before);
  });

  it("an O_APPEND writer's next write lands after the truncation, not at its old offset", () => {
    const p = writeLog("append.log", "y\n".repeat(5000));
    const fd = fs.openSync(p, "a"); // same flag spawnDaemon uses
    try {
      rotateIfOversized(p, 1024, 512);
      fs.writeSync(fd, "AFTER\n");
      const after = fs.readFileSync(p, "utf-8");
      expect(after).toContain("AFTER");
      // A non-append fd would keep its old offset, leaving a large sparse hole
      // of NULs ahead of this write — that is the failure this pins.
      expect(fs.statSync(p).size).toBeLessThan(4096);
      expect(after.includes(NUL)).toBe(false);
    } finally {
      fs.closeSync(fd);
    }
  });

  it("does not start the rotated generation mid-line", () => {
    const p = writeLog("aligned.log", "AAAA\n".repeat(2000));
    rotateIfOversized(p, 1024, 500);
    expect(fs.readFileSync(rotatedPathFor(p), "utf-8").startsWith("AAAA")).toBe(
      true,
    );
  });

  it("overwrites the previous generation rather than accumulating", () => {
    const p = writeLog("gen.log", "first\n".repeat(2000));
    rotateIfOversized(p, 1024, 4096);
    fs.writeFileSync(p, "second\n".repeat(2000));
    rotateIfOversized(p, 1024, 4096);
    const rotated = fs.readFileSync(rotatedPathFor(p), "utf-8");
    expect(rotated).toContain("second");
    expect(rotated).not.toContain("first");
    expect(fs.existsSync(`${p}.2`)).toBe(false);
  });

  it("is a no-op on a missing file", () => {
    expect(rotateIfOversized(path.join(dir, "nope.log"), 10)).toBe(false);
  });
});

describe("sweepLogs", () => {
  it("rotates oversized logs across the repo tree and leaves small ones", () => {
    fs.mkdirSync(path.join(dir, "repo-a"), { recursive: true });
    fs.mkdirSync(path.join(dir, "repo-b"), { recursive: true });
    const big = path.join(dir, "repo-a", "api.log");
    const small = path.join(dir, "repo-b", "api.log");
    fs.writeFileSync(big, "z\n".repeat(5000));
    fs.writeFileSync(small, "z\n");

    expect(sweepLogs(dir, 1024)).toEqual([big]);
    expect(fs.readFileSync(small, "utf-8")).toBe("z\n");
  });

  it("never re-rotates the .log.1 generation", () => {
    fs.mkdirSync(path.join(dir, "repo"), { recursive: true });
    const rotatedGen = path.join(dir, "repo", "api.log.1");
    fs.writeFileSync(rotatedGen, "q\n".repeat(5000));

    expect(sweepLogs(dir, 1024)).toEqual([]);
    expect(fs.readFileSync(rotatedGen, "utf-8")).toContain("q");
  });

  it("returns empty when the log root does not exist", () => {
    expect(sweepLogs(path.join(dir, "missing"), 1024)).toEqual([]);
  });
});
