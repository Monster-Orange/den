/**
 * Issue 592: Den's own server agent offers Keep agents running after
 * logout (the held write keep_running, { on }) instead of the person
 * finding it in Settings. The Allow runs the code Settings › Apply runs
 * (applyKeepRunningMode); the browser that Allows asks for the admin
 * password with the existing dialog (the decide answers needs_sudo and
 * decides nothing until sudo is ready). The password is never the
 * agent's: the ask carries only { on }.
 *
 * The queue and the handler in process, a signed-in browser faked by its
 * session and approval key. Never real launchctl or sudo: the install and
 * sudo readiness are fakes.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import { approveKeyHash } from "../../../src/shared/web-session.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
} from "../../../src/ui/server/approval-routes.js";
import {
  CRITICAL_HELD_ACTIONS,
  heldActions,
} from "../../../src/ui/server/held-actions.js";
import {
  KEEP_PROPOSED_FILE,
  keepRunningHeld,
} from "../../../src/ui/server/keep-running-held.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import type { ServiceMode } from "../../../src/ui/cli/doctor-where.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-keep-held-"));
const KEY = "k".repeat(43);

/** The world the held write sees. */
const world = {
  installed: "login" as ServiceMode | null,
  setting: undefined as boolean | undefined,
  sudo: false,
  token: true as boolean | null,
  installs: [] as ServiceMode[],
  saved: [] as (boolean | null)[],
  /** How often the decide route asked whether sudo is ready (it may run sudo -n). */
  routeAsked: 0,
};

const keep = keepRunningHeld({
  platform: () => "darwin",
  installed: () => world.installed,
  sudoReady: () => world.sudo,
  current: () => world.setting,
  save: (on) => {
    world.saved.push(on);
    world.setting = on ?? undefined;
  },
  install: async (mode) => {
    world.installs.push(mode);
    return 0;
  },
  cli: "acme",
  tokenSet: async () => world.token,
  stateDir: () => stateDir,
});
const actions = heldActions({
  keepRunning: keep,
} as unknown as Parameters<typeof heldActions>[0]);
const queue = createApprovalQueue(actions, () => stateDir);
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const id = req.headers["x-test-agent"];
    const ws = req.headers["x-test-project"];
    const p: Principal =
      typeof id === "string"
        ? {
            kind: "agent",
            actor: `agent:${id}`,
            workspace: typeof ws === "string" ? ws : "den-server",
            grants: [],
            session: { name: `den-server:${id}` },
          }
        : { kind: "person-browser", session: "s1" };
    setPrincipal(req, p);
    const guard = {
      ok: true,
      principal: p,
      via: "loopback",
      beyond: false,
      session:
        typeof id === "string"
          ? null
          : { key: "s1", csrf: "c1", approveKeyHash: approveKeyHash(KEY) },
    } as unknown as Extract<GuardResult, { ok: true }>;
    void handleApprovalRoutes(
      req,
      res,
      new URL(req.url!, "http://x").pathname,
      guard,
      {
        queue,
        actions,
        sudoReady: () => {
          world.routeAsked += 1;
          return world.sudo;
        },
      },
    ).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  for (const [agent, ws] of [
    ["server", "den-server"],
    ["planner", "north"],
  ])
    mintActorToken(stateDir, {
      agentId: agent,
      workspace: ws,
      sessionName: `${ws}:${agent}`,
    });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

interface Answer {
  id: string;
  state?: string;
  summary?: string;
  details?: string[];
  detailKeys?: { key: string; vars?: Record<string, string> }[];
  link?: { href: string; key: string };
  error?: string;
  code?: string;
  needsSudo?: { command: string };
  result?: Record<string, unknown>;
}

async function ask(
  args: Record<string, unknown>,
  agent = "server",
  project = "den-server",
) {
  const r = await fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-agent": agent,
      "x-test-project": project,
    },
    body: JSON.stringify({ action: "keep_running", args }),
  });
  return { status: r.status, body: (await r.json()) as Answer };
}

async function allow(id: string) {
  const r = await fetch(`${base}/api/approvals/${id}/decide`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-den-approve-key": KEY },
    body: JSON.stringify({ decision: "allow" }),
  });
  return { status: r.status, body: (await r.json()) as Answer };
}

function reset(o: Partial<typeof world> = {}) {
  Object.assign(world, {
    installed: "login",
    setting: undefined,
    sudo: false,
    token: true,
    installs: [],
    saved: [],
    ...o,
  });
  fs.rmSync(path.join(stateDir, KEEP_PROPOSED_FILE), { force: true });
}

describe("keep_running, the server agent's offer", () => {
  it("is always the person's own Allow", () => {
    expect(CRITICAL_HELD_ACTIONS.has("keep_running")).toBe(true);
  });

  it("the tool refuses a project's agent before anything is asked", async () => {
    const calls: string[] = [];
    const api = {
      baseUrl: "http://localhost:1",
      async get(p: string) {
        calls.push(p);
        return { ok: true };
      },
      async stream() {
        throw new Error("no");
      },
    } as unknown as DenApi;
    const ctx: ToolContext = {
      api,
      cfg: {
        actions: [],
        runTestsEnvs: ["local"],
        logsRemote: false,
        approvals: true,
      },
      cli: "acme",
      approvalWait: { intervalMs: 1, waitMs: 5, sleep: async () => undefined },
      scope: { workspace: "north", actor: "agent:planner" },
    };
    const r = await callTool("keep_running", { on: true }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/scoped to project "north"/);
    expect(calls).not.toContain("/api/approvals");
  });

  it("the check refuses a project's agent too", async () => {
    reset();
    const a = await ask({ on: true }, "planner", "north");
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/Den's own agent/);
  });

  it("the check refuses the mode already installed", async () => {
    reset({ installed: "always" });
    const a = await ask({ on: true });
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/already/);
    expect(world.installs).toEqual([]);
  });

  it("the Review says what changes, the restart, the password and the token", async () => {
    reset();
    const a = await ask({ on: true });
    expect(a.status).toBe(202);
    expect(a.body.state).toBe("pending");
    const text = (a.body.details ?? []).join("\n");
    expect(text).toMatch(/login → always/);
    expect(text).toMatch(/restarts/);
    expect(text).toMatch(/come back/);
    expect(text).toMatch(/admin password/);
    expect(text).toMatch(/long-lived token/);
    const keys = (a.body.detailKeys ?? []).map((k) => k.key);
    expect(keys).toEqual([
      "ap.det.keep_running.mode",
      "ap.det.keep_running.restart",
      "ap.det.keep_running.sudo",
      "ap.det.keep_running.token",
    ]);
    expect(a.body.link).toBeUndefined();
    await queue.decide(a.body.id, "deny", "session:s1");
  });

  it("with no sign-in token it says so and links Settings › Sign-in token", async () => {
    reset({ token: false });
    const a = await ask({ on: true });
    expect(a.status).toBe(202);
    expect((a.body.details ?? []).join("\n")).toMatch(/no sign-in token/i);
    expect((a.body.detailKeys ?? []).map((k) => k.key)).toContain(
      "ap.det.keep_running.noToken",
    );
    expect(a.body.link).toEqual({
      href: "/settings#agents.keep_running",
      key: "ap.link.signinToken",
    });
    await queue.decide(a.body.id, "deny", "session:s1");
  });

  it("an agent proposes it once per install", async () => {
    reset();
    const a = await ask({ on: true });
    expect(a.status).toBe(202);
    await queue.decide(a.body.id, "deny", "session:s1");
    const again = await ask({ on: true });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/once/);
  });

  it("an agent never asks to stop agents at logout (on: false)", async () => {
    reset({ installed: "always" });
    const a = await ask({ on: false });
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/only offers to keep agents running/);
    expect(world.installs).toEqual([]);
  });

  it("never when the person turned it off", async () => {
    reset({ setting: false });
    const a = await ask({ on: true });
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/turned it off/);
  });

  it("an Allow that needs no sudo never asks whether sudo is ready (that may run sudo -n)", async () => {
    // The password is held: the action itself says it needs no sudo now.
    reset({ sudo: true });
    world.routeAsked = 0;
    const a = await ask({ on: true });
    expect(a.status).toBe(202);
    const r = await allow(a.body.id);
    expect(r.status).toBe(200);
    expect(r.body.code).toBeUndefined();
    expect(world.installs).toEqual(["always"]);
    expect(world.routeAsked).toBe(0);
  });

  it("Allow with no password held: the browser is asked for it, nothing runs", async () => {
    reset();
    const a = await ask({ on: true });
    const r = await allow(a.body.id);
    // Not a conflict: the page acts on it (asks for the password).
    expect(r.status).toBe(200);
    expect(r.body.code).toBe("needs_sudo");
    expect(r.body.needsSudo).toEqual({
      command: "acme service install --mode always",
    });
    expect(world.installs).toEqual([]);
    expect(world.saved).toEqual([]);
    // Still waiting: the person gives the password, then Allows again.
    expect(queue.get(a.body.id)?.state).toBe("pending");
    world.sudo = true;
    const ok = await allow(a.body.id);
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe("done");
    expect(world.installs).toEqual(["always"]);
    expect(world.saved).toEqual([true]);
    expect(ok.body.result).toMatchObject({
      ok: true,
      applied: true,
      mode: "always",
      restarting: true,
    });
  });

  it("a password that lapsed before the run: nothing ran, Allow again", async () => {
    reset({ sudo: false });
    const r = (await keep.run({ on: true })) as Record<string, unknown>;
    expect(world.installs).toEqual([]);
    expect(r).toMatchObject({ ok: false });
    expect(String(r.error)).toMatch(/nothing ran\. Allow again/);
  });

  it("run calls the injected install with mode always (the Settings code)", async () => {
    reset({ sudo: true });
    const r = (await keep.run({ on: true })) as Record<string, unknown>;
    expect(world.installs).toEqual(["always"]);
    expect(r).toMatchObject({ ok: true, applied: true, mode: "always" });
  });

  it("the ask never carries a password: only { on }", async () => {
    reset();
    const a = await ask({ on: true, password: "hunter2" });
    expect(a.status).toBe(202);
    expect(queue.get(a.body.id)?.args).toEqual({ on: true });
    await queue.decide(a.body.id, "deny", "session:s1");
  });
});
