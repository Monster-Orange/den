/**
 * Issue 625 follow-up: an agent asks to add, replace or remove a test box
 * (gate_box_set, gate_box_remove); a person Allows it in the browser.
 * Nothing changes before the Allow; Allow applies it through the same
 * store call and audit verb as the person's own route; Deny changes
 * nothing; an agent can't decide its own ask; a bad box is refused at
 * ask time with checkBox's own words.
 *
 * The queue and the handler, in process (as gate-runner-held does).
 * Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import { policyFor } from "../../../src/shared/approval-policy.js";
import { checkBox } from "../../../src/shared/gates/boxes.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
} from "../../../src/ui/server/approval-routes.js";
import { gateBoxOps } from "../../../src/ui/server/gate-routes.js";
import {
  CRITICAL_HELD_ACTIONS,
  heldActions,
} from "../../../src/ui/server/held-actions.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-box-held-"));
const gateDir = path.join(stateDir, "gate");
const store = () => new GateStore({ dir: gateDir });
const audited: string[] = [];
const ops = gateBoxOps({
  store,
  audit: ((_a: unknown, action: { verb: string; detail: string }) => {
    audited.push(`${action.verb}: ${action.detail}`);
    return {};
  }) as never,
});
const actions = heldActions({
  gateBoxSet: ops.set,
  gateBoxRemove: ops.remove,
} as unknown as Parameters<typeof heldActions>[0]);
const queue = createApprovalQueue(actions, () => stateDir);
let server: http.Server;
let base = "";

beforeAll(async () => {
  fs.mkdirSync(gateDir, { recursive: true });
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

interface Asked {
  id: string;
  state?: string;
  summary?: string;
  details?: string[];
  detailKeys?: { key: string; vars?: Record<string, unknown> }[];
  error?: string;
}

async function ask(
  action: "gate_box_set" | "gate_box_remove",
  args: Record<string, unknown>,
  agent = "server",
) {
  const r = await fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-agent": agent },
    body: JSON.stringify({ action, args }),
  });
  return { status: r.status, body: (await r.json()) as Asked };
}

const FULL = {
  name: "box1",
  ssh: "runner@box1.example",
  ssh_port: 2222,
  ssh_identity: "/keys/box1",
  playwright: "ws://box1.example:3000/",
  browser_slots: 3,
  hold_file: "/tmp/den-hold",
  time_scale: 2,
  playwright_version: "1.48.0",
  min_free_mem_mb: 4096,
};

const names = () =>
  store()
    .boxes()
    .map((b) => b.name);

describe("test boxes, changed on the person's Allow", () => {
  it("an agent asks to set a box; it waits; nothing changes before Allow", async () => {
    const a = await ask("gate_box_set", { box: FULL });
    expect(a.status).toBe(202);
    expect(a.body.state).toBe("pending");
    expect(a.body.summary).toMatch(/box1/);
    expect(names()).toEqual([]);
    expect(audited).toEqual([]);
  });

  it("the Allow card shows every field that will be set", async () => {
    const a = await ask("gate_box_set", { box: FULL });
    const text = (a.body.details ?? []).join("\n");
    for (const v of [
      "runner@box1.example",
      "2222",
      "/keys/box1",
      "ws://box1.example:3000/",
      "3",
      "/tmp/den-hold",
      "1.48.0",
      "4096",
    ])
      expect(text).toContain(v);
    expect(text).toMatch(/time scale.*2/i);
    // One translated line per field, each with its value.
    const keys = (a.body.detailKeys ?? []).map((k) => k.key);
    for (const f of [
      "ssh",
      "ssh_port",
      "ssh_identity",
      "playwright",
      "slots",
      "hold_file",
      "time_scale",
      "playwright_version",
      "min_free_mem_mb",
    ])
      expect(keys).toContain(`ap.det.gate_box_set.${f}`);
    await queue.decide(a.body.id, "deny", "session:s1");
  });

  it("a bad box is refused at ask time, in checkBox's words", async () => {
    const bad = { name: "box2", ssh: "-oProxyCommand=x" };
    const c = checkBox(bad);
    expect(c.ok).toBe(false);
    const a = await ask("gate_box_set", { box: bad });
    expect(a.status).toBe(400);
    expect(a.body.error).toContain(!c.ok ? c.error : "");
    expect((await ask("gate_box_set", {})).status).toBe(400);
    expect(names()).toEqual([]);
  });

  it("Deny changes nothing", async () => {
    const a = await ask("gate_box_set", { box: { ...FULL, name: "box-no" } });
    const r = await queue.decide(a.body.id, "deny", "session:s1");
    expect(r.ok).toBe(true);
    expect(names()).not.toContain("box-no");
    expect(audited.join("\n")).not.toMatch(/box-no/);
  });

  it("an agent can't Allow its own ask", async () => {
    const a = await ask("gate_box_set", { box: { ...FULL, name: "box-self" } });
    const r = await fetch(`${base}/api/approvals/${a.body.id}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-agent": "server" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(r.status).toBe(403);
    expect(names()).not.toContain("box-self");
    await queue.decide(a.body.id, "deny", "session:s1");
  });

  it("Allow sets it, as the person's route does; the audit says who asked and who allowed", async () => {
    const a = await ask("gate_box_set", { box: FULL });
    const r = await queue.decide(a.body.id, "allow", "session:s1");
    expect(r.ok).toBe(true);
    const box = store()
      .boxes()
      .find((b) => b.name === "box1");
    expect(box).toEqual(
      checkBox(FULL).ok ? (checkBox(FULL) as never)["box"] : null,
    );
    const line = audited.find((l) => l.includes("box1 set"));
    expect(line).toMatch(/^gate-box: test box box1 set \(3 browser slots\)/);
    expect(line).toMatch(/asked by agent:server/);
    expect(line).toMatch(/allowed by session:s1/);
  });

  it("removing an unknown box is refused at ask time", async () => {
    const a = await ask("gate_box_remove", { name: "box-none" });
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/no test box box-none/);
  });

  it("remove waits; Deny keeps the box; Allow removes it, with an audit line", async () => {
    const d = await ask("gate_box_remove", { name: "box1" });
    expect(d.status).toBe(202);
    expect(names()).toContain("box1");
    await queue.decide(d.body.id, "deny", "session:s1");
    expect(names()).toContain("box1");
    const a = await ask("gate_box_remove", { name: "box1" });
    const r = await queue.decide(a.body.id, "allow", "session:s1");
    expect(r.ok).toBe(true);
    expect(names()).not.toContain("box1");
    const line = audited.find((l) => l.includes("box1 removed"));
    expect(line).toMatch(/^gate-box: test box box1 removed/);
    expect(line).toMatch(/asked by agent:server, allowed by session:s1/);
  });

  it("both always need a person: no approval policy runs them without one", () => {
    for (const w of ["gate_box_set", "gate_box_remove"]) {
      expect(CRITICAL_HELD_ACTIONS.has(w)).toBe(true);
      const loose = { policy: "auto", writes: { [w]: "auto" } } as const;
      expect(policyFor(w, { install: loose, project: loose }).kind).toBe("ask");
    }
  });
});
