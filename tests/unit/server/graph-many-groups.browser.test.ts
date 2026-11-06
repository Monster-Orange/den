/**
 * The Graph page at scale (0.3.0-dev.34, a consumer's dogfood with 31
 * services in 10 org groups across many active workspaces):
 *
 *   - first paint fits: "All active" opened at 60% with 17 of 31 cards
 *     outside the stage at 1440×900 (22 at 1024×768) until Fit was
 *     clicked. The view fits once the final layout is drawn (the org
 *     frames land after the first draw), and re-fits when the set of
 *     cards changes, unless the user zoomed or panned.
 *   - groups wrap: every org group sat in one row (top-down), so Fit
 *     needed 15–24%. They wrap into rows (columns left-right) sized for
 *     the stage, and the edges between groups still join their cards.
 *   - the picker and ?ws= agree: on /graph?ws=w2, "All active" changed
 *     the pill but the URL kept ?ws=w2 (which wins), so the header and the
 *     graph stayed on w2, after a reload too.
 *
 * The real web server in a throwaway distribution: two active workspaces
 * (w1, w2), 10 orgs, 15 repos, 31 services, four dependencies between
 * orgs. Playwright's headless Chromium, nothing clicked before measuring.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
// org → its repos' service counts (31 services, 15 repos).
const ORGS: [string, number[]][] = [
  ["acme", [3, 2]],
  ["globex", [2, 2]],
  ["initech", [3]],
  ["shop", [1, 1]],
  ["umbrella", [3]],
  ["hooli", [2, 2]],
  ["northwind", [3]],
  ["contoso", [1]],
  ["fabrikam", [2, 1]],
  ["tailspin", [3]],
];
const REPOS = ORGS.flatMap(([org, counts]) =>
  counts.map((n, i) => ({ org, repo: `${org}-${i ? "web" : "api"}`, n })),
);
// Dependencies between orgs, each inside one workspace (a workspace's
// /api/graph names its own repos): from's first service uses to's repo.
const CROSS: [string, string][] = [
  ["globex-api", "acme-api"],
  ["initech-api", "globex-api"],
  ["shop-api", "acme-web"],
  ["hooli-api", "northwind-api"],
];
const W1 = REPOS.slice(0, 8).map((r) => r.repo); // acme … shop
const W2 = REPOS.slice(8).map((r) => r.repo); // umbrella … tailspin
const SERVICES = REPOS.reduce((n, r) => n + r.n, 0);
const SHOTS = process.env.DEN_SHOTS_DIR;
/** A workspace's [cards, org frames]. */
const shape = (names: string[]): [number, number] => {
  const rs = REPOS.filter((r) => names.includes(r.repo));
  return [rs.reduce((n, r) => n + r.n, 0), new Set(rs.map((r) => r.org)).size];
};

let tmp = "";
let port = 0;
let server: ChildProcess;
let serverOut = "";
let browser: Browser | null = null;
let latest = "";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function get(p: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "localhost", port, path: p, timeout: 5_000, agent: false },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
const api = (p: string) => `http://localhost:${port}${p}`;
const setScope = (scope: string) =>
  fetch(api("/api/scope"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope }),
  });

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-many-")));
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    REPOS.map((r) => `${r.repo}:\n  gh: ${r.org}/${r.repo}\n`).join(""),
  );
  const ws = (names: string[]) =>
    names.flatMap((n) => [
      `      ${n}:`,
      "        mode: dev-managed",
      `        path: ${path.join(repos, n)}`,
    ]);
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [w1, w2]",
      "focus: w1",
      "workspaces:",
      "  w1:",
      "    services:",
      ...ws(W1),
      "  w2:",
      "    services:",
      ...ws(W2),
      "",
    ].join("\n"),
  );
  for (const r of REPOS) {
    const deps = CROSS.filter(([f]) => f === r.repo).map(([, t]) => t);
    // The URL a repo's config names is the edge the graph derives
    // (depends_on below makes it hard).
    if (deps.length)
      write(
        path.join(repos, r.repo, "stack.yml"),
        deps
          .map((d) => `${d.toUpperCase().replace("-", "_")}_URL: http://${d}\n`)
          .join(""),
      );
    write(
      path.join(repos, r.repo, ".den.yml"),
      `name: ${r.repo}\nservices:\n` +
        Array.from({ length: r.n }, (_, i) =>
          [
            `  svc${i + 1}:`,
            ...(i === 0 && deps.length
              ? ["    depends_on:", ...deps.map((d) => `      - ${d}`)]
              : []),
            "    commands:",
            "      local:",
            '        up: "true"',
            "",
          ].join("\n"),
        ).join(""),
    );
  }

  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  server = spawnServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
  const deadline = Date.now() + 40_000;
  for (;;) {
    if (server.exitCode !== null)
      throw new Error(`server exited:\n${serverOut}`);
    try {
      const r = await get("/api/server-info");
      if (r.status === 200 && JSON.parse(r.body).root === root) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline)
      throw new Error(`server did not start:\n${serverOut}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  latest =
    (JSON.parse((await get("/api/changelog")).body) as { version: string }[])[0]
      ?.version ?? "";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
  }
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function page(url: string, w: number, h: number): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: w, height: h },
    // DEN_SHOTS_DIR: screenshots for the release notes, in Den dark.
    ...(SHOTS ? { colorScheme: "dark" as const } : {}),
  });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  await p.goto(api(url));
  return p;
}

/** Wait until every service has a card and the org frames are drawn. */
async function settled(p: Page, cards = SERVICES, orgs = ORGS.length) {
  try {
    await p.waitForFunction(
      ([c, o]) =>
        document.querySelectorAll(".dg-card").length === c &&
        document.querySelectorAll(".dg-grp.dg-org").length === o,
      [cards, orgs] as const,
      { timeout: 20_000 },
    );
  } catch (err) {
    const drawn = await p.evaluate(() => ({
      url: location.href,
      cards: document.querySelectorAll(".dg-card").length,
      orgs: [...document.querySelectorAll<HTMLElement>(".dg-grp.dg-org")].map(
        (g) => g.dataset.key,
      ),
    }));
    throw new Error(
      `want ${cards} cards in ${orgs} orgs, drew ${JSON.stringify(drawn)}: ${String(err)}`,
    );
  }
  // The fit follows the last layout; give a late redraw time to land.
  await p.waitForTimeout(800);
}

/** Cards (and org frames) not wholly inside the stage's viewport. */
const outside = (p: Page) =>
  p.evaluate(() => {
    const vp = document.querySelector(".dg-vp")!.getBoundingClientRect();
    const out = (sel: string) =>
      [...document.querySelectorAll(sel)].filter((e) => {
        const r = e.getBoundingClientRect();
        return (
          r.left < vp.left - 1 ||
          r.top < vp.top - 1 ||
          r.right > vp.right + 1 ||
          r.bottom > vp.bottom + 1
        );
      }).length;
    return {
      cards: out(".dg-card"),
      groups: out(".dg-grp"),
      zoom: parseInt(
        document.querySelector('[data-z="100"]')!.textContent ?? "0",
        10,
      ),
    };
  });

describe("/graph with many groups (0.3.0-dev.34)", () => {
  it.each([
    [1440, 900, 35],
    [1024, 768, 25],
  ])(
    "All active at %i×%i: on first paint every card is inside the stage, without Fit, at %i%% or more",
    async (w, h, least) => {
      if (!browser) return;
      await setScope("all");
      const p = await page("/graph", w, h);
      await settled(p);
      const r = await outside(p);
      if (SHOTS)
        await p.screenshot({
          path: path.join(
            SHOTS,
            `graph-first-paint-many-groups-${w}-den-dark.png`,
          ),
        });
      // Fit agrees with the first paint: it was already the fitted view.
      await p.click('[data-z="fit"]');
      await p.waitForTimeout(150);
      const f = await outside(p);
      process.stdout.write(
        `graph-many ${w}x${h}: first paint ${r.zoom}% (${r.cards} cards outside), Fit ${f.zoom}% (${f.cards} outside)\n`,
      );
      expect({ cards: r.cards, groups: r.groups }).toEqual({
        cards: 0,
        groups: 0,
      });
      expect(r.zoom).toBeGreaterThanOrEqual(least);
      expect(f.zoom).toBe(r.zoom);
      await p.context().close();
    },
    45_000,
  );

  it("the org groups wrap into rows (top-down) and columns (left-right) and fit; each edge between orgs still joins its two cards", async () => {
    if (!browser) return;
    await setScope("all");
    const p = await page("/graph", 1440, 900);
    await settled(p);
    try {
      for (const dir of ["down", "right"]) {
        await p.click(`[data-seg="dir"] [data-v="${dir}"]`);
        await p.waitForTimeout(800);
        // Fit (so this measures the wrap, not the first paint's fit).
        await p.click('[data-z="fit"]');
        await p.waitForTimeout(150);
        const g = await p.evaluate((d) => {
          const px = (e: HTMLElement, k: "top" | "left") =>
            parseFloat(e.style[k]);
          const orgs = [
            ...document.querySelectorAll<HTMLElement>(".dg-grp.dg-org"),
          ];
          // Rows top-down: distinct tops; columns left-right: lefts.
          const bands = new Set(
            orgs.map((o) => px(o, d === "down" ? "top" : "left")),
          );
          // Each cross-org edge path: its ends on its cards' boxes.
          const box = (id: string) => {
            const c = document.querySelector<HTMLElement>(
              `.dg-card[data-id="${id}"]`,
            )!;
            const l = parseFloat(c.style.left),
              t = parseFloat(c.style.top);
            return {
              l,
              t,
              r: l + parseFloat(c.style.width),
              b: t + parseFloat(c.style.height),
            };
          };
          const on = (x: number, y: number, b: ReturnType<typeof box>) =>
            x >= b.l - 1 && x <= b.r + 1 && y >= b.t - 1 && y <= b.b + 1;
          const ends = [
            ...document.querySelectorAll<SVGPathElement>("path.dg-e"),
          ]
            .filter(
              (e) => e.dataset.f!.split("-")[0] !== e.dataset.t!.split("-")[0],
            )
            .map((e) => {
              const n = e.getTotalLength();
              const a = e.getPointAtLength(0),
                z = e.getPointAtLength(n);
              return `${e.dataset.f}>${e.dataset.t}:${on(a.x, a.y, box(e.dataset.f!))}/${on(z.x, z.y, box(e.dataset.t!))}`;
            })
            .sort();
          return { bands: bands.size, ends };
        }, dir);
        expect(g.bands).toBeGreaterThan(1);
        expect(g.ends).toEqual(
          [
            "globex-api/svc1>acme-api/svc1:true/true",
            "hooli-api/svc1>northwind-api/svc1:true/true",
            "initech-api/svc1>globex-api/svc1:true/true",
            "shop-api>acme-web/svc1:true/true",
          ].sort(),
        );
        const r = await outside(p);
        process.stdout.write(`graph-many ${dir} 1440x900: Fit ${r.zoom}%\n`);
        expect([dir, r.cards, r.groups]).toEqual([dir, 0, 0]);
        expect(r.zoom).toBeGreaterThanOrEqual(35);
      }
    } finally {
      await p.click('[data-seg="dir"] [data-v="down"]');
      await p.waitForTimeout(300);
      await p.context().close();
    }
  }, 60_000);

  // The org frames come from /api/orgs, which lands after the first
  // draw: the graph is drawn again with ten groups where it had one. Held
  // back here, so the second draw is surely the later one.
  const lateOrgs = async (p: Page) =>
    p.route("**/api/orgs*", async (route) => {
      await new Promise((r) => setTimeout(r, 1_500));
      await route.continue();
    });
  async function lateContext() {
    const ctx = await browser!.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await ctx.addInitScript((v) => {
      try {
        localStorage.setItem("den-changelog-seen", v);
      } catch {
        /* none */
      }
    }, latest);
    const p = await ctx.newPage();
    await lateOrgs(p);
    await p.goto(api("/graph"));
    await p.waitForFunction(
      (c) => document.querySelectorAll(".dg-card").length === c,
      SERVICES,
      { timeout: 20_000 },
    );
    // Before the orgs land: one frame, the org-less group.
    expect(await p.$$(".dg-grp.dg-org")).toHaveLength(1);
    return p;
  }

  it("the org frames landing after the first draw: an untouched view re-fits to the new layout", async () => {
    if (!browser) return;
    await setScope("all");
    const p = await lateContext();
    await settled(p);
    const r = await outside(p);
    expect({ cards: r.cards, groups: r.groups }).toEqual({
      cards: 0,
      groups: 0,
    });
    await p.context().close();
  }, 45_000);

  it("a view the user zoomed before the org frames landed stays as they left it", async () => {
    if (!browser) return;
    await setScope("all");
    const p = await lateContext();
    await p.waitForTimeout(200);
    await p.click('[data-z="in"]');
    const before = await p.$eval(
      ".dg-world",
      (e) => (e as HTMLElement).style.transform,
    );
    await settled(p);
    expect(
      await p.$eval(".dg-world", (e) => (e as HTMLElement).style.transform),
    ).toBe(before);
    await p.context().close();
  }, 45_000);
});

// One workspace's graph (renderContent's, not the All active merge). It
// was Local Dev's Graph tab until dev.35; Workspaces has no graph of its
// own now (R24), so the check runs where that graph lives: /graph?ws=.
describe("one workspace's graph (/graph?ws=) fits on first paint (0.3.0-dev.34)", () => {
  it.each([
    [1440, 900],
    [1024, 768],
  ])(
    "w1 at %i×%i: every card inside the stage, without Fit",
    async (w, h) => {
      if (!browser) return;
      const p = await page("/graph?ws=w1", w, h);
      await settled(p, ...shape(W1));
      const r = await outside(p);
      expect({ cards: r.cards, groups: r.groups }).toEqual({
        cards: 0,
        groups: 0,
      });
      await p.context().close();
    },
    45_000,
  );
});

// A consumer's dev.33 finding: on /graph?ws=w2, "All active" in the top
// bar's Workspace picker changed the pill but the URL kept ?ws=w2, which
// wins, so the header and the graph stayed on w2, after a reload too.
describe("the Workspace picker on /graph replaces ?ws= (0.3.0-dev.34)", () => {
  const sub = (p: Page) =>
    p.textContent("#den-content > .ph .sub").then((s) => s ?? "");
  const repos = (p: Page) =>
    p.$$eval(".dg-card", (els) =>
      [
        ...new Set(
          els.map((e) => (e as HTMLElement).dataset.id!.split("/")[0]),
        ),
      ].sort(),
    );
  const pill = (p: Page) => p.textContent("#ws-pill .den-vn");

  it("/graph?ws=w2 → All active: no ws in the URL, the line reads All active, both workspaces drawn; a reload keeps it; a workspace sets ?ws=", async () => {
    if (!browser) return;
    await setScope("all");
    try {
      const p = await page("/graph?ws=w2", 1440, 900);
      await settled(p, ...shape(W2));
      // ?ws= on a fresh load wins, and the pill shows it.
      expect(await pill(p)).toBe("w2");
      expect(await sub(p)).toMatch(/(^|\/ )w2 \/ local$/);
      const len = await p.evaluate(() => history.length);

      await p.click("#ws-pill");
      await Promise.all([
        p.waitForNavigation(),
        p.click('.den-pop .den-mi:has-text("All active")'),
      ]);
      const check = async () => {
        await settled(p);
        expect(new URL(p.url()).searchParams.has("ws")).toBe(false);
        expect(await sub(p)).toMatch(/(^|\/ )All active \/ /);
        expect(await pill(p)).toBe("All active");
        expect(await repos(p)).toEqual([...W1, ...W2].sort());
      };
      await check();
      // Replaced, not pushed.
      expect(await p.evaluate(() => history.length)).toBe(len);
      await p.reload();
      await check();

      // A workspace picked: ?ws= names it.
      await p.click("#ws-pill");
      await Promise.all([
        p.waitForNavigation(),
        p.click('.den-pop .den-mi:has-text("w1")'),
      ]);
      await settled(p, ...shape(W1));
      expect(new URL(p.url()).searchParams.get("ws")).toBe("w1");
      expect(await pill(p)).toBe("w1");
      expect(await sub(p)).toMatch(/(^|\/ )w1 \/ local$/);
      expect(await repos(p)).toEqual([...W1].sort());
      await p.context().close();
    } finally {
      await setScope("all");
    }
  }, 60_000);
});
