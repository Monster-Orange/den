/**
 * Issue 521: the version handshake with Hub. Every call Den makes to Hub
 * carries X-Den-Version (Den's exact version), X-Den-Protocol (a whole
 * number) and X-Den-Capabilities (lowercase, sorted, comma-separated, no
 * spaces); the proxy replaces any copy an agent sets. Den reads Hub's
 * X-Hub-Compat answer: `unsupported` makes Den send reads only, and the
 * next write is refused with Hub's reason before anything reaches Hub. A
 * Hub that says nothing is "not reported", never an error.
 *
 * A fake Hub on 127.0.0.1 records what reaches it; the proxy is the real
 * one, behind a minimal front that sets an invented agent principal.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  hubAckDelivery,
  hubHeaders,
  hubRevoke,
  hubStatus,
  hubWhoami,
  HubCallError,
} from "../../../src/shared/hub.js";
import { fetchHubTools } from "../../../src/shared/hub-tools.js";
import { handleHubProxy } from "../../../src/ui/server/hub-proxy-routes.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";

const TOKEN = "hubi_TESTONLY_521_install_token";
const PKG = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf-8"),
) as { version: string };

const servers: http.Server[] = [];
let home = "";
const savedHome = process.env.DEN_HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "den-521-"));
  process.env.DEN_HOME = home;
});
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  if (savedHome === undefined) delete process.env.DEN_HOME;
  else process.env.DEN_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A fake Hub: records each request; `compat` is what it says back. */
async function fakeHub(compat: () => Record<string, string> = () => ({})) {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
      });
      res.writeHead(200, { "content-type": "application/json", ...compat() });
      if ((req.url ?? "").startsWith("/mcp")) {
        const m = body ? (JSON.parse(body) as { id?: number }) : {};
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: m.id,
            result: { protocolVersion: "2025-06-18", tools: [] },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ install: "test-install", ok: true }));
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    seen,
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
  };
}

/** Den's proxy in front of `hubUrl`, for one invented agent. */
async function proxy(hubUrl: string): Promise<string> {
  const s = http.createServer((req, res) => {
    setPrincipal(req, {
      kind: "agent",
      actor: "agent:a-test",
      workspace: "north",
      grants: [],
      session: { name: "s1", id: "s1" },
    });
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleHubProxy(req, res, p, {
      upstream: async (who) => ({
        base: hubUrl,
        mcpUrl: `${hubUrl}/mcp`,
        headers: hubHeaders(TOKEN, {
          agent: "Ada",
          agentId: who.agentId,
          session: who.session,
          workspace: who.workspace,
          repos: ["example/north"],
        }),
      }),
    }).then((handled) => {
      if (!handled) {
        res.writeHead(418);
        res.end();
      }
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

const CAPS = /^[a-z0-9][a-z0-9._-]*(,[a-z0-9][a-z0-9._-]*)*$/;

function expectHandshake(h: http.IncomingHttpHeaders) {
  expect(h["x-den-version"]).toBe(PKG.version);
  expect(String(h["x-den-protocol"])).toMatch(/^[1-9][0-9]*$/);
  const caps = String(h["x-den-capabilities"] ?? "");
  expect(caps).toMatch(CAPS);
  const list = caps.split(",");
  expect([...list].sort()).toEqual(list);
  expect(new Set(list).size).toBe(list.length);
}

describe("Den's handshake headers (issue 521)", () => {
  it("every kind of Hub call carries the three headers, in their formats", async () => {
    const hub = await fakeHub();
    await hubWhoami(hub.url, TOKEN);
    await hubAckDelivery(hub.url, TOKEN, "d-1", { state: "done" });
    await fetchHubTools(`${hub.url}/mcp`, TOKEN);
    await hubRevoke(hub.url, TOKEN);
    expect(hub.seen.length).toBeGreaterThanOrEqual(6);
    for (const s of hub.seen) expectHandshake(s.headers);
  });

  it("the proxy replaces an agent's own X-Den-Version (and the other two)", async () => {
    const hub = await fakeHub();
    const den = await proxy(hub.url);
    const r = await fetch(`${den}/hub/api/inbox`, {
      headers: {
        "X-Den-Version": "99.0.0",
        "X-Den-Protocol": "999",
        "X-Den-Capabilities": "everything",
      },
    });
    expect(r.status).toBe(200);
    expect(hub.seen).toHaveLength(1);
    expectHandshake(hub.seen[0].headers);
    expect(hub.seen[0].headers["x-den-capabilities"]).not.toBe("everything");
  });
});

describe("Hub's compat answer (issue 521)", () => {
  it("unsupported: the next write is refused with Hub's reason, and nothing is sent", async () => {
    const hub = await fakeHub(() => ({
      "X-Hub-Version": "3.0.0",
      "X-Hub-Protocol": "4",
      "X-Hub-Compat": "unsupported",
      "X-Hub-Compat-Reason": "protocol 1 retired: update Den",
    }));
    await hubWhoami(hub.url, TOKEN);
    const before = hub.seen.length;
    let err: unknown;
    try {
      await hubAckDelivery(hub.url, TOKEN, "d-1", { state: "done" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HubCallError);
    expect((err as HubCallError).code).toBe("hub_unsupported");
    expect((err as Error).message).toContain("protocol 1 retired: update Den");
    expect(hub.seen.length).toBe(before);
    // Reads still go.
    await hubWhoami(hub.url, TOKEN);
    expect(hub.seen.length).toBe(before + 1);
  });

  it("unsupported through the proxy: reads pass, writes are refused before Hub sees them", async () => {
    const hub = await fakeHub(() => ({
      "X-Hub-Compat": "unsupported",
      "X-Hub-Compat-Reason": "too old",
    }));
    const den = await proxy(hub.url);
    expect((await fetch(`${den}/hub/api/inbox`)).status).toBe(200);
    const n = hub.seen.length;
    const w = await fetch(`${den}/hub/api/artifacts/x`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(w.status).toBe(409);
    const b = (await w.json()) as { code?: string; error?: string };
    expect(b.code).toBe("hub_unsupported");
    expect(b.error).toContain("too old");
    const call = await fetch(`${den}/hub/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "hub_artifact_create", arguments: {} },
      }),
    });
    expect(call.status).toBe(409);
    expect(hub.seen.length).toBe(n);
    // An MCP read still passes.
    const list = await fetch(`${den}/hub/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
    expect(hub.seen.length).toBe(n + 1);
  });

  it("a Hub that sends no compat headers is not reported, never an error", async () => {
    const hub = await fakeHub();
    await hubWhoami(hub.url, TOKEN);
    await expect(
      hubAckDelivery(hub.url, TOKEN, "d-1", { state: "done" }),
    ).resolves.toBeDefined();
    const st = await hubStatus({
      config: () =>
        ({ url: hub.url, tokenRef: "x", tokenFrom: "hub.token" }) as never,
      token: async () => TOKEN,
    });
    expect(st.configured && st.connected).toBe(true);
    expect(st.configured && "compat" in st ? st.compat : undefined).toBe(
      undefined,
    );
  });

  it("degraded shows on the Hub status with Hub's reason", async () => {
    const hub = await fakeHub(() => ({
      "X-Hub-Compat": "degraded",
      "X-Hub-Compat-Reason": "no held asks on this Hub",
    }));
    const st = await hubStatus({
      config: () =>
        ({ url: hub.url, tokenRef: "x", tokenFrom: "hub.token" }) as never,
      token: async () => TOKEN,
    });
    expect(st.configured && st.compat).toEqual(
      expect.objectContaining({
        state: "degraded",
        reason: "no held asks on this Hub",
      }),
    );
  });
});

describe("where the person sees it (issue 521)", () => {
  it("Settings' Hub row and doctor say unsupported, with Hub's reason", async () => {
    const { hubHtml } =
      await import("../../../src/ui/server/public/settings-registry.js");
    const { hubLines } = await import("../../../src/ui/cli/doctor-command.js");
    const hub = await fakeHub(() => ({
      "X-Hub-Compat": "unsupported",
      "X-Hub-Compat-Reason": "protocol 1 retired",
    }));
    const st = await hubStatus({
      config: () =>
        ({ url: hub.url, tokenRef: "x", tokenFrom: "hub.token" }) as never,
      token: async () => TOKEN,
    });
    const html = hubHtml(st, null);
    expect(html).toContain('data-hub-compat="unsupported"');
    expect(html).toContain("Reads only");
    expect(html).toContain("protocol 1 retired");
    const d = hubLines(st, "Den");
    expect(d.check?.status).toBe("warn");
    expect(d.check?.detail).toContain("protocol 1 retired");
  });
});
