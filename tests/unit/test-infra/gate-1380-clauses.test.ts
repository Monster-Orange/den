import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const RID = "Ab3_dEf-Gh1jK2lM";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function rows(result: unknown): Row[] {
  const js = `
    const g = await import("./gate/1380.mjs");
    console.log(JSON.stringify(g.expect([{ cell: { browser: "chromium", width: 1280 }, result: ${JSON.stringify(result)} }])));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as Row[];
}

const good = {
  running: { "g1380-own": 900, "g1380-other": 950 },
  mode: { mode: "strict", from: "den.yml" },
  rid: RID,
  before: "unset",
  whileHeld: "unset",
  after: "unset",
  other: {
    status: 1,
    said: `ask_withdraw: {"error":"Only the agent that asked may withdraw it.","code":"not_asker"}`,
  },
  otherStillWaiting: true,
  otherAudit: [{ actor: "agent:g1380-other", outcome: "refused" }],
  own: {
    status: 0,
    said: `Withdrawn. Your request ${RID} left your person's bell and Needs you; an Allow now runs nothing.`,
  },
  gone: true,
  state: "withdrawn",
  bell: {
    text: "g1380-own withdrew its request: sessions.close_grace_seconds: not set → 9. Withdrawn: gate check 1380 withdraws its own request",
    subject: `record:held-withdrawn-${RID}`,
  },
  late: { status: 409, code: "already_decided", error: "" },
};

describe("gate/1380 rows", () => {
  it("a Den that withdraws, refuses the other agent and runs nothing on a late Allow passes all four", () => {
    expect(rows(good).map((r) => r.ok)).toEqual([true, true, true, true]);
  });

  it("a withdraw Den refused, with the request still waiting, fails rows 1 and 2", () => {
    const r = rows({
      ...good,
      own: {
        status: 1,
        said: "ask_withdraw: no question in the bell has that id",
      },
      gone: false,
      state: "pending",
      bell: null,
    });
    expect(r.map((x) => x.ok)).toEqual([false, false, true, true]);
  });

  it("a late Allow that writes the setting fails row 3", () => {
    const r = rows({ ...good, late: { status: 200, code: null }, after: "9" });
    expect(r[2].ok).toBe(false);
  });

  it("the test operator's Allow refused before the request skips row 3 by name", () => {
    const r = rows({ ...good, late: { status: 403, code: "fixture_scope" } });
    expect([r[2].ok, r[2].skip]).toEqual([null, "needs-operator-allow"]);
  });

  it("another agent's withdraw that goes through fails row 4", () => {
    const r = rows({
      ...good,
      other: { status: 0, said: `Withdrawn. Your request ${RID} left` },
      otherStillWaiting: false,
      otherAudit: [{ actor: "agent:g1380-other", outcome: "done" }],
    });
    expect(r[3].ok).toBe(false);
  });

  it("no held request, or a personal den2, fails every row it needs", () => {
    expect(rows({ ...good, rid: null }).map((x) => x.ok)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(
      rows({ ...good, mode: { mode: "personal", from: "default" } })[0].ok,
    ).toBe(false);
  });
});
