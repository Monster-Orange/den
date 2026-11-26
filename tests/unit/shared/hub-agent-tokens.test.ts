/**
 *
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  hubMintAgentToken,
  hubRevoke,
  hubRevokeAgentToken,
  HubCallError,
  readHubConfig,
} from "../../../src/shared/hub.js";
import {
  HubAgentTokens,
  agentHubTokenDir,
  readAgentHubToken,
  agentHubTokenSettingsOf,
  readAgentTokenProblems,
  type AgentHubTokenSettings,
} from "../../../src/shared/hub-agent-tokens.js";
import { hubAgentTokenLines } from "../../../src/ui/cli/doctor-command.js";
import {
  readUnrevoked,
  recordUnrevoked,
} from "../../../src/shared/hub-binding.js";
import { retryUnrevoked } from "../../../src/ui/server/hub-change.js";
import { agentFilesDir } from "../../../src/shared/agents/records.js";
import {
  agentsNotCovered,
  clearAgentsNotCovered,
} from "../../../src/shared/hub-agent-grant.js";

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
 */
type Mode =
  | "ok"
  | "absent"
  | "down"
  | "nomint"
  | "norevoke"
  | "notcovered"
  | "installreq"
  | "manage";
async function fakeHub(mode: { v: Mode } = { v: "ok" }) {
  const seen: Seen[] = [];
  const live = new Map<string, string>();
  const tokens = new Map<string, string>();
  const chainOf = new Map<string, Set<string>>();
  const replaces = new Map<string, string>();
  const end = (id: string) => {
    live.delete(id);
    for (const [t, i] of tokens) if (i === id) tokens.delete(t);
  };
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
        body = {};
      }
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: String(req.headers.authorization ?? ""),
        body,
      });
      const json = (code: number, v: unknown) => {
        res.writeHead(code, {
          "content-type": "application/json",
          "cache-control": "no-store",
          ...(code === 401 ? { "www-authenticate": "Bearer" } : {}),
        });
        res.end(
          JSON.stringify(
            code === 401 ? { ...(v as object), request_id: "req-test" } : v,
          ),
        );
      };
      if (mode.v === "down") return json(500, { error: "down" });
      if (req.url === "/connect/whoami" && req.method === "GET") {
        const id = tokens.get(String(req.headers.authorization).slice(7));
        if (!id) return json(401, { error: "unauthorized" });
        const old = replaces.get(id);
        if (old) {
          end(old);
          replaces.delete(id);
        }
        return json(200, { agent: live.get(id) });
      }
      if (
        req.url === "/connect/revoke" &&
        req.method === "POST" &&
        body.token_id === undefined &&
        mode.v !== "norevoke"
      ) {
        const own = tokens.get(String(req.headers.authorization).slice(7));
        if (own) {
          end(own);
          return json(200, { revoked: true });
        }
      }
      if (req.headers.authorization !== `Bearer ${INSTALL}`) {
        const asAgent = tokens.has(String(req.headers.authorization).slice(7));
        if (asAgent && req.url === "/connect/agent")
          return json(403, { error: "install_token_required" });
        return json(401, { error: "unauthorized" });
      }
      if (req.url === "/connect/agent" && req.method === "POST") {
        if (mode.v === "absent") return json(404, { error: "not_found" });
        if (mode.v === "nomint") return json(503, { error: "busy" });
        if (mode.v === "notcovered")
          return json(403, {
            error: "agents_not_covered",
            error_description: "this install's grant doesn't cover agents",
          });
        if (mode.v === "installreq")
          return json(403, { error: "install_token_required" });
        if (mode.v === "manage")
          return json(403, { error: "agents_manage_missing" });
        const keys = Object.keys(body).sort().join(",");
        const nm =
          typeof body.agent_name === "string"
            ? body.agent_name.replace(/\s+/g, " ").trim()
            : "";
        if (
          keys !== "agent_id,agent_name" ||
          typeof body.agent_id !== "string" ||
          !/^[A-Za-z0-9._:-]{1,100}$/.test(body.agent_id) ||
          !nm ||
          !/^[\x20-\x7e]{1,80}$/.test(nm)
        )
          return json(400, { error: "invalid_request" });
        n += 1;
        const id = `00000000-0000-4000-8000-00000000000${n}`;
        const agent = String(body.agent_id);
        const prev = [...live].find(([, a]) => a === agent)?.[0];
        const chain = (prev && chainOf.get(prev)) || new Set<string>();
        chain.add(id);
        chainOf.set(id, chain);
        if (prev) replaces.set(id, prev);
        live.set(id, agent);
        const token = `hubi_TESTONLY_agent_${n}`;
        tokens.set(token, id);
        return json(200, {
          token,
          token_id: id,
          agent: { id: body.agent_id, name: nm },
        });
      }
      if (req.url === "/connect/revoke" && req.method === "POST") {
        if (mode.v === "norevoke") return json(503, { error: "busy" });
        const id = String(body.token_id ?? "");
        if (!live.has(id)) return json(404, { error: "no such token" });
        for (const c of chainOf.get(id) ?? [id]) end(c);
        return json(200, { revoked: true, token_id: id });
      }
      json(404, { error: "not_found" });
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return {
    seen,
    live,
    url,
    use: async (token: string) =>
      (
        await fetch(`${url}/connect/whoami`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    expireGrace: () => {
      for (const [, old] of replaces) end(old);
      replaces.clear();
    },
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
    const mode = { v: "absent" as Mode };
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
    expect(hub.seen).toHaveLength(1);
    now += 59_000;
    expect(await b.tokenFor(h, a)).toBeNull();
    expect(hub.seen).toHaveLength(1);
    mode.v = "ok";
    now += 2_000;
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_1");
  });

  it("a token Hub no longer takes (401 on a call) is dropped; the next mint waits hub.agent_token_retry_seconds", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    let now = 1_000_000;
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
      now: () => now,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_1");
    b.rejected("ada");
    expect(b.bound("ada")).toBe(false);
    expect(await b.tokenFor(h, a)).toBeNull();
    now += 601_000;
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

  it("rotation at the 30-day default: the new token is minted, kept and used from the next call; Den never revokes the old one (Hub ends it)", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    let now = Date.parse("2026-11-01T00:00:00Z");
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: () => agentHubTokenSettingsOf({}),
      now: () => now,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    const first = await b.tokenFor(h, a);
    const firstId = readAgentHubToken(stateDir, "ada")!.tokenId;
    now += 29 * 86_400_000;
    expect(await b.tokenFor(h, a)).toBe(first);
    expect(hub.seen.filter((s) => s.url === "/connect/agent")).toHaveLength(1);
    now += 2 * 86_400_000;
    const mark = hub.seen.length;
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_2");
    expect(hub.seen.slice(mark).map((s) => s.url)).toEqual(["/connect/agent"]);
    const kept = readAgentHubToken(stateDir, "ada")!;
    expect(kept.token).toBe("hubi_TESTONLY_agent_2");
    expect(kept.tokenId).not.toBe(firstId);
    expect(JSON.stringify(kept)).not.toContain(firstId);
    expect(hub.live.has(firstId)).toBe(true);
    expect(hub.live.has(kept.tokenId)).toBe(true);
    for (let i = 0; i < 3; i++)
      expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_2");
    expect(await hub.use("hubi_TESTONLY_agent_2")).toBe(200);
    expect([...hub.live.keys()]).toEqual([kept.tokenId]);
    expect(hub.seen.filter((s) => s.url === "/connect/revoke")).toEqual([]);
  });

  it("rotation, then the grace period runs out before the new one's first use: the new one still works (nothing of Den's ended it)", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    let now = Date.parse("2026-11-01T00:00:00Z");
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ maxAgeDays: 30 }),
      now: () => now,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    await b.tokenFor(h, a);
    now += 31 * 86_400_000;
    const fresh = await b.tokenFor(h, a);
    hub.expireGrace();
    expect(await hub.use(fresh!)).toBe(200);
    expect(hub.live.size).toBe(1);
  });

  it("rotation: a mint that fails keeps the old token in use, revokes nothing, and is tried again after the retry wait", async () => {
    const mode = { v: "ok" as Mode };
    const hub = await fakeHub(mode);
    const stateDir = tmp();
    let now = Date.parse("2026-11-01T00:00:00Z");
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ maxAgeDays: 30, retrySeconds: 60 }),
      now: () => now,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    const first = await b.tokenFor(h, a);
    now += 31 * 86_400_000;
    mode.v = "nomint";
    expect(await b.tokenFor(h, a)).toBe(first);
    expect(hub.seen.filter((s) => s.url === "/connect/revoke")).toEqual([]);
    expect(hub.live.size).toBe(1);
    const mints = () =>
      hub.seen.filter((s) => s.url === "/connect/agent").length;
    const before = mints();
    now += 30_000;
    expect(await b.tokenFor(h, a)).toBe(first);
    expect(mints()).toBe(before);
    mode.v = "ok";
    now += 31_000;
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_2");
    expect(hub.live.size).toBe(2);
    await hub.use("hubi_TESTONLY_agent_2");
    expect(hub.live.size).toBe(1);
    expect(hub.seen.filter((s) => s.url === "/connect/revoke")).toEqual([]);
  });

  it("removing an agent soon after a rotation revokes its current token by its id; Hub's rule ends the replaced one with it", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    let now = Date.parse("2026-11-01T00:00:00Z");
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ maxAgeDays: 30 }),
      now: () => now,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    await b.tokenFor(h, a);
    now += 31 * 86_400_000;
    await b.tokenFor(h, a);
    expect(hub.live.size).toBe(2);
    expect(await b.unbind(h, "ada")).toEqual({ revoked: true });
    const revokes = hub.seen.filter((s) => s.url === "/connect/revoke");
    expect(revokes).toHaveLength(1);
    expect(hub.live.size).toBe(0);
  });

  it("hub.agent_token_max_age_days 0: never rotated", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    let now = Date.parse("2026-11-01T00:00:00Z");
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ maxAgeDays: 0 }),
      now: () => now,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    const first = await b.tokenFor(h, a);
    now += 400 * 86_400_000;
    expect(await b.tokenFor(h, a)).toBe(first);
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
    const before = hub.seen.length;
    expect(await b.unbind(h, "ada")).toEqual({ revoked: false });
    expect(hub.seen).toHaveLength(before);
  });

  it("unbind with Hub down: kept to revoke later; the next unbindAll revokes it", async () => {
    const mode = { v: "ok" as Mode };
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
    expect(b.bound("ada")).toBe(false);
    expect(
      await b.tokenFor(h, { id: "ada", name: "Ada", workspace: "north" }),
    ).toBeNull();
    mode.v = "ok";
    expect(await b.unbindAll(h)).toEqual({ revoked: 1, failed: 0 });
    expect(hub.live.size).toBe(0);
  });

  it("a revoke still waiting is tried again at the agent's next call (an Undo); once Hub takes it, a new token", async () => {
    const mode = { v: "ok" as Mode };
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

describe("issue 249: one [hub] log line per mint, mint failure and revoke", () => {
  it("a stored mint, a failed one (Hub's status and error code), a 401 drop and a revoke (with its reason) each log one line; never a token", async () => {
    const mode = { v: "ok" as Mode };
    const hub = await fakeHub(mode);
    const stateDir = tmp();
    let now = 1_000_000;
    const logged: string[] = [];
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ retrySeconds: 60 }),
      now: () => now,
      log: (l) => void logged.push(l),
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    const t = await b.tokenFor(h, a);
    const id = readAgentHubToken(stateDir, "ada")!.tokenId;
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("ada");
    expect(logged[0]).toContain(id);
    expect(logged[0]).toMatch(/stored/);
    mode.v = "nomint";
    await b.tokenFor(h, { ...a, id: "bob" });
    expect(logged).toHaveLength(2);
    expect(logged[1]).toMatch(/bob.*503.*busy/);
    b.rejected("ada");
    expect(logged).toHaveLength(3);
    expect(logged[2]).toMatch(/401.*ada/);
    mode.v = "ok";
    now += 61_000;
    await b.tokenFor(h, a);
    await b.unbind(h, "ada", "remove");
    expect(logged.at(-1)).toMatch(/revoked.*ada.*remove/);
    for (const l of logged) {
      expect(l).not.toContain(t!);
      expect(l).not.toContain(INSTALL);
      expect(l).not.toMatch(/hubi_/);
    }
  });
});

describe("issue 249: den doctor shows a failed mint or an unexpected drop as ✗", () => {
  it("a failed mint (Hub's status and code) and a 401 drop each show one ✗ row per agent; a stored mint clears its row; never a token", async () => {
    const mode = { v: "nomint" as Mode };
    const hub = await fakeHub(mode);
    const stateDir = tmp();
    let now = 1_000_000;
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ retrySeconds: 60 }),
      now: () => now,
      log: () => undefined,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    await b.tokenFor(h, a);
    let d = hubAgentTokenLines(readAgentTokenProblems(stateDir));
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatch(/✗.*ada.*status 503, error busy/);
    expect(d.checks[0]).toMatchObject({
      id: "hub:agent-token:ada",
      status: "fail",
    });
    mode.v = "ok";
    now += 61_000;
    const t = await b.tokenFor(h, a);
    expect(hubAgentTokenLines(readAgentTokenProblems(stateDir)).lines).toEqual(
      [],
    );
    b.rejected("ada");
    d = hubAgentTokenLines(readAgentTokenProblems(stateDir));
    expect(d.lines[0]).toMatch(/✗.*ada.*401/);
    mode.v = "notcovered";
    await b.tokenFor(h, { ...a, id: "bob" });
    d = hubAgentTokenLines(readAgentTokenProblems(stateDir));
    expect(d.lines).toHaveLength(2);
    expect(d.lines.join("\n")).toMatch(
      /bob.*status 403, error agents_not_covered.*Reconnect/,
    );
    expect(JSON.stringify(d)).not.toContain(t!);
    expect(JSON.stringify(d)).not.toMatch(/hubi_/);
  });
});

describe("issue 249: Hub's mint refusals, by their error value", () => {
  it("Hub 0.2.10's exact 200 (a normalized name, no other fields): stored, bound, and the agent's next call uses it", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
      log: () => undefined,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = {
      id: "gate-249-bound",
      name: "Gate  249\tbound ",
      workspace: "default",
    };
    const t = await b.tokenFor(h, a);
    expect(t).toBe("hubi_TESTONLY_agent_1");
    expect(hub.seen[0].body).toEqual({
      agent_id: "gate-249-bound",
      agent_name: "Gate 249 bound",
    });
    expect(b.bound("gate-249-bound")).toBe(true);
    expect(
      fs
        .readdirSync(agentHubTokenDir(stateDir))
        .filter((f) => f.endsWith(".json")),
    ).toEqual(["gate-249-bound.json"]);
    expect(await b.tokenFor(h, a)).toBe(t);
    expect(hub.seen.filter((s) => s.url === "/connect/agent")).toHaveLength(1);
  });

  it("403 agents_manage_missing is handled as agents_not_covered: one reconnect item, no retry, and the log names the code", async () => {
    const mode = { v: "manage" as Mode };
    const hub = await fakeHub(mode);
    const stateDir = tmp();
    let now = 1_000_000;
    const posted: string[] = [];
    const logged: string[] = [];
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ retrySeconds: 60 }),
      now: () => now,
      onNotCovered: (url) => void posted.push(url),
      log: (l) => void logged.push(l),
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    expect(await b.tokenFor(h, a)).toBeNull();
    mode.v = "ok";
    now += 86_400_000;
    expect(await b.tokenFor(h, { ...a, id: "bob" })).toBeNull();
    expect(hub.seen.filter((s) => s.url === "/connect/agent")).toHaveLength(1);
    expect(posted).toEqual([hub.url]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/status 403, error agents_manage_missing/);
  });

  it("403 agents_not_covered: the install token, ONE reconnect item, and no more mints (any agent, any wait, a restart) until the install connects again", async () => {
    const mode = { v: "notcovered" as Mode };
    const hub = await fakeHub(mode);
    const stateDir = tmp();
    let now = 1_000_000;
    const posted: string[] = [];
    const make = () =>
      new HubAgentTokens({
        stateDir: () => stateDir,
        settings: settings({ retrySeconds: 60 }),
        now: () => now,
        onNotCovered: (url) => void posted.push(url),
      });
    let b = make();
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    const mints = () =>
      hub.seen.filter((s) => s.url === "/connect/agent").length;
    expect(await b.tokenFor(h, a)).toBeNull();
    expect(posted).toEqual([hub.url]);
    expect(agentsNotCovered(stateDir, hub.url)).toBe(true);
    mode.v = "ok";
    for (const id of ["ada", "bob", "cy"]) {
      now += 86_400_000;
      expect(await b.tokenFor(h, { ...a, id })).toBeNull();
    }
    b = make();
    expect(await b.tokenFor(h, a)).toBeNull();
    expect(mints()).toBe(1);
    expect(posted).toHaveLength(1);
    clearAgentsNotCovered(stateDir);
    expect(await b.tokenFor(h, a)).toBe("hubi_TESTONLY_agent_1");
    expect(mints()).toBe(2);
  });

  it("403 agents_not_covered at a rotation keeps the old token in use and revokes nothing", async () => {
    const mode = { v: "ok" as Mode };
    const hub = await fakeHub(mode);
    const stateDir = tmp();
    let now = Date.parse("2026-11-01T00:00:00Z");
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ maxAgeDays: 30 }),
      now: () => now,
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    const first = await b.tokenFor(h, a);
    now += 31 * 86_400_000;
    mode.v = "notcovered";
    expect(await b.tokenFor(h, a)).toBe(first);
    expect(await b.tokenFor(h, a)).toBe(first);
    expect(hub.seen.filter((s) => s.url === "/connect/agent")).toHaveLength(2);
    expect(hub.seen.filter((s) => s.url === "/connect/revoke")).toEqual([]);
  });

  it("403 install_token_required (an agent's own token tried to mint): logged once, never a loop", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    let now = 1_000_000;
    const logged: string[] = [];
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings({ retrySeconds: 60 }),
      now: () => now,
      log: (l) => void logged.push(l),
    });
    const ok = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    const agentTok = await b.tokenFor(ok, a);
    const wrong = { url: hub.url, token: agentTok! };
    const mints = () =>
      hub.seen.filter((s) => s.url === "/connect/agent").length;
    const before = mints();
    for (const id of ["bob", "cy", "bob"]) {
      now += 86_400_000;
      expect(await b.tokenFor(wrong, { ...a, id })).toBeNull();
    }
    expect(mints()).toBe(before + 1);
    const refused = logged.filter((l) => l.includes("install_token_required"));
    expect(refused).toHaveLength(1);
    expect(refused[0]).not.toContain(agentTok!);
    expect(await b.tokenFor(ok, { ...a, id: "bob" })).toMatch(/^hubi_/);
  });

  it("the mint's answer is {token, token_id, agent}: one for another agent is refused", async () => {
    const answer = (agent: unknown) =>
      hubMintAgentToken(
        "https://hub.example.test",
        INSTALL,
        { id: "ada", name: "Ada" },
        {
          fetch: async () =>
            new Response(
              JSON.stringify({
                token: "hubi_TESTONLY_agent_x",
                token_id: "00000000-0000-4000-8000-0000000000aa",
                agent,
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
        },
      );
    expect(await answer({ id: "ada", name: "Ada" })).toEqual({
      token: "hubi_TESTONLY_agent_x",
      tokenId: "00000000-0000-4000-8000-0000000000aa",
    });
    await expect(answer({ id: "bob", name: "Bob" })).rejects.toThrow(
      "another agent",
    );
  });
});

describe("issue 249: no live token left behind (security review)", () => {
  it("two 401s in a row: one mint, not two (Hub refusing new tokens is no mint storm)", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
    });
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    await b.tokenFor(h, a);
    b.rejected("ada");
    expect(await b.tokenFor(h, a)).toBeNull();
    b.rejected("ada");
    expect(await b.tokenFor(h, a)).toBeNull();
    expect(hub.seen.filter((x) => x.url === "/connect/agent")).toHaveLength(1);
  });

  it("a forced Disconnect keeps each token Hub couldn't revoke on the unrevoked record (doctor, and the retry at each start revokes it)", async () => {
    const mode = { v: "ok" as Mode };
    const hub = await fakeHub(mode);
    const stateDir = tmp();
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
      unrevoked: (u) => void recordUnrevoked(stateDir, u),
    });
    const h = { url: hub.url, token: INSTALL };
    await b.tokenFor(h, { id: "ada", name: "Ada", workspace: "north" });
    const kept = readAgentHubToken(stateDir, "ada")!;
    mode.v = "down";
    expect(await b.unbindAll(h, { force: true })).toEqual({
      revoked: 0,
      failed: 1,
    });
    expect(readAgentHubToken(stateDir, "ada")).toBeNull();
    const recs = readUnrevoked(stateDir);
    expect(recs).toHaveLength(1);
    expect(recs[0].why).toContain("ada");
    expect(recs[0].why).toContain(kept.tokenId);
    expect(JSON.stringify(recs)).not.toContain(kept.token);
    expect(hub.live.size).toBe(1);
    mode.v = "ok";
    expect(
      await retryUnrevoked({
        stateDir: () => stateDir,
        revoke: (u, t) => hubRevoke(u, t),
      }),
    ).toBe(1);
    expect(hub.live.size).toBe(0);
    expect(readUnrevoked(stateDir)).toEqual([]);
  });

  it("a revoke left pending is retried (at start and on hub.agent_token_revoke_retry_seconds), not only at an Undo or a Disconnect", async () => {
    const mode = { v: "ok" as Mode };
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
    expect(await b.retryPending(h)).toEqual({ revoked: 0, failed: 1 });
    mode.v = "ok";
    expect(await b.retryPending(h)).toEqual({ revoked: 1, failed: 0 });
    expect(hub.live.size).toBe(0);
    expect(readAgentHubToken(stateDir, "ada")).toBeNull();
    expect(
      readAgentTokenProblems(stateDir).filter((p) => p.agentId === "ada"),
    ).toEqual([]);
  });

  it("an agent removed while its first mint is in flight: the new token is revoked at once, never stored", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    let exists = true;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const b = new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
      agentExists: () => exists,
      mint: async (url, token, a) => {
        await gate;
        return hubMintAgentToken(url, token, a);
      },
    });
    const h = { url: hub.url, token: INSTALL };
    const going = b.tokenFor(h, { id: "ada", name: "Ada", workspace: "north" });
    exists = false;
    expect(await b.unbind(h, "ada")).toEqual({ revoked: false });
    release();
    expect(await going).toBeNull();
    expect(readAgentHubToken(stateDir, "ada")).toBeNull();
    expect(hub.live.size).toBe(0);
  });
});

describe("issue 249: a token outlives its agent record only to be revoked (security review)", () => {
  const store = (stateDir: string, rec: { exists: boolean; rid: string }) =>
    new HubAgentTokens({
      stateDir: () => stateDir,
      settings: settings(),
      agentExists: () => rec.exists,
      recordIdOf: () => (rec.exists ? rec.rid : undefined),
    });

  it("a removed agent's token its unbind never marked (the write failed): the retry revokes it, as at each start", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const rec = { exists: true, rid: "rec-one" };
    const b = store(stateDir, rec);
    const h = { url: hub.url, token: INSTALL };
    await b.tokenFor(h, { id: "ada", name: "Ada", workspace: "north" });
    rec.exists = false;
    expect(readAgentHubToken(stateDir, "ada")?.revokePending).toBeUndefined();
    expect(b.hasWaiting()).toBe(true);
    expect(await b.retryPending(h)).toEqual({ revoked: 1, failed: 0 });
    expect(hub.live.size).toBe(0);
    expect(readAgentHubToken(stateDir, "ada")).toBeNull();
    expect(b.hasWaiting()).toBe(false);
  });

  it("an agent made again with a removed one's id never gets its token: that one is revoked, a new one minted", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const rec = { exists: true, rid: "rec-one" };
    const b = store(stateDir, rec);
    const h = { url: hub.url, token: INSTALL };
    const a = { id: "ada", name: "Ada", workspace: "north" };
    const first = await b.tokenFor(h, a);
    const firstId = readAgentHubToken(stateDir, "ada")!.tokenId;
    expect(readAgentHubToken(stateDir, "ada")!.recordId).toBe("rec-one");
    rec.rid = "rec-two";
    const second = await b.tokenFor(h, a);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(hub.live.has(firstId)).toBe(false);
    expect(readAgentHubToken(stateDir, "ada")!.recordId).toBe("rec-two");
  });

  it("the retry revokes a token minted for an earlier record of that id, before the new agent calls Hub", async () => {
    const hub = await fakeHub();
    const stateDir = tmp();
    const rec = { exists: true, rid: "rec-one" };
    const b = store(stateDir, rec);
    const h = { url: hub.url, token: INSTALL };
    await b.tokenFor(h, { id: "ada", name: "Ada", workspace: "north" });
    rec.rid = "rec-two";
    expect(b.hasWaiting()).toBe(true);
    expect(await b.retryPending(h)).toEqual({ revoked: 1, failed: 0 });
    expect(hub.live.size).toBe(0);
    expect(readAgentHubToken(stateDir, "ada")).toBeNull();
  });
});

describe("issue 249: the settings, with permissive defaults", () => {
  it("hub.agent_tokens on, retry every 600 s, rotation every 30 days (0: never)", () => {
    const c = readHubConfig(
      { hub: { url: "https://hub.example.test" } },
      {},
      () => ({}) as never,
    );
    expect(c?.agentTokens).toBe(true);
    expect(c?.agentTokenRetrySeconds).toBe(600);
    expect(c?.agentTokenMaxAgeDays).toBe(30);
    expect(c?.agentTokenRevokeRetrySeconds).toBe(600);
    expect(agentHubTokenSettingsOf(c!).revokeRetrySeconds).toBe(600);
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
    expect(rd({ agent_token_max_age_days: 0 })()?.agentTokenMaxAgeDays).toBe(0);
    expect(rd({ agent_token_revoke_retry_seconds: 1 })).toThrow(
      "hub.agent_token_revoke_retry_seconds",
    );
    expect(
      rd({ agent_token_revoke_retry_seconds: 60 })()
        ?.agentTokenRevokeRetrySeconds,
    ).toBe(60);
  });
});
