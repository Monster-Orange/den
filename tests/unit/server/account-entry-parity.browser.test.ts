/**
 * Issue 406: the rail's account entry is the kit's, value for value: the
 * name on line 1 at the nav item's size, @login on line 2, smaller and
 * muted; @login alone when no name is known. The other product draws its
 * entry with the same kit function and the kit's shell.css, without an
 * override, so the kit's own entry, drawn on a bare kit page, is the
 * reference.
 *
 * Den's server (a fake GitHub on localhost, never github.com; no gh) with
 * an owner linked before names were kept:
 *  1. on start, Den reads the owner's public GitHub profile (the fake) and
 *     keeps the name; a browser on this machine shows two lines;
 *  2. a browser on another machine with a GitHub session from before names
 *     were kept shows the same two lines (the owner's name);
 *  3. the owner signs in with GitHub and GitHub has no name: Den forgets
 *     the name it kept, and the entry is one line, the kit's one-line one;
 *  4. GitHub has no name, Den is connected to Hub, and Hub has a name for
 *     the same login: Hub's name, two lines; Hub's name for another login
 *     is never used (one line).
 * Each measured in Chromium and WebKit, at 1280 and at 390 (in ☰'s
 * drawer), against the kit's entry with the same words at the same width.
 *
 * ACCT_REF_OUT=<file> appends each reference measured, as JSON lines.
 * DEN_PW_WS=ws://…/ uses a browser behind a Playwright run-server.
 * DEN_SKIP_BROWSER_TESTS=1 skips it. No link, code or cookie is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { readWebOwner, writeWebOwner } from "../../../src/shared/web-owner.js";
import { readWebSecret } from "../../../src/shared/web-secret.js";
import {
  sessionCookieName,
  WebSessionStore,
} from "../../../src/shared/web-session.js";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { EDGE_PROOF, writeTestEdgeProof } from "./helpers/edge-proof.js";
import { startFakeGithub, type FakeGithub } from "./helpers/fake-github.js";
import { signIn } from "./helpers/signed-in.js";

const ENGINE = path.resolve(__dirname, "../../..");
const KIT = path.join(ENGINE, "packages", "den-ui", "src");
const EDGE = "den.acme.localhost";
/** The edge's X-Forwarded-For for a client on another machine. */
const AWAY = { "x-forwarded-for": "203.0.113.7", ...EDGE_PROOF };
/** An invented person. */
const OWNER = { id: 4242, login: "octo-lead" };
const NAME = "Odette Lead";
const BROWSERS = ["chromium", "webkit"] as const;
const WIDTHS = [1280, 390] as const;
const browsers: Partial<Record<(typeof BROWSERS)[number], Browser>> = {};
let gh: FakeGithub;
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const b of BROWSERS)
      browsers[b] = process.env.DEN_PW_WS
        ? await pw[b].connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await pw[b].launch(
            b === "chromium"
              ? { args: [`--host-resolver-rules=MAP ${EDGE} 127.0.0.1`] }
              : {},
          );
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  gh = await startFakeGithub({ interval: 0 });
  // The owner's public profile on (the fake) GitHub has a name.
  gh.profiles[OWNER.login] = { ...OWNER, name: NAME };
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-acct-")));
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: acme.localhost",
      "  tls: none",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    "web:\n  github_client_id: Iv23liAcmeTest\n",
  );
  // An owner linked before display names were kept: no name.
  writeWebOwner(OWNER, stateDir);
  expect(readWebOwner(stateDir)?.name).toBeUndefined();
  const edgeDir = path.join(tmp, "edge-state");
  writeTestEdgeProof(edgeDir);
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: edgeDir,
        DEN_HOME: stateDir,
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        DEN_TEST_GITHUB_URL: gh.url,
      },
    },
    { timeoutMs: 40_000 },
  );
  server = started.server;
  port = started.port;
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [server, gh],
    after: () => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    },
  });
});

const skip = () => !browsers.chromium || !browsers.webkit;

/** What the entry draws, measured: every value the issue lists. */
interface Measured {
  lines: string[];
  type: {
    fontSize: string;
    fontWeight: string;
    lineHeight: string;
    fontFamily: string;
    overflow: string;
    textOverflow: string;
    whiteSpace: string;
    height: number;
    /** Line 1: a nav entry's colour (--muted); line 2: --faint. */
    tone: string;
  }[];
  entry: {
    display: string;
    gap: string;
    padding: string;
    fontSize: string;
    width: number;
    height: number;
  };
  label: { display: string; flexDirection: string; minWidth: string };
  icon: { width: number; height: number };
}

/** Opens the rail (☰'s drawer when narrow) and measures the entry. */
async function measure(p: Page, sel: string): Promise<Measured> {
  await p.waitForSelector(sel, { state: "attached" });
  const btn = p.locator("#den-menu-btn");
  if (await btn.isVisible()) {
    if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
    await p.waitForFunction(
      (s) => {
        const r = document.querySelector(s)?.getBoundingClientRect();
        return !!r && r.width > 0 && r.right <= window.innerWidth;
      },
      sel,
      { timeout: 10_000 },
    );
  }
  await p.evaluate(() => document.fonts.ready.then(() => true));
  return p.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement;
    const cs = (e: Element) => getComputedStyle(e);
    const round = (n: number) => Math.round(n * 100) / 100;
    // The colours to tell the lines by, resolved in the rail: a nav
    // entry's (--muted), the theme's --faint, and --text (a current entry).
    const tone = (v: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${v})`;
      el.parentElement!.appendChild(probe);
      const c = cs(probe).color;
      probe.remove();
      return c;
    };
    const tones = {
      muted: tone("--muted"),
      faint: tone("--faint"),
      text: tone("--text"),
    };
    const lbl = el.querySelector(".den-acct")!;
    const lines = [...lbl.children].filter((c) => cs(c).display !== "none");
    const svg = el.querySelector("svg")!.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const e = cs(el);
    return {
      lines: lines.map((c) => c.textContent ?? ""),
      type: lines.map((c) => {
        const k = cs(c);
        return {
          fontSize: k.fontSize,
          fontWeight: k.fontWeight,
          lineHeight: k.lineHeight,
          fontFamily: k.fontFamily,
          overflow: k.overflow,
          textOverflow: k.textOverflow,
          whiteSpace: k.whiteSpace,
          height: round(c.getBoundingClientRect().height),
          tone:
            (Object.keys(tones) as (keyof typeof tones)[]).find(
              (t) => tones[t] === k.color,
            ) ?? `other ${k.color}`,
        };
      }),
      entry: {
        display: e.display,
        gap: e.gap,
        padding: e.padding,
        fontSize: e.fontSize,
        width: round(box.width),
        height: round(box.height),
      },
      label: {
        display: cs(lbl).display,
        flexDirection: cs(lbl).flexDirection,
        minWidth: cs(lbl).minWidth,
      },
      icon: { width: round(svg.width), height: round(svg.height) },
    };
  }, sel);
}

/** A bare kit page: the kit's shell with the kit's own account entry. */
const KIT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${["tokens", "fonts", "base", "shell"].map((s) => `<link rel="stylesheet" href="/kit/${s}.css">`).join("\n")}
<style>body { margin: 0; }</style>
</head>
<body class="den-has-shell"><div class="den-shell" id="den-shell"></div>
<main id="den-content"><p>page</p></main>
<script type="module" src="/app.js"></script>
</body></html>`;

const kitApp = (account: object) => `
import DenUI from "/kit/kit.js";
DenUI.configure({ lang: "en", product: { name: "Acme" } });
const model = {
  product: { name: "Acme", version: "1.0.0", mark: { text: "A", label: "Acme" } },
  groups: [{ id: "work", label: "Work" }],
  nav: [{ id: "home", label: "Home", href: "/", group: "work", icon: "home", current: true }],
  settings: { href: "#settings" },
  account: ${JSON.stringify({ ...account, href: "#account", id: "kit-acct" })},
};
window.shell = DenUI.mount(document.getElementById("den-shell"), model);
window.ready = true;
`;

/** The kit's entry for `account` in `b` at `width`: the reference. */
async function kitReference(
  b: Browser,
  width: number,
  account: { name?: string; login: string },
): Promise<Measured> {
  const ctx = await b.newContext({
    viewport: { width, height: 844 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  try {
    const p = await ctx.newPage();
    await p.route("http://kit.test/**", async (r: Route) => {
      const u = new URL(r.request().url());
      if (u.pathname === "/")
        return r.fulfill({ contentType: "text/html", body: KIT_PAGE });
      if (u.pathname === "/app.js")
        return r.fulfill({
          contentType: "text/javascript",
          body: kitApp(account),
        });
      const f = u.pathname.replace(/^\/kit\//, "");
      const file = path.join(KIT, f);
      if (u.pathname.startsWith("/kit/") && fs.existsSync(file))
        return r.fulfill({
          contentType: f.endsWith(".css")
            ? "text/css"
            : f.endsWith(".woff2")
              ? "font/woff2"
              : "text/javascript",
          body: fs.readFileSync(file),
        });
      return r.fulfill({ status: 404, body: "" });
    });
    await p.goto("http://kit.test/");
    await p.waitForFunction(() => (window as { ready?: boolean }).ready);
    return await measure(p, "#kit-acct");
  } finally {
    await ctx.close();
  }
}

/** Den's /settings in `b` at `width`, as `open` makes the context. */
async function denEntry(
  b: Browser,
  width: number,
  open: (ctx: BrowserContext) => Promise<Page>,
  ctxOpts: Parameters<Browser["newContext"]>[0] = {},
): Promise<Measured> {
  const ctx = await b.newContext({
    viewport: { width, height: 844 },
    colorScheme: "light",
    reducedMotion: "reduce",
    ...ctxOpts,
  });
  try {
    const p = await open(ctx);
    await p.waitForFunction(
      () => !!document.querySelector("#den-ident .den-acct"),
      undefined,
      { timeout: 20_000 },
    );
    return await measure(p, "#den-ident");
  } finally {
    await ctx.close();
  }
}

/** Every browser and width: Den's entry equals the kit's for `account`. */
async function sameAsKit(
  account: { name?: string; login: string },
  open: (ctx: BrowserContext) => Promise<Page>,
  ctxOpts: Parameters<Browser["newContext"]>[0] = {},
): Promise<void> {
  const lines = account.name
    ? [account.name, `@${account.login}`]
    : [`@${account.login}`];
  for (const name of BROWSERS)
    for (const width of WIDTHS) {
      const b = browsers[name]!;
      const ref = await kitReference(b, width, account);
      // ACCT_REF_OUT=<file>: the reference, one JSON line each (issue 406's table).
      if (process.env.ACCT_REF_OUT)
        fs.appendFileSync(
          process.env.ACCT_REF_OUT,
          `${JSON.stringify({ browser: name, width, ...ref })}\n`,
        );
      // The kit itself: line 1 a nav entry's colour and size, line 2 smaller and
      // muted (--faint), each one line, cut with an ellipsis.
      expect(ref.lines).toEqual(lines);
      expect(ref.type.map((t) => t.tone)).toEqual(
        account.name ? ["muted", "faint"] : ["muted"],
      );
      if (account.name) expect(ref.type[1].fontSize).toBe("11px");
      for (const t of ref.type)
        expect([t.overflow, t.textOverflow, t.whiteSpace]).toEqual([
          "hidden",
          "ellipsis",
          "nowrap",
        ]);
      const den = await denEntry(b, width, open, ctxOpts);
      expect({ browser: name, width, ...den }).toEqual({
        browser: name,
        width,
        ...ref,
      });
    }
}

describe("issue 406: the account entry is the kit's, name over @login", () => {
  it("an owner linked before names were kept: the name from GitHub's public profile, on start; two lines on this machine", async () => {
    if (skip()) return;
    // Den reads the public profile once, after it starts listening, without
    // a token, and keeps the name.
    for (let i = 0; i < 100 && !readWebOwner(stateDir)?.name; i++)
      await new Promise((ok) => setTimeout(ok, 100));
    expect(readWebOwner(stateDir)?.name).toBe(NAME);
    const asked = gh.requests.filter((r) => r.path === `/users/${OWNER.login}`);
    expect(asked).toHaveLength(1);
    expect(asked[0].auth).toBe(false);
    await sameAsKit({ name: NAME, login: OWNER.login }, async (ctx) => {
      // Sign-in on this machine too: a local browser opens the one-time link first.
      await signIn(ctx, stateDir, `http://localhost:${port}`);
      const p = await ctx.newPage();
      await p.goto(`http://localhost:${port}/settings`);
      return p;
    });
  }, 240_000);

  it("a GitHub session from before names were kept, on another machine: the owner's name, two lines", async () => {
    if (skip()) return;
    const secret = readWebSecret(stateDir);
    expect(secret).not.toBeNull();
    const store = new WebSessionStore({
      stateDir: () => stateDir,
      secret: () => secret,
    });
    const { id } = store.create({
      via: "github",
      login: OWNER.login,
      host: `${EDGE}:${port}`,
    });
    expect(store.list().find((s) => s.login === OWNER.login)?.name).toBe(
      undefined,
    );
    await sameAsKit(
      { name: NAME, login: OWNER.login },
      async (ctx) => {
        await ctx.addCookies([
          {
            name: sessionCookieName(port),
            value: id,
            domain: EDGE,
            path: "/",
          },
        ]);
        const p = await ctx.newPage();
        await p.goto(`http://${EDGE}:${port}/settings`);
        return p;
      },
      { extraHTTPHeaders: AWAY },
    );
  }, 240_000);

  it("the owner signs in with GitHub, which has no name now: Den forgets it; one line, the kit's", async () => {
    if (skip()) return;
    const ctx = await browsers.chromium!.newContext({
      extraHTTPHeaders: AWAY,
    });
    const p = await ctx.newPage();
    await p.goto(`http://${EDGE}:${port}/`);
    const flow = await p.evaluate(async () => {
      const r = await fetch("/api/github/signin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      return (await r.json()) as { id?: string; userCode?: string };
    });
    expect(typeof flow.id).toBe("string");
    gh.approve(flow.userCode!, OWNER);
    const done = await p.evaluate(async (fid) => {
      for (let i = 0; i < 100; i++) {
        const r = await fetch(`/api/github/signin/${fid}`, {
          cache: "no-store",
        });
        const j = (await r.json()) as { state?: string };
        if (j.state !== "pending") return j.state;
        await new Promise((ok) => setTimeout(ok, 150));
      }
      return "timeout";
    }, flow.id!);
    expect(done).toBe("ok");
    await ctx.close();
    expect(readWebOwner(stateDir)?.name).toBeUndefined();
    await sameAsKit({ login: OWNER.login }, async (c) => {
      // Sign-in on this machine too: a local browser opens the one-time link first.
      await signIn(c, stateDir, `http://localhost:${port}`);
      const pg = await c.newPage();
      await pg.goto(`http://localhost:${port}/settings`);
      return pg;
    });
  }, 240_000);

  it("GitHub has no name and Hub has one for the same login: Hub's name, two lines; another login's never", async () => {
    if (skip()) return;
    expect(readWebOwner(stateDir)?.name).toBeUndefined();
    const HUB_NAME = "Odette from Hub";
    /** Den's page, with the rail's Hub look answering as `hub` would. */
    const withHub =
      (login: string) =>
      async (c: BrowserContext): Promise<Page> => {
        await c.route(/\/api\/hub\?rail=1$/, (r: Route) =>
          r.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              configured: true,
              connected: true,
              state: "connected",
              url: "https://hub.example.test",
              team: "Acme",
              teamUrl: "https://hub.example.test/c/acme",
              login,
              name: HUB_NAME,
            }),
          }),
        );
        // Sign-in on this machine too: a local browser opens the one-time link first.
        await signIn(c, stateDir, `http://localhost:${port}`);
        const pg = await c.newPage();
        await pg.goto(`http://localhost:${port}/settings`);
        // The rail's first Hub look (0.8 s after load) has landed.
        await pg.waitForFunction(
          () => !!document.querySelector('[data-hub="connected"]'),
          undefined,
          { timeout: 20_000 },
        );
        return pg;
      };
    await sameAsKit(
      { name: HUB_NAME, login: OWNER.login },
      withHub(OWNER.login.toUpperCase()),
    );
    await sameAsKit({ login: OWNER.login }, withHub("someone-else"));
  }, 300_000);
});
