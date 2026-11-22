/**
 * Issue 796, clause 6: an agent's view session opens Agents, Settings and
 * the terminal page read-only, in a real browser. The page says it is a
 * read-only view and no write control is live; each write the page could
 * send is refused by the server and logged as the agent.
 *
 * Chromium and WebKit; DEN_PW_WS connects to a Playwright server instead
 * of launching. The demo distribution (helpers/agents-page-server.ts).
 * Invented names only. No code, cookie or token is printed.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import type { Browser, Page } from "playwright";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";
import {
  bindActorSession,
  mintActorToken,
} from "../../../src/shared/actor-token.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";

jest.setTimeout(90_000);

const ENGINES = ["chromium", "webkit"] as const;
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};
let s: AgentsPageServer | null = null;
let token = "";

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES) browsers[e] = await launchBrowser(pw[e]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  // The agent's token, bound to a session that runs from this process (as
  // Den's start binds it to the agent's own).
  const dir = sessionPaths(s.stateDir).dir;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "s-viewer.json"),
    JSON.stringify({ pid: process.pid }),
  );
  const t = mintActorToken(s.stateDir, {
    agentId: "viewer",
    workspace: "north",
    sessionName: "viewer",
  });
  bindActorSession(s.stateDir, t.key, "s-viewer");
  token = t.token;
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

/** The agent's one-time view link (MCP page_view's call). */
function viewLink(next: string): Promise<string> {
  const body = JSON.stringify({ next });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port: s!.port,
        path: "/api/agents/self/view",
        method: "POST",
        agent: false,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d: Buffer) => (buf += d.toString()));
        res.on("end", () => {
          try {
            const j = JSON.parse(buf) as { url?: string };
            if (res.statusCode === 200 && j.url) return resolve(j.url);
          } catch {
            /* refused below */
          }
          reject(new Error(`view link refused: ${res.statusCode}`));
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function open(e: (typeof ENGINES)[number]): Promise<Page> {
  const ctx = await browsers[e]!.newContext({
    viewport: { width: 1280, height: 900 },
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
  return ctx.newPage();
}

/** The page's live write controls: what an agent's view must not have. */
const liveWrites = (p: Page) =>
  p.evaluate(() => {
    const keep =
      '[role="tab"],[aria-haspopup],[aria-expanded],[aria-controls],' +
      '[data-nav],[data-visit],[data-den-view-ok],input[type="search"],' +
      '[role="combobox"],[role="searchbox"]';
    return [
      ...document.querySelectorAll<HTMLElement>(
        "#den-content button,#den-content input,#den-content select,#den-content textarea",
      ),
    ]
      .filter(
        (el) =>
          !el.closest("#den-banners") &&
          !el.matches(keep) &&
          !(el as HTMLButtonElement).disabled,
      )
      .map((el) => el.outerHTML.slice(0, 120));
  });

const audit = () =>
  fs
    .readFileSync(path.join(s!.stateDir, "audit.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe.each(ENGINES)("issue 796 in %s: an agent's read-only view", (e) => {
  it.each([
    ["Agents", "/agents", "#den-content"],
    ["Settings", "/settings", "#den-content"],
    ["Terminals", "/terminals", "#den-content"],
  ])(
    "opens %s read-only, with no live write buttons",
    async (_n, next, sel) => {
      if (!browsers[e] || !s) return;
      const p = await open(e);
      await p.goto(await viewLink(next));
      await p.waitForURL(
        (u) => u.pathname === new URL(next, s!.base).pathname,
        {
          timeout: 20_000,
        },
      );
      await p.locator(sel).waitFor({ timeout: 20_000 });
      const banner = p.locator('[data-banner="view"]');
      await banner.waitFor({ timeout: 20_000 });
      expect(await banner.textContent()).toContain("agent:viewer");
      expect(
        await p.evaluate(() =>
          document.documentElement.getAttribute("data-den-view"),
        ),
      ).toBe("read-only");
      // Once the page has drawn its rows, nothing that writes may be live.
      await p.waitForLoadState("networkidle");
      expect(await liveWrites(p)).toEqual([]);
      await p.context().close();
    },
  );

  it("each write the page could send is refused and logged as the agent", async () => {
    if (!browsers[e] || !s) return;
    const p = await open(e);
    await p.goto(await viewLink("/settings"));
    await p.locator('[data-banner="view"]').waitFor({ timeout: 20_000 });
    const tries = [
      ["POST", "/api/settings", { language: "es" }],
      ["POST", "/api/approvals/a1/decide", { decision: "allow" }],
      ["POST", "/api/workspaces/north/agents/viewer/start", {}],
      ["POST", "/api/workspaces/north/agents/viewer/stop", {}],
    ] as const;
    for (const [method, url, body] of tries) {
      const r = await p.evaluate(
        async ([m, u, b]) => {
          const res = await fetch(u, {
            method: m,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(b),
          });
          const j = (await res.json().catch(() => ({}))) as { code?: string };
          return [res.status, j.code ?? ""];
        },
        [method, url, body] as const,
      );
      expect([url, ...r]).toEqual([url, 403, "agent_view"]);
    }
    const terminal = await p.evaluate(async () => {
      const me = (await (await fetch("/api/session")).json()) as {
        csrf?: string;
      };
      return new Promise<string>((done) => {
        const ws = new WebSocket(`ws://${location.host}/api/sessions/s1/io`, [
          "den.io",
          `den.csrf.${me.csrf ?? ""}`,
        ]);
        ws.onopen = () => done("open");
        ws.onerror = () => done("refused");
        ws.onclose = () => done("refused");
      });
    });
    expect(terminal).toBe("refused");
    const rows = audit().filter(
      (r) => r.verb === "agent-view" && r.outcome === "refused",
    );
    const posts = rows.filter(
      (r) =>
        r.principal === "agent:viewer" && String(r.detail).startsWith("POST "),
    );
    expect(posts.length).toBeGreaterThanOrEqual(tries.length);
    expect(rows.some((r) => String(r.detail).startsWith("WS "))).toBe(true);
    await p.context().close();
  });
});
