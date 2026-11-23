/**
 * Issue 750: gate/750.mjs's real-Hub leg. Its five rows pass only on what
 * Hub itself shows: clause 3 on the exact reason Den sent for a held
 * member, clause 4 on Hub's groups request count staying at zero, clause
 * 5 on auto reading the group (a named skip while the test Hub's whoami
 * lists no groups.read, as Den says). A leg
 * whose harness lacks a piece skips every row by name; a product failure
 * (Connect, config, agents, Hub identity, a thrown error) fails them. The module is plain
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
    process.stdout.write(JSON.stringify(rows.slice(8)));
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
  compose: {
    want: WANT,
    got: WANT,
    status: 200,
    location: null,
    origin: "https://hub.example.test",
  },
  failed: true,
  thread: "t1",
  held: { state: "held", reason: "hub_tools_unavailable" },
  off: { state: "off", requests: 0, onRequests: 1 },
  auto: { state: "ok", why: null, found: true },
};

describe("issue 750: the real-Hub leg", () => {
  it("adds five real-Hub rows, all passing on a good leg", () => {
    const r = rows(good);
    expect(r).toHaveLength(5);
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
  it("a product failure before the read fails all five rows, never skips", () => {
    const r = rows({ fail: "connect", why: "connect start 500: boom" });
    expect(r).toHaveLength(5);
    for (const x of r) {
      expect(x.ok).toBe(false);
      expect(x.skip).toBeUndefined();
      expect(x.detail).toContain("connect start 500: boom");
    }
  });

  it("an error thrown before the read fails all five rows", () => {
    for (const x of rows({
      fixture: "allowed by test fixture",
      error: "boom",
    })) {
      expect(x.ok).toBe(false);
      expect(x.detail).toContain("boom");
    }
  });

  it("clause 4 fails when Hub saw no groups request while groups were on", () => {
    const r = rows({
      ...good,
      off: { state: "off", requests: 0, onRequests: 0 },
    });
    expect(r[3].ok).toBe(false);
    expect(r[3].detail).toContain("while on: 0");
  });

  it("clause 4 fails when turning groups off failed", () => {
    const r = rows({
      ...good,
      off: { fail: "config", why: "hub.groups=off: 1" },
    });
    expect(r[3]).toMatchObject({ ok: false });
    expect(r[3].skip).toBeUndefined();
  });

  it("clause 2 passes a redirect only when it stays on the test Hub", () => {
    const c = good.compose;
    const at = (compose: object) =>
      rows({ ...good, compose: { ...c, ...compose } })[1];
    expect(
      at({ status: 302, location: "https://elsewhere.example.test/sign-in" })
        .ok,
    ).toBe(false);
    const stay = at({
      status: 302,
      location: "https://hub.example.test/sign-in?next=x",
    });
    expect(stay.ok).toBe(true);
    expect(stay.detail).toContain("https://hub.example.test/sign-in?next=x");
    expect(at({ status: 302, location: "/sign-in" }).ok).toBe(true);
    expect(at({ status: 404 }).ok).toBe(false);
    expect(at({ status: 302, location: null }).ok).toBe(false);
  });

  it("an error thrown after the read names itself on the rows it cut short", () => {
    const r = rows({ fixture: good.fixture, read: good.read, error: "boom" });
    expect(r[0].ok).toBe(true);
    for (const x of r.slice(1)) {
      expect(x.ok).toBe(false);
      expect(x.detail).toContain("error: boom");
    }
  });

  it("clause 5: auto skips by name while the test Hub lacks groups.read", () => {
    const r = rows({
      ...good,
      auto: { state: "off", why: "hub-lacks-groups-read", found: false },
    });
    expect(r[4]).toMatchObject({ ok: null, skip: "needs-hub-groups-read" });
  });

  it("clause 5 fails when auto reads off with no reason, or misses the group", () => {
    for (const auto of [
      { state: "off", why: null, found: false },
      { state: "ok", why: null, found: false },
      { state: null, error: "hub groups: 2: usage", found: false },
      { fail: "config", why: "hub.groups=auto: 1" },
    ]) {
      const x = rows({ ...good, auto })[4];
      expect(x.ok).toBe(false);
      expect(x.skip).toBeUndefined();
    }
    // Cut short before auto: it fails, never passes.
    expect(rows({ ...good, auto: undefined })[4].ok).toBe(false);
  });
});
