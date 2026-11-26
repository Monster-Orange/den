/**
 * Settings › Hub (HUB-1.5, HUB-1.7 Connect to Hub).
 *
 * The row is always there. Not connected: Hub's address and Connect.
 * Connected: the company (a link), role, who signed in, this install, and
 * Disconnect. A token Hub refuses offers Reconnect; a role that may no
 * longer connect says to ask an admin. Never the token.
 *
 * Most cases answer /api/hub from the test. One runs the real path: the
 * real server, a fake Hub on 127.0.0.1 (another site, as Hub is), and the
 * browser through Hub's /connect, Den's /hub/callback and back to Settings;
 * then Disconnect revokes the token on Hub.
 *
 * The demo distribution (helpers/agents-page-server.ts; secrets provider
 * none, so the token goes to Den's 0600 file). Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names only.
 */
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

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

const TOKEN = "hubi_TESTONLY_conn_7f3a";
const CODE = "code_TESTONLY_51c";

/** A Hub on 127.0.0.1: /connect, /connect/token, whoami, revoke. */
const hub = {
  url: "",
  server: null as http.Server | null,
  deny: false,
  revoked: false,
  seen: [] as { path: string; q: Record<string, string> }[],
  exchanged: [] as Record<string, unknown>[],
  challenge: "",
  redirectUri: "",
};
const company = () => ({
  slug: "acme-co",
  name: "Acme Co",
  url: `${hub.url}/c/acme-co`,
});

function startHub(): Promise<void> {
  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  hub.server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    hub.seen.push({ path: u.pathname, q: Object.fromEntries(u.searchParams) });
    const bearer = req.headers.authorization === `Bearer ${TOKEN}`;
    if (u.pathname === "/connect" && req.method === "GET") {
      // Hub's approve page, approved (or declined) at once.
      hub.challenge = u.searchParams.get("code_challenge") ?? "";
      hub.redirectUri = u.searchParams.get("redirect_uri") ?? "";
      const back = new URL(hub.redirectUri);
      back.searchParams.set("state", u.searchParams.get("state") ?? "");
      if (hub.deny) back.searchParams.set("error", "access_denied");
      else back.searchParams.set("code", CODE);
      res.writeHead(303, { location: back.toString() });
      return void res.end();
    }
    if (u.pathname === "/connect/token" && req.method === "POST") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const b = JSON.parse(raw) as Record<string, string>;
        hub.exchanged.push(b);
        const pkce = crypto
          .createHash("sha256")
          .update(b.code_verifier ?? "")
          .digest("base64url");
        if (
          b.grant_type !== "authorization_code" ||
          b.code !== CODE ||
          b.redirect_uri !== hub.redirectUri ||
          pkce !== hub.challenge
        )
          return json(res, 400, { error: "invalid_grant" });
        hub.revoked = false;
        json(res, 200, {
          token: TOKEN,
          install: "den on test-box",
          role: "member",
          company: company(),
          hub_url: hub.url,
          mcp_url: `${hub.url}/mcp`,
        });
      });
      return;
    }
    if (u.pathname === "/connect/whoami") {
      if (!bearer || hub.revoked)
        return json(res, 401, { error: "unauthorized" });
      return json(res, 200, {
        install: "den on test-box",
        role: "member",
        login: "pat",
        company: company(),
        mcp_url: `${hub.url}/mcp`,
      });
    }
    // Issue 646: Connect's review asks Hub for each project's suggestions
    // and the company's projects; this Hub has one project, none suggested.
    if (u.pathname === "/api/projects/suggest") {
      if (!bearer || hub.revoked)
        return json(res, 401, { error: "unauthorized" });
      return json(res, 200, {
        suggestions: [],
        projects: [
          { project_id: "proj_acme1", slug: "acme-web", name: "Acme Web" },
        ],
      });
    }
    if (u.pathname === "/connect/revoke" && req.method === "POST") {
      if (!bearer || hub.revoked)
        return json(res, 401, { error: "unauthorized" });
      hub.revoked = true;
      return json(res, 200, { revoked: true });
    }
    res.writeHead(404).end();
  });
  return new Promise((r) =>
    hub.server!.listen(0, "127.0.0.1", () => {
      hub.url = `http://127.0.0.1:${(hub.server!.address() as AddressInfo).port}`;
      r();
    }),
  );
}

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  await startHub();
  s = await startAgentsPageServer();
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s, hub.server],
  });
});

const skip = () => !browser;

/** Settings, with /api/hub answered from `answer` (or the real one). */
async function page(answer?: unknown, width = 1440): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  if (answer !== undefined)
    await p.route("**/api/hub", (r) =>
      r.fulfill({
        contentType: "application/json",
        body: JSON.stringify(answer),
      }),
    );
  const answered = p.waitForResponse((r) => r.url().endsWith("/api/hub"));
  await signInPage(p, s!.stateDir, s!.base, "/settings");
  await answered;
  await p.waitForSelector('[data-setting="agents.hub"]');
  return p;
}

const shown = (p: Page) =>
  p.$eval(
    '[data-setting="agents.hub"]',
    (el) => !(el as HTMLElement).closest("[hidden]"),
  );
const hubText = (p: Page) =>
  p.$eval('[data-setting="agents.hub"]', (el) => el.textContent ?? "");
const fits = (p: Page) =>
  p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

describe("#267: Settings › Hub, a section of its own, with Hub's address", () => {
  it("Hub's rows sit in their own section, with the same ids", async () => {
    if (skip()) return;
    const p = await page(undefined);
    for (const id of [
      "agents.hub",
      "agents.hub_link_all",
      "distribution.hub_github",
      "notifications.hub",
      "notifications.pick",
      "notifications.shared",
    ])
      expect(
        await p.$eval(`[data-setting="${id}"]`, (el) =>
          el.closest("section[data-cat]")?.getAttribute("data-cat"),
        ),
      ).toBe("hub");
    expect(await p.textContent('a.set-ni[data-cat="hub"]')).toMatch(/Hub/);
    expect(await p.textContent('section[data-cat="hub"]')).toMatch(
      /docs\/hub\.md/,
    );
    await p.context().close();
  });

  it("a broken address can be fixed here: the check as you type, Save only when it's right", async () => {
    if (skip()) return;
    const p = await page({
      configured: true,
      state: "bad_config",
      url: "http://hub.example.com",
      problem:
        "hub.url must be https (http only to this machine): http://hub.example.com",
    });
    await p.waitForSelector("#hub-addr");
    await p.fill("#hub-addr", "http://hub.example.com");
    expect(await p.isVisible("[data-hub-addr-problem]")).toBe(true);
    expect(await p.textContent("[data-hub-addr-problem]")).toMatch(
      /https:\/\//,
    );
    expect(await p.isDisabled('[data-hub-action="save-url"]')).toBe(true);
    await p.fill("#hub-addr", "https://hub.example.com");
    expect(await p.isVisible("[data-hub-addr-problem]")).toBe(false);
    expect(await p.isDisabled('[data-hub-action="save-url"]')).toBe(false);
    await p.context().close();
  });

  it("connected: the company shows; Save of a new address disconnects, writes it, and restarts Den", async () => {
    if (skip()) return;
    const p = await page({
      configured: true,
      connected: true,
      state: "connected",
      url: "https://hub.example.com",
      team: "Example Co",
    });
    const calls: string[] = [];
    await p.route("**/api/hub/disconnect", (r) => {
      calls.push("disconnect");
      return r.fulfill({
        contentType: "application/json",
        body: '{"ok":true,"message":"Disconnected."}',
      });
    });
    await p.route("**/api/settings", (r) => {
      if (r.request().method() !== "POST") return r.fallback();
      calls.push(`settings ${r.request().postData()}`);
      return r.fulfill({
        contentType: "application/json",
        body: '{"ok":true}',
      });
    });
    await p.route("**/api/web/restart", (r) => {
      calls.push("restart");
      return r.abort();
    });
    expect(await hubText(p)).toMatch(/Example Co/);
    // Issue 646 (mock v2, 1b): connected, the address waits behind Hub address….
    expect(await p.isVisible("#hub-addr")).toBe(false);
    await p.click('[data-hub-action="address"]');
    expect(await p.inputValue("#hub-addr")).toBe("https://hub.example.com");
    await p.fill("#hub-addr", "https://other.example.com/");
    await p.click('[data-hub-action="save-url"]');
    for (let i = 0; i < 100 && !calls.includes("restart"); i++)
      await p.waitForTimeout(100);
    expect(calls).toEqual([
      "disconnect",
      'settings {"hub_url":"https://other.example.com"}',
      "restart",
    ]);
    await p.context().close();
  });
});

describe("Settings › Hub (HUB-1.7)", () => {
  it("no hub.url: the row asks for Hub's address and Connect; Connect with none says so", async () => {
    if (skip()) return;
    const p = await page(undefined, 375);
    await p.waitForSelector("[data-hub-connect]");
    expect(await shown(p)).toBe(true);
    expect(await p.inputValue("#hub-url")).toBe("");
    await p.click('[data-hub-action="connect"]');
    await p.waitForSelector(
      '[data-setting="agents.hub"] .rt-err:not([hidden])',
    );
    expect(await p.textContent('[data-setting="agents.hub"] .rt-err')).toMatch(
      /type Hub's address first/,
    );
    expect(await fits(p)).toBeLessThanOrEqual(0);
    await p.context().close();
  }, 60_000);

  it("connected: Connected, the company as a plain link (this tab, D51), role, who signed in, this install, Disconnect", async () => {
    if (skip()) return;
    const p = await page({
      configured: true,
      url: "https://hub.example.test",
      connected: true,
      state: "connected",
      team: "Acme Co",
      teamUrl: "https://hub.example.test/c/acme-co",
      role: "member",
      login: "pat",
      label: "den on north-box",
      allowTools: true,
    });
    await p.waitForSelector('[data-hub-state="connected"]');
    // Issue 646 (mock v2, 1b): the company first, then the list.
    const text = await hubText(p);
    for (const t of [
      "https://hub.example.test",
      "Connected",
      "Acme Co",
      "member",
      "pat",
      "den on north-box",
    ])
      expect(text).toContain(t);
    // D51: like the rail's Hub, a plain link: this tab, no new window.
    expect(
      await p.$eval('[data-hub-co] a[href*="/c/acme-co"]', (a) => [
        a.getAttribute("target"),
        a.getAttribute("href"),
      ]),
    ).toEqual([null, "https://hub.example.test/c/acme-co"]);
    expect(await p.$('[data-hub-action="disconnect"]')).not.toBeNull();
    expect(await p.$('button[data-hub-action="connect"]')).toBeNull();
    await p.context().close();
  }, 60_000);

  it("a token Hub refuses: says so and offers Reconnect; fits at 375", async () => {
    if (skip()) return;
    const p = await page(
      {
        configured: true,
        url: "https://hub.example.test",
        connected: false,
        state: "rejected",
        problem: "Hub refused it (401)",
      },
      375,
    );
    await p.waitForSelector('[data-hub-state="rejected"]');
    expect(await p.textContent("[data-hub-problem]")).toMatch(/Reconnect/);
    expect(await p.textContent('button[data-hub-action="connect"]')).toBe(
      "Reconnect",
    );
    expect(await fits(p)).toBeLessThanOrEqual(0);
    await p.context().close();
  }, 60_000);

  it("a role that may no longer connect: ask an admin, never a retry", async () => {
    if (skip()) return;
    const p = await page({
      configured: true,
      url: "https://hub.example.test",
      connected: false,
      state: "forbidden",
      problem: "your role (viewer) no longer allows Den installs",
    });
    await p.waitForSelector('[data-hub-state="forbidden"]');
    expect(await p.textContent("[data-hub-problem]")).toMatch(
      /Ask a Hub admin/,
    );
    expect(await p.$('button[data-hub-action="connect"]')).toBeNull();
    await p.context().close();
  }, 60_000);

  it("Hub unreachable: Disconnect removes nothing, then offers to remove it here anyway", async () => {
    if (skip()) return;
    const p = await page({
      configured: true,
      url: "https://hub.example.test",
      connected: false,
      state: "unreachable",
      problem: "Hub did not answer in 5000 ms",
    });
    const posted: unknown[] = [];
    await p.route("**/api/hub/disconnect", (r) => {
      const body = r.request().postDataJSON() as Record<string, unknown>;
      posted.push(body);
      return body.force
        ? r.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              revoked: false,
              message: "Disconnected. Hub couldn't be reached.",
            }),
          })
        : r.fulfill({
            status: 502,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: "Hub couldn't revoke the token. Nothing was removed.",
            }),
          });
    });
    // Disconnect asks first, saying what it does; Cancel and Escape do
    // nothing, and focus goes back to Disconnect.
    await p.click('[data-hub-action="disconnect"]');
    const ask = p.locator("[data-hub-confirm]");
    await ask.waitFor();
    expect(await ask.textContent()).toContain(
      "This revokes this Den's Hub key on Hub. Agents lose Hub until you Connect again.",
    );
    expect(
      await p.evaluate(() =>
        document.activeElement?.getAttribute("data-hub-action"),
      ),
    ).toBe("disconnect-no");
    await p.click('[data-hub-action="disconnect-no"]');
    expect(await ask.isHidden()).toBe(true);
    expect(
      await p.evaluate(() =>
        document.activeElement?.getAttribute("data-hub-action"),
      ),
    ).toBe("disconnect");
    await p.click('[data-hub-action="disconnect"]');
    await ask.waitFor();
    await p.keyboard.press("Escape");
    expect(await ask.isHidden()).toBe(true);
    expect(posted).toEqual([]);
    await p.click('[data-hub-action="disconnect"]');
    await p.click('[data-hub-action="disconnect-yes"]');
    await p.waitForSelector('[data-hub-action="force"]');
    expect(await p.textContent('[data-setting="agents.hub"] .rt-err')).toMatch(
      /Nothing was removed/,
    );
    await p.unroute("**/api/hub");
    await p.route("**/api/hub", (r) =>
      r.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          configured: true,
          url: "https://hub.example.test",
          connected: false,
          state: "no_token",
        }),
      }),
    );
    await p.click('[data-hub-action="force"]');
    await p.waitForSelector("[data-hub-flash]");
    expect(posted).toEqual([{}, { force: true }]);
    expect(await p.textContent("[data-hub-flash]")).toMatch(/Disconnected/);
    expect(await p.inputValue("#hub-url")).toBe("https://hub.example.test");
    await p.context().close();
  }, 60_000);

  it("Hub's tools: on with its note; unchecking saves hub_allow_tools false", async () => {
    if (skip()) return;
    const answer = {
      configured: true,
      url: "https://hub.example.test",
      connected: true,
      state: "connected",
      allowTools: true,
    };
    const p = await page(answer);
    const posted: unknown[] = [];
    await p.route("**/api/settings", (r) => {
      const body = r.request().postDataJSON() as Record<string, unknown> | null;
      if (
        r.request().method() === "POST" &&
        body &&
        "hub_allow_tools" in body
      ) {
        posted.push(body);
        answer.allowTools = body.hub_allow_tools as boolean;
        return r.fulfill({
          contentType: "application/json",
          body: '{"ok":true}',
        });
      }
      return r.continue();
    });
    await p.unroute("**/api/hub");
    await p.route("**/api/hub", (r) =>
      r.fulfill({
        contentType: "application/json",
        body: JSON.stringify(answer),
      }),
    );
    expect(await p.isChecked("#hub-allow-tools")).toBe(true);
    expect(await p.$eval("[data-hub-tools-note]", (el) => el.textContent)).toBe(
      "Agents can publish and comment in Hub without asking; writes are versioned and stay in this install's team.",
    );
    await p.click("#hub-allow-tools");
    await p.waitForFunction(() =>
      /ask before each Hub tool/.test(
        document.querySelector("[data-hub-tools-note]")?.textContent ?? "",
      ),
    );
    expect(posted).toEqual([{ hub_allow_tools: false }]);
    expect(await p.isChecked("#hub-allow-tools")).toBe(false);
    await p.context().close();
  }, 60_000);

  it("D44: agents started before Hub connected: the offer to restart them at their next idle", async () => {
    if (skip()) return;
    const p = await page(
      {
        configured: true,
        url: "https://hub.example.test",
        connected: true,
        state: "connected",
        allowTools: true,
        connect: { ok: true, message: "Connected to Hub." },
      },
      375,
    );
    const asked: string[] = [];
    const JOB_CMD = "npm run dev";
    const stale = [
      {
        id: "planner",
        workspace: "north",
        stale: { adds: ["hub"], drops: [] },
      },
      { id: "scout", workspace: "south", stale: { adds: ["hub"], drops: [] } },
    ];
    await p.route("**/api/agents/stale*", (r) => {
      asked.push(new URL(r.request().url()).search);
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ agents: stale }),
      });
    });
    let restarts = 0;
    await p.route("**/api/agents/restart-stale", (r) => {
      restarts++;
      return r.fulfill({
        status: 202,
        contentType: "application/json",
        // Issue 1407: each agent's own answer.
        body: JSON.stringify({
          ok: true,
          pending: stale,
          agents: [
            { id: "planner", workspace: "north", state: "now" },
            {
              id: "scout",
              workspace: "south",
              state: "job",
              job: { command: JOB_CMD, minutes: 12 },
            },
          ],
        }),
      });
    });
    await p.reload();
    await p.waitForSelector('[data-hub-restart="2"]');
    // Right after Connect: Den asks Hub's config again (fresh).
    expect(asked).toEqual(["?fresh=1"]);
    expect(await p.textContent("[data-hub-restart]")).toContain(
      "2 agents started before Hub was connected, so they don't have Hub's tools yet.",
    );
    expect(await p.textContent('[data-hub-action="restart-stale"]')).toBe(
      "Restart 2 agents at their next idle",
    );
    expect(await fits(p)).toBeLessThanOrEqual(0);
    await p.click('[data-hub-action="restart-stale"]');
    await p.waitForSelector('[data-rs-result="2"]');
    expect(restarts).toBe(1);
    // Issue 1407: never a fixed line; the job is named, with Restart now.
    expect(
      await p.getAttribute('[data-rs-agent="planner"]', "data-rs-state"),
    ).toBe("now");
    expect(
      await p.getAttribute('[data-rs-agent="scout"]', "data-rs-state"),
    ).toBe("job");
    expect(await p.textContent('[data-rs-agent="scout"]')).toContain(JOB_CMD);
    // Restart now only for the one that waits on the person.
    expect(await p.locator("[data-rs-now]").count()).toBe(1);
    expect(await p.locator('[data-rs-now="scout"]').count()).toBe(1);
    expect(await fits(p)).toBeLessThanOrEqual(0);
    await p.context().close();
  }, 60_000);

  it("D44: no agent out of date, no offer", async () => {
    if (skip()) return;
    const p = await page({
      configured: true,
      url: "https://hub.example.test",
      connected: true,
      state: "connected",
      allowTools: true,
    });
    await p.waitForSelector('[data-hub-state="connected"]');
    await p.waitForTimeout(300);
    expect(await p.$("[data-hub-restart]")).toBeNull();
    await p.context().close();
  }, 60_000);

  it("the real path: declined on Hub comes back saying so, and connects nothing", async () => {
    if (skip()) return;
    hub.deny = true;
    const p = await page();
    await p.fill("#hub-url", hub.url);
    await p.click('[data-hub-action="connect"]');
    await p.waitForSelector('[data-hub-flash="failed"]', { timeout: 20_000 });
    expect(await p.textContent("[data-hub-flash]")).toMatch(/declined on Hub/);
    expect(new URL(p.url()).searchParams.get("hub")).toBeNull();
    expect(hub.exchanged).toEqual([]);
    await p.waitForSelector("[data-hub-connect]");
    await p.context().close();
    hub.deny = false;
  }, 60_000);

  it("the real path: Connect → Hub → back connected; the token never reaches the page; Disconnect revokes it", async () => {
    if (skip()) return;
    const p = await page();
    const bodies: string[] = [];
    p.on("response", (r) => {
      if (/\/api\/hub|\/hub\/callback/.test(r.url()))
        void r.text().then(
          (t) => bodies.push(t),
          () => undefined,
        );
    });
    await p.fill("#hub-url", hub.url);
    await p.click('[data-hub-action="connect"]');
    await p.waitForSelector('[data-hub-state="connected"]', {
      timeout: 20_000,
    });
    // What Den asked Hub for: its callback, S256, a state, this install.
    const asked = hub.seen.find((x) => x.path === "/connect")!.q;
    expect(asked.redirect_uri).toBe(`${s!.base}/hub/callback`);
    expect(asked.code_challenge_method).toBe("S256");
    expect(asked.code_challenge).toHaveLength(43);
    expect(asked.state.length).toBeGreaterThanOrEqual(8);
    expect(asked.install).toMatch(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/);
    // Back in Settings, with words and the company.
    // Issue 646 (mock v2, 1c): one line naming the company and its Hub.
    expect(await p.textContent("[data-hub-flash]")).toMatch(
      /Connected to Acme Co \(/,
    );
    const text = await hubText(p);
    for (const t of ["Acme Co", "member", "pat", "den on test-box"])
      expect(text).toContain(t);
    expect(new URL(p.url()).searchParams.get("hub")).toBeNull();
    // Kept in Den's own file, 0600; user.yml names the file, not the token.
    const userYml = fs.readFileSync(
      path.join(s!.tmp, "dist", "config", "local", "user.yml"),
      "utf-8",
    );
    expect(userYml).toContain(hub.url);
    expect(userYml).not.toContain(TOKEN);
    const named = /token: file:(\S+)/.exec(userYml)?.[1] ?? "";
    expect(path.dirname(named)).toBe(
      fs.realpathSync(path.join(s!.stateDir, "hub")),
    );
    expect(path.basename(named)).toMatch(/^token-[0-9a-f]{10}$/);
    const file = named;
    expect(fs.readFileSync(file, "utf-8").trim()).toBe(TOKEN);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // The callback's state is single use: replaying it changes nothing.
    const replay = await fetch(
      `${s!.base}/hub/callback?state=${encodeURIComponent(asked.state)}&code=${CODE}`,
    );
    expect(replay.status).toBe(400);
    expect(hub.exchanged).toHaveLength(1);
    // Never the token, in any page or answer.
    expect(await p.content()).not.toContain(TOKEN);
    // Disconnect: revoked on Hub, gone here, back to Connect.
    await p.click('[data-hub-action="disconnect"]');
    await p.click('[data-hub-action="disconnect-yes"]');
    await p.waitForSelector("[data-hub-connect]");
    expect(await p.textContent("[data-hub-flash]")).toMatch(
      /Hub revoked this install's token/,
    );
    expect(hub.revoked).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(await p.inputValue("#hub-url")).toBe(hub.url);
    await new Promise((r) => setTimeout(r, 200));
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) expect(b).not.toContain(TOKEN);
    await p.context().close();
  }, 90_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
