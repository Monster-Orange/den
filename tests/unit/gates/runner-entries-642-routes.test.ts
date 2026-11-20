/**
 * Issue 642, slice 1: CI runner entries on the web. A person lists, sets
 * and removes them (Settings); an agent or a runner is refused there. An
 * agent asks with the held write gate_runner_entry_set, which waits for
 * the person's Allow (always: it widens what runs on a box). In process,
 * a temp gate dir; nothing starts a runner or reaches a box. Invented
 * names.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import { policyFor } from "../../../src/shared/approval-policy.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
} from "../../../src/ui/server/approval-routes.js";
import {
  gateRunnerEntryOp,
  handleGateRoutes,
} from "../../../src/ui/server/gate-routes.js";
import {
  CRITICAL_HELD_ACTIONS,
  heldActions,
} from "../../../src/ui/server/held-actions.js";
import {
  AGENT_PERSON_WRITES,
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const ENTRY = {
  repo: "acme/alpha",
  labels: ["self-hosted", "box-a"],
  routing_variable: "CI_RUNNER",
  box: "box-a",
  slots: 1,
  heavy: true,
  owner: "the owner",
};

const tmps: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

async function serve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gaterun-"));
  tmps.push(dir);
  const store = new GateStore({ dir, alive: () => true });
  store.setBox({ name: "box-a", ssh: "ci@box-a.test" });
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
  return { store, call, audited };
}

describe("the runner entries routes (a person's, in Settings)", () => {
  it("a person sets, lists and removes an entry; the audit says so", async () => {
    const t = await serve();
    const set = await t.call(
      "POST",
      "/api/gate-slots/runner-entries",
      "person",
      { entry: ENTRY },
    );
    expect(set.status).toBe(200);
    const list = await t.call(
      "GET",
      "/api/gate-slots/runner-entries",
      "person",
    );
    expect(list.json.entries).toEqual([ENTRY]);
    expect(list.json.boxes).toEqual(["box-a"]);
    const rm = await t.call(
      "POST",
      "/api/gate-slots/runner-entries/remove",
      "person",
      { repo: "acme/alpha", box: "box-a" },
    );
    expect(rm.status).toBe(200);
    expect(t.store.runnerEntries()).toEqual([]);
    expect(t.audited.join("\n")).toMatch(
      /runner entry acme\/alpha on box-a set[\s\S]*runner entry acme\/alpha on box-a removed/,
    );
  });

  it("a bad entry, or one for a box not set, is refused with why", async () => {
    const t = await serve();
    const bad = await t.call(
      "POST",
      "/api/gate-slots/runner-entries",
      "person",
      {
        entry: { ...ENTRY, repo: "alpha" },
      },
    );
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/owner\/name/);
    const nobox = await t.call(
      "POST",
      "/api/gate-slots/runner-entries",
      "person",
      { entry: { ...ENTRY, box: "box-z" } },
    );
    expect(nobox.status).toBe(400);
    expect(nobox.json.error).toMatch(/no test box box-z/);
  });

  it("an agent can't list or change them here; signed out is told to sign in", async () => {
    const t = await serve();
    for (const [m, p] of [
      ["GET", "/api/gate-slots/runner-entries"],
      ["POST", "/api/gate-slots/runner-entries"],
      ["POST", "/api/gate-slots/runner-entries/remove"],
    ] as const) {
      const r = await t.call(
        m,
        p,
        "agent",
        m === "POST" ? { entry: ENTRY } : undefined,
      );
      expect(r.status).toBe(403);
      expect(r.json.code).toBe("person_only");
    }
    expect(
      (await t.call("GET", "/api/gate-slots/runner-entries", null)).status,
    ).toBe(401);
    expect(t.store.runnerEntries()).toEqual([]);
  });

  it("the guard keeps an agent's write off these routes", () => {
    expect(AGENT_PERSON_WRITES).toEqual(
      expect.arrayContaining([
        "/api/gate-slots/runner-entries",
        "/api/gate-slots/runner-entries/remove",
      ]),
    );
  });
});

describe("gate_runner_entry_set: an agent asks, the person Allows", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-runentry-held-"));
  const store = new GateStore({ dir: path.join(stateDir, "gate") });
  const audited: string[] = [];
  const actions = heldActions({
    gateRunnerEntry: gateRunnerEntryOp({
      store: () => store,
      audit: ((_a: unknown, action: { detail: string }) => {
        audited.push(action.detail);
        return {};
      }) as never,
    }),
  } as unknown as Parameters<typeof heldActions>[0]);
  const queue = createApprovalQueue(actions, () => stateDir);
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    store.setBox({ name: "box-a", ssh: "ci@box-a.test" });
    server = http.createServer((req, res) => {
      const id = req.headers["x-test-agent"];
      const p: Principal =
        typeof id === "string"
          ? {
              kind: "agent",
              actor: `agent:${id}`,
              workspace: "den-server",
              grants: [],
              session: { name: `den-server:${id}` },
            }
          : { kind: "person-browser", session: "s1" };
      setPrincipal(req, p);
      const pathname = new URL(req.url!, "http://x").pathname;
      const guard = {
        ok: true,
        principal: p,
        via: "loopback",
        beyond: false,
        session: null,
      } as unknown as Extract<GuardResult, { ok: true }>;
      void handleApprovalRoutes(req, res, pathname, guard, {
        queue,
        actions,
      }).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "localhost", r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    mintActorToken(stateDir, {
      agentId: "server",
      workspace: "den-server",
      sessionName: "den-server:server",
    });
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const ask = async (args: Record<string, unknown>) => {
    const r = await fetch(`${base}/api/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-agent": "server" },
      body: JSON.stringify({ action: "gate_runner_entry_set", args }),
    });
    return {
      status: r.status,
      body: (await r.json()) as {
        id: string;
        state?: string;
        summary?: string;
        details?: string[];
      },
    };
  };

  it("waits; the card says what runs where; nothing is set before Allow", async () => {
    const a = await ask(ENTRY);
    expect(a.status).toBe(202);
    expect(a.body.state).toBe("pending");
    expect(a.body.summary).toMatch(/acme\/alpha.*box-a/);
    expect(a.body.details?.join(" ")).toMatch(/CI_RUNNER/);
    expect(store.runnerEntries()).toEqual([]);
  });

  it("a bad entry or a box not set is refused before anything waits", async () => {
    expect((await ask({ ...ENTRY, repo: "x" })).status).toBe(400);
    expect((await ask({ ...ENTRY, box: "box-z" })).status).toBe(400);
  });

  it("Deny sets nothing; Allow sets it and says who allowed it", async () => {
    const d = await ask({ ...ENTRY, repo: "acme/denied" });
    await queue.decide(d.body.id, "deny", "session:s1");
    expect(store.runnerEntries().map((e) => e.repo)).not.toContain(
      "acme/denied",
    );
    const a = await ask(ENTRY);
    const r = await queue.decide(a.body.id, "allow", "session:s1");
    expect(r.ok).toBe(true);
    expect(store.runnerEntries()).toEqual([ENTRY]);
    expect(audited.join("\n")).toMatch(
      /acme\/alpha on box-a set.*agent:server/,
    );
  });

  it("is critical: no approval policy sets one without the person", () => {
    expect(CRITICAL_HELD_ACTIONS.has("gate_runner_entry_set")).toBe(true);
    const loose = {
      policy: "auto",
      writes: { gate_runner_entry_set: "auto" },
    } as const;
    expect(
      policyFor("gate_runner_entry_set", { install: loose, project: loose })
        .kind,
    ).toBe("ask");
  });
});
