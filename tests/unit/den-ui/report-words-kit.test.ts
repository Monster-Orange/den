/**
 * den-ui, issue 1127: a report refused for a listed name (the server's
 * code "words", with its hits: field, line and the person's own phrase) is
 * said in the person's language, never in the server's English line: the
 * phrase quoted, with neutral words to use instead. reportRefusalText(data, lang) gives that text; the form shows it on
 * its "Not sent" step.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

/** reportRefusalText for each [data, lang], in Node (report.js uses import.meta). */
function run(cases: [Record<string, unknown>, string][]): {
  has: boolean;
  out: (string | null)[];
} {
  const js = `
    const R = await import("./packages/den-ui/src/report.js");
    const cases = ${JSON.stringify(cases)};
    const has = typeof R.reportRefusalText === "function";
    const out = has ? cases.map(([d, l]) => R.reportRefusalText(d, l)) : [];
    console.log(JSON.stringify({ has, out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

const refused = {
  ok: false,
  code: "words",
  hits: [{ field: "description", line: 2, index: 1, phrase: "Zorblax" }],
  // The server's plain line: never shown on the page.
  error: "description line 2 matches listed pattern #1; nothing was sent",
};

describe("issue 1127: the words refusal on the Report page", () => {
  it("is said in en, es and ja, with the field, line and the person's phrase", () => {
    const r = run([
      [refused, "en"],
      [refused, "es"],
      [refused, "ja"],
    ]);
    expect(r.has).toBe(true);
    const [en, es, ja] = r.out as string[];
    for (const t of [en, es, ja]) {
      expect(t).toContain("2");
      expect(t).toContain("Zorblax");
      expect(t).not.toContain("#1");
      expect(t).not.toContain("matches listed pattern");
    }
    expect(new Set([en, es, ja]).size).toBe(3);
    expect(en).toMatch(/"the person"/);
  });

  it("a list that can't be read (no hits) has its own words", () => {
    const r = run([[{ ok: false, code: "words", hits: [] }, "es"]]);
    expect(r.out[0]).toBeTruthy();
    expect(r.out[0]).not.toContain("names list");
  });

  it("any other answer is not this one's (null)", () => {
    const r = run([[{ ok: false, error: "GitHub refused it" }, "en"]]);
    expect(r.out[0]).toBeNull();
  });
});
