import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const PERSON =
  "hub comment: the doc's Send to names the person @gate-person, not an agent (Hub offers the agent only to the doc's author): not posted";
const NO_BOX = "hub comment: the doc page has no Send to box: not posted";
const OTHER = "hub comment: doc page answered 500";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function rows(gate: string, result: unknown): Row[] {
  const js = `const g = await import("${gate}"); console.log(JSON.stringify(g.expect(${JSON.stringify(result)})));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as Row[];
}

const r701 = (postThrew: string) =>
  rows("./gate/701.mjs", {
    hub: true,
    asked: { agent: "g701-ask", running: true, askedMs: 999, postThrew },
    held: { agent: "g701-held", running: true, postThrew },
  });
const r629 = (postThrew: string) =>
  rows("./gate/629.mjs", {
    hub: { agent: "g629-hub", running: true, postThrew },
  })[1];

describe("gates 701 and 629: a test doc whose Send to offers no agent", () => {
  it.each([PERSON, NO_BOX])(
    "701: %s leaves every row not run, saying so",
    (m) => {
      for (const row of r701(m)) {
        expect(row).toMatchObject({
          ok: null,
          skip: "needs-fixture-comment",
        });
        expect(row.detail).toContain("offers no agent to send a comment to");
      }
    },
  );

  it.each([PERSON, NO_BOX])(
    "629: %s leaves the Hub row not run, saying so",
    (m) => {
      expect(r629(m)).toMatchObject({
        ok: null,
        skip: "needs-fixture-comment",
      });
    },
  );

  it("the skip is not the bed's needs-hub, which the bed turns into ERROR", () => {
    const skips = [...r701(PERSON), r629(PERSON)].map((x) => String(x.skip));
    expect(skips.filter((s) => /needs-hub\b/.test(s))).toEqual([]);
  });

  it("any other failure to post still FAILs both checks' rows", () => {
    expect(r701(OTHER).map((x) => x.ok)).toEqual([false, false, false]);
    expect(r629(OTHER).ok).toBe(false);
  });
});
