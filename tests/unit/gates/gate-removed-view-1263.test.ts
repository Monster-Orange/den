/**
 * Issue 1263 follow-up: the Gate queue shows the throwaway containers Den
 * removed after their run ended (the last day), beside what was stopped
 * of ended runs (issue 1132): when, how many, the run, and their images.
 *
 *  1. removedWords: how many, the run's label, and the image names.
 *  2. en, es and ja have the heading and the line, with every value.
 *  3. A removal from an earlier day shows its date too. That the queue
 *     lists them, as text, only when any: gate-chip.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  gateTime,
  removedAt,
  removedWords,
} from "../../../src/ui/server/public/gate-chip.js";
import { formatTime } from "../../../packages/den-ui/src/time.js";

const t = (k: string, v?: Record<string, unknown>) =>
  k + (v ? JSON.stringify(v) : "");

describe("issue 1263: the Gate queue shows removed containers", () => {
  it("(1) a removal in words: how many, the run, its images", () => {
    expect(
      removedWords(
        {
          at: "2026-11-23T08:00:00Z",
          id: "cpu-0a1b2c3d4e",
          label: "unit",
          count: 2,
          images: ["postgres:16", "redis:7"],
        },
        t,
      ),
    ).toBe(
      'gate.removed{"n":2,"label":"unit","images":"postgres:16, redis:7"}',
    );
    // A run with no label: its slot id; no image names: the words without.
    expect(
      removedWords({ at: "x", id: "cpu-0a1b2c3d4e", count: 1, images: [] }, t),
    ).toBe('gate.removedBare{"n":1,"label":"cpu-0a1b2c3d4e"}');
  });

  const pub = path.join(process.cwd(), "src/ui/server/public");
  const read = (f: string) => fs.readFileSync(path.join(pub, f), "utf-8");

  it("(2) en, es and ja have the heading and the lines, with every value", () => {
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const src = read(f);
      expect([f, /"gate\.removedH":\s*"\S/.test(src)]).toEqual([f, true]);
      const line = /"gate\.removed":\s*"([^"]*)"/.exec(src)?.[1] ?? "";
      for (const v of ["{n}", "{label}", "{images}"])
        expect([f, v, line.includes(v)]).toEqual([f, v, true]);
      const bare = /"gate\.removedBare":\s*"([^"]*)"/.exec(src)?.[1] ?? "";
      for (const v of ["{n}", "{label}"])
        expect([f, v, bare.includes(v)]).toEqual([f, v, true]);
    }
  });

  it("(4) a row from today shows its time; one from an earlier day, its date too", () => {
    const now = Date.parse("2026-11-23T20:00:00");
    const today = "2026-11-23T08:12:00";
    const yesterday = "2026-11-22T23:50:00";
    expect(removedAt(today, now)).toBe(gateTime(today));
    expect(removedAt(yesterday, now)).toBe(
      formatTime(yesterday, { style: "datetime" }),
    );
    expect(removedAt(yesterday, now)).not.toBe(gateTime(yesterday));
  });
});
