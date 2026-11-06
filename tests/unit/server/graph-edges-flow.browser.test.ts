/**
 * Graph edges on top, and flowing when selected (R22b, 0.3.0-dev.35, Ward's
 * QA of dev.34): "the connections between cards should animate in the
 * direction of the relationship. And the arrows need to stay on top of
 * boundaries and groupings so that they stay visible."
 *
 * R22b-1: the edge layer paints above the group frames and the cards and
 * takes no pointer events (cards stay clickable under it).
 * R22b-2: a highlighted edge carries a marching-dash overlay that moves
 * from data-f to data-t; under reduced motion it doesn't move.
 *
 * The real web server in a throwaway distribution (one workspace, two
 * repos; shop's api depends on its worker, so an intra edge crosses the
 * shop frame), driven by Playwright's headless Chromium.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, BrowserContextOptions, Page } from "playwright";

const ENGINE = path.resolve(__dirname, "../../..");
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
function get(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "localhost", port, path: p, timeout: 5_000, agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
const api = (p: string) => `http://localhost:${port}${p}`;

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-flow-")));
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    "environments: [local]\ngithub_org: acme\n",
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    ["shop", "billing"].map((n) => `${n}:\n  gh: acme/${n}\n`).join(""),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [main]",
      "focus: main",
      "workspaces:",
      "  main:",
      "    services:",
      ...["shop", "billing"].flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  const svc = (s: string, deps: string[] = []) =>
    `  ${s}:\n` +
    (deps.length ? `    depends_on: [${deps.join(", ")}]\n` : "") +
    `    commands:\n      local:\n        up: "true"\n`;
  write(
    path.join(repos, "shop", ".den.yml"),
    "name: shop\nservices:\n" + svc("api", ["shop/worker"]) + svc("worker"),
  );
  write(
    path.join(repos, "billing", ".den.yml"),
    "name: billing\nservices:\n" + svc("api"),
  );

  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  server = spawn(
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
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await get("/api/server-info")) === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline)
      throw new Error(`server did not start:\n${serverOut}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  latest =
    (
      (await (await fetch(api("/api/changelog"))).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((r) => setTimeout(r, 5_000).unref()),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const EDGE = 'path.dg-e[data-f="shop/api"][data-t="shop/worker"]';
const FLOW = 'path.dg-flow[data-f="shop/api"][data-t="shop/worker"]';

/** The Graph page at 1440×900, its intra edge drawn. */
async function graph(o: BrowserContextOptions = {}): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    ...o,
  });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  await p.goto(api("/graph?ws=main"));
  // (A straight vertical edge has a zero-width box: attached, not "visible".)
  await p.waitForSelector(EDGE, { state: "attached" });
  await p.waitForTimeout(300);
  return p;
}
/** Select a card by clicking it (the details panel may open). */
async function select(p: Page, id: string): Promise<void> {
  await p.click(`.dg-card[data-id="${id}"]`, { timeout: 8_000 });
  await p.waitForTimeout(200);
}

describe("R22b-2: a selected card's edges flow from data-f to data-t", () => {
  it("the lit edge's overlay animates, its dashoffset decreasing; nothing flows before a selection", async () => {
    if (!browser) return;
    const p = await graph();
    const anim = () =>
      p.$eval(FLOW, (e) => {
        const cs = getComputedStyle(e);
        return { name: cs.animationName, display: cs.display };
      });
    // Nothing selected: no flow.
    expect(await anim()).toEqual({ name: "none", display: "none" });

    // Its dependency flows out of the selected card, and into its dependent.
    for (const id of ["shop/api", "shop/worker"]) {
      await select(p, id);
      expect(await p.$eval(EDGE, (e) => e.classList.contains("hl"))).toBe(true);
      expect(await anim()).toEqual({ name: "dg-flow", display: "inline" });
    }
    // The overlay keeps its kind's colour (intra: --muted), the base's.
    const colours = await p.evaluate(
      ([a, b]) => [
        getComputedStyle(document.querySelector(a)!).stroke,
        getComputedStyle(document.querySelector(b)!).stroke,
      ],
      [EDGE, FLOW],
    );
    expect(colours[1]).toBe(colours[0]);

    // Visible (Ward QA of dev.35): the lit base fades to a track and the
    // overlay is full strength and wider, so the dashes stand out from it.
    const look = await p.evaluate(
      ([a, b]) => {
        const base = getComputedStyle(document.querySelector(a)!);
        const flow = getComputedStyle(document.querySelector(b)!);
        return {
          baseOpacity: parseFloat(base.strokeOpacity),
          flowOpacity: parseFloat(flow.strokeOpacity),
          wider: parseFloat(flow.strokeWidth) > parseFloat(base.strokeWidth),
        };
      },
      [EDGE, FLOW],
    );
    expect(look.baseOpacity).toBeLessThanOrEqual(0.4);
    expect(look.flowOpacity).toBe(1);
    expect(look.wider).toBe(true);

    // From → to: the dashoffset falls over time (it wraps 0 → 20 once a
    // second, so a fall is a small step and a wrap a big jump).
    const offs: number[] = [];
    for (let i = 0; i < 6; i++) {
      offs.push(
        await p.$eval(FLOW, (e) =>
          parseFloat(getComputedStyle(e).strokeDashoffset),
        ),
      );
      await p.waitForTimeout(90);
    }
    const steps = offs.slice(1).map((v, i) => v - offs[i]);
    expect(steps.filter((d) => d < 0 && d > -10).length).toBeGreaterThan(0);
    expect(steps.filter((d) => d > 0 && d < 10)).toEqual([]);
    await p.context().close();
  }, 45_000);

  it("under reduced motion nothing moves: the lit edge stays thicker in the accent colour", async () => {
    if (!browser) return;
    const p = await graph({ reducedMotion: "reduce" });
    await select(p, "shop/api");
    const r = await p.evaluate(
      ([a, b]) => {
        const base = getComputedStyle(document.querySelector(a)!);
        const probe = document.createElement("span");
        probe.style.color = "var(--accent)";
        document.body.appendChild(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        return {
          flow: getComputedStyle(document.querySelector(b)!).animationName,
          width: base.strokeWidth,
          opacity: base.strokeOpacity,
          accent: base.stroke === accent,
        };
      },
      [EDGE, FLOW],
    );
    expect(r).toEqual({
      flow: "none",
      width: "3px",
      opacity: "1",
      accent: true,
    });
    await p.context().close();
  }, 30_000);
});

describe("R22b-1: the edge layer paints above the frames and the cards", () => {
  it("at the arrowhead over the shop frame, the edge layer is on top; cards under it stay clickable", async () => {
    if (!browser) return;
    const p = await graph();
    // The arrowhead: the path's end, a few px back along it (it sits over
    // the shop repo frame, just outside the worker card's border).
    const tip = await p.$eval(EDGE, (e) => {
      const path = e as SVGPathElement;
      const len = path.getTotalLength();
      const pt = path.getPointAtLength(Math.max(0, len - 3));
      const m = path.getScreenCTM()!;
      return { x: pt.x * m.a + m.e, y: pt.y * m.d + m.f };
    });
    // The layer takes no pointer events: what's under it gets the hit.
    const under = await p.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest(".dg-grp, .dg-card")
          ?.className ?? "",
      tip,
    );
    expect(under).toMatch(/dg-(grp|card)/);
    // Stacking order: with hit-testing switched on for the check, the
    // topmost element at the arrowhead is the edge layer, not the frame.
    const top = await p.evaluate(({ x, y }) => {
      const svg = document.querySelector<SVGElement>(".dg-world > svg")!;
      svg.style.pointerEvents = "auto";
      const hit = document.elementFromPoint(x, y);
      svg.style.pointerEvents = "";
      return hit?.closest("svg") === svg;
    }, tip);
    expect(top).toBe(true);

    // The card the arrow points at, clicked right under the arrowhead,
    // still takes the click (the layer is pointer-events: none).
    const box = (await (await p.$(
      '.dg-card[data-id="shop/worker"]',
    ))!.boundingBox())!;
    await p.mouse.click(tip.x, box.y + 4);
    await p.waitForTimeout(200);
    expect(
      await p.$eval('.dg-card[data-id="shop/worker"]', (e) =>
        e.classList.contains("sel"),
      ),
    ).toBe(true);
    await p.context().close();
  }, 30_000);
});
