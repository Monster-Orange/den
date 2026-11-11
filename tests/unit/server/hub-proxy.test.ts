/**
 * D52: an agent reaches Hub through Den. Den's proxy (/hub/<path>) takes
 * only an agent's own Den token, passes only Hub's agent paths, swaps the
 * agent's credential for the install's Hub token, sets who calls from
 * Den's own records, never follows a redirect, and streams bodies both
 * ways with Hub's status and errors as they are.
 *
 * A fake Hub records what reaches it; Den's side is the real proxy in
 * front of a real agent (a scripted PTY), with its real actor token.
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as http from "http";
import type { AddressInfo } from "net";
import { verifyActorToken } from "../../../src/shared/actor-token.js";
import { readRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { cmdHub } from "../../../src/ui/cli/hub-command.js";
import {
  hubUpstream,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import {
  HUB_PROXY_PATHS,
  handleHubProxy,
  hubProxyAllowed,
  hubProxyPath,
} from "../../../src/ui/server/hub-proxy-routes.js";
import {
  agentRefusal,
  setPrincipal,
} from "../../../src/ui/server/request-guard.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";
import { cleanupRigs, rig, settle, type Rig } from "../agents/helpers/rig.js";

const TOKEN = "hubi_TESTONLY_d52_install_token";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((res) => s.close(() => res()));
  }
  await cleanupRigs();
});

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  bytes: number;
  sha: string;
}

type HubAnswer = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
) => void;

/** A fake Hub: records each request (and its body's size and sha256). */
async function fakeHub(answer?: HubAnswer) {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        bytes: body.length,
        sha: createHash("sha256").update(body).digest("hex"),
      });
      if (answer) return answer(req, res, body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ team: "acme", waiting: 2, yours: 1 }));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    seen,
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
  };
}

/** Den: an agent started, and the proxy in front of Hub (`hubUrl`). */
async function den(
  hubUrl: string | null,
  more: { mcpUrl?: string } = {},
): Promise<{
  r: Rig;
  agentToken: string;
  base: string;
  sessionId: string;
  agentId: string;
}> {
  const r = await rig({
    hub: async () => (hubUrl ? { url: hubUrl, token: TOKEN, ...more } : null),
    workspaceRepos: (ws) => (ws === "north" ? ["acme/north", "acme/kit"] : []),
  });
  // The agent starts with Hub there, so it has a Hub server at all.
  const real = r.deps.hub!;
  r.deps.hub = async () => ({ url: "http://hub.invalid", token: TOKEN });
  expect(
    await cmdAgents(
      ["start", "-w", "north", "--persona", "planner", "--name", "Ada"],
      r.deps,
    ),
  ).toBe(0);
  r.deps.hub = real;
  await settle();
  const agentToken = r.made[0].opts.env!.DEN_ACTOR_TOKEN!;
  const agentId = verifyActorToken(r.stateDir, agentToken)!.actor.slice(
    "agent:".length,
  );
  const d = resolveAgentsDeps(r.deps);
  const s = http.createServer((req, res) => {
    const bearer = /^Bearer (den_at_\S+)$/.exec(
      String(req.headers.authorization ?? ""),
    );
    const t = bearer ? verifyActorToken(r.stateDir, bearer[1]) : null;
    if (t)
      setPrincipal(req, {
        kind: "agent",
        actor: t.actor,
        workspace: t.workspace,
        grants: t.grants,
        session: t.session,
      });
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleHubProxy(req, res, p, {
      upstream: (who) => hubUpstream(d, who),
    }).then((handled) => {
      if (!handled) {
        res.writeHead(418);
        res.end("not the proxy's");
      }
    });
  });
  servers.push(s);
  await new Promise<void>((res) => s.listen(0, "127.0.0.1", res));
  return {
    r,
    agentToken,
    base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
    sessionId: readRecord(r.stateDir, agentId)!.session.id,
    agentId,
  };
}

const lower = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

describe("D52: who reaches Hub through Den", () => {
  it("an agent's own Den token: Hub sees the install token and who calls, from Den's records", async () => {
    const hub = await fakeHub();
    const { base, agentToken, sessionId, agentId } = await den(hub.url);
    const res = await fetch(`${base}/hub/api/inbox?since=1`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ team: "acme", waiting: 2, yours: 1 });
    expect(hub.seen).toHaveLength(1);
    const h = hub.seen[0];
    expect(h.url).toBe("/api/inbox?since=1");
    expect(h.headers).toMatchObject(
      lower({
        Authorization: `Bearer ${TOKEN}`,
        "X-Den-Agent": "Ada",
        "X-Den-Agent-Id": agentId,
        "X-Den-Workspace": "north",
        "X-Den-Session": sessionId,
        "X-Den-Repos": "acme/north,acme/kit",
      }),
    );
    // The agent's own token never reaches Hub.
    expect(JSON.stringify(h.headers)).not.toContain(agentToken);
  });

  it("what the agent claims is dropped: its X-Den-* and any other header", async () => {
    const hub = await fakeHub();
    const { base, agentToken, agentId } = await den(hub.url);
    await fetch(`${base}/hub/api/inbox`, {
      headers: {
        authorization: `Bearer ${agentToken}`,
        "x-den-agent-id": "someone-else",
        "x-den-workspace": "south",
        "x-den-session": "forged",
        "x-den-repos": "evil/repo",
        "x-den-agent": "Mallory",
        cookie: "den_session=abc",
        "x-forwarded-for": "10.0.0.9",
      },
    });
    const h = hub.seen[0].headers;
    expect(h["x-den-agent-id"]).toBe(agentId);
    expect(h["x-den-workspace"]).toBe("north");
    expect(h["x-den-agent"]).toBe("Ada");
    expect(h["x-den-repos"]).toBe("acme/north,acme/kit");
    expect(h["x-den-session"]).not.toBe("forged");
    expect(h.cookie).toBeUndefined();
    expect(h["x-forwarded-for"]).toBeUndefined();
  });

  it("no agent token: 403, and Hub hears nothing (a person, a browser, a bad token)", async () => {
    const hub = await fakeHub();
    const { base } = await den(hub.url);
    for (const auth of [undefined, `Bearer ${TOKEN}`, "Bearer den_at_nope"]) {
      const res = await fetch(`${base}/hub/api/inbox`, {
        headers: auth ? { authorization: auth } : {},
      });
      expect([auth, res.status]).toEqual([auth, 403]);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/for agents, with their own Den token/);
    }
    expect(hub.seen).toEqual([]);
  });

  it("an ended agent's token stops working", async () => {
    const hub = await fakeHub();
    const { r, base, agentToken, agentId } = await den(hub.url);
    expect(await cmdAgents(["stop", agentId], r.deps)).toBe(0);
    r.made[0].exit(143);
    await settle();
    const res = await fetch(`${base}/hub/api/inbox`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(403);
    expect(hub.seen).toEqual([]);
  });
});

describe("D52: which paths", () => {
  it("Hub's agent paths pass; anything else is 404 from Den, and Hub hears nothing", async () => {
    const hub = await fakeHub();
    const { base, agentToken } = await den(hub.url);
    const auth = { authorization: `Bearer ${agentToken}` };
    for (const p of [
      "/hub/api/inbox",
      "/hub/api/notifications",
      "/hub/api/notifications/3/read",
      "/hub/api/import/packs",
      "/hub/api/import/packs/p1/dry-run",
      "/hub/api/reports/imports",
      "/hub/api/admin/fixtures/demo/dry-run",
    ]) {
      const res = await fetch(`${base}${p}`, { headers: auth });
      expect([p, res.status]).toEqual([p, 200]);
    }
    expect(hub.seen.map((s) => s.url)).toEqual([
      "/api/inbox",
      "/api/notifications",
      "/api/notifications/3/read",
      "/api/import/packs",
      "/api/import/packs/p1/dry-run",
      "/api/reports/imports",
      "/api/admin/fixtures/demo/dry-run",
    ]);
    hub.seen.length = 0;
    for (const p of [
      "/hub/api/projects",
      "/hub/api/members/x",
      "/hub/settings",
      "/hub/connect/whoami",
      "/hub/api/reports",
      "/hub/api/inboxx",
      "/hub/api/import/packs%2f..%2f..%2fapi%2fprojects",
      "/hub/",
      "/hub/api/admin/users",
    ]) {
      const res = await fetch(`${base}${p}`, { headers: auth });
      expect([p, res.status]).toEqual([p, 404]);
    }
    // Dot segments are resolved before the check: what's checked is sent.
    const dots = await fetch(`${base}/hub/api/inbox/../projects`, {
      headers: auth,
    });
    expect(dots.status).toBe(404);
    expect(hub.seen).toEqual([]);
  });

  it("the allow-list, and /hub/callback stays Den's own", () => {
    expect(HUB_PROXY_PATHS).toEqual([
      "/mcp",
      "/api/inbox",
      "/api/notifications",
      "/api/notifications/*",
      "/api/import/packs",
      "/api/import/packs/*",
      "/api/reports/*",
      "/api/admin/fixtures/*",
    ]);
    expect(hubProxyPath("/hub/callback")).toBeNull();
    expect(hubProxyPath("/hubx/mcp")).toBeNull();
    expect(hubProxyPath("/api/hub")).toBeNull();
    expect(hubProxyPath("/hub/mcp")).toBe("/mcp");
    expect(hubProxyAllowed("/api/import/packs/p/files/abc")).toBe(true);
    expect(hubProxyAllowed("/api/import/packs/p/../../projects")).toBe(false);
  });

  it("the request checks let an agent's bearer through to it: a read, and a call", () => {
    expect(routeClass("GET", "/hub/mcp")).toBe("readonly");
    expect(routeClass("POST", "/hub/mcp")).toBe("mutating");
    expect(routeClass("PUT", "/hub/api/import/packs/p/files/x")).toBe(
      "mutating",
    );
    expect(routeClass("GET", "/hub/callback")).toBe("readonly");
    const agent = {
      kind: "agent" as const,
      actor: "agent:planner" as const,
      workspace: "north",
      grants: [],
      session: { name: "acme-north:planner" },
    };
    for (const [m, p] of [
      ["POST", "/hub/mcp"],
      ["GET", "/hub/mcp"],
      ["PUT", "/hub/api/import/packs/p/files/x"],
    ] as const)
      expect(agentRefusal(agent, m, p, routeClass(m, p)!)).toBeNull();
  });
});

describe("D52: what passes through", () => {
  it("MCP: POST and its session header both ways; a streamed answer arrives as Hub sends it", async () => {
    let release = () => undefined as void;
    const hub = await fakeHub((req, res) => {
      if (req.method === "POST") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "mcp-session-id": "s-123",
        });
        res.write('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n');
        release = () => res.end();
        return;
      }
      res.writeHead(202);
      res.end();
    });
    const { base, agentToken } = await den(hub.url, {
      mcpUrl: `${hub.url}/t/acme/mcp`,
    });
    const res = await fetch(`${base}/hub/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "s-123",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("s-123");
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // The first event, before Hub ends the stream.
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"jsonrpc":"2.0"');
    release();
    while (!(await reader.read()).done);
    // Hub's own mcp_url; the session and protocol headers went with it.
    expect(hub.seen[0].url).toBe("/t/acme/mcp");
    expect(hub.seen[0].headers).toMatchObject({
      "mcp-session-id": "s-123",
      "mcp-protocol-version": "2025-06-18",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${TOKEN}`,
    });
    // DELETE ends the MCP session.
    const del = await fetch(`${base}/hub/mcp`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "mcp-session-id": "s-123",
      },
    });
    expect(del.status).toBe(202);
  });

  it("a 30 MB file streams through intact; Hub's 413 and its words come back as they are", async () => {
    const hub = await fakeHub((req, res, body) => {
      if (body.length > 25 * 1024 * 1024) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: "file is over 25 MB (this Hub's HUB_IMPORT_FILE_MB)",
          }),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ missing: 0 }));
    });
    const { base, agentToken } = await den(hub.url);
    const big = Buffer.alloc(30 * 1024 * 1024, 7);
    const res = await fetch(`${base}/hub/api/import/packs/p1/files/abc`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/octet-stream",
      },
      body: big,
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: "file is over 25 MB (this Hub's HUB_IMPORT_FILE_MB)",
    });
    expect(hub.seen[0].bytes).toBe(big.length);
    expect(hub.seen[0].sha).toBe(
      createHash("sha256").update(big).digest("hex"),
    );
    expect(hub.seen[0].headers["content-type"]).toBe(
      "application/octet-stream",
    );
  }, 60_000);

  it("a redirect is passed back, never followed; the install token never comes back", async () => {
    const hub = await fakeHub((_req, res) => {
      res.writeHead(302, {
        location: "https://elsewhere.invalid/x",
        "set-cookie": "hub_session=1",
        "www-authenticate": `Bearer realm="${TOKEN}"`,
      });
      res.end();
    });
    const { base, agentToken } = await den(hub.url);
    const res = await fetch(`${base}/hub/api/reports/status`, {
      headers: { authorization: `Bearer ${agentToken}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://elsewhere.invalid/x");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify([...res.headers])).not.toContain(TOKEN);
    expect(hub.seen).toHaveLength(1);
  });

  it("Hub not connected: 503 saying where to connect it; Hub down: 502", async () => {
    const off = await den(null);
    const a = await fetch(`${off.base}/hub/api/inbox`, {
      headers: { authorization: `Bearer ${off.agentToken}` },
    });
    expect(a.status).toBe(503);
    expect(((await a.json()) as { error: string }).error).toMatch(
      /Settings › Agents › Hub/,
    );
    const down = await den("http://127.0.0.1:1");
    const b = await fetch(`${down.base}/hub/api/inbox`, {
      headers: { authorization: `Bearer ${down.agentToken}` },
    });
    expect(b.status).toBe(502);
    expect(JSON.stringify(await b.json())).not.toContain(TOKEN);
  });

  it("a path that isn't /hub/* is left for the other routes", async () => {
    const hub = await fakeHub();
    const { base, agentToken } = await den(hub.url);
    for (const p of ["/hub/callback", "/api/hub", "/hubx"]) {
      const res = await fetch(`${base}${p}`, {
        headers: { authorization: `Bearer ${agentToken}` },
      });
      expect([p, res.status]).toEqual([p, 418]);
    }
    expect(hub.seen).toEqual([]);
  });
});

describe("D52: hub push, from an agent, through Den", () => {
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  /** A pack: pack.json and blobs/<sha256>; Hub has the first file already. */
  function pack() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-pack-"));
    fs.mkdirSync(path.join(dir, "blobs"));
    const blobs = [0, 1, 2, 3, 4, 5].map((i) => Buffer.from(`file ${i}`));
    for (const b of blobs) fs.writeFileSync(path.join(dir, "blobs", sha(b)), b);
    fs.writeFileSync(
      path.join(dir, "pack.json"),
      JSON.stringify({
        source: { repo: "acme/designs", commit: "abc1234def" },
        files: blobs.map((b) => ({ sha256: sha(b), size: b.length })),
        records: [],
      }),
    );
    return { dir, shas: blobs.map(sha), bytes: blobs };
  }

  async function hubWithImports(over?: HubAnswer) {
    const reasons: unknown[] = [];
    let p: ReturnType<typeof pack> | undefined;
    const hub = await fakeHub((req, res, body) => {
      if (over) return over(req, res, body);
      const u = req.url ?? "";
      const json = (status: number, b: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (req.method === "POST" && u === "/api/import/packs")
        return json(201, {
          pack: "pk1",
          files: 6,
          missing: p!.shas.slice(1),
        });
      const put = /^\/api\/import\/packs\/pk1\/files\/([0-9a-f]{64})$/.exec(u);
      if (req.method === "PUT" && put)
        return sha(body) === put[1]
          ? json(200, { missing: 0 })
          : json(400, { error: "sha256 mismatch" });
      if (u === "/api/import/packs/pk1/dry-run")
        return json(200, { create: 3, update: 1 });
      if (u === "/api/import/packs/pk1/request") {
        reasons.push(JSON.parse(body.toString()));
        return json(201, {
          held: "h1",
          url: "https://hub.example.test/acme/held/h1",
          summary: "Import 3 new, 1 changed from acme/designs",
        });
      }
      json(404, { error: "no" });
    });
    return { hub, reasons, use: (x: ReturnType<typeof pack>) => (p = x) };
  }

  it("stages, uploads what Hub lacks (4 at a time), prints the dry run and the approval link; Hub's token is nowhere in it", async () => {
    const { hub, reasons, use } = await hubWithImports();
    const { base, agentToken, agentId } = await den(hub.url);
    const p = use(pack());
    const out: string[] = [];
    const err: string[] = [];
    const code = await cmdHub(["push", p.dir, "--request", "the new screens"], {
      env: { DEN_ACTOR_TOKEN: agentToken },
      denBase: () => base,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect([code, err]).toEqual([0, []]);
    const text = out.join("\n");
    expect(text).toContain("staged pk1: 6 files, 5 to upload");
    expect(text).toContain("uploaded 5 files");
    expect(text).toContain('"create": 3');
    expect(text).toContain("asked: Import 3 new, 1 changed from acme/designs");
    expect(text).toContain(
      "a person approves it at https://hub.example.test/acme/held/h1",
    );
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(agentToken);
    // Hub got each call as the install, for this agent.
    expect(hub.seen.map((x) => `${x.method} ${x.url}`).sort()).toEqual(
      [
        "POST /api/import/packs",
        ...p.shas.slice(1).map((h) => `PUT /api/import/packs/pk1/files/${h}`),
        "POST /api/import/packs/pk1/dry-run",
        "POST /api/import/packs/pk1/request",
      ].sort(),
    );
    for (const x of hub.seen) {
      expect(x.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(x.headers["x-den-agent-id"]).toBe(agentId);
    }
    expect(reasons).toEqual([{ reason: "the new screens" }]);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("without --request: the dry run only, and how to ask", async () => {
    const { hub, use } = await hubWithImports();
    const { base, agentToken } = await den(hub.url);
    const p = use(pack());
    const out: string[] = [];
    expect(
      await cmdHub(["push", p.dir], {
        env: { DEN_ACTOR_TOKEN: agentToken },
        denBase: () => base,
        out: (l) => out.push(l),
        err: () => undefined,
      }),
    ).toBe(0);
    expect(hub.seen.some((x) => x.url.endsWith("/request"))).toBe(false);
    expect(out.join("\n")).toMatch(/to ask a person to apply it: .* --request/);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("outside an agent: refused, and Hub hears nothing", async () => {
    const { hub, use } = await hubWithImports();
    const { base } = await den(hub.url);
    const p = use(pack());
    const err: string[] = [];
    expect(
      await cmdHub(["push", p.dir], {
        env: {},
        denBase: () => base,
        out: () => undefined,
        err: (l) => err.push(l),
      }),
    ).toBe(2);
    expect(err.join("\n")).toMatch(/runs inside an agent Den started/);
    expect(hub.seen).toEqual([]);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });

  it("Hub's refusal, in Hub's words: a file over its limit", async () => {
    const { hub, use } = await hubWithImports((req, res) => {
      res.writeHead(req.method === "PUT" ? 413 : 201, {
        "content-type": "application/json",
      });
      res.end(
        req.method === "PUT"
          ? JSON.stringify({
              error: "file is over 25 MB (this Hub's HUB_IMPORT_FILE_MB)",
            })
          : JSON.stringify({ pack: "pk1", files: 6, missing: p.shas.slice(1) }),
      );
    });
    const { base, agentToken } = await den(hub.url);
    const p = use(pack());
    const err: string[] = [];
    expect(
      await cmdHub(["push", p.dir], {
        env: { DEN_ACTOR_TOKEN: agentToken },
        denBase: () => base,
        out: () => undefined,
        err: (l) => err.push(l),
      }),
    ).toBe(1);
    expect(err.join("\n")).toMatch(
      /PUT \/api\/import\/packs\/pk1\/files\/[0-9a-f]{64}: 413 file is over 25 MB \(this Hub's HUB_IMPORT_FILE_MB\)/,
    );
    expect(err.join("\n")).not.toContain(TOKEN);
    fs.rmSync(p.dir, { recursive: true, force: true });
  });
});
