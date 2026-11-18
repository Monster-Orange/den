/**
 * A live check's "en/es/ja" clause runs: it switches the bed's language
 * (POST /api/settings { language }), reads each one, and puts back the
 * language it found, even when a read throws or a switch is refused. It
 * never skips as "needs-language-switch": a bed can always switch.
 *
 * Runs gate/367.mjs and gate/393.mjs against a fake bed
 * (tests/fixtures/gate-lang/fake-bed.mjs): no Den, no browser.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const BED = path.join(ROOT, "tests", "fixtures", "gate-lang", "fake-bed.mjs");

type Row = { clause: string; ok: boolean | null; skip?: string };
type Out = {
  rows: Row[] | null;
  error: string | null;
  posts: (string | null)[];
  final: string;
};

function onBed(gate: string, scenario: Record<string, string>): Out {
  const r = spawnSync(
    process.execPath,
    [BED, path.join(ROOT, "gate", gate), JSON.stringify(scenario)],
    { cwd: ROOT, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout);
}
const langRow = (o: Out) => o.rows?.find((x) => x.clause === "en/es/ja");

describe("live checks: the en/es/ja clause", () => {
  it("no check in gate/ skips as needs-language-switch", () => {
    const skipping = fs
      .readdirSync(path.join(ROOT, "gate"))
      .filter((f) => f.endsWith(".mjs"))
      .filter((f) =>
        fs
          .readFileSync(path.join(ROOT, "gate", f), "utf-8")
          .includes("needs-language-switch"),
      );
    expect(skipping).toEqual([]);
  });

  for (const gate of ["367.mjs", "393.mjs"]) {
    describe(gate, () => {
      it("passes in en, es and ja, and puts the bed's language back", () => {
        const o = onBed(gate, { start: "es" });
        expect(o.error).toBeNull();
        expect(langRow(o)).toMatchObject({ ok: true });
        expect(langRow(o)?.skip).toBeUndefined();
        expect(o.posts).toContain("ja");
        expect(o.posts[o.posts.length - 1]).toBe("es");
        expect(o.final).toBe("es");
      });

      it("puts the language back when a read throws", () => {
        const o = onBed(gate, { start: "ja", throwIn: "es" });
        expect(o.error).toMatch(/page read failed in es/);
        expect(o.posts).toContain("es");
        expect(o.final).toBe("ja");
      });

      it("says so when a switch is refused, and puts the language back", () => {
        const o = onBed(gate, { start: "en", refuse: "es" });
        expect(o.error).toMatch(/the language switch to es was refused/);
        expect(o.final).toBe("en");
      });
    });
  }

  it("367 fails when the push rows stay English in es", () => {
    const o = onBed("367.mjs", { start: "en", englishIn: "es" });
    expect(langRow(o)).toMatchObject({ ok: false });
  });

  it("393 fails when a row in ja tells the person to run a command", () => {
    const o = onBed("393.mjs", { start: "en", choresIn: "ja" });
    expect(langRow(o)).toMatchObject({ ok: false });
  });
});
