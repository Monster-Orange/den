/**
 * Issue 103, framing and the embedded agent pane, through the real routes
 * and a real cross-origin frame: Den on http://localhost:<port>, the host
 * pages on another server at http://127.0.0.1:<h> (listed in Settings ›
 * Embedding) and http://localhost:<h> (not listed: another origin).
 *
 *   - every page says frame-ancestors 'self' and X-Frame-Options
 *     SAMEORIGIN; Den's own frame (the Tests page's report) still loads;
 *   - an unlisted origin can't frame any page or the pane; a listed one
 *     can't frame any page but the pane;
 *   - a listed one frames the pane and the handshake runs: den:ready,
 *     den:hello, den:connected, den:size; Send reaches the agent, then
 *     den:sent;
 *   - the frame never carries Den's cookie, even with one in the browser;
 *   - a key is refused for an unlisted origin, once its origin is taken
 *     off the list, and without one.
 *
 * The demo distribution with a scripted PTY (helpers/agents-page-server.ts).
 * DEN_HELPERS_BROWSER=webkit runs it in WebKit. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import type { Browser, Frame, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer;
let sid = "";
let pty: ScriptedPty;
let hostServer: http.Server;
let hostPort = 0;
let LISTED = "";
let UNLISTED = "";

/** A host page: frames `target`, says hello to Den, logs what Den says. */
function hostPage(target: string, den: string): string {
  const cfg = JSON.stringify({ target, den }).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body>
<iframe id="f" style="width:600px;height:200px;border:0"></iframe>
<script>
const C = ${cfg};
window.got = [];
const f = document.getElementById("f");
const hello = () => f.contentWindow && f.contentWindow.postMessage({ type: "den:hello" }, C.den);
addEventListener("message", (e) => {
  window.got.push({ origin: e.origin, data: e.data });
  if (e.data && e.data.type === "den:ready") hello();
  if (e.data && e.data.type === "den:size") f.style.height = e.data.height + "px";
});
f.addEventListener("load", hello);
f.src = C.target;
</script></body></html>`;
}

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const engine = (
      ["firefox", "webkit"].includes(process.env.DEN_HELPERS_BROWSER ?? "")
        ? process.env.DEN_HELPERS_BROWSER
        : "chromium"
    ) as "chromium" | "firefox" | "webkit";
    const ws = process.env.DEN_PW_WS;
    browser = ws
      ? await pw[engine].connect(ws, { exposeNetwork: "<loopback>" })
      : await pw[engine].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const host = await connectHost(sessionPaths(s.stateDir).socket);
  const info = await host.start({
    name: "acme-north:scout",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  host.close();
  sid = info.ref.id;
  pty = s.made.at(-1)!;
  s.seed({
    id: "scout",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: sid },
    sessionName: "acme-north:scout",
  });
  // Another web app: one server, two origins.
  hostServer = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(hostPage(u.searchParams.get("target") ?? "", s.base));
  });
  await new Promise<void>((r) => hostServer.listen(0, "::", r));
  hostPort = (hostServer.address() as AddressInfo).port;
  LISTED = `http://127.0.0.1:${hostPort}`;
  UNLISTED = `http://localhost:${hostPort}`;
  // Den's own report, for its frame.
  const report = path.join(s.tmp, "dist", "playwright-report", "index.html");
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(
    report,
    "<!doctype html><title>report</title><p id=rep>the report</p>",
  );
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => (hostServer ? hostServer.close(r) : r(null)));
  await s?.stop();
});

const typed = (from: number) =>
  Buffer.concat(pty.writes.slice(from)).toString("utf8");

async function list(origins: string[] | null): Promise<void> {
  expect(await s.settings({ embed: { origins } })).toBe(200);
}

async function newPage(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 900, height: 700 },
  });
  return ctx.newPage();
}

/** Open `hostOrigin`'s page framing Den's `target`. */
async function frame(p: Page, hostOrigin: string, target: string) {
  await p.goto(
    `${hostOrigin}/host?target=${encodeURIComponent(`${s.base}${target}`)}`,
  );
}

/** The frame Den's page is in, once it has Den's page in it; else null. */
async function denFrame(p: Page, waitMs = 4000): Promise<Frame | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    for (const f of p.frames()) {
      if (f === p.mainFrame()) continue;
      const has = await f
        .evaluate(
          () =>
            !!document.getElementById("den-shell") ||
            !!document.getElementById("emb"),
        )
        .catch(() => false);
      if (has) return f;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

const got = (p: Page) =>
  p.evaluate(
    () =>
      (
        window as unknown as {
          got: { origin: string; data: { type?: string } }[];
        }
      ).got,
  );

describe("issue 103: no page is framed by another site", () => {
  it.each([
    "/",
    "/agents",
    "/settings",
    "/api/settings",
    "/p/north/agents/scout",
    "/no-such-page",
    "/report/",
  ])(
    "%s says frame-ancestors 'self' and X-Frame-Options SAMEORIGIN",
    async (p) => {
      if (!browser) return;
      const r = await fetch(`${s.base}${p}`);
      expect(r.headers.get("content-security-policy")).toMatch(
        /(^|;\s*)frame-ancestors 'self'$/,
      );
      expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    },
  );

  it("the embedded pane: frame-ancestors 'none' while nothing is listed", async () => {
    if (!browser) return;
    await list(null);
    const r = await fetch(`${s.base}/embed/p/north/agents/scout`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'",
    );
    expect(r.headers.get("x-frame-options")).toBeNull();
  });

  it("Den's own frame still loads: its report inside a Den page", async () => {
    if (!browser) return;
    const p = await newPage();
    await p.goto(`${s.base}/settings`);
    await p.evaluate(() => {
      const f = document.createElement("iframe");
      f.id = "report-frame";
      f.src = "/report/";
      document.body.append(f);
    });
    const t0 = Date.now();
    let text: string | null = null;
    while (!text && Date.now() - t0 < 10_000) {
      for (const f of p.frames())
        if (f !== p.mainFrame())
          text = await f
            .evaluate(() => document.getElementById("rep")?.textContent ?? null)
            .catch(() => null);
      if (!text) await new Promise((r) => setTimeout(r, 200));
    }
    expect(text).toBe("the report");
    await p.context().close();
  }, 60_000);

  it("an unlisted origin can't frame any page, nor the pane", async () => {
    if (!browser) return;
    await list([LISTED]);
    for (const target of [
      "/agents",
      "/settings",
      "/p/north/agents/scout",
      "/embed/p/north/agents/scout",
    ]) {
      const p = await newPage();
      await frame(p, UNLISTED, target);
      expect([target, await denFrame(p)]).toEqual([target, null]);
      expect((await got(p)).map((m) => m.data?.type)).toEqual([]);
      await p.context().close();
    }
  }, 120_000);

  it("a listed origin can't frame any page but the pane", async () => {
    if (!browser) return;
    await list([LISTED]);
    for (const target of ["/agents", "/settings"]) {
      const p = await newPage();
      await frame(p, LISTED, target);
      expect([target, await denFrame(p)]).toEqual([target, null]);
      await p.context().close();
    }
  }, 90_000);
});

describe("issue 103: a listed origin frames the pane", () => {
  it("the handshake runs, Send reaches the agent, and the frame carries no Den cookie", async () => {
    if (!browser) return;
    await list([LISTED]);
    const p = await newPage();
    // A Den cookie in this browser: signed in at Den's own origin.
    await p.goto(signInUrl(s.stateDir, s.base, "/settings"));
    const cookies = await p.context().cookies(s.base);
    expect(cookies.some((c) => c.name.startsWith("den_session_"))).toBe(true);
    const sent: { url: string; cookie: string | undefined }[] = [];
    p.on("request", (r) => {
      if (r.url().startsWith(s.base) && r.frame() !== p.mainFrame())
        void r
          .allHeaders()
          .then((h) => sent.push({ url: r.url(), cookie: h.cookie }))
          .catch(() => {});
    });
    await frame(p, LISTED, "/embed/p/north/agents/scout");
    const f = await denFrame(p, 15_000);
    expect(f).not.toBeNull();
    await p.waitForFunction(
      () =>
        (window as unknown as { got: { data: { type?: string } }[] }).got.some(
          (m) => m.data?.type === "den:connected",
        ),
      undefined,
      { timeout: 20_000 },
    );
    const msgs = await got(p);
    for (const m of msgs) expect(m.origin).toBe(new URL(s.base).origin);
    const types = msgs.map((m) => m.data?.type);
    expect(types).toContain("den:ready");
    const connected = msgs.find((m) => m.data?.type === "den:connected")!
      .data as unknown as { agent: { id: string; project: string } };
    expect(connected.agent).toMatchObject({ id: "scout", project: "north" });
    await p.waitForFunction(
      () =>
        (window as unknown as { got: { data: { type?: string } }[] }).got.some(
          (m) => m.data?.type === "den:size",
        ),
      undefined,
      { timeout: 10_000 },
    );
    // The key never left the frame.
    expect(JSON.stringify(msgs)).not.toContain("den_ek_");

    // Send.
    const from = pty.writes.length;
    await f!.locator(".agc-in").fill("hello from the other app");
    await f!.locator(".agc-send").click();
    const t0 = Date.now();
    while (!typed(from).includes("\r") && Date.now() - t0 < 15_000)
      await new Promise((r) => setTimeout(r, 100));
    expect(typed(from)).toContain("hello from the other app");
    expect(typed(from).endsWith("\r")).toBe(true);
    await p.waitForFunction(
      () =>
        (window as unknown as { got: { data: { type?: string } }[] }).got.some(
          (m) => m.data?.type === "den:sent",
        ),
      undefined,
      { timeout: 10_000 },
    );
    // No request from the frame carried Den's cookie.
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.length).toBeGreaterThan(2);
    for (const r of sent)
      expect([r.url, (r.cookie ?? "").includes("den_session_")]).toEqual([
        r.url,
        false,
      ]);
    expect(sent.map((r) => r.url)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/embed/p/north/agents/scout"),
        expect.stringContaining("/api/embed/keys"),
        expect.stringContaining("/api/embed/say"),
      ]),
    );
    await p.context().close();
  }, 90_000);
});

describe("issue 103: the pop-up for a browser on another computer", () => {
  it("Allow mints the key and hands it to the window that opened it, at Den's origin only", async () => {
    if (!browser) return;
    await list([LISTED]);
    const p = await newPage();
    // The opener stands in for the pane's frame: a page at Den's origin.
    await p.goto(`${s.base}/settings`);
    await p.evaluate(() => {
      (window as unknown as { keys: unknown[] }).keys = [];
      addEventListener("message", (e) =>
        (window as unknown as { keys: unknown[] }).keys.push({
          origin: e.origin,
          data: e.data,
        }),
      );
    });
    const [pop] = await Promise.all([
      p.waitForEvent("popup"),
      p.evaluate(
        (o) =>
          window.open(
            `/embed/connect?project=north&agent=scout&origin=${encodeURIComponent(o)}`,
            "den-embed-connect",
            "popup,width=520,height=640",
          ),
        LISTED,
      ),
    ]);
    await pop.locator("#emc-what").waitFor();
    expect(await pop.locator("#emc-what").textContent()).toBe(
      `Let ${LISTED} use agent scout in project north?`,
    );
    // Every Den page's Report is here too.
    expect(
      await pop.locator(`[data-den-report], [data-act="report"]`).count(),
    ).toBeGreaterThan(0);
    await pop.locator("#emc-allow").click();
    await p.waitForFunction(
      () => (window as unknown as { keys: unknown[] }).keys.length > 0,
      undefined,
      { timeout: 10_000 },
    );
    const [k] = (await p.evaluate(
      () => (window as unknown as { keys: unknown[] }).keys,
    )) as { origin: string; data: { type: string; key: string } }[];
    expect(k.origin).toBe(new URL(s.base).origin);
    expect(k.data.type).toBe("den:key");
    expect(k.data.key).toMatch(/^den_ek_/);
    await p.context().close();
  }, 60_000);
});

describe("issue 103: the pane's key", () => {
  /** The loopback CSRF token and a mint, as the frame asks. */
  async function mint(origin: string) {
    const sj = (await (await fetch(`${s.base}/api/session`)).json()) as {
      csrf: string;
    };
    return fetch(`${s.base}/api/embed/keys`, {
      method: "POST",
      headers: {
        origin: s.base,
        "content-type": "application/json",
        "x-den-csrf": sj.csrf,
      },
      body: JSON.stringify({ project: "north", agent: "scout", origin }),
    });
  }
  const say = (key: string | null) =>
    fetch(`${s.base}/api/embed/say`, {
      method: "POST",
      headers: {
        origin: s.base,
        "content-type": "application/json",
        ...(key ? { "x-den-embed-key": key } : {}),
      },
      body: JSON.stringify({ text: "x" }),
    });

  it("an unlisted origin gets none; a near miss neither", async () => {
    if (!browser) return;
    await list([LISTED]);
    for (const o of [UNLISTED, `${LISTED}/`, `${LISTED}0`, "*", "null"]) {
      const r = await mint(o);
      expect([o, r.status]).toEqual([o, 403]);
      expect(((await r.json()) as { code: string }).code).toBe(
        "origin_not_listed",
      );
    }
  });

  it("another project's agent: none", async () => {
    if (!browser) return;
    await list([LISTED]);
    const sj = (await (await fetch(`${s.base}/api/session`)).json()) as {
      csrf: string;
    };
    const r = await fetch(`${s.base}/api/embed/keys`, {
      method: "POST",
      headers: {
        origin: s.base,
        "content-type": "application/json",
        "x-den-csrf": sj.csrf,
      },
      body: JSON.stringify({
        project: "south",
        agent: "scout",
        origin: LISTED,
      }),
    });
    expect(r.status).toBe(404);
  });

  it("Send without a key, or with its origin taken off the list, is refused", async () => {
    if (!browser) return;
    await list([LISTED]);
    expect((await say(null)).status).toBe(401);
    expect((await say("den_ek_nope")).status).toBe(401);
    const r = await mint(LISTED);
    expect(r.status).toBe(200);
    const { key } = (await r.json()) as { key: string };
    await list(null);
    const off = await say(key);
    expect(off.status).toBe(403);
    expect(((await off.json()) as { code: string }).code).toBe(
      "origin_not_listed",
    );
  });

  it("a page on another site can't mint one: its Origin is refused", async () => {
    if (!browser) return;
    await list([LISTED]);
    const r = await fetch(`${s.base}/api/embed/keys`, {
      method: "POST",
      headers: { origin: LISTED, "content-type": "application/json" },
      body: JSON.stringify({
        project: "north",
        agent: "scout",
        origin: LISTED,
      }),
    });
    expect(r.status).toBe(403);
  });
});
