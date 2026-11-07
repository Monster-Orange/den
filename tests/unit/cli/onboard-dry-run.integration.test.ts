/**
 * ON-4's dry run: the install-den skill's steps (skills/install-den/SKILL.md),
 * as an agent runs them, on a scratch HOME and a scratch folder with one
 * tiny sample repo. Every step answers `ok` in JSON, and each is run twice
 * to show it is safe to re-run. The wall-clock time from the first step to
 * "service running, MCP connected" is recorded as the metric (R11, target
 * 5 minutes or less); it is printed, never asserted, so a slow CI machine
 * cannot fail it.
 *
 * The steps:
 *   1. create <name> <dir> --yes --json       (another "Den" already holds
 *      the start port, so create picks the next free one and writes it to
 *      config/local/user.yml; DEN_WEB_PORT_START stands in for the default,
 *      so nothing here touches 7777)
 *      (then the engine linked into node_modules, standing in for
 *      `npm install`, which would download Den from the registry)
 *   2. repo add <repo> --health <url> --json  (a side-car; repo untouched)
 *   3. up <repo> --json                       (started, then already-running)
 *   4. web up --no-open --json                (url and port, twice)
 *   5. doctor --json                          (node, git, docker, web, mcp)
 *   6. mcp connect --runtime claude --dry-run --json, and
 *      mcp connect --runtime grok --json      (writes the scratch HOME only)
 *
 * The sample repo's `make up` serves http on a free localhost port; the
 * service is stopped and the web server shut down afterwards. Nothing here
 * runs a real claude, codex, gemini or grok (tests/setup.ts puts inert
 * stand-ins first on PATH) or touches the real HOME.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
/** ON-5's share line, as people see it on the site and in the README. */
const SHARE_LINE =
  "Set up Den for me by following https://raw.githubusercontent.com/Monster-Orange/den/main/skills/install-den/SKILL.md";
let tmp = "";
let dist = "";
let repo = "";
let appPort = 0;
let webPort = 0;
/** Holds the start port, as another distribution's web server would. */
let held: net.Server | null = null;
let heldPort = 0;
let env: NodeJS.ProcessEnv = {};
let started = 0;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "localhost", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** One GET with no keep-alive (Linux CI: agent false, Connection: close). */
function get(port: number, p: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "localhost",
        port,
        path: p,
        agent: false,
        headers: { Connection: "close" },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", () => resolve(0));
    req.end();
  });
}

interface Step {
  code: number;
  // A command's JSON answer, read field by field below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  out: string;
}

function run(cmd: string, args: string[], cwd: string): Step {
  const r = spawnSync(cmd, args, {
    cwd,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  let json: unknown = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = { unparsed: r.stdout.slice(-2000), stderr: r.stderr.slice(-2000) };
  }
  return { code: r.status ?? -1, json, out: `${r.stdout}${r.stderr}` };
}

const acme = (...args: string[]) =>
  run(path.join(dist, "bin", "acme"), args, dist);

/** Run a step twice: both ok (exit 0), and the answers to compare. */
function twice(...args: string[]): [Step, Step] {
  const a = acme(...args);
  expect([args.join(" "), a.code, a.json?.ok]).toEqual([
    args.join(" "),
    0,
    true,
  ]);
  const b = acme(...args);
  expect([args.join(" "), b.code, b.json?.ok]).toEqual([
    args.join(" "),
    0,
    true,
  ]);
  return [a, b];
}

function treeDigest(root: string): string {
  const h = createHash("sha256");
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    h.update(`${rel}\0${st.mode}\0`);
    if (st.isDirectory())
      for (const e of fs.readdirSync(abs).sort()) walk(path.join(rel, e));
    else if (st.isFile()) h.update(fs.readFileSync(abs));
  };
  walk("");
  return h.digest("hex");
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-on4-")));
  dist = path.join(tmp, "den");
  repo = path.join(tmp, "sample");
  appPort = await freePort();
  held = net.createServer((c) => c.destroy());
  await new Promise<void>((r) => held!.listen(0, "localhost", () => r()));
  heldPort = (held.address() as net.AddressInfo).port;
  for (const [k, v] of Object.entries(process.env))
    // Keep setup.ts's guards (no login shell, no runtime search dirs).
    if (!/^(DEN_(?!LOGIN_SHELL$|RUNTIME_DIRS$)|ACME_|OP_|DOPPLER_)/.test(k))
      env[k] = v;
  env = {
    ...env,
    HOME: path.join(tmp, "home"),
    ACME_HOME: path.join(tmp, "acme-home"),
    NO_COLOR: "1",
    CI: "1",
    DEN_FORCE_TABS: "0",
    DEN_WEB_PORT_START: String(heldPort),
  };
  fs.mkdirSync(path.join(tmp, "home"));
  // The sample repo: `make up` serves http on its port until stopped.
  fs.mkdirSync(repo);
  fs.writeFileSync(
    path.join(repo, "Makefile"),
    [
      "up:",
      `\tnode -e "require('http').createServer((q, s) => s.end('ok')).listen(${appPort}, 'localhost')"`,
      "down:",
      "\t@echo stopped",
      "",
    ].join("\n"),
  );
});

afterAll(async () => {
  if (dist && fs.existsSync(path.join(dist, "bin", "acme"))) {
    acme("down", "sample");
    acme("web", "down");
  }
  // Fallback: anything this test started still listening on its ports.
  for (const port of [appPort, webPort].filter(Boolean))
    spawn("sh", [
      "-c",
      `for p in $(lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null); do kill $p; done`,
    ]);
  if (held) await new Promise((r) => held!.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("ON-4: the install-den skill's steps, dry run", () => {
  it("every step answers ok and is safe to re-run; the paste-to-connected time is recorded", async () => {
    started = Date.now();

    // 1. create --yes --json, twice.
    const den = path.join(ENGINE, "bin", "den");
    const c1 = run(den, ["create", "acme", dist, "--yes", "--json"], tmp);
    expect([c1.code, c1.json]).toEqual([
      0,
      expect.objectContaining({
        ok: true,
        existed: false,
        dir: dist,
        cli: "acme",
        portPicked: {
          wanted: heldPort,
          file: path.join("config", "local", "user.yml"),
        },
      }),
    ]);
    webPort = c1.json.port;
    expect(webPort).toBeGreaterThan(heldPort);
    expect(
      fs.readFileSync(path.join(dist, "config", "local", "user.yml"), "utf-8"),
    ).toMatch(new RegExp(`^web:\n  port: ${webPort}$`, "m"));
    const c2 = run(den, ["create", "acme", dist, "--yes", "--json"], tmp);
    expect([c2.code, c2.json]).toEqual([
      0,
      expect.objectContaining({ ok: true, existed: true, port: webPort }),
    ]);
    // `npm install`, offline: the engine where npm would put it.
    fs.mkdirSync(path.join(dist, "node_modules", "@monster-orange"), {
      recursive: true,
    });
    fs.symlinkSync(
      ENGINE,
      path.join(dist, "node_modules", "@monster-orange", "den"),
    );
    // The share line is in --help (ON-5).
    expect(acme("--help").out).toContain(SHARE_LINE);

    // 2. repo add, twice; the repo's tree never changes.
    const repoBefore = treeDigest(repo);
    const health = `http://localhost:${appPort}/`;
    const [r1, r2] = twice("repo", "add", repo, "--health", health, "--json");
    expect(r1.json).toMatchObject({
      existed: false,
      repo: "sample",
      manifest: { source: "sidecar", written: true, detected: "make" },
    });
    expect(r2.json).toMatchObject({
      existed: true,
      manifest: { written: false },
    });
    expect(treeDigest(repo)).toBe(repoBefore);

    // 3. up --json, twice: started healthy, then already running.
    const [u1, u2] = twice("up", "sample", "--json");
    expect(u1.json.services).toEqual([
      { address: "sample", result: "started", health: "ok" },
    ]);
    expect(u2.json.services).toEqual([
      { address: "sample", result: "already-running", health: "ok" },
    ]);
    expect(await get(appPort, "/")).toBe(200);

    // 4. web up --json, twice (the second finds it running).
    const [w1, w2] = twice("web", "up", "--no-open", "--json");
    for (const w of [w1, w2])
      expect(w.json).toMatchObject({
        url: `http://localhost:${webPort}`,
        port: webPort,
      });
    expect(await get(webPort, "/api/server-info")).toBe(200);

    // 5. doctor --json, twice: every onboarding check ok, web with its URL.
    const [d1, d2] = twice("doctor", "--json");
    for (const d of [d1, d2]) {
      const byId = Object.fromEntries(
        (d.json.checks as { id: string; status: string }[]).map((c) => [
          c.id,
          c,
        ]),
      );
      for (const id of ["node", "git", "docker", "web", "mcp"])
        expect([id, byId[id]?.status]).toEqual([id, "ok"]);
      expect(byId.web).toMatchObject({
        url: `http://localhost:${webPort}`,
        port: webPort,
      });
    }

    // 6. mcp connect: claude as a dry run (its CLI would run), grok for real
    // into the scratch HOME; the second grok run changes nothing.
    const [m1] = twice(
      "mcp",
      "connect",
      "--runtime",
      "claude",
      "--dry-run",
      "--json",
    );
    expect(m1.json.clients).toEqual([
      expect.objectContaining({ id: "claude-code", ok: true }),
    ]);
    expect(m1.json.web).toEqual({
      url: `http://localhost:${webPort}`,
      up: true,
    });
    const [g1, g2] = twice("mcp", "connect", "--runtime", "grok", "--json");
    const grokFile = path.join(tmp, "home", ".grok", "config.toml");
    expect(g1.json.clients).toEqual([
      expect.objectContaining({
        id: "grok",
        ok: true,
        file: grokFile,
        changed: true,
      }),
    ]);
    expect(g2.json.clients).toEqual([
      expect.objectContaining({ id: "grok", changed: false }),
    ]);
    expect(fs.readFileSync(grokFile, "utf-8")).toMatch(
      /^\[mcp_servers\.acme\]$/m,
    );

    // The metric: paste to "service running, MCP connected". Recorded only.
    const seconds = (Date.now() - started) / 1000;

    // 7. Clean up the way the skill does, in JSON too: down, then web down,
    // each twice (the second finds it already stopped).
    const [x1, x2] = twice("down", "sample", "--json");
    expect(x1.json).toMatchObject({ ok: true, services: ["sample"] });
    expect(x2.json).toMatchObject({ ok: true });
    const [y1, y2] = twice("web", "down", "--json");
    for (const y of [y1, y2])
      expect(y.json).toMatchObject({
        ok: true,
        running: false,
        url: `http://localhost:${webPort}`,
        port: webPort,
      });
    expect(y1.json.stopped).toBe(true);
    expect(y2.json.stopped).toBe(false);
    expect(await get(webPort, "/api/server-info")).toBe(0);
    process.stderr.write(
      `\n  ON-4 dry run: paste → service running, MCP connected in ${seconds.toFixed(1)}s (target ≤ 300s)\n`,
    );
    if (process.env.DEN_ON4_METRIC_FILE)
      fs.writeFileSync(
        process.env.DEN_ON4_METRIC_FILE,
        `${JSON.stringify({ metric: "on4-dry-run-seconds", seconds })}\n`,
      );
  }, 600_000);
});
