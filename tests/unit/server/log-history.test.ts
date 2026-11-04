import { describe, expect, it, afterAll } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  readPageBefore,
  parseManifestDockerFilter,
  parseGrepOutput,
} from "../../../src/ui/server/log-history.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-loghist-"));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeFixture(name: string, lines: string[], trailingNewline = true) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return p;
}

const NUMBERED = Array.from({ length: 1000 }, (_, i) => `line-${i + 1}`);

// ── readPageBefore ────────────────────────────────────────────────────────────

describe("readPageBefore", () => {
  it("returns the last N lines with cursor='' and pages are contiguous and non-overlapping", () => {
    const p = writeFixture("numbered.log", NUMBERED);
    const page1 = readPageBefore(p, null, 100);
    expect(page1.lines).toHaveLength(100);
    expect(page1.lines[0]).toBe("line-901");
    expect(page1.lines[99]).toBe("line-1000");
    expect(page1.atStart).toBe(false);

    const page2 = readPageBefore(p, page1.cursor, 100);
    expect(page2.lines[0]).toBe("line-801");
    expect(page2.lines[99]).toBe("line-900");
    expect(page2.atStart).toBe(false);
  });

  it("walks all the way to the first line and reports atStart", () => {
    const p = writeFixture("walk.log", NUMBERED);
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let guard = 0; guard < 50; guard++) {
      const page = readPageBefore(p, cursor, 137);
      seen.unshift(...page.lines);
      cursor = page.cursor;
      if (page.atStart) break;
    }
    expect(seen).toEqual(NUMBERED);
  });

  it("crosses block boundaries without splitting or duplicating lines", () => {
    const p = writeFixture("blocks.log", NUMBERED);
    // Tiny block size forces many backward reads per page.
    let cursor: string | null = null;
    const seen: string[] = [];
    for (let guard = 0; guard < 200; guard++) {
      const page = readPageBefore(p, cursor, 50, 64);
      seen.unshift(...page.lines);
      cursor = page.cursor;
      if (page.atStart) break;
    }
    expect(seen).toEqual(NUMBERED);
  });

  it("returns the whole file when it is smaller than the limit", () => {
    const p = writeFixture("small.log", ["a", "b", "c"]);
    const page = readPageBefore(p, null, 100);
    expect(page.lines).toEqual(["a", "b", "c"]);
    expect(page.atStart).toBe(true);
    expect(page.cursor).toBe("0");
  });

  it("handles a file without a trailing newline", () => {
    const p = writeFixture("notrail.log", ["a", "b", "c"], false);
    const page = readPageBefore(p, null, 2);
    expect(page.lines).toEqual(["b", "c"]);
    const rest = readPageBefore(p, page.cursor, 2);
    expect(rest.lines).toEqual(["a"]);
    expect(rest.atStart).toBe(true);
  });

  it("cursor 0 and empty files return an empty atStart page", () => {
    const p = writeFixture("tiny.log", ["only"]);
    expect(readPageBefore(p, "0", 10)).toEqual({
      lines: [],
      cursor: "0",
      atStart: true,
    });
    const empty = writeFixture("empty.log", [], false);
    expect(readPageBefore(empty, null, 10).atStart).toBe(true);
  });

  it("strips CRLF endings while keeping byte cursors exact (docker preserves container \\r\\n)", () => {
    const p = path.join(tmpDir, "crlf.log");
    const lines = Array.from({ length: 20 }, (_, i) => `crlf-${i + 1}`);
    fs.writeFileSync(p, lines.join("\r\n") + "\r\n");
    const page1 = readPageBefore(p, null, 12);
    expect(page1.lines).toEqual(lines.slice(8)); // no \r suffixes
    const page2 = readPageBefore(p, page1.cursor, 12);
    expect(page2.lines).toEqual(lines.slice(0, 8));
    expect(page2.atStart).toBe(true);
  });

  it("handles multi-byte UTF-8 content across pages", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `héllo-🚀-${i}`);
    const p = writeFixture("utf8.log", lines);
    const page1 = readPageBefore(p, null, 25, 32);
    const page2 = readPageBefore(p, page1.cursor, 25, 32);
    expect([...page2.lines, ...page1.lines]).toEqual(lines);
    expect(page2.atStart).toBe(true);
  });
});

// ── parseManifestDockerFilter ─────────────────────────────────────────────────

describe("parseManifestDockerFilter", () => {
  it("extracts name filters from fleet-style log commands", () => {
    expect(
      parseManifestDockerFilter(
        `sh -c 'cid="$(docker ps --filter name=shop-postgres --format "{{.ID}}" | head -1)"; exec docker logs -f "$cid"'`,
      ),
    ).toBe("name=shop-postgres");
  });

  it("extracts publish/expose filters and = style", () => {
    expect(
      parseManifestDockerFilter("docker ps --filter publish=8000 -q"),
    ).toBe("publish=8000");
    expect(parseManifestDockerFilter("docker ps --filter=expose=5432 -q")).toBe(
      "expose=5432",
    );
  });

  it("returns null when there is no docker filter", () => {
    expect(parseManifestDockerFilter("tail -F /var/log/foo.log")).toBeNull();
  });
});

// ── parseGrepOutput ───────────────────────────────────────────────────────────

describe("parseGrepOutput", () => {
  const TS = "2026-07-10T20:11:23.358440922Z";

  it("parses matches with context and strips docker timestamps", () => {
    const out = [
      `10-${TS} before`,
      `11:${TS} ERROR kaboom`,
      `12-${TS} after`,
      "--",
      `40:plain no-ts match`,
    ].join("\n");
    const { matches, truncated } = parseGrepOutput(out, 200);
    expect(truncated).toBe(false);
    expect(matches).toHaveLength(2);
    expect(matches[0].ts).toBe(TS);
    expect(matches[0].line).toBe("ERROR kaboom");
    expect(matches[0].context).toEqual(["after"]);
    expect(matches[1].ts).toBeNull();
    expect(matches[1].line).toBe("plain no-ts match");
  });

  it("parses CRLF grep output (JS `.` does not match \\r)", () => {
    const out = `11:${TS} ERROR kaboom\r\n12-${TS} after\r\n`;
    const { matches } = parseGrepOutput(out, 200);
    expect(matches).toHaveLength(1);
    expect(matches[0].line).toBe("ERROR kaboom");
    expect(matches[0].context).toEqual(["after"]);
  });

  it("bounds the number of matches and reports truncation", () => {
    const out = Array.from(
      { length: 10 },
      (_, i) => `${i + 1}:match ${i}`,
    ).join("\n");
    const { matches, truncated } = parseGrepOutput(out, 5);
    expect(matches).toHaveLength(5);
    expect(truncated).toBe(true);
  });
});
