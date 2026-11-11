/**
 * D34: what a "Clear done" mark hides. Done, failed and stopped helpers
 * that ended at or before it; running and idle ones never; one that ends
 * after it shows. Invented ids only.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Helper } from "../../../src/shared/agents/helpers.js";
import {
  endedAt,
  readClearedAt,
  splitCleared,
  writeClearedAt,
} from "../../../src/shared/agents/helpers-cleared.js";

const h = (id: string, status: Helper["status"], last: number): Helper => ({
  id,
  depth: 1,
  status,
  statusFrom: "test",
  startedAt: last - 10,
  lastActivityAt: last,
});

describe("splitCleared", () => {
  const MARK = 1_000;
  it("hides the ended ones from before the mark, keeps running and idle", () => {
    const list = [
      h("run", "running", 500),
      h("idle", "idle", 500),
      h("done", "done", 900),
      h("failed", "failed", 1_000),
      h("stopped", "stopped", 10),
      h("later", "done", 1_001),
    ];
    const { shown, cleared } = splitCleared(list, MARK);
    expect(shown.map((x) => x.id)).toEqual(["run", "idle", "later"]);
    expect(cleared.map((x) => x.id)).toEqual(["done", "failed", "stopped"]);
  });

  it("no mark: nothing hidden", () => {
    const list = [h("done", "done", 1)];
    expect(splitCleared(list, undefined)).toEqual({ shown: list, cleared: [] });
  });

  it("when one ended: its last activity, else start + duration, else start", () => {
    expect(endedAt({ ...h("a", "done", 50) })).toBe(50);
    expect(
      endedAt({
        id: "b",
        depth: 1,
        status: "done",
        statusFrom: "t",
        startedAt: 5,
        durationMs: 7,
      }),
    ).toBe(12);
  });
});

describe("the mark on disk", () => {
  it("round-trips, owner-only; a missing or bad file is no mark", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-cleared-"));
    try {
      expect(readClearedAt(dir)).toBeUndefined();
      writeClearedAt(dir, 1234);
      expect(readClearedAt(dir)).toBe(1234);
      const f = path.join(dir, "helpers-cleared.json");
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      fs.writeFileSync(f, '{"clearedAt":"soon"}');
      expect(readClearedAt(dir)).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
