/**
 * HUB-1.5: hub.* config, the caller headers, owner/repo from a catalog
 * entry, whoami over Streamable HTTP, and the status Settings and doctor
 * show. Never this machine's config or secrets store; a local MCP server
 * on localhost plays Hub. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  hubHeaders,
  hubStatus,
  hubUrlProblem,
  hubWhoami,
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
    });
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

/** A Hub on localhost: one whoami tool, the bearer token required. */
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
});
async function fakeHub(
  who: Record<string, unknown> = { team: "Acme", label: "north-box" },
): Promise<{ url: string; auths: string[] }> {
  const auths: string[] = [];
  const s = http.createServer((req, res) => {
    auths.push(String(req.headers.authorization ?? ""));
    if (req.url !== "/mcp") return void res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return void res.writeHead(401).end("unauthorized");
    const mcp = new McpServer({ name: "fake-hub", version: "1" });
    mcp.registerTool("hub_whoami", { description: "who" }, async () => ({
      content: [{ type: "text", text: JSON.stringify(who) }],
    }));
    const t = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => void t.close());
    void mcp.connect(t).then(() => t.handleRequest(req, res));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "localhost", () => r()));
  return {
    url: `http://localhost:${(s.address() as AddressInfo).port}`,
    auths,
  };
}

describe("hubWhoami", () => {
  it("calls Hub's whoami with the bearer token and reads team and label", async () => {
    const h = await fakeHub();
    expect(await hubWhoami(h.url, TOKEN)).toEqual({
      team: "Acme",
      label: "north-box",
    });
    expect(h.auths.length).toBeGreaterThan(0);
    expect(h.auths.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("team_name and install_label work too", async () => {
    const h = await fakeHub({ team_name: "Acme", install_label: "kit-box" });
    expect(await hubWhoami(h.url, TOKEN)).toEqual({
      team: "Acme",
      label: "kit-box",
    });
  });

  it("a wrong token fails", async () => {
    const h = await fakeHub();
    await expect(hubWhoami(h.url, "hubi_wrong")).rejects.toThrow();
  });

  it("no answer in time fails, saying so", async () => {
    const s = http.createServer(() => undefined); // never answers
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "localhost", () => r()));
    const url = `http://localhost:${(s.address() as AddressInfo).port}`;
    await expect(hubWhoami(url, TOKEN, { timeoutMs: 200 })).rejects.toThrow(
      /did not answer in 200 ms/,
    );
    s.closeAllConnections();
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
        whoami: async () => ({ team: "Acme", label: "north-box" }),
      }),
    ).toEqual({
      configured: true,
      url: cfg.url,
      allowTools: true,
      connected: true,
      team: "Acme",
      label: "north-box",
    });
  });

  it("each problem in words, and never the token", async () => {
    const bad = await hubStatus({
      config: () => {
        throw new Error("hub.url must be https (http only to this machine): x");
      },
    });
    expect(bad).toMatchObject({ connected: false, problem: /must be https/ });
    expect(
      await hubStatus({ config: () => ({ ...cfg, tokenRef: null }) }),
    ).toMatchObject({ connected: false, problem: /no hub\.token/ });
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
      problem: /Hub did not answer/,
    });
    expect(JSON.stringify(down)).not.toContain(TOKEN);
  });

  it("scrubToken cuts the token out of any message", () => {
    expect(scrubToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe(
      "a [token] b [token]",
    );
    expect(scrubToken("plain", null)).toBe("plain");
  });
});
