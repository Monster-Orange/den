/**
 * Issue 750: gate/750.mjs's real-Hub leg. Its four rows pass only on what
 * Hub itself shows: clause 3 on the exact reason Den sent for a held
 * member, clause 4 on Hub's groups request count staying at zero. A leg
 * that couldn't run skips every row by name. The module is plain
 * JavaScript, so it runs in a child node, as the bed runs it. Invented
 * names only.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";

interface Row {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
}

function rows(hubLeg: unknown): Row[] {
  const js = `
    const g = await import("./gate/750.mjs");
    const rows = g.expect([{ cell: {}, result: { tag: "chromium-1280", real: "off", hubLeg: ${JSON.stringify(hubLeg)} } }]);
    process.stdout.write(JSON.stringify(rows.slice(-4)));
  `;
  const r = spawnSync("node", ["--input-type=module", "-e", js], {
    cwd: process.cwd(),
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as Row[];
}

const WANT = "https://hub.example.test/gate-750-x/groups/g750-check?compose=1";
const good = {
  fixture: "allowed by test fixture",
  read: {
    state: "ok",
    found: true,
    leadHere: true,
    heldHere: true,
    compose: WANT,
  },
  compose: { want: WANT, got: WANT, status: 200 },
  failed: true,
  thread: "t1",
  held: { state: "held", reason: "hub_tools_unavailable" },
  off: { state: "off", requests: 0 },
};

describe("issue 750: the real-Hub leg", () => {
  it("adds four real-Hub rows, all passing on a good leg", () => {
    const r = rows(good);
    expect(r).toHaveLength(4);
    for (const x of r) {
      expect(x.clause).toMatch(/^real Hub: /);
      expect(x.ok).toBe(true);
    }
    expect(r[0].detail).toContain("allowed by test fixture");
  });

  it("a leg that didn't run skips every row with its reason", () => {
    const r = rows({
      skip: "needs-hub-group-fixture",
      why: "no group / groupSend / groupThread on test Hub A",
    });
    for (const x of r) {
      expect(x.ok).toBeNull();
      expect(x.skip).toBe("needs-hub-group-fixture");
      expect(x.detail).toContain("groupSend");
    }
  });

  it("no leg at all skips by name, never passes", () => {
    for (const x of rows(null)) expect(x.skip).toBe("needs-hub-leg");
  });

  it("clause 3 fails on any reason but the one Den sent", () => {
    const r = rows({ ...good, held: { state: "held", reason: "busy" } });
    expect(r[2].ok).toBe(false);
    expect(r[2].detail).toContain('"busy"');
    expect(
      rows({
        ...good,
        held: { state: "queued", reason: "hub_tools_unavailable" },
      })[2].ok,
    ).toBe(false);
  });

  it("clause 3 fails when the member's tools never showed as failed", () => {
    expect(rows({ ...good, failed: false })[2].ok).toBe(false);
  });

  it("clause 4 fails when Hub saw a groups request", () => {
    const r = rows({ ...good, off: { state: "off", requests: 1 } });
    expect(r[3].ok).toBe(false);
    expect(r[3].detail).toContain("1");
  });

  it("clause 4 skips by name while Hub can't count requests", () => {
    const r = rows({
      ...good,
      off: {
        skip: "needs-hub-request-count",
        why: "no requests() on test Hub A",
      },
    });
    expect(r[3]).toMatchObject({ ok: null, skip: "needs-hub-request-count" });
  });

  it("clause 1 fails when the lead isn't marked here; clause 2 on a wrong composer", () => {
    const r = rows({
      ...good,
      read: { ...good.read, leadHere: false },
      compose: { want: WANT, got: `${WANT}x`, status: 200 },
    });
    expect(r[0]).toMatchObject({
      ok: false,
      clause: expect.stringMatching(/^real Hub: By group/),
    });
    expect(r[1]).toMatchObject({
      ok: false,
      clause: expect.stringMatching(/^real Hub: Message group/),
    });
  });
});
