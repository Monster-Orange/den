/**
 * Issue 455 (mock v3): when the wanted address answers as another server,
 * every page shows the address banner once: "Den is at {address} for
 * now.", why, "Fix it in Settings › Edge" and ×. Dismissed, or on a later
 * page, it says nothing. The Edge page shows the card: the owner, "What
 * would you like to do?" with "Add Den to that proxy" before "Free port
 * 80", the three proxies, Copy and Check again. 1440 and 390 wide, in
 * Chromium and WebKit, with no side scroll.
 *
 * The check's answer is faked at the page's network (GET
 * /api/edge/address), so nothing binds a port or reaches Docker. DEN_PW_WS
 * connects to a Playwright server instead of launching; DEN455_SHOTS (a
 * folder) keeps a screenshot of each state. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

jest.setTimeout(90_000);

const ENGINES = ["chromium", "webkit"] as const;
const WIDTHS = [1440, 390] as const;
const SHOTS = process.env.DEN455_SHOTS?.trim() || "";
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const ws = process.env.DEN_PW_WS;
    for (const e of ENGINES)
      browsers[e] = ws
        ? await pw[e].connect(ws, { exposeNetwork: "<loopback>" })
        : await pw[e].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

const NGINX = [
  "server {",
  "  listen 80;",
  "  server_name den.acme.localhost;",
  "  location / {",
  "    proxy_pass http://host.docker.internal:4321;",
  "    proxy_http_version 1.1;",
  "    proxy_set_header Host $host;",
  "    proxy_set_header Upgrade $http_upgrade;",
  '    proxy_set_header Connection "upgrade";',
  "  }",
  "}",
].join("\n");

/** What the check found: another server holds the wanted address's port. */
const held = (direct: string) => ({
  ok: true,
  checkedAt: new Date().toISOString(),
  wanted: "http://den.acme.localhost",
  wantedAnswer: "other",
  direct,
  directOk: true,
  address: direct,
  port: 80,
  owner: {
    owner: "nginx",
    kind: "container",
    name: "web-proxy-1",
    denEdge: false,
  },
  answeredAs: "nginx",
  routes: {
    nginx: NGINX,
    caddy:
      "http://den.acme.localhost {\n  reverse_proxy host.docker.internal:4321\n}",
    traefik:
      'http:\n  routers:\n    den:\n      rule: "Host(`den.acme.localhost`)"',
  },
  routeKind: "nginx",
  edge: {
    container: "acme-edge",
    state: "absent",
    publish: true,
    ports: [
      {
        port: 80,
        held: true,
        by: {
          owner: "nginx",
          kind: "container",
          name: "web-proxy-1",
          denEdge: false,
        },
      },
      { port: 443, held: false, by: null },
    ],
  },
});

async function open(e: (typeof ENGINES)[number], width: number): Promise<Page> {
  const ctx = await browsers[e]!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
    } catch {
      /* none */
    }
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const p = await ctx.newPage();
  await p.route("**/api/edge/address", (r) =>
    r.fulfill({ json: held(s!.base) }),
  );
  return p;
}

const shot = async (p: Page, name: string) => {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`) });
};

const sideScroll = (p: Page) =>
  p.evaluate(
    () =>
      document.documentElement.scrollWidth >
      document.documentElement.clientWidth + 1,
  );

describe.each(ENGINES)("issue 455 in %s", (e) => {
  describe.each(WIDTHS)("%ipx wide", (width) => {
    it("the banner: once, its words, the fix link, ×; gone on the next page", async () => {
      if (!browsers[e] || !s) return;
      const p = await open(e, width);
      await p.goto(`${s.base}/agents`);
      const b = p.locator('[data-banner="den-address"]');
      await b.waitFor({ timeout: 20_000 });
      const text = ((await b.textContent()) ?? "").replace(/\s+/g, " ");
      expect(text).toContain(`Den is at ${s.base} for now.`);
      expect(text).toContain(
        "Port 80 is held by nginx (web-proxy-1), so den.acme.localhost goes to that server instead.",
      );
      const fix = b.locator(".den-bn-a");
      expect(await fix.textContent()).toBe("Fix it in Settings › Edge");
      expect(await fix.getAttribute("href")).toBe("/edge");
      const x = b.locator(".den-bn-x");
      const box = await x.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(await sideScroll(p)).toBe(false);
      await shot(p, `banner-${e}-${width}`);

      await x.click();
      await b.waitFor({ state: "detached", timeout: 5000 });
      await shot(p, `dismissed-${e}-${width}`);
      // Shown once for this address: the next page says nothing.
      await p.goto(`${s.base}/agents`);
      await p.waitForTimeout(1500);
      expect(await b.count()).toBe(0);
      await p.context().close();
    });

    it("Settings › Edge: the owner, the two choices in order, the route, Copy, Check again", async () => {
      if (!browsers[e] || !s) return;
      const p = await open(e, width);
      await p.goto(`${s.base}/edge`);
      const card = p.locator("[data-address-card]");
      await card.waitFor({ timeout: 20_000 });
      const text = ((await card.textContent()) ?? "").replace(/\s+/g, " ");
      expect(text).toContain("port 80 is in use");
      expect(text).toContain("web-proxy-1");
      expect(text).toContain("What would you like to do?");
      expect(text.indexOf("Add Den to that proxy")).toBeLessThan(
        text.indexOf("Free port 80"),
      );
      expect(await card.locator("pre").textContent()).toBe(NGINX);
      for (const id of ["#addr-copy", "#addr-check"]) {
        const box = await card.locator(id).boundingBox();
        expect([id, box!.height >= 44]).toEqual([id, true]);
      }
      expect(await sideScroll(p)).toBe(false);
      await card.scrollIntoViewIfNeeded();
      await shot(p, `card-${e}-${width}`);
      await p.context().close();
    });
  });
});
