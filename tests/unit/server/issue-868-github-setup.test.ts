/**
 * Issue 868 (ruling 11-21): the sign-in page's fix for an install with no
 * GitHub sign-in client is an ask in the page, not "edit a file on the
 * host and restart". POST /api/signin/github-setup (from the signed-out
 * page) holds github_signin_setup; only a person signed in to THIS Den,
 * in a browser holding this Den's approval key, allows it. A session of
 * another Den on the same host is a separate trust domain: refused. The
 * Allow sets the client id to Den's own app and restarts.
 *
 * The queue, the ask route and the approval routes in process; the
 * config write and the restart are fakes. Invented names.
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
  GITHUB_SETUP_PATH,
  githubSetupHeld,
  handleGithubSetupAsk,
} from "../../../src/ui/server/github-setup-held.js";
import {
  CRITICAL_HELD_ACTIONS,
  heldActions,
} from "../../../src/ui/server/held-actions.js";
import { SIGNIN_FREE, ROUTES } from "../../../src/ui/server/route-classes.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { sendJson } from "../../../src/ui/server/http-helpers.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-ghsetup-"));
const KEY = "a".repeat(43);
const OTHER_KEY = "b".repeat(43);

const world = {
  state: "no_client_id" as "ready" | "claim" | "no_client_id" | "no_owner",
  enabled: 0,
  restarts: [] as string[],
};
const held = githubSetupHeld({
  state: () => world.state,
  setting: "web.github_client_id",
  file: "config/local/user.yml",
  enable: () => {
    world.enabled++;
  },
  restart: async (reason) => {
    world.restarts.push(reason);
    return { ok: true, restarting: true };
  },
});
const actions = heldActions({
  githubSetup: held,
} as unknown as Parameters<typeof heldActions>[0]);
const queue = createApprovalQueue(actions, () => stateDir);
let server: http.Server;
let base = "";
/** The route's clock, ahead of the queue's by `skew`, and its cooldown. */
let skew = 0;
let cooldownMinutes = 10;

type Who = "anon" | "person" | "other-den" | "agent";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const who = String(req.headers["x-test-who"] ?? "anon") as Who;
    const p: Principal | null =
      who === "agent"
        ? {
            kind: "agent",
            actor: "agent:server",
            workspace: "den-server",
            grants: [],
            session: { name: "den-server:server" },
          }
        : who === "person"
          ? { kind: "person-browser", session: "s1" }
          : null;
    if (p) setPrincipal(req, p);
    // A person signed in to this Den: its session and approval key. A
    // browser signed in to another Den on this host brings a cookie this
    // Den never issued: no session here.
    const guard = {
      ok: true,
      principal: p,
      via: "loopback",
      beyond: false,
      session:
        who === "person"
          ? { key: "s1", csrf: "c1", approveKeyHash: approveKeyHash(KEY) }
          : null,
    } as unknown as Extract<GuardResult, { ok: true }>;
    const pathname = new URL(req.url!, "http://x").pathname;
    void (async () => {
      if (
        await handleGithubSetupAsk(req, res, pathname, {
          queue,
          action: actions.github_signin_setup,
          sendJson,
          cooldownMs: () => cooldownMinutes * 60_000,
          askerAddress: () => "192.0.2.7",
          now: () => Date.now() + skew,
        })
      )
        return;
      if (
        await handleApprovalRoutes(req, res, pathname, guard, {
          queue,
          actions,
        })
      )
        return;
      res.writeHead(404);
      res.end();
    })();
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

async function askFromPage() {
  const r = await fetch(`${base}${GITHUB_SETUP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return {
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
  };
}
const waiting = () =>
  queue.pending().filter((a) => a.action === "github_signin_setup");
async function decide(
  id: string,
  who: Who,
  key?: string,
  decision: "allow" | "deny" = "allow",
) {
  const r = await fetch(`${base}/api/approvals/${id}/decide`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-test-who": who,
      ...(key ? { "x-den-approve-key": key } : {}),
    },
    body: JSON.stringify({ decision }),
  });
  return {
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
  };
}

describe("issue 868: ask to turn on Sign in with GitHub from the sign-in page", () => {
  it("the route is sign-in free and classified", () => {
    expect(SIGNIN_FREE).toContain(GITHUB_SETUP_PATH);
    expect(
      ROUTES.some(
        (r) => r.path === GITHUB_SETUP_PATH && r.methods.includes("POST"),
      ),
    ).toBe(true);
  });

  it("is always a person's own Allow", () => {
    expect(CRITICAL_HELD_ACTIONS.has("github_signin_setup")).toBe(true);
  });

  it("the signed-out page's ask holds one request, said to come from the sign-in page; nothing changes yet", async () => {
    const a = await askFromPage();
    expect([a.status, a.body.ok, a.body.state]).toEqual([202, true, "pending"]);
    // The asker gets nothing to read or decide with.
    expect(a.body.id).toBeUndefined();
    expect(a.body.ticket).toBeUndefined();
    const w = waiting();
    expect(w).toHaveLength(1);
    expect(w[0].via).toBe("signin-page");
    expect(w[0].agent).toBeUndefined();
    expect((w[0].detailKeys ?? []).map((k) => k?.key)).toEqual([
      "ap.det.github_signin_setup.set",
      "ap.det.github_signin_setup.restart",
      "ap.det.github_signin_setup.then",
    ]);
    expect([world.enabled, world.restarts.length]).toEqual([0, 0]);
  });

  it("asking again while one waits answers the same: never a second", async () => {
    const a = await askFromPage();
    expect([a.status, a.body.again]).toEqual([202, true]);
    expect(waiting()).toHaveLength(1);
  });

  it("nobody signed in to this Den can allow it: not the page, not an agent, not another Den's browser", async () => {
    const id = waiting()[0].id;
    for (const [who, key] of [
      ["anon", undefined],
      ["agent", undefined],
      // Signed in to another Den on the same host: a cookie this Den
      // never issued, with that Den's approval key.
      ["other-den", OTHER_KEY],
      // This Den's session, but not its approval key.
      ["person", OTHER_KEY],
    ] as const) {
      const r = await decide(id, who, key);
      expect([who, r.status]).toEqual([who, 403]);
    }
    expect(waiting()).toHaveLength(1);
    expect([world.enabled, world.restarts.length]).toEqual([0, 0]);
  });

  it("a person signed in to this Den allows it: the client id is set, then Den restarts", async () => {
    const id = waiting()[0].id;
    const r = await decide(id, "person", KEY);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("done");
    expect(r.body.result).toMatchObject({ ok: true, restarting: true });
    expect(world.enabled).toBe(1);
    expect(world.restarts).toHaveLength(1);
  });

  it("with a client id set, the page's ask is refused and nothing is held", async () => {
    world.state = "ready";
    const a = await askFromPage();
    expect([a.status, a.body.code]).toEqual([409, "not_offered"]);
    expect(waiting()).toHaveLength(0);
    world.state = "no_client_id";
  });

  it("only a POST", async () => {
    const r = await fetch(`${base}${GITHUB_SETUP_PATH}`);
    expect(r.status).toBe(405);
  });
});

describe("issue 868: after a Deny, the page can't ask again until the cooldown passes", () => {
  it("Deny, ask again: refused as asked recently, nothing held; after web.signin_ask_cooldown_minutes, an ask is held again", async () => {
    world.state = "no_client_id";
    skew = 0;
    const a = await askFromPage();
    expect(a.status).toBe(202);
    const id = waiting()[0].id;
    const d = await decide(id, "person", KEY, "deny");
    expect([d.status, d.body.state]).toEqual([200, "denied"]);

    const again = await askFromPage();
    expect([again.status, again.body.code]).toEqual([429, "asked_recently"]);
    expect(String(again.body.error)).toMatch(/asked recently/);
    expect(waiting()).toHaveLength(0);

    // Just short of the cooldown: still refused.
    skew = cooldownMinutes * 60_000 - 5_000;
    expect((await askFromPage()).status).toBe(429);
    expect(waiting()).toHaveLength(0);

    // Past it: held again.
    skew = cooldownMinutes * 60_000 + 1_000;
    const later = await askFromPage();
    expect(later.status).toBe(202);
    expect(waiting()).toHaveLength(1);
    await decide(waiting()[0].id, "person", KEY, "deny");
    skew = 0;
  });

  it("a cooldown of 0: the page may ask again at once after a Deny", async () => {
    cooldownMinutes = 0;
    const a = await askFromPage();
    expect(a.status).toBe(202);
    await decide(waiting()[0].id, "person", KEY, "deny");
    expect((await askFromPage()).status).toBe(202);
    expect(waiting()).toHaveLength(1);
    await decide(waiting()[0].id, "person", KEY, "deny");
    cooldownMinutes = 10;
  });
});

describe("issue 868: the person can tell whose browser asked", () => {
  it("the held request names the asker's network address", async () => {
    cooldownMinutes = 0;
    expect((await askFromPage()).status).toBe(202);
    const a = waiting()[0];
    expect(a.details?.join("\n")).toMatch(/Asked from 192\.0\.2\.7/);
    expect(a.detailKeys).toContainEqual({
      key: "ap.det.github_signin_setup.from",
      vars: { address: "192.0.2.7" },
    });
    await decide(a.id, "person", KEY, "deny");
    cooldownMinutes = 10;
  });
});
