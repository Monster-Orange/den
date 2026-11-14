/**
 * HUB-1.5/1.7: hub.* config, the caller headers, owner/repo from a catalog
 * entry, Hub's /connect REST calls (whoami, token, revoke), PKCE, and the
 * status Settings and doctor show. Never this machine's config or secrets
 * store; a local HTTP server on localhost plays Hub. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import * as crypto from "crypto";
import {
  HubCallError,
  hubExchange,
  hubHeaders,
  hubRevoke,
  hubStatus,
  hubUrlProblem,
  hubWhoami,
  newHubState,
  newPkce,
  ownerRepo,
  patchHubAllowTools,
  readHubConfig,
  readHubToken,
  scrubToken,
  type HubConfig,
} from "../../../src/shared/hub.js";
import type { SecretsProvider } from "../../../src/shared/secrets/index.js";

const TOKEN = "hubi_TESTONLYabc987";
const noSecrets = () => ({});

describe("readHubConfig", () => {
  it("nothing without hub.url", () => {
    expect(readHubConfig({}, {}, noSecrets)).toBeNull();
    expect(readHubConfig({ hub: { url: "" } }, {}, noSecrets)).toBeNull();
  });

  it("user.yml wins over the org config; the trailing slash goes", () => {
    const c = readHubConfig(
      {
        hub: {
          url: "https://org.example.test",
          token: { item: "i", field: "f" },
        },
      },
      { hub: { url: "https://mine.example.test/" } },
      noSecrets,
    );
    expect(c).toEqual({
      url: "https://mine.example.test",
      tokenRef: { vault: "", item: "i", field: "f" },
      tokenFrom: "hub.token",
      allowTools: true,
      mcpUrl: "https://mine.example.test/mcp",
      inboxOnStop: "nudge",
      syncCheckSeconds: 30,
      namesCheckSeconds: 300,
      mcpRetrySeconds: 30,
      mcpRetryAttempts: 0,
      deliveryHeartbeatSeconds: 15,
      deliveryPollSeconds: 30,
    });
  });

  it("hub.mcp_url (Connect writes Hub's own, kept as given) wins over <url>/mcp; a bad one throws", () => {
    const url = "https://hub.example.test";
    expect(
      readHubConfig(
        { hub: { url, mcp_url: "https://mcp.example.test/v2/" } },
        {},
        noSecrets,
      )?.mcpUrl,
    ).toBe("https://mcp.example.test/v2/");
    expect(() =>
      readHubConfig({ hub: { url, mcp_url: "ftp://x" } }, {}, noSecrets),
    ).toThrow(/hub\.mcp_url/);
  });

  it("hub.token as file:, keychain: or env: (what Connect writes without a store)", () => {
    const c = readHubConfig(
      { hub: { url: "https://hub.example.test", token: "file:/tmp/x/token" } },
      {},
      noSecrets,
    );
    expect(c?.tokenRef).toBeNull();
    expect(c?.tokenSource).toMatchObject({
      kind: "file",
      path: "/tmp/x/token",
    });
  });

  it("a token ref by key", () => {
    expect(
      readHubConfig(
        { hub: { url: "https://hub.example.test", token: { key: "HUB_T" } } },
        {},
        noSecrets,
      )?.tokenRef,
    ).toEqual({ vault: "", item: "", field: "HUB_T", key: "HUB_T" });
  });

  it("a token named by a secrets.refs entry", () => {
    const c = readHubConfig(
      { hub: { url: "https://hub.example.test", token: "hub_install" } },
      {},
      () => ({ provider: "env", refs: { hub_install: { key: "HUB_T" } } }),
    );
    expect(c?.tokenFrom).toBe("secrets.refs.hub_install");
    expect(c?.tokenRef).toMatchObject({ key: "HUB_T" });
  });

  it("no token is allowed (status says so); a bad token or url throws naming the key", () => {
    expect(
      readHubConfig({ hub: { url: "https://hub.example.test" } }, {}, noSecrets)
        ?.tokenRef,
    ).toBeNull();
    expect(() =>
      readHubConfig(
        { hub: { url: "https://hub.example.test", token: 5 } },
        {},
        noSecrets,
      ),
    ).toThrow(/hub\.token must be/);
    expect(() => readHubConfig({ hub: { url: 5 } }, {}, noSecrets)).toThrow(
      /hub\.url must be a string/,
    );
    expect(() =>
      readHubConfig({ hub: { url: "http://hub.example.test" } }, {}, noSecrets),
    ).toThrow(/must be https/);
  });

  it("http only to this machine", () => {
    expect(hubUrlProblem("http://localhost:7100")).toBeNull();
    expect(hubUrlProblem("http://hub.localhost")).toBeNull();
    expect(hubUrlProblem("https://hub.example.test")).toBeNull();
    expect(hubUrlProblem("http://hub.example.test")).toMatch(/https/);
    expect(hubUrlProblem("not a url")).toMatch(/not a URL/);
  });
});

describe("hub.inbox_on_stop (D41)", () => {
  const url = "https://hub.example.test";
  it("nudge unless set off; anything else throws naming the key", () => {
    expect(readHubConfig({ hub: { url } }, {}, noSecrets)?.inboxOnStop).toBe(
      "nudge",
    );
    expect(
      readHubConfig(
        { hub: { url } },
        { hub: { inbox_on_stop: "off" } },
        noSecrets,
      )?.inboxOnStop,
    ).toBe("off");
    expect(() =>
      readHubConfig({ hub: { url, inbox_on_stop: false } }, {}, noSecrets),
    ).toThrow(/hub\.inbox_on_stop must be "nudge" or "off"/);
  });

  it("H5 hub.sync_check_seconds: 30 by default, a setting, at least 5", () => {
    expect(
      readHubConfig({ hub: { url } }, {}, noSecrets)?.syncCheckSeconds,
    ).toBe(30);
    expect(
      readHubConfig(
        { hub: { url } },
        { hub: { sync_check_seconds: 120 } },
        noSecrets,
      )?.syncCheckSeconds,
    ).toBe(120);
    expect(() =>
      readHubConfig({ hub: { url, sync_check_seconds: 1 } }, {}, noSecrets),
    ).toThrow(/hub\.sync_check_seconds must be a number, at least 5/);
  });

  it("0.4.40 delivery heartbeat (15) and poll (30): settings, at least 5", () => {
    const c = readHubConfig({ hub: { url } }, {}, noSecrets)!;
    expect([c.deliveryHeartbeatSeconds, c.deliveryPollSeconds]).toEqual([
      15, 30,
    ]);
    const d = readHubConfig(
      { hub: { url } },
      { hub: { delivery_heartbeat_seconds: 20, delivery_poll_seconds: 60 } },
      noSecrets,
    )!;
    expect([d.deliveryHeartbeatSeconds, d.deliveryPollSeconds]).toEqual([
      20, 60,
    ]);
    expect(() =>
      readHubConfig(
        { hub: { url, delivery_heartbeat_seconds: 2 } },
        {},
        noSecrets,
      ),
    ).toThrow(/hub\.delivery_heartbeat_seconds must be a number, at least 5/);
    expect(() =>
      readHubConfig(
        { hub: { url, delivery_poll_seconds: "x" } },
        {},
        noSecrets,
      ),
    ).toThrow(/hub\.delivery_poll_seconds must be a number, at least 5/);
  });
});

describe("hub.allow_tools", () => {
  const url = "https://hub.example.test";
  it("on unless set false; anything but a boolean throws naming the key", () => {
    expect(readHubConfig({ hub: { url } }, {}, noSecrets)?.allowTools).toBe(
      true,
    );
    expect(
      readHubConfig(
        { hub: { url, allow_tools: true } },
        { hub: { allow_tools: false } },
        noSecrets,
      )?.allowTools,
    ).toBe(false);
    expect(() =>
      readHubConfig({ hub: { url, allow_tools: "no" } }, {}, noSecrets),
    ).toThrow(/hub\.allow_tools must be true or false/);
  });

  it("Settings' POST sets it in user.yml, null clears it, junk is refused", () => {
    const user: Record<string, unknown> = { hub: { url } };
    expect(patchHubAllowTools(user, false)).toEqual({ ok: true });
    expect(user.hub).toEqual({ url, allow_tools: false });
    expect(patchHubAllowTools(user, null)).toEqual({ ok: true });
    expect(user.hub).toEqual({ url });
    const bare: Record<string, unknown> = {};
    patchHubAllowTools(bare, null);
    expect(bare).toEqual({});
    expect(patchHubAllowTools(user, "yes")).toMatchObject({ ok: false });
  });
});

describe("headers and repos", () => {
  it("the bearer token and plain caller names, one printable line each", () => {
    expect(
      hubHeaders(TOKEN, {
        agent: "Planner\nX-Evil: 1",
        session: "s-1",
        workspace: "north",
        repos: ["acme/north", "acme/kit"],
      }),
    ).toEqual({
      Authorization: `Bearer ${TOKEN}`,
      "X-Den-Agent": "Planner?X-Evil: 1",
      "X-Den-Session": "s-1",
      "X-Den-Workspace": "north",
      "X-Den-Repos": "acme/north,acme/kit",
      // H5: not linked to a Hub project.
      "X-Den-Project": "none",
    });
  });

  it("the server agent's scope says so (X-Den-Scope: server); a project's doesn't", () => {
    const who = { agent: "a", session: "s", repos: [] as string[] };
    expect(
      hubHeaders(TOKEN, { ...who, workspace: "den-server" })["X-Den-Scope"],
    ).toBe("server");
    expect(
      hubHeaders(TOKEN, { ...who, workspace: "north" })["X-Den-Scope"],
    ).toBeUndefined();
  });

  it("owner/repo from a gh slug, else the git remote", () => {
    expect(ownerRepo({ gh: "acme/north" })).toBe("acme/north");
    expect(ownerRepo({ remote: "git@github.com:acme/kit.git" })).toBe(
      "acme/kit",
    );
    expect(ownerRepo({ remote: "https://github.com/acme/kit" })).toBe(
      "acme/kit",
    );
    expect(ownerRepo({ remote: "" })).toBeNull();
    expect(ownerRepo(undefined)).toBeNull();
  });
});

describe("readHubToken", () => {
  const cfg: HubConfig = {
    url: "https://hub.example.test",
    tokenRef: { vault: "", item: "", field: "HUB_T", key: "HUB_T" },
    tokenFrom: "hub.token",
    allowTools: true,
  };
  const store = (v: string | null | Error) =>
    (() =>
      ({
        tryGet: async () => {
          if (v instanceof Error) throw v;
          return v;
        },
      }) as unknown as SecretsProvider) as () => SecretsProvider;

  it("the install's store answers; blank, missing or failing is null", async () => {
    expect(await readHubToken(cfg, store(` ${TOKEN}\n`))).toBe(TOKEN);
    expect(await readHubToken(cfg, store("  "))).toBeNull();
    expect(await readHubToken(cfg, store(null))).toBeNull();
    expect(await readHubToken(cfg, store(new Error("locked")))).toBeNull();
    expect(
      await readHubToken({ ...cfg, tokenRef: null }, store(TOKEN)),
    ).toBeNull();
  });
});

/** A Hub on localhost: /connect/whoami, /connect/token, /connect/revoke. */
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((res) => s.close(() => res()));
  }
});
interface Seen {
  method: string;
  path: string;
  auth: string;
  agentId: string;
  body: string;
}
async function fakeHub(
  who: Record<string, unknown> = {
    install: "north-box",
    role: "member",
    login: "pat",
    company: {
      slug: "acme",
      name: "Acme",
      url: "https://hub.example.test/c/acme",
    },
    mcp_url: "https://hub.example.test/mcp",
  },
  answer: (r: Seen) => [number, unknown] | null = () => null,
): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const s = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const r: Seen = {
        method: req.method ?? "",
        path: req.url ?? "",
        auth: String(req.headers.authorization ?? ""),
        agentId: String(req.headers["x-den-agent-id"] ?? ""),
        body,
      };
      seen.push(r);
      const send = (code: number, v: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      const forced = answer(r);
      if (forced) return send(forced[0], forced[1]);
      if (r.path === "/connect/whoami" && r.method === "GET")
        return r.auth === `Bearer ${TOKEN}`
          ? send(200, who)
          : send(401, { error: "unauthorized" });
      if (r.path === "/connect/revoke" && r.method === "POST")
        return r.auth === `Bearer ${TOKEN}`
          ? send(200, { revoked: true })
          : send(401, { error: "unauthorized" });
      if (r.path === "/connect/token" && r.method === "POST") {
        const b = JSON.parse(body) as Record<string, string>;
        return b.code === "good-code"
          ? send(200, {
              token: TOKEN,
              install: "north-box",
              role: "member",
              company: who.company,
              hub_url: "https://hub.example.test/",
              mcp_url: "https://hub.example.test/mcp",
            })
          : send(400, { error: "invalid_grant" });
      }
      res.writeHead(404).end();
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "localhost", () => r()));
  return { url: `http://localhost:${(s.address() as AddressInfo).port}`, seen };
}

describe("hubWhoami (GET /connect/whoami)", () => {
  it("sends the bearer token and reads install, role, login, company, mcp_url", async () => {
    const h = await fakeHub();
    expect(await hubWhoami(h.url, TOKEN)).toEqual({
      install: "north-box",
      role: "member",
      login: "pat",
      company: {
        slug: "acme",
        name: "Acme",
        url: "https://hub.example.test/c/acme",
      },
      mcpUrl: "https://hub.example.test/mcp",
    });
    expect(h.seen.map((r) => [r.method, r.path, r.auth])).toEqual([
      ["GET", "/connect/whoami", `Bearer ${TOKEN}`],
    ]);
  });

  it("unread (threads waiting on the person): a whole number of at least 0, else left out", async () => {
    const base = {
      install: "north-box",
      company: { name: "Acme", url: "https://hub.example.test/c/acme" },
    };
    for (const [v, want] of [
      [4, 4],
      [0, 0],
      [-1, undefined],
      [2.5, undefined],
      ["3", undefined],
      [null, undefined],
      [5_000_000, 1_000_000],
    ] as const) {
      const h = await fakeHub({ ...base, unread: v });
      expect([v, (await hubWhoami(h.url, TOKEN)).unread]).toEqual([v, want]);
    }
  });

  it("401 is rejected (connect again); 403 is forbidden (ask an admin), with Hub's words", async () => {
    const h = await fakeHub();
    await expect(hubWhoami(h.url, "hubi_wrong")).rejects.toMatchObject({
      kind: "rejected",
    });
    const f = await fakeHub(undefined, () => [
      403,
      { error: "your role (viewer) no longer allows Den installs" },
    ]);
    const e = (await hubWhoami(f.url, TOKEN).catch((x) => x)) as HubCallError;
    expect(e).toBeInstanceOf(HubCallError);
    expect(e.kind).toBe("forbidden");
    expect(e.message).toMatch(/role \(viewer\) no longer allows.*ask an admin/);
  });

  it("never follows a redirect (the token stays with Hub)", async () => {
    const h = await fakeHub(undefined, () => null);
    const other = await fakeHub();
    const r = http.createServer((_q, res) => {
      res.writeHead(302, { location: `${other.url}/connect/whoami` });
      res.end();
    });
    servers.push(r);
    await new Promise<void>((ok) => r.listen(0, "localhost", () => ok()));
    const url = `http://localhost:${(r.address() as AddressInfo).port}`;
    await expect(hubWhoami(url, TOKEN)).rejects.toMatchObject({
      kind: "unreachable",
    });
    expect(other.seen).toEqual([]);
    expect(h.seen).toEqual([]);
  });

  it("no answer in time fails, saying so", async () => {
    const s = http.createServer(() => undefined); // never answers
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "localhost", () => r()));
    const url = `http://localhost:${(s.address() as AddressInfo).port}`;
    await expect(hubWhoami(url, TOKEN, { timeoutMs: 200 })).rejects.toThrow(
      /did not answer in 200 ms/,
    );
  });
});

describe("hubExchange (POST /connect/token) and hubRevoke", () => {
  it("trades the code with the verifier for the token, Hub's url and mcp_url", async () => {
    const h = await fakeHub();
    const g = await hubExchange(h.url, {
      code: "good-code",
      redirectUri: "http://localhost:7000/hub/callback",
      verifier: "v".repeat(43),
    });
    expect(g).toMatchObject({
      token: TOKEN,
      install: "north-box",
      role: "member",
      company: { name: "Acme" },
      hubUrl: "https://hub.example.test",
      mcpUrl: "https://hub.example.test/mcp",
    });
    expect(JSON.parse(h.seen[0].body)).toEqual({
      grant_type: "authorization_code",
      code: "good-code",
      redirect_uri: "http://localhost:7000/hub/callback",
      code_verifier: "v".repeat(43),
    });
  });

  it("a bad code is refused with Hub's error code", async () => {
    const h = await fakeHub();
    await expect(
      hubExchange(h.url, {
        code: "x",
        redirectUri: "http://localhost/hub/callback",
        verifier: "v",
      }),
    ).rejects.toMatchObject({ kind: "refused", code: "invalid_grant" });
  });

  it("an answer with no token is refused", async () => {
    const h = await fakeHub(undefined, (r) =>
      r.path === "/connect/token" ? [200, { install: "x" }] : null,
    );
    await expect(
      hubExchange(h.url, {
        code: "good-code",
        redirectUri: "http://localhost/hub/callback",
        verifier: "v",
      }),
    ).rejects.toThrow(/no token/);
  });

  it("revoke: true when Hub revoked it, false when it was already invalid (401)", async () => {
    const h = await fakeHub();
    expect(await hubRevoke(h.url, TOKEN)).toBe(true);
    expect(await hubRevoke(h.url, "hubi_dead")).toBe(false);
    expect(h.seen.map((r) => [r.method, r.path])).toEqual([
      ["POST", "/connect/revoke"],
      ["POST", "/connect/revoke"],
    ]);
  });

  it("PKCE S256: a 43-character verifier and its sha256 challenge; states are fresh", () => {
    const { verifier, challenge } = newPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(
      crypto.createHash("sha256").update(verifier).digest("base64url"),
    );
    expect(challenge).toHaveLength(43);
    expect(newHubState()).not.toBe(newHubState());
    expect(newHubState().length).toBeGreaterThanOrEqual(8);
  });
});

describe("hubStatus", () => {
  const cfg: HubConfig = {
    url: "https://hub.example.test",
    tokenRef: { vault: "", item: "i", field: "f" },
    tokenFrom: "hub.token",
    allowTools: true,
  };

  it("not configured: nothing to show", async () => {
    expect(await hubStatus({ config: () => null })).toEqual({
      configured: false,
    });
  });

  it("connected, with the team and label", async () => {
    expect(
      await hubStatus({
        config: () => cfg,
        token: async () => TOKEN,
        whoami: async () => ({
          install: "north-box",
          role: "member",
          login: "pat",
          company: { name: "Acme", url: "https://hub.example.test/c/acme" },
        }),
      }),
    ).toEqual({
      configured: true,
      url: cfg.url,
      allowTools: true,
      connected: true,
      state: "connected",
      team: "Acme",
      teamUrl: "https://hub.example.test/c/acme",
      label: "north-box",
      role: "member",
      login: "pat",
    });
  });

  it("carries whoami's unread for the rail's badge", async () => {
    const st = await hubStatus({
      config: () => cfg,
      token: async () => TOKEN,
      whoami: async () => ({ unread: 2 }),
    });
    expect(st).toMatchObject({ state: "connected", unread: 2 });
    const none = await hubStatus({
      config: () => cfg,
      token: async () => TOKEN,
      whoami: async () => ({}),
    });
    expect("unread" in none).toBe(false);
  });

  it("each problem in words, and never the token", async () => {
    const bad = await hubStatus({
      config: () => {
        throw new Error("hub.url must be https (http only to this machine): x");
      },
    });
    expect(bad).toMatchObject({
      connected: false,
      state: "bad_config",
      problem: /must be https/,
    });
    expect(
      await hubStatus({ config: () => ({ ...cfg, tokenRef: null }) }),
    ).toMatchObject({
      connected: false,
      state: "no_token",
      problem: /not connected yet: Connect signs you in/,
    });
    expect(
      await hubStatus({
        config: () => ({
          ...cfg,
          tokenRef: null,
          tokenFrom: "secrets.refs.hub_install",
        }),
      }),
    ).toMatchObject({
      connected: false,
      problem: /names secrets\.refs\.hub_install, which is not set/,
    });
    expect(
      await hubStatus({ config: () => cfg, token: async () => null }),
    ).toMatchObject({
      connected: false,
      problem: /hub\.token could not be read/,
    });
    const down = await hubStatus({
      config: () => cfg,
      token: async () => TOKEN,
      whoami: async () => {
        throw new Error(`401 for Bearer ${TOKEN}`);
      },
    });
    expect(down).toMatchObject({
      connected: false,
      state: "unreachable",
      problem: /Hub did not answer: 401 for Bearer \[token\]/,
    });
    expect(JSON.stringify(down)).not.toContain(TOKEN);
  });

  it("Hub's own answers map to a state Settings acts on", async () => {
    const st = (e: Error) =>
      hubStatus({
        config: () => cfg,
        token: async () => TOKEN,
        whoami: async () => {
          throw e;
        },
      });
    expect(
      await st(
        new HubCallError("rejected", "Hub doesn't accept this install's token"),
      ),
    ).toMatchObject({ state: "rejected", problem: /doesn't accept/ });
    expect(
      await st(
        new HubCallError(
          "forbidden",
          "your role (viewer) no longer allows Den installs: ask an admin",
        ),
      ),
    ).toMatchObject({ state: "forbidden", problem: /ask an admin/ });
    const late = await st(
      new HubCallError("unreachable", "Hub did not answer in 5000 ms"),
    );
    expect(late).toMatchObject({ state: "unreachable" });
    expect(late.problem).toBe("Hub did not answer in 5000 ms");
  });

  it("scrubToken cuts the token out of any message", () => {
    expect(scrubToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe(
      "a [token] b [token]",
    );
    expect(scrubToken("plain", null)).toBe("plain");
  });
});
