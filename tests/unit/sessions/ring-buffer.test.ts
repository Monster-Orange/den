/**
 * Scrollback (AG-3a): a ring buffer per session that keeps the newest
 * bytes, and its log in the state dir, from which a host that restarted
 * rebuilds the ring.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_SCROLLBACK_BYTES,
  ScrollbackLog,
  ScrollbackRing,
} from "../../../src/shared/sessions/ring-buffer.js";

const tmps: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-ring-"));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const b = (s: string) => Buffer.from(s, "utf-8");

describe("ScrollbackRing", () => {
  it("defaults to 2 MB", () => {
    expect(DEFAULT_SCROLLBACK_BYTES).toBe(2 * 1024 * 1024);
    expect(new ScrollbackRing().capacity).toBe(DEFAULT_SCROLLBACK_BYTES);
  });

  it("keeps everything while under capacity", () => {
    const r = new ScrollbackRing(16);
    r.push(b("hello "));
    r.push(b("world"));
    expect(r.size).toBe(11);
    expect(r.snapshot().toString()).toBe("hello world");
  });

  it("truncates to the newest bytes once full, across the wrap", () => {
    const r = new ScrollbackRing(8);
    r.push(b("abcdef"));
    r.push(b("ghij"));
    expect(r.size).toBe(8);
    expect(r.snapshot().toString()).toBe("cdefghij");
    r.push(b("kl"));
    expect(r.snapshot().toString()).toBe("efghijkl");
    expect(r.dropped).toBe(4);
  });

  it("keeps only the tail of a chunk bigger than the ring", () => {
    const r = new ScrollbackRing(4);
    r.push(b("0123456789"));
    expect(r.snapshot().toString()).toBe("6789");
  });

  it("snapshot(max) returns the newest max bytes", () => {
    const r = new ScrollbackRing(8);
    r.push(b("abcdefghij"));
    expect(r.snapshot(3).toString()).toBe("hij");
    expect(r.snapshot(0).length).toBe(0);
  });
});

describe("ScrollbackLog", () => {
  it("flushes appended output to the log, and a reload rebuilds the ring", () => {
    const file = path.join(tmpDir(), "s1.log");
    const log = new ScrollbackLog(file, new ScrollbackRing(1024), {
      flushMs: 0,
    });
    log.append(b("one\n"));
    log.append(b("two\n"));
    log.flush();
    expect(fs.readFileSync(file, "utf-8")).toBe("one\ntwo\n");
    log.close();
    const ring = ScrollbackLog.load(file, 1024);
    expect(ring.snapshot().toString()).toBe("one\ntwo\n");
  });

  it("a reload keeps only the newest `capacity` bytes", () => {
    const file = path.join(tmpDir(), "s2.log");
    fs.writeFileSync(file, "0123456789");
    expect(ScrollbackLog.load(file, 4).snapshot().toString()).toBe("6789");
    expect(ScrollbackLog.load(path.join(tmpDir(), "none.log"), 4).size).toBe(0);
  });

  it("compacts the log to the ring once it passes twice the capacity", () => {
    const file = path.join(tmpDir(), "s3.log");
    const log = new ScrollbackLog(file, new ScrollbackRing(8), { flushMs: 0 });
    for (const chunk of ["aaaa", "bbbb", "cccc", "dddd", "eeee"]) {
      log.append(b(chunk));
      log.flush();
    }
    const size = fs.statSync(file).size;
    expect(size).toBeLessThanOrEqual(16);
    expect(fs.readFileSync(file, "utf-8").endsWith("ddddeeee")).toBe(true);
    log.close();
  });

  it("writes the log owner-only (0600)", () => {
    const file = path.join(tmpDir(), "s4.log");
    const log = new ScrollbackLog(file, new ScrollbackRing(8), { flushMs: 0 });
    log.append(b("x"));
    log.flush();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    log.close();
  });
});
