/**
 * Issue 455 (mock v3): when the wanted address answers as another server,
 * every page shows the address banner once: "Den is at {address} for
 * now.", why, "Fix it in Edge" and ×. Dismissed, or on a later
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
import { proxyRoutes } from "../../../src/shared/edge/proxy-route.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

jest.setTimeout(90_000);

const ENGINES = ["chromium", "webkit"] as const;
const WIDTHS = [1440, 390] as const;
const SHOTS = process.env.DEN455_SHOTS?.trim() || "";
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES) browsers[e] = await launchBrowser(pw[e]);
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

/**
 * The routes, as the server builds them (proxy-route.ts), to the port Den
 * serves on here: one source for the address the card states and every
 * snippet's port (Den Design, issue 455).
 */
const routesFor = (direct: string) =>
  proxyRoutes({
    host: "den.acme.localhost",
    listen: 80,
    upstreamHost: "host.docker.internal",
    upstreamPort: Number(new URL(direct).port),
    name: "den",
  });

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
  routes: routesFor(direct),
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
  await signIn(ctx, s!.stateDir, s!.base);
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
      // The product's title (the demo's is its brand's).
      expect(text).toContain(` is at ${s.base} for now.`);
      expect(text).toContain(
        "Port 80 is held by nginx (web-proxy-1), so den.acme.localhost goes to nginx instead.",
      );
      const fix = b.locator(".den-bn-a");
      expect(await fix.textContent()).toBe("Fix it in Edge");
      expect(await fix.getAttribute("href")).toBe("/edge");
      const x = b.locator(".den-bn-x");
      const box = await x.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      // × sits top-right, beside the title (mock v3), at 390 too.
      const title = await b.locator(".den-bn-body b").boundingBox();
      const bannerBox = await b.boundingBox();
      expect(box!.y).toBeLessThan(title!.y + title!.height);
      expect(box!.x).toBeGreaterThan(title!.x);
      expect(box!.x + box!.width).toBeGreaterThan(
        bannerBox!.x + bannerBox!.width - 60,
      );
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

    it("Edge: the owner, the two choices in order, the route, Copy, Check again", async () => {
      if (!browsers[e] || !s) return;
      const p = await open(e, width);
      await p.goto(`${s.base}/edge`);
      const card = p.locator("[data-address-card]");
      await card.waitFor({ timeout: 20_000 });
      const text = ((await card.textContent()) ?? "").replace(/\s+/g, " ");
      expect(text).toContain("port 80 is in use");
      expect(text).toContain("web-proxy-1");
      expect(text).toContain("What would you like to do?");
      // The product's title (the demo's is its brand's).
      const add = text.search(/Add \S+ to that proxy/);
      expect(add).toBeGreaterThan(-1);
      expect(add).toBeLessThan(text.indexOf("Free port 80"));
      // The address the card states and the snippet's port are one port.
      const port = new URL(s.base).port;
      expect(text).toContain(`serving at ${s.base} instead`);
      expect(await card.locator("pre").textContent()).toBe(
        routesFor(s.base).nginx,
      );
      expect(await card.locator("pre").textContent()).toContain(
        `proxy_pass http://host.docker.internal:${port};`,
      );
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
