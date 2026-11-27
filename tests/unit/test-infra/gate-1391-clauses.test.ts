import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

interface Row {
  clause: string;
  ok: boolean | null;
  detail?: string;
}

const personal = (o: Record<string, unknown> = {}) => ({
  before: undefined,
  written: true,
  after: "7",
  bell: {
    text: "g1391-agent did this without your Allow: sessions.close_grace_seconds: not set → 7",
    undo: true,
    heldWaiting: 0,
  },
  notOperatorUndo: { status: 403, ok: false },
  afterNotOperator: "7",
  fixtureUndo: { status: 200, ok: true },
  afterUndo: undefined,
  ...o,
});
const strict = (o: Record<string, unknown> = {}) => ({
  mode: { mode: "strict", from: "den.yml" },
  held: {
    id: "6daZSLjMyN8953b-",
    what: "sessions.close_grace_seconds: not set → 7",
  },
  before: undefined,
  whileHeld: undefined,
  notOperatorAllow: { status: 403 },
  afterNotOperator: undefined,
  fixtureAllow: { status: 200 },
  after: "7",
  ...o,
});

function rows(result: unknown): Row[] {
  const js = `const g = await import("./gate/1391.mjs"); console.log(JSON.stringify(g.expect([{ cell: {}, result: ${JSON.stringify(result)} }])));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as Row[];
}

describe("gate/1391.mjs: the test operator's Allow and Undo (issue 1414)", () => {
  it("the operator's Undo puts the setting back and its Allow writes the held one, after a non-operator's 403: both rows pass", () => {
    const r = rows({ personal: personal(), strict: strict() });
    expect([r[2].ok, r[3].ok]).toEqual([true, true]);
  });

  it("a session that isn't the test operator gets through: both rows fail", () => {
    const r = rows({
      personal: personal({
        notOperatorUndo: { status: 200, ok: true },
        afterNotOperator: undefined,
      }),
      strict: strict({
        notOperatorAllow: { status: 200 },
        afterNotOperator: "7",
      }),
    });
    expect([r[2].ok, r[3].ok]).toEqual([false, false]);
  });

  it("the operator's Undo is refused or leaves the setting changed: the Undo row fails", () => {
    expect(
      rows({
        personal: personal({
          fixtureUndo: { status: 403, ok: false },
          afterUndo: "7",
        }),
        strict: strict(),
      })[2].ok,
    ).toBe(false);
    expect(
      rows({ personal: personal({ afterUndo: "7" }), strict: strict() })[2].ok,
    ).toBe(false);
  });

  it("the operator's Allow is refused, or writes nothing: the held row fails", () => {
    expect(
      rows({
        personal: personal(),
        strict: strict({ fixtureAllow: { status: 403 }, after: undefined }),
      })[3].ok,
    ).toBe(false);
    expect(
      rows({ personal: personal(), strict: strict({ after: undefined }) })[3]
        .ok,
    ).toBe(false);
  });

  it("the clauses say who may Allow and Undo", () => {
    const r = rows({ personal: personal(), strict: strict() });
    expect(r[2].clause).toMatch(
      /the test operator's Undo puts the setting back/,
    );
    expect(r[3].clause).toMatch(/the test operator's Allow writes it/);
  });
});
