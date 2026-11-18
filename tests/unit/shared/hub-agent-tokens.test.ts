/**
 * Issue 249: each Hub-connected agent gets its own Hub token, bound to it
 * on Hub, minted with the install's token (one grant per install). Den
 * keeps it in the server's own store (never the agent's env or files),
 * uses it for that agent's Hub calls, and revokes it when the agent goes.
 *
 * A fake Hub on a loopback port; temp state dirs; invented names and
 * test-only token values.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  hubMintAgentToken,
  hubRevokeAgentToken,
  HubCallError,
  readHubConfig,
} from "../../../src/shared/hub.js";
import {
  HubAgentTokens,
  agentHubTokenDir,
  readAgentHubToken,
  type AgentHubTokenSettings,
} from "../../../src/shared/hub-agent-tokens.js";
import { agentFilesDir } from "../../../src/shared/agents/records.js";

const INSTALL = "hubi_TESTONLY_249_install";

const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-249-"));
  dirs.push(d);
  return d;
};

interface Seen {
  method: string;
  url: string;
  auth: string;
  body: Record<string, unknown>;
}

/**
 * A fake Hub with the agent grant: POST /connect/agent (install token)
 * mints a bound token; POST /connect/revoke {token_id} revokes one.
 * `mode`: "ok", "absent" (404 for /connect/agent, as Hub before it), or
 * "down" (500).
 */
async function fakeHub(mode: { v: "ok" | "absent" | "down" } = { v: "ok" }) {
  const seen: Seen[] = [];
  const live = new Map<string, string>(); // token_id -> agent id
  let n = 0;
  const s = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        /* not JSON */
      }
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: String(req.headers.authorization ?? ""),
        body,
      });
      const json = (code: number, v: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (mode.v === "down") return json(500, { error: "down" });
      if (req.headers.authorization !== `Bearer ${INSTALL}`)
        return json(401, { error: "unauthorized" });
      if (req.url === "/connect/agent" && req.method === "POST") {
        if (mode.v === "absent") return json(404, { error: "not_found" });
        n += 1;
        const id = `00000000-0000-4000-8000-00000000000${n}`;
        live.set(id, String(body.agent_id));
        return json(200, {
          token: `hubi_TESTONLY_agent_${n}`,
          token_id: id,
          agent: { id: body.agent_id, name: body.agent_name },
        });
      }
      if (req.url === "/connect/revoke" && req.method === "POST") {
        const id = String(body.token_id ?? "");
        if (!live.has(id)) return json(404, { error: "no such token" });
        live.delete(id);
        return json(200, { revoked: true, token_id: id });
      }
      json(404, { error: "not_found" });
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return {
    seen,
    live,
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`,
  };
}

const settings = (
  o: Partial<AgentHubTokenSettings> = {},
): (() => AgentHubTokenSettings) => {
  const v: AgentHubTokenSettings = {
    enabled: true,
    retrySeconds: 600,
    maxAgeDays: 0,
    ...o,
  };
  return () => v;
};

describe("issue 249: Hub's agent grant, as Den calls it", () => {
  it("mint: POST /connect/agent with the install token and the agent's id and name", async () => {
    const hub = await fakeHub();
    const g = await hubMintAgentToken(hub.url, INSTALL, {
      id: "ada",
      name: "Ada",
    });
    expect(g).toEqual({
      token: "hubi_TESTONLY_agent_1",
      tokenId: "00000000-0000-4000-8000-000000000001",
    });
    expect(hub.seen).toEqual([
      {
        method: "POST",
        url: "/connect/agent",
        auth: `Bearer ${INSTALL}`,
        body: { agent_id: "ada", agent_name: "Ada" },
      },
    ]);
  });

  it("mint: a Hub without the grant (404) is a refusal with its status", async () => {
    const hub = await fakeHub({ v: "absent" });
    const e = await hubMintAgentToken(hub.url, INSTALL, {
      id: "ada",
      name: "Ada",
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HubCallError);
    expect((e as HubCallError).status).toBe(404);
  });

  it("revoke: the install token revokes one agent token by its id; an unknown id is false", async () => {
    const hub = await fakeHub();
    const g = await hubMintAgentToken(hub.url, INSTALL, {
      id: "ada",
      name: "Ada",
    });
    expect(await hubRevokeAgentToken(hub.url, INSTALL, g.tokenId)).toBe(true);
    expect(hub.seen[1]).toEqual({
      method: "POST",
      url: "/connect/revoke",
      auth: `Bearer ${INSTALL}`,
      body: { token_id: g.tokenId },
    });
    expect(await hubRevokeAgentToken(hub.url, INSTALL, g.tokenId)).toBe(false);
  });
});

describe("issue 249: the server's store of agent tokens", () => {
  it("mints once per agent, keeps it 0600 in the server's own folder (never the agent's files), and reuses it", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_1");
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_1");
    expect(hub.seen.filter((s) => s.url === "/connect/agent")).toHaveLength(1);
    const dir = agentHubTokenDir(stateDir);
    expect(dir.startsWith(path.join(stateDir, "hub"))).toBe(true);
    const file = path.join(dir, "ada.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    // Nothing of it lands in the agent's own files.
    const own = agentFilesDir(stateDir, "ada");
    const ownText = fs.existsSync(own)
      ? fs
          .readdirSync(own)
          .map((f) => fs.readFileSync(path.join(own, f), "utf8"))
          .join("")
      : "";
    expect(ownText).not.toContain("hubi_TESTONLY_agent_1");
    expect(b.bound("ada")).toBe(true);
    expect(b.bound("bob")).toBe(false);
  });

  it("two calls at once mint once", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    const [x, y] = await Promise.all([b.tokenFor(h, a), b.tokenFor(h, a)]);
    expect(x).toBe(y);
    expect(hub.seen.filter((s) => s.url === "/connect/agent")).toHaveLength(1);
  });

  it("the server agent, and every call with no agent, keep the install token: nothing is minted", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
    });
    const h = { url: hub.url, token: INSTALL };
    expect(
      await b.tokenFor(h, {
        id: "server",
        name: "Den",
        workspace: "den-server",
      }),
    ).toBeNull();
    expect(hub.seen).toHaveLength(0);
  });

  it("hub.agent_tokens off: the install token, nothing minted", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ enabled: false }),
    });
    expect(
      await b.tokenFor(
        { url: hub.url, token: INSTALL },
        { id: "ada", name: "Ada", workspace: "north" },
      ),
    ).toBeNull();
    expect(hub.seen).toHaveLength(0);
  });

  it("a Hub without the grant: the install token, and Den asks again only after hub.agent_token_retry_seconds", async () => {
    const mode = { v: "absent" as "ok" | "absent" | "down" };
    const hub = await fakeHub(mode);
    const stateDir = tmp();
    let now = 1_000_000;
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ retrySeconds: 60 }),
      now: () => now,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    expect(await b.tokenFor(h, a)).toBeNull();
    expect(await b.tokenFor(h, { ...a, id: "bob" })).toBeNull();
    // One ask for the whole install while Hub lacks it.
    expect(hub.seen).toHaveLength(1);
    now += 59_000;
    expect(await b.tokenFor(h, a)).toBeNull();
    expect(hub.seen).toHaveLength(1);
    mode.v = "ok";
    now += 2_000;
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_1");
  });

  it("a token Hub no longer takes (401 on a call) is dropped, and the next call mints a new one", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_1");
    b.rejected("ada");
    expect(b.bound("ada")).toBe(false);
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_2");
  });

  it("a token for another Hub is never sent: the store is per Hub address", async () => {
    const one = await fakeHub();
    const two = await fakeHub();
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
    });
    const a = { id: "ada", name: "Ada", workspace: "north" };
    expect(await b.tokenFor({ url: one.url, token: INSTALL }, a)).toBe(
      "hubi_TESTONLY_agent_1",
    );
    expect(await b.tokenFor({ url: two.url, token: INSTALL }, a)).toBe(
      "hubi_TESTONLY_agent_1",
    );
    expect(two.seen.filter((s) => s.url === "/connect/agent")).toHaveLength(1);
    expect(readAgentHubToken(stateDir, "ada")?.hubUrl).toBe(two.url);
  });

  it("hub.agent_token_max_age_days: an older token is revoked and replaced", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    let now = Date.parse("2026-11-01T00:00:00Z");
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ maxAgeDays: 7 }),
      now: () => now,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    const first = await b.tokenFor(h, a);
    now += 6 * 86_400_000;
    expect(await b.tokenFor(h, a)).toBe(first);
    now += 2 * 86_400_000;
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_2");
    expect(hub.live.size).toBe(1);
  });

  it("unbind: revokes the agent's token on Hub and forgets it here", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
    });
    const h = { url: hub.url, token: INSTALL };
    await b.tokenFor(h, { id: "ada", name: "Ada", workspace: "north" });
    expect(hub.live.size).toBe(1);
    expect(await b.unbind(h, "ada")).toEqual({ revoked: true });
    expect(hub.live.size).toBe(0);
    expect(b.bound("ada")).toBe(false);
    expect(
      fs.existsSync(path.join(agentHubTokenDir(stateDir), "ada.json")),
    ).toBe(false);
    // No token: nothing to do, and Hub hears nothing.
    const before = hub.seen.length;
    expect(await b.unbind(h, "ada")).toEqual({ revoked: false });
    expect(hub.seen).toHaveLength(before);
  });

  it("unbind with Hub down: kept to revoke later; the next unbindAll revokes it", async () => {
    const mode = { v: "ok" as "ok" | "absent" | "down" };
    const hub = await fakeHub(mode);
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
    });
    const h = { url: hub.url, token: INSTALL };
    await b.tokenFor(h, { id: "ada", name: "Ada", workspace: "north" });
    mode.v = "down";
    expect(await b.unbind(h, "ada")).toEqual({ revoked: false, pending: true });
    // Never used again for the agent, though kept.
    expect(b.bound("ada")).toBe(false);
    expect(
      await b.tokenFor(h, { id: "ada", name: "Ada", workspace: "north" }),
    ).toBeNull();
    mode.v = "ok";
    expect(await b.unbindAll(h)).toEqual({ revoked: 1, failed: 0 });
    expect(hub.live.size).toBe(0);
  });

  it("a revoke still waiting is tried again at the agent's next call (an Undo); once Hub takes it, a new token", async () => {
    const mode = { v: "ok" as "ok" | "absent" | "down" };
    const hub = await fakeHub(mode);
    const stateDir = tmp();
    let now = 1_000_000;
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ retrySeconds: 60 }),
      now: () => now,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    await b.tokenFor(h, a);
    mode.v = "down";
    await b.unbind(h, "ada");
    expect(await b.tokenFor(h, a)).toBeNull();
    mode.v = "ok";
    // Within the wait: not asked again.
    expect(await b.tokenFor(h, a)).toBeNull();
    now += 61_000;
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_2");
    expect(hub.live.size).toBe(1);
  });

  it("unbindAll (Disconnect): every agent's token is revoked and forgotten", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
    });
    const h = { url: hub.url, token: INSTALL };
    await b.tokenFor(h, { id: "ada", name: "Ada", workspace: "north" });
    await b.tokenFor(h, { id: "bob", name: "Bob", workspace: "south" });
    expect(hub.live.size).toBe(2);
    expect(await b.unbindAll(h)).toEqual({ revoked: 2, failed: 0 });
    expect(hub.live.size).toBe(0);
    expect(b.bound("ada") || b.bound("bob")).toBe(false);
  });

  it("the name Hub gets is printable and at most 80 characters; else the id", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
    });
    const h = { url: hub.url, token: INSTALL };
    await b.tokenFor(h, { id: "ada", name: "Adaé ☃", workspace: "north" });
    await b.tokenFor(h, {
      id: "bob",
      name: "x".repeat(200),
      workspace: "north",
    });
    const names = hub.seen
      .filter((s) => s.url === "/connect/agent")
      .map((s) => s.body.agent_name);
    expect(names[0]).toBe("ada");
    expect(names[1]).toBe("x".repeat(80));
  });
});

describe("issue 249: the settings, with permissive defaults", () => {
  it("hub.agent_tokens on, retry every 600 s, no maximum age", () => {
    const c = readHubConfig(
      { hub: { url: "https://hub.example.test" } },
      {},
      () => ({}) as never,
    );
    expect(c?.agentTokens).toBe(true);
    expect(c?.agentTokenRetrySeconds).toBe(600);
    expect(c?.agentTokenMaxAgeDays).toBe(0);
  });

  it("bad values name their key", () => {
    const rd = (hub: Record<string, unknown>) => () =>
      readHubConfig(
        { hub: { url: "https://hub.example.test", ...hub } },
        {},
        () => ({}) as never,
      );
    expect(rd({ agent_tokens: "yes" })).toThrow("hub.agent_tokens");
    expect(rd({ agent_token_retry_seconds: 1 })).toThrow(
      "hub.agent_token_retry_seconds",
    );
    expect(rd({ agent_token_max_age_days: -1 })).toThrow(
      "hub.agent_token_max_age_days",
    );
    expect(rd({ agent_token_max_age_days: 30 })().agentTokenMaxAgeDays).toBe(
      30,
    );
  });
});
