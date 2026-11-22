/**
 * Issue 625: the test boxes on the web. A person lists, sets and removes
 * them (Settings); an agent is refused. A CI runner on a box asks for that
 * box's slot (`where`), and the box is checked before it is given. The
 * queue view shows each slot's box and each box's state. In process, a
 * temp store and a fake box check: nothing reaches a real box.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { BoxProbe } from "../../../src/shared/gates/boxes.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { handleGateRoutes } from "../../../src/ui/server/gate-routes.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";

const tmps: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

async function serve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gatebox-"));
  tmps.push(dir);
  const answers: Record<string, "open" | "held" | "unreachable"> = {};
  const calls: string[] = [];
  const probe: BoxProbe = (b) => {
    calls.push(b.name);
    return Promise.resolve({
      state: answers[b.name] ?? "open",
      ...(answers[b.name] === "held"
        ? { reason: "its hold file is there" }
        : {}),
    });
  };
  const store = new GateStore({ dir, alive: () => true, probe });
  const audited: string[] = [];
  const server = http.createServer((req, res) => {
    const a = req.headers.authorization;
    if (a === "Bearer agent")
      setPrincipal(req, {
        kind: "agent",
        actor: "agent:coder",
        workspace: "north",
        grants: [],
        session: "s",
      } as never);
    if (a === "Bearer person")
      setPrincipal(req, { kind: "person", actor: "person:pat" } as never);
    if (a === "Bearer runner")
      setPrincipal(req, {
        kind: "gate-runner",
        id: "t1",
        name: "box-ci",
      } as never);
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleGateRoutes(req, res, p, {
      store: () => store,
      title: "Acme",
      pollMs: 10,
      audit: ((_a: unknown, action: { detail: string }) => {
        audited.push(action.detail);
        return {};
      }) as never,
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (
    method: string,
    p: string,
    who: string | null,
    body?: unknown,
  ) => {
    const r = await fetch(base + p, {
      method,
      headers: {
        "content-type": "application/json",
        ...(who ? { authorization: `Bearer ${who}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: r.status,
      json: (await r.json()) as Record<string, unknown>,
    };
  };
  return { store, call, answers, calls, audited };
}

const B1 = { name: "b1", ssh: "ci@b1.test", browser_slots: 1, hold_file: "h" };

describe("the test boxes routes", () => {
  it("a person sets, lists and removes a box; the audit says so", async () => {
    const t = await serve();
    const set = await t.call("POST", "/api/gate-slots/boxes", "person", {
      box: B1,
    });
    expect(set.status).toBe(200);
    const list = await t.call("GET", "/api/gate-slots/boxes", "person");
    expect(list.json.boxes).toEqual([B1]);
    const rm = await t.call("POST", "/api/gate-slots/boxes/remove", "person", {
      name: "b1",
    });
    expect(rm.status).toBe(200);
    expect(t.store.boxes()).toEqual([]);
    expect(t.audited.join("\n")).toMatch(
      /test box b1 set[\s\S]*test box b1 removed/,
    );
  });

  it("an agent or a runner can't list, set or remove boxes", async () => {
    const t = await serve();
    for (const who of ["agent", "runner"]) {
      expect(
        (await t.call("POST", "/api/gate-slots/boxes", who, { box: B1 }))
          .status,
      ).toBe(403);
      expect((await t.call("GET", "/api/gate-slots/boxes", who)).status).toBe(
        403,
      );
    }
    expect(t.store.boxes()).toEqual([]);
  });

  it("a person turns a box off and on; the audit says so; an agent can't", async () => {
    const t = await serve();
    t.store.setBox(B1);
    const off = await t.call("POST", "/api/gate-slots/boxes/enable", "person", {
      name: "b1",
      enabled: false,
    });
    expect(off.status).toBe(200);
    expect(t.store.boxes()[0]!.enabled).toBe(false);
    expect(
      (
        await t.call("POST", "/api/gate-slots/boxes/enable", "agent", {
          name: "b1",
          enabled: true,
        })
      ).status,
    ).toBe(403);
    expect(t.store.boxes()[0]!.enabled).toBe(false);
    const on = await t.call("POST", "/api/gate-slots/boxes/enable", "person", {
      name: "b1",
      enabled: true,
    });
    expect(on.status).toBe(200);
    expect(t.store.boxes()).toEqual([B1]);
    expect(
      (
        await t.call("POST", "/api/gate-slots/boxes/enable", "person", {
          name: "nope",
          enabled: true,
        })
      ).status,
    ).toBe(404);
    expect(t.audited.join("\n")).toMatch(
      /test box b1 turned off[\s\S]*test box b1 turned on/,
    );
  });

  it("a runner asking for a box that is turned off waits; the box is never checked", async () => {
    const t = await serve();
    t.store.setBox({ ...B1, enabled: false });
    const r = await t.call("POST", "/api/gate-slots/ask", "runner", {
      kind: "browser",
      estimate_minutes: 5,
      where: "b1",
      wait_seconds: 0,
    });
    expect(r.json).toMatchObject({ granted: false });
    expect(t.calls).toEqual([]);
    const v = await t.call("GET", "/api/gate-slots", null);
    expect(v.json.boxes).toEqual([
      expect.objectContaining({ name: "b1", state: "off" }),
    ]);
  });

  it("a malformed box is refused, saying why", async () => {
    const t = await serve();
    const r = await t.call("POST", "/api/gate-slots/boxes", "person", {
      box: { name: "b1", ssh: "-oProxyCommand=x" },
    });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/ssh/);
  });

  it("a runner on a box asks for that box's slot; it is checked, then given; the queue shows the box", async () => {
    const t = await serve();
    t.store.setBox(B1);
    const r = await t.call("POST", "/api/gate-slots/ask", "runner", {
      kind: "browser",
      estimate_minutes: 5,
      where: "b1",
      wait_seconds: 2,
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ granted: true, box: "b1" });
    expect(t.calls).toEqual(["b1"]);
    const v = await t.call("GET", "/api/gate-slots", null);
    expect((v.json.slots as { box?: string }[])[0]!.box).toBe("b1");
    expect(v.json.boxes).toEqual([
      expect.objectContaining({ name: "b1", slots: 1, held: 1 }),
    ]);
  });

  it("a held box gives no slot to its runner, and says why in the queue", async () => {
    const t = await serve();
    t.store.setBox(B1);
    t.answers.b1 = "held";
    const r = await t.call("POST", "/api/gate-slots/ask", "runner", {
      kind: "browser",
      estimate_minutes: 5,
      where: "b1",
      wait_seconds: 0,
    });
    expect(r.json).toMatchObject({ granted: false });
    const v = await t.call("GET", "/api/gate-slots", null);
    expect(v.json.boxes).toEqual([
      expect.objectContaining({
        name: "b1",
        state: "held",
        reason: "its hold file is there",
      }),
    ]);
  });

  it("a runner naming a box that isn't set is refused", async () => {
    const t = await serve();
    const r = await t.call("POST", "/api/gate-slots/ask", "runner", {
      kind: "browser",
      estimate_minutes: 5,
      where: "nope",
    });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/where/);
  });
});
