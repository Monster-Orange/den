#!/usr/bin/env node
/**
 * DOC-1: the README's screenshots, generated from examples/demo.
 *
 *   DEN_ORG_NAMES_FILE=../notes/org-names.txt node scripts/doc-shots.mjs
 *   npm run docs:shots
 *
 * Runs a Den web server on a scratch copy of examples/distribution with the
 * examples/demo repos as its workspace (a docker shim stands in for docker,
 * on a random localhost port, with a throwaway HOME), captures each shot
 * with Playwright and writes them, with alt.json (the alt text), to
 * docs/images/<version>/ (version: package.json's, without the prerelease
 * suffix). Nothing reaches the tree unless every shot passes: they are
 * captured to a staging dir first.
 *
 * The capture guard: before each shot the page's text (innerText, every
 * title, alt and aria-label, and SVG text) goes through the org-name
 * gate's matcher (scripts/org-names.js). A hit aborts the run naming the
 * shot and the term, never the text around it, and no image is written.
 * Without DEN_ORG_NAMES / DEN_ORG_NAMES_FILE the run refuses (exit 2), as
 * the gate does; --unguarded runs anyway, for local layout work only.
 *
 * The animated "up" shot needs ffmpeg (GIF) or img2webp (animated WebP) on
 * PATH; with neither it is skipped with a message.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkShotText, guardShot, releaseVersion } from "./doc-shots-guard.js";
import { orgPatterns } from "./org-names.js";

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── the demo server ─────────────────────────────────────────────────────────

const REPOS = ["demo-api", "demo-web", "demo-notes"];
/** Each demo repo's compose service (its route target), for the docker shim. */
const COMPOSE_SERVICE = {
  "demo-api": "api",
  "demo-web": "web",
  "demo-notes": "notes",
};
/** Each demo repo's edge route: [route, `<compose service>-1:<port>`]. */
const ROUTE = {
  "demo-api": ["api", "api-1:8080"],
  "demo-web": ["app", "web-1:8080"],
  "demo-notes": ["app", "notes-1:8080"],
};
const WORKSPACE = "demo";

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "localhost", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * A scratch distribution in `tmp`: examples/distribution renamed to "den"
 * (so the shots show Den, not the scaffold's sample brand), the demo repos
 * as the "demo" workspace, and a docker shim whose `ps` lists the running
 * stacks named in `<tmp>/running` (one repo per line). Returns the paths.
 */
export function scaffoldDemo(tmp) {
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  fs.cpSync(path.join(ENGINE, "examples", "distribution"), root, {
    recursive: true,
  });
  fs.cpSync(path.join(ENGINE, "examples", "demo"), repos, { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  // The scaffold's org config, under the name the "den" profile reads.
  fs.renameSync(
    path.join(root, "config", "acme.yml"),
    path.join(root, "config", "den.yml"),
  );
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    [
      "brand:",
      "  name: Den",
      "  tagline: Local dev for you and your agents",
      "secrets:",
      "  provider: none",
      "edge:",
      "  org: den",
      "  domain: localhost",
      "  tls: none",
      "environments: [local]",
      "",
    ].join("\n"),
  );
  const write = (f, c) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, c);
  };
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    REPOS.map((n) => `${n}:\n  gh: example-org/${n}\n`).join(""),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      `active: [${WORKSPACE}]`,
      `focus: ${WORKSPACE}`,
      "workspaces:",
      `  ${WORKSPACE}:`,
      "    services:",
      ...REPOS.flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  const running = path.join(tmp, "running");
  const rows = path.join(tmp, "docker-ps");
  fs.writeFileSync(running, "");
  fs.writeFileSync(rows, "");
  // `docker ps`: the rows file (written by setRunning); `docker inspect`:
  // running (the edge container); anything else fails, so nothing real is
  // ever started, stopped or created.
  write(
    path.join(tmp, "bin", "docker"),
    [
      "#!/bin/sh",
      `if [ "$1" = ps ]; then cat '${rows}'; exit 0; fi`,
      'if [ "$1" = inspect ]; then echo running; exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
  );
  fs.chmodSync(path.join(tmp, "bin", "docker"), 0o755);
  const edge = path.join(tmp, "edge-state");
  fs.mkdirSync(path.join(edge, "dynamic"), { recursive: true });
  return { root, repos, running, rows, edge };
}

/**
 * Marks `names` as running stacks: rows in the docker shim's listing, and
 * each stack's edge route file, in the shape `stack up` writes
 * (renderStackRoutes, http-only edge).
 */
export function setRunning(demo, names) {
  fs.writeFileSync(demo.running, names.join("\n"));
  for (const n of names) {
    const project = `${n}-${WORKSPACE}`;
    const [route, target] = ROUTE[n];
    const key = `stack-${n}-${route}`;
    fs.writeFileSync(
      path.join(demo.edge, "dynamic", `stack-${project}.yml`),
      [
        `# Generated by \`den stack up ${n}\`.`,
        "http:",
        "  routers:",
        `    ${key}:`,
        "      entryPoints: [web]",
        `      rule: Host(\`${route}.${n}.localhost\`)`,
        `      service: ${key}`,
        "  services:",
        `    ${key}:`,
        "      loadBalancer:",
        "        servers:",
        `          - url: http://${project}-${target}`,
        "",
      ].join("\n"),
    );
  }
  fs.writeFileSync(
    demo.rows,
    names
      .map((n) => {
        const project = `${n}-${WORKSPACE}`;
        const svc = COMPOSE_SERVICE[n];
        return `${project}\t${svc}\trunning\tUp 2 minutes (healthy)\t${project}-${svc}-1\n`;
      })
      .join(""),
  );
}

/**
 * Starts the server on the scratch distribution. Its env is built from
 * scratch (HOME, PATH and the DEN_* it needs), never from process.env, so
 * nothing of the caller's environment (tokens, accounts) reaches the page.
 */
export async function startServer(tmp, demo) {
  const port = await freePort();
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    PATH: [
      path.join(tmp, "bin"),
      path.dirname(process.execPath),
      "/usr/bin",
      "/bin",
    ].join(":"),
    DEN_ROOT: demo.root,
    DEN_ENGINE_ROOT: ENGINE,
    DEN_HOME: path.join(home, ".den"),
    DEN_EDGE_DIR: demo.edge,
    DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
    DEN_NO_OPEN: "1",
    NO_COLOR: "1",
    PORT: String(port),
  };
  const log = fs.openSync(path.join(tmp, "server.log"), "w");
  const server = spawn(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    { cwd: demo.root, env, stdio: ["ignore", log, log] },
  );
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) break;
    try {
      if ((await fetch(`${base}/api/server-info`)).ok)
        return { server, base, env };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  server.kill("SIGTERM");
  throw new Error(
    `doc-shots: the server did not start (log: ${path.join(tmp, "server.log")})`,
  );
}

/**
 * The Agents tab's terminal: a plain session in demo-api that runs its test
 * and then the service itself, started with the CLI under the server's own
 * env (so the same state dir and session host). Returns the session id, or
 * null when the PTY module is unavailable (the shot is then skipped).
 */
export async function startSession(tmp, demo, env) {
  const cli = path.join(ENGINE, "bin", "den");
  const run = (args) =>
    execFileSync(cli, args, {
      cwd: demo.root,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const port = await freePort();
  const script = [
    "make test",
    `SERVICE=demo-api PORT=${port} exec '${process.execPath}' server.mjs`,
  ].join(" && ");
  try {
    run([
      "sessions",
      "start",
      "--workspace",
      WORKSPACE,
      "--name",
      "api",
      "--cwd",
      path.join(demo.repos, "demo-api"),
      "--",
      "/bin/sh",
      "-c",
      script,
    ]);
  } catch (e) {
    console.log(
      `  skip agents.png: no session (${
        String(e.stderr ?? e.message)
          .trim()
          .split("\n")[0]
      })`,
    );
    return null;
  }
  const rows = JSON.parse(run(["sessions", "list", "--json"]));
  const list = Array.isArray(rows) ? rows : (rows.sessions ?? []);
  return list.find((r) => /:api$/.test(r.name ?? ""))?.ref?.id ?? null;
}

/** Stops the session host startSession started (its sessions end). */
export function stopSessions(demo, env) {
  try {
    execFileSync(
      path.join(ENGINE, "bin", "den"),
      ["sessions", "host", "--stop"],
      {
        cwd: demo.root,
        env,
        stdio: "ignore",
      },
    );
  } catch {
    /* none running */
  }
}

// ── the shots ───────────────────────────────────────────────────────────────

/** The size budgets (DOC-SPEC): hero ≤400 KB a theme, the rest ≤200 KB, the animation ≤5 MB. */
export const BUDGET = { hero: 400_000, thumb: 200_000, anim: 5_000_000 };

/**
 * Every still: file name, alt text, budget, viewport and how to get there.
 * `go(page, ctx)` leaves the page ready to capture.
 */
const VIEW = { width: 1280, height: 720 };
/** The hero and social preview: 2:1, so the graph fills it. */
const WIDE = { width: 1280, height: 640 };
const STILLS = [
  {
    file: "hero-dark.png",
    alt: "Den's Graph page in dark mode: the demo project's services grouped by application, all healthy, with the status chip and the left rail",
    budget: "hero",
    scheme: "dark",
    viewport: WIDE,
    go: (p, c) => graph(p, c, { dir: "right", group: "app" }),
  },
  {
    file: "hero-light.png",
    alt: "Den's Graph page in light mode: the demo project's services grouped by application, all healthy, with the status chip and the left rail",
    budget: "hero",
    scheme: "light",
    viewport: WIDE,
    go: (p, c) => graph(p, c, { dir: "right", group: "app" }),
  },
  {
    file: "social-preview.png",
    alt: "Den's Graph page: the demo project, all services healthy",
    budget: "thumb",
    scheme: "dark",
    viewport: WIDE,
    scale: 1,
    go: (p, c) => graph(p, c, { dir: "right", group: "app" }),
  },
  {
    file: "workspaces.png",
    alt: "The Projects page: the demo project's repos with their health, mode and Start, Stop, Restart and Logs actions",
    budget: "thumb",
    // Wider: at 1280 the table wraps the repo names.
    viewport: { width: 1440, height: 810 },
    go: async (p, c) => {
      await p.goto(`${c.base}/?ws=${WORKSPACE}`);
      await p.waitForSelector("#repo-table tbody tr.repo");
      await healthy(p);
    },
  },
  {
    file: "graph.png",
    alt: "The Graph page with demo-web selected: its details panel shows its health, its URL on the edge and that it depends on demo-api",
    budget: "thumb",
    go: async (p, c) => {
      await graph(p, c, { dir: "down", group: "app" });
      await p.click('.dg-card[aria-label^="demo-web"]');
      await p.waitForTimeout(800);
    },
  },
  {
    file: "status-drawer.png",
    alt: "The status drawer: nothing needs attention, and every service in the demo project, by application, with its latency",
    budget: "thumb",
    go: async (p, c) => {
      await graph(p, c, { dir: "right", group: "app" });
      await p.click("#den-status");
      await p.waitForSelector("#den-status-drawer");
      await p.waitForTimeout(600);
    },
  },
  {
    file: "edge.png",
    alt: "The Edge page: the edge container up, its ports and TLS, and every route it serves, Den's own and each stack's, with its upstream",
    budget: "thumb",
    go: async (p, c) => {
      await p.goto(`${c.base}/edge`);
      await p.waitForSelector("text=stack-demo-web-app");
      await healthy(p);
    },
  },
  {
    file: "agents.png",
    needsSession: true,
    alt: "The Agents tab: the demo project's agents and shells on the left, and one shell open in a terminal pane on the right, running demo-api's test and then the service",
    budget: "thumb",
    go: async (p, c) => {
      await p.goto(`${c.base}/agents?open=${encodeURIComponent(c.session)}`);
      await p.waitForSelector(".agr");
      await p.waitForFunction(
        () =>
          /listening on/.test(
            document.querySelector("#agr")?.textContent ?? "",
          ),
        null,
        { timeout: 30_000 },
      );
      await healthy(p);
      await p.waitForTimeout(600);
    },
  },
  // After the animation: it leaves the runs dock open in the saved prefs.
  {
    file: "runs-dock.png",
    afterAnimation: true,
    alt: "The Services page with the runs dock open: a preflight run of demo-api and its output",
    budget: "thumb",
    go: async (p, c) => {
      await p.goto(`${c.base}/services`);
      await healthy(p);
      await p
        .locator("button", { hasText: /^preflight$/ })
        .nth(1)
        .click();
      const show = p.getByText("Show runs");
      if (await show.isVisible()) await show.click();
      await p.waitForSelector("text=server.mjs ok", { timeout: 30_000 });
      // The run finished: the Runs chip no longer counts it.
      await p
        .waitForFunction(
          () =>
            !/running/.test(
              document.getElementById("den-runs")?.textContent ?? "",
            ),
          null,
          { timeout: 20_000 },
        )
        .catch(() => {});
      await p.waitForTimeout(500);
    },
  },
];

/** The Graph page in a layout (`dir`: down / right) and grouping (org / app). */
async function graph(p, c, { dir, group }) {
  await p.goto(`${c.base}/graph`);
  await p.waitForSelector(".dg-card");
  for (const [seg, v] of [
    ["dir", dir],
    ["group", group],
  ]) {
    const b = p.locator(`[data-seg="${seg}"] button[data-v="${v}"]`);
    if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
  }
  await healthy(p);
  await p.waitForTimeout(800); // the fit and edge animations settle
}

/** Waits for the status chip to read "All N healthy". */
async function healthy(p) {
  await p.waitForFunction(
    () =>
      /^All \d+ healthy/.test(
        document.getElementById("den-status")?.textContent?.trim() ?? "",
      ),
    null,
    { timeout: 30_000 },
  );
}

/**
 * The `make up` animation's frames, from the real UI: every stack down, then each coming up in dependency order (demo-api before
 * demo-web, which calls it) until the chip reads "All 3 healthy". The
 * docker shim's listing changes between frames; nothing is mocked in the
 * page. Returns [{ path, ms }].
 */
async function upFrames(browser, c, dir, patterns, guardOpts) {
  const ctx = await c.context(browser, {
    scheme: "dark",
    viewport: VIEW,
    scale: 0.75,
  });
  const p = await ctx.newPage();
  const frames = [];
  const frame = async (name, ms) => {
    await guardShot(p, `up:${name}`, patterns, guardOpts);
    const file = path.join(dir, `up-${frames.length}.png`);
    await p.screenshot({ path: file });
    frames.push({ path: file, ms });
  };
  // Each frame is a fresh load of the page: an in-place health update
  // leaves a recovered card's red "down" border behind (graph.js
  // graphHealth toggles it only on repo cards), which a README must not show.
  const step = async (names, chip) => {
    setRunning(c.demo, names);
    await fetch(`${c.base}/api/health?env=local&refresh=1`);
    await p.goto(`${c.base}/graph`);
    await p.waitForSelector(".dg-card");
    await p.waitForFunction(
      (re) =>
        new RegExp(re).test(
          document.getElementById("den-status")?.textContent ?? "",
        ),
      chip.source,
      { timeout: 30_000 },
    );
    await p.waitForTimeout(800);
  };
  // The layout and grouping are the saved prefs the stills left behind.
  await step([], /3 down/);
  await frame("down", 2500);
  await step(["demo-api"], /1\/3 healthy/);
  await frame("demo-api", 1500);
  await step(["demo-api", "demo-web"], /2\/3 healthy/);
  await frame("demo-web", 1500);
  await step(["demo-api", "demo-web", "demo-notes"], /All 3 healthy/);
  await frame("all", 5000);
  await ctx.close();
  return frames;
}

/** Writes the animation with ffmpeg (GIF) or img2webp (animated WebP); null when neither is on PATH. */
function encodeAnimation(frames, stage) {
  const has = (cmd) => {
    try {
      execFileSync("/usr/bin/which", [cmd], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (has("ffmpeg")) {
    const list = path.join(stage, "frames.txt");
    fs.writeFileSync(
      list,
      frames
        .map((f) => `file '${f.path}'\nduration ${f.ms / 1000}\n`)
        .join("") + `file '${frames.at(-1).path}'\n`,
    );
    const file = "up.gif";
    execFileSync(
      "ffmpeg",
      [
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-vf",
        "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
        "-loop",
        "0",
        path.join(stage, file),
      ],
      { stdio: "inherit" },
    );
    return file;
  }
  if (has("img2webp")) {
    const file = "up.webp";
    execFileSync(
      "img2webp",
      [
        "-loop",
        "0",
        "-lossless",
        ...frames.flatMap((f) => ["-d", String(f.ms), f.path]),
        "-o",
        path.join(stage, file),
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    return file;
  }
  return null;
}

function parseArgs(argv) {
  const o = { unguarded: false, out: null, tmp: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--unguarded") o.unguarded = true;
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--tmp") o.tmp = argv[++i];
    else
      throw new Error(
        `doc-shots: unknown argument ${a} (--out <dir>, --tmp <dir>, --unguarded)`,
      );
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ENGINE, "package.json"), "utf-8"),
  );
  const version = releaseVersion(pkg.version);
  const out = path.resolve(
    opts.out ?? path.join(ENGINE, "docs", "images", version),
  );
  const patterns = orgPatterns();
  if (!patterns.length && !opts.unguarded) {
    console.error(
      "doc-shots: no org-name patterns (set DEN_ORG_NAMES or DEN_ORG_NAMES_FILE); --unguarded for local layout work",
    );
    process.exit(2);
  }
  if (!patterns.length)
    console.warn(
      "doc-shots: UNGUARDED: no org-name check; don't publish these images",
    );
  const guardOpts = { home: os.homedir() };
  for (const s of STILLS)
    checkShotText(
      `${s.file} (alt)`,
      `${s.file}\n${s.alt}`,
      patterns,
      guardOpts,
    );

  // A short, neutral scratch root: paths under it show in the shots.
  const base = opts.tmp ?? (fs.existsSync("/tmp") ? "/tmp" : os.tmpdir());
  const tmp = fs.mkdtempSync(path.join(base, "den-shots-"));
  const stage = path.join(tmp, "shots");
  fs.mkdirSync(stage);
  const demo = scaffoldDemo(tmp);
  setRunning(demo, REPOS);
  const { server, base: url, env: serverEnv } = await startServer(tmp, demo);
  const session = await startSession(tmp, demo, serverEnv);
  const { createRequire } = await import("node:module");
  const { chromium } = createRequire(path.join(ENGINE, "package.json"))(
    "playwright",
  );
  const browser = await chromium.launch();
  const latest =
    (await (await fetch(`${url}/api/changelog`)).json())[0]?.version ?? "";
  const c = {
    base: url,
    demo,
    session,
    async context(b, { scheme = "dark", viewport = VIEW, scale = 1 } = {}) {
      const ctx = await b.newContext({
        viewport,
        deviceScaleFactor: scale,
        colorScheme: scheme,
      });
      // "What's new" is for people, not screenshots.
      await ctx.addInitScript((v) => {
        try {
          localStorage.setItem("den-changelog-seen", v);
        } catch {
          /* no storage */
        }
      }, latest);
      return ctx;
    },
  };
  const written = [];
  const alt = {};
  try {
    const still = async (s) => {
      const ctx = await c.context(browser, {
        scheme: s.scheme,
        viewport: s.viewport ?? VIEW,
        scale: s.scale ?? (s.budget === "hero" ? 2 : 1),
      });
      const p = await ctx.newPage();
      await s.go(p, c);
      await guardShot(p, s.file, patterns, guardOpts);
      await p.screenshot({ path: path.join(stage, s.file) });
      await ctx.close();
      written.push({ file: s.file, budget: BUDGET[s.budget] });
      alt[s.file] = s.alt;
      console.log(`  ok   ${s.file}`);
    };
    const stills = STILLS.filter((s) => !s.needsSession || session);
    for (const s of stills.filter((s) => !s.afterAnimation)) await still(s);
    const frames = await upFrames(browser, c, tmp, patterns, guardOpts);
    const anim = encodeAnimation(frames, stage);
    if (anim) {
      alt[anim] =
        "make up in the Graph page: every stack down, then demo-api, demo-web and demo-notes come up in dependency order until the status chip reads All 3 healthy";
      written.push({ file: anim, budget: BUDGET.anim });
      console.log(`  ok   ${anim}`);
    } else
      console.log(
        "  skip up animation: neither ffmpeg nor img2webp is on PATH",
      );
    for (const s of stills.filter((s) => s.afterAnimation)) await still(s);
  } finally {
    await browser.close();
    stopSessions(demo, serverEnv);
    server.kill("SIGTERM");
  }

  const over = written
    .map((w) => ({ ...w, size: fs.statSync(path.join(stage, w.file)).size }))
    .filter((w) => w.size > w.budget);
  if (over.length) {
    for (const w of over)
      console.error(
        `doc-shots: ${w.file} is ${w.size} bytes, over its ${w.budget}-byte budget`,
      );
    process.exit(1);
  }
  // Every shot passed: only now does anything reach the tree.
  fs.mkdirSync(out, { recursive: true });
  for (const w of written)
    fs.copyFileSync(path.join(stage, w.file), path.join(out, w.file));
  fs.writeFileSync(
    path.join(out, "alt.json"),
    JSON.stringify(alt, null, 2) + "\n",
  );
  console.log(
    `doc-shots: ${written.length} images and alt.json in ${path.relative(ENGINE, out) || out}`,
  );
  const others = fs.existsSync(path.dirname(out))
    ? fs
        .readdirSync(path.dirname(out))
        .filter((d) => d !== path.basename(out) && /^\d+\.\d+\.\d+$/.test(d))
    : [];
  if (others.length && !opts.out)
    console.log(
      `doc-shots: older versions still in the tree (their tags keep them): ${others.join(", ")}; git rm them`,
    );
  console.log(`doc-shots: scratch left in ${tmp}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
