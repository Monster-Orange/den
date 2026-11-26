import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

type FakeHub = {
  url: string;
  token: string;
  server: http.Server | null;
  down: boolean;
  revoked: boolean;
  challenge: string;
  redirectUri: string;
};

const CODE = "code_TESTONLY_1632";
const oldHub: FakeHub = {
  url: "",
  token: "hubi_TESTONLY_old_1632b",
  server: null,
  down: false,
  revoked: false,
  challenge: "",
  redirectUri: "",
};
const newHub: FakeHub = { ...oldHub, token: "hubi_TESTONLY_new_1632b" };

function startHub(h: FakeHub, slug: string): Promise<void> {
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const company = () => ({ slug, name: slug, url: `${h.url}/c/${slug}` });
  h.server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const bearer = req.headers.authorization === `Bearer ${h.token}`;
    if (u.pathname === "/connect" && req.method === "GET") {
      h.challenge = u.searchParams.get("code_challenge") ?? "";
      h.redirectUri = u.searchParams.get("redirect_uri") ?? "";
      const back = new URL(h.redirectUri);
      back.searchParams.set("state", u.searchParams.get("state") ?? "");
      back.searchParams.set("code", CODE);
      res.writeHead(303, { location: back.toString() });
      return void res.end();
    }
    if (u.pathname === "/connect/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        if (h.down) return json(res, 503, { error: "down for maintenance" });
        const b = JSON.parse(raw) as Record<string, string>;
        const pkce = crypto
          .createHash("sha256")
          .update(b.code_verifier ?? "")
          .digest("base64url");
        if (b.code !== CODE || pkce !== h.challenge)
          return json(res, 400, { error: "invalid_grant" });
        h.revoked = false;
        json(res, 200, {
          token: h.token,
          install: "den on test-box",
          role: "member",
          company: company(),
          hub_url: h.url,
          mcp_url: `${h.url}/mcp`,
        });
      });
      return;
    }
    if (u.pathname === "/connect/whoami") {
      if (!bearer || h.revoked) return json(res, 401, { error: "no" });
      return json(res, 200, {
        install: "den on test-box",
        role: "member",
        login: "pat",
        company: company(),
        mcp_url: `${h.url}/mcp`,
      });
    }
    if (u.pathname === "/api/projects/suggest") {
      if (!bearer || h.revoked) return json(res, 401, { error: "no" });
      return json(res, 200, { suggestions: [], projects: [] });
    }
    if (u.pathname === "/connect/revoke" && req.method === "POST") {
      if (!bearer || h.revoked) return json(res, 401, { error: "no" });
      h.revoked = true;
      return json(res, 200, { revoked: true });
    }
    res.writeHead(404).end();
  });
  return new Promise((r) =>
    h.server!.listen(0, "127.0.0.1", () => {
      h.url = `http://127.0.0.1:${(h.server!.address() as AddressInfo).port}`;
      r();
    }),
  );
}

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  await startHub(oldHub, "old-co");
  await startHub(newHub, "new-co");
  s = await startAgentsPageServer();
  const log = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  for (const entry of log) {
    latest = entry.version;
    break;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s, oldHub.server, newHub.server],
  });
});

async function settings(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      return;
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await signInPage(p, s!.stateDir, s!.base, "/settings");
  await p.waitForSelector('[data-setting="agents.hub"]');
  return p;
}

const userYml = () =>
  fs.readFileSync(
    path.join(s!.tmp, "dist", "config", "local", "user.yml"),
    "utf-8",
  );
const bellKeys = (): string[] => {
  try {
    const f = JSON.parse(
      fs.readFileSync(path.join(s!.stateDir, "notifications.json"), "utf-8"),
    ) as { items?: { msg?: { key?: string } }[] };
    return (f.items ?? []).map((n) => n.msg?.key ?? "");
  } catch {
    return [];
  }
};
const switchFile = () => path.join(s!.stateDir, "hub", "switch.json");

describe("issue 1632: switching Hubs in the browser", () => {
  it("connected to one Hub, a pending switch shows; a failed sign-in keeps the old Hub and says why; a good one switches", async () => {
    if (!browser) return;
    const p = await settings();
    await p.fill("#hub-url", oldHub.url);
    await p.click('[data-hub-action="connect"]');
    await p.waitForSelector('[data-hub-state="connected"]', {
      timeout: 20_000,
    });
    expect(userYml()).toContain(oldHub.url);

    fs.writeFileSync(
      switchFile(),
      JSON.stringify({
        to: newHub.url,
        from: oldHub.url,
        at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    await p.reload();
    const row = await p.waitForSelector("[data-hub-switching]", {
      timeout: 20_000,
    });
    expect(await row.textContent()).toContain(newHub.url);
    expect(await row.textContent()).toContain(oldHub.url);

    newHub.down = true;
    await p.click("[data-hub-switch-signin]");
    await p.waitForSelector('[data-hub-flash="failed"]', { timeout: 20_000 });
    expect(await p.textContent("[data-hub-flash]")).toMatch(/maintenance|503/);
    await p.waitForSelector('[data-hub-state="connected"]');
    expect(userYml()).toContain(oldHub.url);
    expect(userYml()).not.toContain(newHub.url);
    expect(oldHub.revoked).toBe(false);
    expect(bellKeys()).toContain("bell.m.hubSwitchFailed");
    await p.waitForSelector("[data-hub-switching]");

    newHub.down = false;
    await p.click("[data-hub-switch-signin]");
    await p.waitForSelector('[data-hub-flash="ok"]', { timeout: 20_000 });
    await p.waitForSelector('[data-hub-state="connected"]');
    expect(await p.$("[data-hub-switching]")).toBeNull();
    expect(userYml()).toContain(newHub.url);
    expect(userYml()).not.toContain(oldHub.url);
    expect(oldHub.revoked).toBe(true);
    expect(fs.existsSync(switchFile())).toBe(false);
    for (const t of [oldHub.token, newHub.token])
      expect(await p.content()).not.toContain(t);
    await p.context().close();
  }, 120_000);

  it("raised no page errors", () => {
    if (!browser) return;
    expect(errors).toEqual([]);
  });
});
