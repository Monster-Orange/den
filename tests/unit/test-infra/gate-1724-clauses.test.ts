import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface Row {
  clause: string;
  ok: boolean | null;
  detail?: string;
  skip?: string;
}

function run(js: string): string {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return r.stdout.trim().split("\n").pop()!;
}

function rows(result: unknown): Row[] {
  return JSON.parse(
    run(`
    const g = await import("./gate/1724.mjs");
    console.log(JSON.stringify(g.expect(${JSON.stringify(result)})));`),
  ) as Row[];
}

const ipad = { cols: 101, rows: 72 };
const desk = { cols: 178, rows: 41 };
const good = {
  claimMs: 30000,
  leaveMs: 3000,
  pane: true,
  ipad,
  firstPty: ipad,
  sizedMs: 400,
  "1001": {
    measured: true,
    took: true,
    tookMs: 80,
    desk,
    backMs: 3200,
    limit: 8000,
    pty: ipad,
  },
  normal: {
    measured: true,
    took: true,
    tookMs: 70,
    desk,
    backMs: 30300,
    limit: 35000,
    pty: ipad,
  },
  claimed: { measured: true, took: true, kept: true, desk, pty: desk },
  idle: {
    measured: true,
    took: true,
    desk,
    reattached: { pty: desk, follow: true },
    reloaded: { pty: desk, follow: true },
  },
};

describe("gate/1724 rows", () => {
  it("each case back on time, and a Take over in between kept: all four pass", () => {
    expect(rows(good).map((r) => r.ok)).toEqual([true, true, true, true, true]);
  });

  it("the size never coming back (v0.4.90: the desktop keeps it) fails that case", () => {
    const r = rows({
      ...good,
      "1001": { ...good["1001"], backMs: null, pty: desk },
      normal: { ...good.normal, backMs: null, pty: desk },
    });
    expect(r.map((x) => x.ok)).toEqual([true, true, false, false, true]);
    expect(r[2].detail).toContain("still 178x41");
  });

  it("back too late fails; the iPad taking it back over a Take over fails the last", () => {
    const r = rows({
      ...good,
      normal: { ...good.normal, backMs: 36000 },
      claimed: { ...good.claimed, kept: false, pty: ipad },
    });
    expect(r.map((x) => x.ok)).toEqual([true, true, true, false, false]);
  });

  it("the returning iPad keeping its place passes; taking the size back, or no Sized by another view, fails", () => {
    expect(rows(good)[1].ok).toBe(true);
    const took = rows({
      ...good,
      idle: { ...good.idle, reattached: { pty: ipad, follow: false } },
    })[1];
    expect(took.ok).toBe(false);
    expect(took.detail).toContain("after the iPad's socket reattached: 101x72");
    const reload = rows({
      ...good,
      idle: { ...good.idle, reloaded: { pty: ipad, follow: false } },
    })[1];
    expect(reload.ok).toBe(false);
    expect(reload.detail).toContain("after its reload: 101x72");
    const noChip = rows({
      ...good,
      idle: { ...good.idle, reloaded: { pty: desk, follow: false } },
    })[1];
    expect(noChip.ok).toBe(false);
    expect(noChip.detail).toContain("no Sized by another view");
    expect(() =>
      rows({
        ...good,
        idle: {
          measured: false,
          why: "the iPad page never reattached after its reload",
        },
      }),
    ).toThrow(/1724 not measured: the iPad page never reattached/);
  });

  it("a Take over that never sized the terminal fails its case", () => {
    const r = rows({
      ...good,
      "1001": { measured: true, took: false, pty: ipad },
    });
    expect(r[2].ok).toBe(false);
    expect(r[2].detail).toContain("never sized");
  });

  it("the iPad view not sizing first fails row 1 and skips the rest", () => {
    const r = rows({ ...good, sizedMs: null, firstPty: desk });
    expect(r.map((x) => x.ok)).toEqual([false, null, null, null, null]);
    expect(r[1].skip).toBe("needs-ipad-sized-first");
  });

  it("the terminal's size never heard (v0.4.90 on the bed: attach refused) is not measured, never a FAIL", () => {
    let said = "";
    try {
      rows({ ...good, sizedMs: null, firstPty: null });
    } catch (e) {
      said = String((e as Error).message);
    }
    expect(said).toMatch(
      /1724 not measured: the iPad pane \(101x72\) never heard the terminal's size, so no case could run/,
    );
    expect(said).not.toContain("Den refused");
    expect(() =>
      rows({
        ...good,
        sizedMs: null,
        firstPty: null,
        refused: "fixture_scope for fixture:person",
      }),
    ).toThrow(
      /Den refused its terminal attach \(fixture_scope for fixture:person\): a check's signed-in browser is the bed's fixture person/,
    );
  });

  it("anything not measured is an ERROR, never a FAIL", () => {
    expect(() => rows({ error: "the agent's terminal never ran" })).toThrow(
      /1724 not measured: the agent's/,
    );
    expect(() => rows({ ...good, pane: false })).toThrow(
      /1724 not measured: the iPad page showed no terminal pane/,
    );
    expect(() =>
      rows({
        ...good,
        normal: {
          measured: false,
          why: "the desktop page opened no terminal socket",
        },
      }),
    ).toThrow(/1724 not measured: the desktop page opened no terminal socket/);
  });

  it("says how the desktop closed, and the case names stay put", () => {
    const g = JSON.parse(
      run(
        `const g = await import("./gate/1724.mjs"); console.log(JSON.stringify({ way: g.CLOSE_WAY, n: g.clauses.length }));`,
      ),
    ) as { way: string; n: number };
    expect(g.n).toBe(5);
    expect(g.way).toContain("1001");
    expect(g.way).toContain("does not cover a dead connection with no close");
  });
});
