/**
 * Issue 334: Settings › Embedding's app keys are held writes. A person
 * asks; only their Allow makes or revokes one; an agent can't ask. The new
 * key is in the run's result once: the decide route hands it to the
 * Allow's browser, then forgets it (forgetOnce). The list never holds a
 * key or its hash.
 *
 * The queue and the handler, in process (deciding over HTTP needs a
 * signed-in browser: approval-routes.integration). Invented names.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import {
  createApprovalQueue,
  forgetOnce,
  handleApprovalRoutes,
} from "../../../src/ui/server/approval-routes.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import {
  appKeyOps,
  handleAppKeyList,
} from "../../../src/ui/server/embed-routes.js";
import { ServerKeys } from "../../../src/ui/server/embed-server-keys.js";
import { EMBED_DEFAULTS } from "../../../src/ui/server/embed-settings.js";

const ORIGIN = "http://127.0.0.1:5173";
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-appkey-"));
const keys = () => ServerKeys.at(stateDir);
const ops = appKeyOps({
  settings: () => ({ ...EMBED_DEFAULTS, origins: [ORIGIN] }),
  stateDir: () => stateDir,
  serverKeys: keys,
});
const actions = heldActions({ appKeys: ops } as unknown as Parameters<
  typeof heldActions
>[0]);
const queue = createApprovalQueue(actions, () => stateDir);
let server: http.Server;
let base = "";

function agentRecord(id: string, ws: string): void {
  const dir = path.join(stateDir, "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      persona: id,
      runtime: "claude",
      workspace: ws,
      cwd: stateDir,
      session: { id: `s-${id}`, name: `${ws}-${id}` },
      sessionName: `${ws}-${id}`,
      startedAt: "2026-11-17T18:00:00.000Z",
    }),
  );
}

beforeAll(async () => {
  agentRecord("scout", "north");
  server = http.createServer((req, res) => {
    const id = req.headers["x-test-agent"];
    const p: Principal =
      typeof id === "string"
        ? {
            kind: "agent",
            actor: `agent:${id}`,
            workspace: "north",
            grants: [],
            session: { name: `acme-north:${id}` },
          }
        : { kind: "person-browser", session: "s1" };
    setPrincipal(req, p);
    const pathname = new URL(req.url!, "http://x").pathname;
    if (
      handleAppKeyList(req, res, pathname, {
        serverKeys: keys,
        agentCaller: () => typeof id === "string",
      })
    )
      return;
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
    agentId: "scout",
    workspace: "north",
    sessionName: "acme-north:scout",
  });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function ask(
  action: string,
  args: Record<string, unknown>,
  agent?: string,
) {
  const r = await fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(agent ? { "x-test-agent": agent } : {}),
    },
    body: JSON.stringify({ action, args }),
  });
  return {
    status: r.status,
    body: (await r.json()) as {
      id: string;
      state?: string;
      summary?: string;
      error?: string;
    },
  };
}

describe("app keys, made and revoked on the person's Allow", () => {
  it("a person's ask waits; nothing is made before Allow", async () => {
    const a = await ask("embed_key_create", {
      project: "north",
      agent: "scout",
      origin: ORIGIN,
      label: "staging app",
    });
    expect(a.status).toBe(202);
    expect(a.body.state).toBe("pending");
    expect(a.body.summary).toMatch(
      /let http:\/\/127\.0\.0\.1:5173 message scout/,
    );
    expect(keys().list()).toEqual([]);
  });

  it("an agent can't ask for one, even for itself", async () => {
    const a = await ask(
      "embed_key_create",
      { project: "north", agent: "scout", origin: ORIGIN },
      "scout",
    );
    expect(a.status).toBe(400);
    expect(a.body.error).toMatch(/Only a person/);
  });

  it("an origin not on the list, or another project's agent: refused before anything waits", async () => {
    expect(
      (
        await ask("embed_key_create", {
          project: "north",
          agent: "scout",
          origin: "https://other.example.test",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await ask("embed_key_create", {
          project: "south",
          agent: "scout",
          origin: ORIGIN,
        })
      ).status,
    ).toBe(400);
  });

  it("Allow makes it; the key is in the result once, then forgotten; the list never shows it", async () => {
    const a = await ask("embed_key_create", {
      project: "north",
      agent: "scout",
      origin: ORIGIN,
    });
    const r = await queue.decide(a.body.id, "allow", "session:s1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.approval.result as { once: { key: string } };
    const key = res.once.key;
    expect(key).toMatch(/^den_sk_/);
    expect(keys().check(key).ok).toBe(true);
    forgetOnce(r.approval);
    expect(JSON.stringify(r.approval)).not.toContain(key);
    const got = await fetch(`${base}/api/approvals/${a.body.id}`);
    expect(await got.text()).not.toContain(key);
    const list = await fetch(`${base}/api/embed/app-keys`);
    const text = await list.text();
    expect(text).not.toContain(key);
    expect(text).not.toContain("hash");
    expect(JSON.parse(text).keys[0]).toMatchObject({
      agent: "scout",
      project: "north",
      origin: ORIGIN,
    });
  });

  it("revoke: held, then the key answers key_revoked", async () => {
    const made = keys().create({
      project: "north",
      agent: "scout",
      origin: ORIGIN,
    });
    const a = await ask("embed_key_revoke", { id: made.view.id });
    expect(a.status).toBe(202);
    expect(keys().check(made.key).ok).toBe(true);
    const r = await queue.decide(a.body.id, "allow", "session:s1");
    expect(r.ok).toBe(true);
    expect(keys().check(made.key)).toEqual({
      ok: false,
      code: "key_revoked",
    });
  });

  it("an agent can't list the keys", async () => {
    const r = await fetch(`${base}/api/embed/app-keys`, {
      headers: { "x-test-agent": "scout" },
    });
    expect(r.status).toBe(403);
  });
});
