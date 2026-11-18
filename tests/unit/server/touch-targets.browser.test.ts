/**
 * Issue 302, slice 2a: on an iPhone (390x844, touch) every list row, tab
 * and menu item a thumb can reach is at least 44px tall and wide, Allow
 * and Deny stack full width, and no page scrolls sideways.
 *
 * The sweep measures every interactive element (links, buttons, tabs,
 * menu items, options, fields, anything focusable) on each surface:
 *
 *   - /agents with four agents in the list;
 *   - the rail (at phone size, the drawer: ☰ opens it);
 *   - /services;
 *   - /settings, with its tabs;
 *   - the bell's notifications, open;
 *   - a kit menu (the top bar's ◐ ▾: mode, theme, language), open.
 *
 * An element's tap is its box, or the kit's transparent 44px hit area
 * (.den-hit, a ::after centred on it) when it has one, or its <label>.
 * Anything under 44 fails, with its selector, size and text, unless it
 * matches EXCEPTIONS (each with its reason).
 *
 * The held-write ask (the approval dialog on every page): Allow, Deny,
 * Review and Later one under the other, Allow first, each the dialog's
 * full inner width and at least 44px tall, 8px apart.
 *
 * Reference values: the iPhone mock (Den on iPhone, Den project) and its
 * table, copied from the phone kit: --size-touch-min 44px, gap 8px,
 * under (pointer: coarse), (max-width: 767.98px).
 *
 * Chromium and WebKit, each with touch (iPhone emulation); DEN_PW_WS
 * connects to a Playwright server. DEN_SKIP_BROWSER_TESTS=1
 * skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import { claimLink, mintClaimCode } from "../../../src/shared/claim-code.js";
import { readWebSecret } from "../../../src/shared/web-secret.js";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const MIN = 44;
const W = 390;
const H = 844;

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
type Engine = "chromium" | "webkit";
const ENGINES: Engine[] = ["chromium", "webkit"];
const browsers: Partial<Record<Engine, Browser>> = {};
let latest = "";
const errors: string[] = [];

const AGENTS = [
  ["planner", "planner", "north"],
  ["reviewer", "reviewer", "north"],
  ["builder", "builder", "south"],
  ["scout", "reviewer", "south"],
] as const;

/**
 * What the sweep leaves out, each with why. A selector matched by
 * Element.matches() (or one of its ancestors, for a `within` rule).
 */
const EXCEPTIONS: { sel: string; within?: boolean; why: string }[] = [
  {
    sel: ".xterm",
    within: true,
    why: "the terminal's own parts (its hidden input, its scroll area): issue 302 slice 1 owns the agent's view",
  },
  {
    sel: ".den-skip",
    why: "the skip link is off screen until a keyboard focuses it",
  },
  {
    sel: ".den-sr, .sr-only, .visually-hidden",
    within: true,
    why: "read by a screen reader only, never tapped",
  },
];

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
  host = await connectHost(sessionPaths(s.stateDir).socket);
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  for (const [id, persona, ws] of AGENTS) {
    const info = await host.start({
      name: `acme-${ws}:${id}`,
      cwd: s.wsDir(ws),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    s.seed({
      id,
      persona,
      workspace: ws,
      session: { backend: "den-pty", id: info.ref.id },
      sessionName: `acme-${ws}:${id}`,
    });
    s.made[s.made.length - 1].emit(`${id} ready\r\n$ `);
  }
  const st = new NotificationStore(s.stateDir);
  st.add({
    kind: "waiting",
    subject: "agent:asker",
    scope: "workspace/north",
    text: "Asker asked: Ship it today?",
    msg: {
      key: "bell.m.asked",
      vars: { name: "Asker", text: "Ship it today?" },
    },
    link: "/agents?project=north&agent=asker",
    source: "hub",
  });
  st.add({
    kind: "service",
    subject: "agent:shipper",
    scope: "workspace/north",
    text: "Release 1 shipped",
    link: "/settings",
  });
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [host, s],
  });
});

const skip = () => !browsers.chromium;

async function phone(
  engine: Engine,
  url: string,
  opts: { claim?: boolean } = {},
): Promise<Page> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width: W, height: H },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
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
  p.on("pageerror", (e) => errors.push(`${engine} ${url}: ${e.message}`));
  await p.route("**/api/notifications/read", (r) =>
    r.fulfill({ json: { ok: true } }),
  );
  if (opts.claim) {
    await p.goto(
      claimLink(s!.base, mintClaimCode(readWebSecret(s!.stateDir)!)),
    );
    await p.waitForFunction(
      () => localStorage.getItem("den.approveKey")?.length === 43,
    );
    await p.goto(`${s!.base}${url}`);
  } else {
    await p.goto(signInUrl(s!.stateDir, s!.base, url));
  }
  await p.waitForFunction(() => "denShell" in window);
  return p;
}

type Small = { what: string; w: number; h: number };

/** Every interactive element under `root` that is visible and under 44px. */
async function sweep(
  p: Page,
  root: string,
): Promise<{ n: number; small: Small[] }> {
  return p.evaluate(
    ({ root, min, exceptions }) => {
      const SEL = [
        "a[href]",
        "button",
        "input:not([type=hidden])",
        "select",
        "textarea",
        "summary",
        "[role=tab]",
        "[role=menuitem]",
        "[role=menuitemradio]",
        "[role=menuitemcheckbox]",
        "[role=option]",
        "[role=button]",
        "[role=link]",
        "[role=switch]",
        "[role=checkbox]",
        "[tabindex]:not([tabindex='-1'])",
      ].join(",");
      const excepted = (el: Element) =>
        exceptions.some((x) =>
          x.within ? !!el.closest(x.sel) : el.matches(x.sel),
        );
      const shown = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return false;
        for (let e: Element | null = el; e; e = e.parentElement) {
          const c = getComputedStyle(e);
          if (c.opacity === "0") return false;
        }
        return true;
      };
      /** The tap: the box, the kit's ::after hit area, or the label. */
      const tap = (el: Element) => {
        const r = el.getBoundingClientRect();
        let w = r.width;
        let h = r.height;
        const a = getComputedStyle(el, "::after");
        if (a.content !== "none" && a.position === "absolute") {
          w = Math.max(w, parseFloat(a.minWidth) || 0);
          h = Math.max(h, parseFloat(a.minHeight) || 0);
        }
        const lab = el.closest("label");
        if (lab) {
          const l = lab.getBoundingClientRect();
          w = Math.max(w, l.width);
          h = Math.max(h, l.height);
        }
        return { w, h };
      };
      const name = (el: Element) => {
        let s = el.tagName.toLowerCase();
        if (el.id) s += "#" + el.id;
        const c = (el.getAttribute("class") || "")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (c.length) s += "." + c.slice(0, 3).join(".");
        const t = (el.getAttribute("aria-label") || el.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 30);
        return t ? `${s} "${t}"` : s;
      };
      const scope = document.querySelectorAll(root);
      const els = new Set<Element>();
      scope.forEach((r) => {
        if (r.matches(SEL)) els.add(r);
        r.querySelectorAll(SEL).forEach((e) => els.add(e));
      });
      const small: { what: string; w: number; h: number }[] = [];
      let n = 0;
      els.forEach((el) => {
        if (excepted(el) || !shown(el)) return;
        n++;
        const { w, h } = tap(el);
        // Half a pixel for rounding (a 43.5px box is drawn at 44).
        if (w < min - 0.5 || h < min - 0.5)
          small.push({ what: name(el), w: Math.round(w), h: Math.round(h) });
      });
      return { n, small };
    },
    { root, min: MIN, exceptions: EXCEPTIONS },
  );
}

async function noSideways(p: Page): Promise<void> {
  const r = await p.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    w: window.innerWidth,
  }));
  expect(r.sw).toBeLessThanOrEqual(r.w);
}

function report(small: Small[]): string[] {
  return small.map((x) => `${x.what} ${x.w}x${x.h}`);
}

describe.each(ENGINES)(
  "issue 302 in %s: touch targets at 390x844",
  (engine) => {
    it("/agents: every list row and control is 44px or more, no sideways scroll", async () => {
      if (skip()) return;
      const p = await phone(engine, "/agents");
      await p.waitForSelector(".agr", { timeout: 20_000 });
      const r = await sweep(p, "body");
      expect(r.n).toBeGreaterThan(5);
      expect(report(r.small)).toEqual([]);
      await noSideways(p);
      await p.context().close();
    }, 60_000);

    it("the rail drawer: every row is 44px or more", async () => {
      if (skip()) return;
      const p = await phone(engine, "/agents");
      await p.click(".den-menu-btn");
      await p.waitForSelector("body.den-rail-open");
      await p.waitForTimeout(300);
      const r = await sweep(p, ".den-rail");
      expect(r.n).toBeGreaterThan(3);
      expect(report(r.small)).toEqual([]);
      await noSideways(p);
      await p.context().close();
    }, 60_000);

    it("/services: every row and control is 44px or more, no sideways scroll", async () => {
      if (skip()) return;
      const p = await phone(engine, "/services");
      await p.waitForSelector("#den-content main, main", { timeout: 20_000 });
      await p.waitForTimeout(1000);
      const r = await sweep(p, "body");
      expect(r.n).toBeGreaterThan(5);
      expect(report(r.small)).toEqual([]);
      await noSideways(p);
      await p.context().close();
    }, 60_000);

    it("/settings: every tab and control is 44px or more, no sideways scroll", async () => {
      if (skip()) return;
      const p = await phone(engine, "/settings");
      await p.waitForSelector("[role=tablist] [role=tab]", { timeout: 20_000 });
      await p.waitForTimeout(1000);
      const r = await sweep(p, "body");
      expect(r.n).toBeGreaterThan(5);
      expect(report(r.small)).toEqual([]);
      await noSideways(p);
      await p.context().close();
    }, 60_000);

    it("the bell's notifications: every row and control is 44px or more", async () => {
      if (skip()) return;
      const p = await phone(engine, "/services");
      await p.click("#den-bell");
      await p.locator("#den-bell-pop .den-bell-row").first().waitFor();
      const r = await sweep(p, "#den-bell-pop");
      expect(r.n).toBeGreaterThan(1);
      expect(report(r.small)).toEqual([]);
      await noSideways(p);
      await p.context().close();
    }, 60_000);

    it("a kit menu (the top bar's ◐ ▾): every item is 44px or more", async () => {
      if (skip()) return;
      const p = await phone(engine, "/services");
      const btn = p.locator(".den-top .appearance-btn").first();
      await btn.click();
      await p.locator(".den-pop .den-mi:visible").first().waitFor();
      const r = await sweep(p, ".den-pop");
      expect(r.n).toBeGreaterThan(1);
      expect(report(r.small)).toEqual([]);
      await noSideways(p);
      await p.context().close();
    }, 60_000);

    it("the held-write ask: Allow, Deny, Review, Later stacked full width, Allow first, each 44px", async () => {
      if (skip()) return;
      const p = await phone(engine, "/services", { claim: true });
      const sess = (await (
        await fetch(`${s!.base}/api/session`, {
          headers: { "sec-fetch-site": "same-origin" },
        })
      ).json()) as { csrf?: string };
      const res = await fetch(`${s!.base}/api/approvals`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: s!.base,
          "x-den-csrf": String(sess.csrf ?? ""),
        },
        body: JSON.stringify({
          action: "workspace_create",
          args: { name: "east" },
        }),
      });
      expect(res.status).toBe(202);
      await p.waitForSelector("#den-ap-dlg[open]", { timeout: 20_000 });
      const b = await p.evaluate(() => {
        const d = document.getElementById("den-ap-dlg")!;
        const foot = d.querySelector(".btns")!;
        const fr = foot.getBoundingClientRect();
        const cs = getComputedStyle(foot);
        const inner =
          fr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const box = (id: string) => {
          const r = document.getElementById(id)!.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, w: r.width, h: r.height };
        };
        return {
          inner,
          allow: box("den-ap-allow"),
          deny: box("den-ap-deny"),
          review: box("den-ap-review"),
          later: box("den-ap-later"),
        };
      });
      for (const k of ["allow", "deny", "review", "later"] as const) {
        expect([k, b[k].h >= MIN - 0.5]).toEqual([k, true]);
        expect([k, Math.abs(b[k].w - b.inner) <= 1]).toEqual([k, true]);
      }
      // Allow first, then Deny, each on its own line, 8px apart.
      expect(b.allow.bottom).toBeLessThanOrEqual(b.deny.top);
      expect(Math.round(b.deny.top - b.allow.bottom)).toBe(8);
      expect(b.deny.bottom).toBeLessThanOrEqual(b.review.top);
      expect(b.review.bottom).toBeLessThanOrEqual(b.later.top);
      const r = await sweep(p, "#den-ap-dlg");
      expect(report(r.small)).toEqual([]);
      await noSideways(p);
      await p.context().close();
    }, 60_000);
  },
);

it("no page errors", () => {
  expect(errors).toEqual([]);
});
