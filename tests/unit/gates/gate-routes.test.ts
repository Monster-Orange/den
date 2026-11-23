/**
 * Issue 144 GATE-SLOT: the gate-slot routes. A person ends a slot
 * early; an agent's token (or an agent's claim) is refused. In process,
 * a temp store: no Den runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { GateStore } from "../../../src/shared/gates/store.js";
import { GATE_DEFAULTS } from "../../../src/shared/gates/rules.js";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gateroute-"));
  tmps.push(dir);
  const store = new GateStore({
    platform: "linux",
    dir,
    alive: () => true,
  });
  const audited: {
    actor: unknown;
    action: { verb: string; detail: string };
    principal?: string;
  }[] = [];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization === "Bearer agent")
      setPrincipal(req, {
        kind: "agent",
        actor: "agent:coder",
        workspace: "north",
        grants: [],
        session: "s",
      } as never);
    if (req.headers.authorization === "Bearer person")
      setPrincipal(req, { kind: "person", actor: "person:pat" });
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleGateRoutes(req, res, p, {
      store: () => store,
      title: "Acme",
      audit: ((actor, action, principal) => {
        audited.push({ actor, action, principal });
        return {} as never;
      }) as never,
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (
    method: string,
    p: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const r = await fetch(base + p, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: r.status,
      json: (await r.json()) as Record<string, unknown>,
    };
  };
  return { store, call, audited };
}

describe("gate-slot routes", () => {
  it("GET lists holders and waiters with the machine's settings", async () => {
    const { store, call } = await serve();
    const a = store.ask({
      kind: "browser",
      who: "A",
      label: "e2e",
      pid: 1,
      estimateMin: 6,
    });
    const r = await call("GET", "/api/gate-slots");
    expect(r.status).toBe(200);
    expect(r.json.settings).toEqual({
      cpuSlots: 2,
      cpuSlotsBesideBrowser: 2,
      cpuSlotsBesideReleaseBrowser: 0,
      // Issue 1009: cores × 4 / 3 on the machine the test runs on.
      cpuHoldLoad: GATE_DEFAULTS.cpuHoldLoad,
      loadHoldPerCore: 3,
      // Issue 1132: cores × 1.5 on the machine the test runs on.
      maxStartLoad: GATE_DEFAULTS.maxStartLoad,
      maxStartWaitMinutes: 10,
      reapGraceSeconds: 10,
      memoryFreeMinPercent: 10,
      swapHoldGb: 8,
      vmMemoryShare: 1,
      localBrowserSlots: 1,
      overrunMarginMinutes: 15,
      overrunBellMultiple: 2,
      priorityMax: 1,
      priorityPassLimitMinutes: 0,
      priorityAgents: true,
      priorityRunners: true,
      claimMinutes: 3,
      mcpRenewMinutes: 5,
      mcpLapseMinutes: 15,
      mcpGraceMinutes: 15,
      browserRequiresContainer: false,
      browserBoxDefault: "any",
      browserHostOnly: "",
      remoteRenewSeconds: 30,
      waiterReturnMinutes: 10,
      remoteLapseSeconds: 120,
      remoteMaxSlots: 4,
      remoteMaxAsks: 4,
      boxCheckTimeoutSeconds: 8,
      boxRecheckSeconds: 30,
    });
    expect(r.json.slots).toEqual([
      expect.objectContaining({ id: a.id, granted: true, label: "e2e" }),
    ]);
  });

  it("an agent can't end a slot early, by token or by claim", async () => {
    const { store, call, audited } = await serve();
    const a = store.ask({
      kind: "browser",
      who: "A",
      label: "e2e",
      pid: 1,
      estimateMin: 6,
    });
    const byToken = await call(
      "POST",
      "/api/gate-slots/end",
      { id: a.id },
      {
        authorization: "Bearer agent",
      },
    );
    expect(byToken).toEqual({
      status: 403,
      json: {
        ok: false,
        code: "person_only",
        error: "only a person can end a slot early",
      },
    });
    const byClaim = await call(
      "POST",
      "/api/gate-slots/end",
      { id: a.id },
      {
        "x-den-actor": "agent",
        "x-den-mcp-client": "x",
        "x-den-mcp-session": "s",
      },
    );
    expect(byClaim.status).toBe(403);
    expect(store.list()).toHaveLength(1);
    expect(audited).toEqual([]);
  });

  it("a person ends it; recorded with who; a wrong id is said", async () => {
    const { store, call, audited } = await serve();
    const a = store.ask({
      kind: "browser",
      who: "A",
      label: "e2e",
      pid: 1,
      estimateMin: 6,
    });
    expect(
      (await call("POST", "/api/gate-slots/end", { id: "nope" })).status,
    ).toBe(404);
    expect((await call("POST", "/api/gate-slots/end", {})).status).toBe(400);
    const r = await call(
      "POST",
      "/api/gate-slots/end",
      { id: a.id },
      {
        authorization: "Bearer person",
      },
    );
    expect(r).toEqual({ status: 200, json: { ok: true, slots: [] } });
    const row = store.events().at(-1)!;
    expect(row).toMatchObject({
      event: "ended-early",
      by: "Acme · person:pat",
    });
    // This install's audit says who, and points to the slot log's entry.
    expect(audited).toEqual([
      {
        actor: null,
        principal: "person:pat",
        action: {
          verb: "gate-end",
          detail: `ended gate slot ${a.id} (e2e; A) early; slot log ${store.eventsFile} at ${row.at}`,
        },
      },
    ]);
  });
});
