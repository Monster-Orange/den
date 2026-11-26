/**
 * Issue 1264 (Reviewer A): the gate's routing settings widen what an
 * agent may do. Turning gate.route_agents off, or dropping a program from
 * gate.route_commands, lets an agent's heavy run skip the gate: through
 * gate_settings_set that needs the person's own Allow, on a personal
 * install too, whatever the Limits choice. Turning routing on, or adding a
 * program, stays a plain limit. Checked with setting-change.ts's real
 * settingKind, then through the approval queue to an Allow. A temp gates
 * folder; invented names only.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
import {
  policyFor,
  readPolicySetting,
} from "../../../src/shared/approval-policy.js";
import type { InstallMode } from "../../../src/shared/den-config.js";
import {
  checkGateSettingsSet,
  runGateSettingsSet,
  type GateSettingsSetDeps,
} from "../../../src/shared/gates/settings-set.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { settingKind } from "../../../src/ui/cli/setting-change.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
} from "../../../src/ui/server/approval-routes.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const ALL = "jest, vitest, tsc, playwright, npm test, npm run test*";

function deps(
  store: GateStore,
  mode: InstallMode,
  limits: "auto" | "ask" = "auto",
): GateSettingsSetDeps {
  return {
    settings: (patch) => store.settings(patch),
    write: async (patch, by) => store.writeSettings(patch, by),
    installMode: () => mode,
    kind: (key, value, before) => settingKind(key, mode, value, before),
    choices: () => readPolicySetting({ settings: { limits } })?.settings,
  };
}

describe("issue 1264: settingKind judges the routing settings by value", () => {
  for (const mode of ["personal", "strict"] as const) {
    it(`${mode}: route_agents off widens; on is a plain limit`, () => {
      expect(settingKind("gate.route_agents", mode, 0, 1).widens).toBe(true);
      expect(settingKind("gate.route_agents", mode, 0).widens).toBe(true);
      expect(settingKind("gate.route_agents", mode, 1, 0).widens).toBe(false);
    });

    it(`${mode}: route_commands widens when a program in effect now is dropped`, () => {
      const k = (to: string, from?: string) =>
        (from === undefined
          ? settingKind("gate.route_commands", mode, to)
          : settingKind("gate.route_commands", mode, to, from)
        ).widens;
      expect(k("eslint", "jest")).toBe(true);
      expect(k("jest", ALL)).toBe(true);
      expect(k(`${ALL}, eslint`, ALL)).toBe(false);
      expect(k(ALL, "jest")).toBe(false);
      // Same programs, other spacing or order: nothing dropped.
      expect(k("tsc,jest", "jest, tsc")).toBe(false);
      // No old value known: judged against the default list.
      expect(k("jest")).toBe(true);
      expect(k(`${ALL}, eslint`)).toBe(false);
    });
  }
});

describe("issue 1264: gate_settings_set's real check", () => {
  let dir = "";
  let store: GateStore;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-1264w-")));
    store = new GateStore({ dir, lockWaitMs: 1_000 });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("personal, Limits on auto: route_agents 0 needs the person (personOnly)", () => {
    const c = checkGateSettingsSet(deps(store, "personal"), {
      settings: { route_agents: 0 },
      reason: "my runs wait too long",
    });
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.personOnly).toBe(true);
  });

  it("personal: route_commands down to one program needs the person, and the card shows both lists", () => {
    const c = checkGateSettingsSet(deps(store, "personal"), {
      settings: { route_commands: "jest" },
      reason: "only jest is heavy here",
    });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBe(true);
    expect(c.details).toContain(`gate.route_commands: ${ALL} → jest`);
  });

  it("personal: adding a program is routine", () => {
    const c = checkGateSettingsSet(deps(store, "personal"), {
      settings: { route_commands: `${ALL}, eslint` },
      reason: "eslint is heavy here",
    });
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.personOnly).toBeUndefined();
  });

  it("run by the policy at once, it's refused; the person's Allow writes it", async () => {
    const d = deps(store, "personal");
    const args = { settings: { route_agents: 0 }, reason: "my runs wait" };
    const auto = await runGateSettingsSet(d, args, {
      decidedBy: "auto:approvals policy: auto",
    });
    expect(auto.ok).toBe(false);
    expect(store.settings().routeAgents).toBe(true);
    const person = await runGateSettingsSet(d, args, { decidedBy: "person" });
    expect(person.ok).toBe(true);
    expect(store.settings().routeAgents).toBe(false);
  });

  it("the gate's settings log records a route_commands change", () => {
    store.writeSettings({ route_commands: "jest" }, "a person");
    const rows = store.settingsChanges();
    expect(rows.at(-1)?.changes.route_commands).toEqual({
      from: ALL,
      to: "jest",
    });
  });
});

describe("issue 1264: through the approval queue, a personal install on auto", () => {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-1264q-")),
  );
  const store = new GateStore({ dir: path.join(stateDir, "gate") });
  const d = deps(store, "personal");
  const actions = heldActions({
    gateSettings: {
      check: (a: Record<string, unknown>) => checkGateSettingsSet(d, a),
      run: (
        a: Record<string, unknown>,
        asked?: { agent?: string; decidedBy?: string },
      ) => runGateSettingsSet(d, a, asked),
    },
  } as unknown as Parameters<typeof heldActions>[0]);
  const queue = createApprovalQueue(actions, () => stateDir);
  const install = readPolicySetting({ settings: { limits: "auto" } });
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const agent = req.headers["x-test-agent"] === "server";
      const p: Principal = agent
        ? {
            kind: "agent",
            actor: "agent:server",
            workspace: "den-server",
            grants: [],
            session: { name: "den-server:server" },
          }
        : { kind: "person-browser", session: "s1" };
      setPrincipal(req, p);
      const guard = {
        ok: true,
        principal: p,
        via: "loopback",
        beyond: false,
        session: null,
      } as unknown as Extract<GuardResult, { ok: true }>;
      const pathname = new URL(req.url!, "http://x").pathname;
      void handleApprovalRoutes(req, res, pathname, guard, {
        queue,
        actions,
        installMode: () => "personal",
        policy: (action, _project, widens, ask) =>
          policyFor(action, {
            widens,
            mode: "personal",
            ...(ask?.category ? { setting: { category: ask.category } } : {}),
            install,
          }),
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

  const ask = async (settings: Record<string, unknown>) => {
    const r = await fetch(`${base}/api/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-agent": "server" },
      body: JSON.stringify({
        action: "gate_settings_set",
        args: { settings, reason: "an agent's ask" },
      }),
    });
    return {
      status: r.status,
      body: (await r.json()) as { id: string; state?: string },
    };
  };

  it("a plain limit runs at once (the policy is live in this queue)", async () => {
    const a = await ask({ cpu_slots: 3 });
    expect(a.body.state).not.toBe("pending");
    expect(store.settings().cpuSlots).toBe(3);
  });

  it("route_agents 0 waits; nothing is written before the person's Allow", async () => {
    const a = await ask({ route_agents: 0 });
    expect(a.status).toBe(202);
    expect(a.body.state).toBe("pending");
    expect(store.settings().routeAgents).toBe(true);
    const r = await queue.decide(a.body.id, "allow", "session:s1");
    expect(r.ok).toBe(true);
    expect(store.settings().routeAgents).toBe(false);
  });

  it("dropping a program waits too", async () => {
    const a = await ask({ route_commands: "jest" });
    expect(a.body.state).toBe("pending");
    expect(store.settings().routeCommands).toContain("tsc");
  });
});
