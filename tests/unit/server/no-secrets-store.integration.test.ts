/**
 * Den runs with no secrets store (0.3.0-dev.23).
 *
 * A distribution made by `den create` (which scaffolds `secrets.provider:
 * none`), and the same distribution with NO `secrets:` block at all (the
 * implicit doppler default, resolved lazily), each run through the real
 * CLI, make, the web server and a test run. `op` and `doppler` are taken
 * off PATH, and fakes that record every invocation are put on it instead:
 * neither is ever called, nothing warns, and every secret-backed endpoint
 * or command says "not configured" instead of failing.
 *
 * The test run is a one-iteration performance test and needs k6; without
 * k6 on PATH that one step is skipped (the rest still runs).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import {
  runningDenVersion,
  writeDistribution,
} from "../../../src/ui/cli/create.js";

const ENGINE = process.cwd();
const SECRET_CLIS = ["op", "doppler"];

interface Run {
  code: number | null;
  out: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "localhost", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function get(port: number, p: string, method = "GET"): Promise<Run> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "localhost", port, path: p, method },
      (res) => {
        let body = "";
        res.on("data", (d: Buffer) => (body += d.toString()));
        res.on("end", () => resolve({ code: res.statusCode ?? 0, out: body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const onRealPath = (bin: string): boolean =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((d) => d && fs.existsSync(path.join(d, bin)));

/** One throwaway distribution, its fakes and its env. */
function fixture(label: string, secretsBlock: "none" | "absent") {
  const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `den-nostore-${label}-`)),
  );
  const dist = path.join(tmp, "acme");
  writeDistribution(dist, {
    name: "acme",
    denVersion: runningDenVersion(ENGINE),
  });
  const cfgFile = path.join(dist, "config", "acme.yml");
  if (secretsBlock === "absent") {
    // Drop the scaffold's secrets block (and its comment): no secrets config.
    const cfg = fs
      .readFileSync(cfgFile, "utf-8")
      .replace(/# Secrets backend:[\s\S]*?secrets:\n {2}provider: none\n/, "");
    expect(cfg).not.toMatch(/secrets/);
    fs.writeFileSync(cfgFile, cfg);
  } else {
    expect(fs.readFileSync(cfgFile, "utf-8")).toMatch(
      /secrets:\n {2}provider: none\n/,
    );
  }
  // The engine, as `npm install` of a linked checkout would place it.
  fs.mkdirSync(path.join(dist, "node_modules", "@monster-orange"), {
    recursive: true,
  });
  fs.symlinkSync(
    ENGINE,
    path.join(dist, "node_modules", "@monster-orange", "den"),
  );

  // One repo with one service, in the active workspace.
  const repo = path.join(tmp, "repos", "shop");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(
    path.join(repo, ".acme.yml"),
    [
      "name: shop",
      "services:",
      "  shop:",
      "    commands:",
      "      local:",
      "        up:",
      `          cmd: touch ${path.join(tmp, "up-ran")}`,
      "          detachable: false",
      `        down: touch ${path.join(tmp, "down-ran")}`,
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(dist, "config", "local"), { recursive: true });
  fs.writeFileSync(
    path.join(dist, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: example-org/shop\n",
  );
  fs.writeFileSync(
    path.join(dist, "config", "local", "workspaces.yml"),
    [
      "active: default",
      "workspaces:",
      "  default:",
      "    services:",
      "      shop:",
      "        mode: dev-managed",
      `        path: ${repo}`,
      "",
    ].join("\n"),
  );
  // A one-iteration k6 test of the distribution's own.
  fs.mkdirSync(path.join(dist, "tests", "pillars", "perf", "hello"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dist, "tests", "pillars", "perf", "hello", "test.js"),
    "export const options = { vus: 1, iterations: 1 };\nexport default function () {}\n",
  );

  // Fakes that record any call; no real op or doppler on PATH.
  const fakeBin = path.join(tmp, "fake-bin");
  const calls = path.join(tmp, "secret-cli-calls");
  fs.mkdirSync(fakeBin);
  for (const bin of SECRET_CLIS) {
    fs.writeFileSync(
      path.join(fakeBin, bin),
      `#!/bin/sh\necho "${bin} $*" >> ${calls}\nexit 1\n`,
      { mode: 0o755 },
    );
  }
  // PATH without op and doppler: a dir holding either is replaced by a
  // mirror of links to everything else in it (k6, git, node stay reachable).
  const realDirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((d) => d && fs.existsSync(d))
    .map((d, i) => {
      if (!SECRET_CLIS.some((b) => fs.existsSync(path.join(d, b)))) return d;
      const mirror = path.join(tmp, `path-${i}`);
      fs.mkdirSync(mirror);
      for (const e of fs.readdirSync(d))
        if (!SECRET_CLIS.includes(e))
          fs.symlinkSync(path.join(d, e), path.join(mirror, e));
      return mirror;
    });
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!/^(DEN_|ACME_|OP_|DOPPLER_|E2E_)/.test(k)) env[k] = v;
  Object.assign(env, {
    PATH: [fakeBin, ...realDirs].join(path.delimiter),
    HOME: path.join(tmp, "home"),
    ACME_HOME: path.join(tmp, "acme-home"),
    NO_COLOR: "1",
    CI: "1",
    DEN_FORCE_TABS: "0",
  });
  fs.mkdirSync(path.join(tmp, "home"));

  const run = (cmd: string, args: string[], cwd = dist): Run => {
    const r = spawnSync(cmd, args, {
      cwd,
      env,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const acme = (...args: string[]): Run => run("./bin/acme", args);
  return { tmp, dist, repo, calls, env, run, acme };
}

const hasK6 = onRealPath("k6");

describe.each([
  ["den create (secrets.provider: none)", "none"],
  ["no secrets block at all", "absent"],
] as const)("%s", (label, block) => {
  let f: ReturnType<typeof fixture>;
  let port = 0;
  let webLog = "";

  beforeAll(async () => {
    f = fixture(block, block);
    port = await freePort();
  });

  afterAll(async () => {
    if (port) f.acme("web", "down", "--port", String(port));
    // Fallback: a server this test started is still on the port.
    spawn("sh", [
      "-c",
      `for p in $(lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null); do kill $p; done`,
    ]);
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  it("make setup-secrets: nothing to set up, exit 0", () => {
    const r = f.run("make", ["--no-print-directory", "acme-setup-secrets"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/nothing to set up/);
    expect(r.out).not.toMatch(/warn|⚠|deprecated/i);
  }, 120_000);

  it("make offers no 1Password targets", () => {
    expect(f.run("make", ["-n", "acme-setup-1password"]).code).not.toBe(0);
    expect(f.run("make", ["-n", "auth-configure"]).code).not.toBe(0);
  }, 120_000);

  it("setup and validate", () => {
    const s = f.acme("setup");
    expect(s.code).toBe(0);
    const v = f.run(path.join(f.dist, "bin", "acme"), ["validate"], f.repo);
    expect(v.code).toBe(0);
    expect(v.out).toMatch(/no issues/);
    expect(`${s.out}${v.out}`).not.toMatch(/warn|⚠|deprecated/i);
  }, 120_000);

  it("up (dry run, then for real) and down", () => {
    const dry = f.acme("up", "shop", "-n");
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/Would up: shop/);
    const up = f.acme("up", "shop", "--no-tabs");
    expect(up.code).toBe(0);
    expect(fs.existsSync(path.join(f.tmp, "up-ran"))).toBe(true);
    const down = f.acme("down", "shop");
    expect(down.code).toBe(0);
    expect(`${dry.out}${up.out}${down.out}`).not.toMatch(
      /warn|⚠|deprecated|not ready/i,
    );
  }, 120_000);

  (hasK6 ? it : it.skip)(
    "a test run (one k6 iteration)",
    () => {
      const r = f.acme(
        "run",
        "--pillar=performance",
        "--environment=local",
        "--module=hello",
      );
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/Tests completed successfully/);
      expect(r.out).not.toMatch(/deprecated/i);
    },
    120_000,
  );

  it("web: health, the UI pages, and not-configured secret endpoints", async () => {
    const up = f.acme("web", "up", "--no-open", "--port", String(port));
    expect(up.code).toBe(0);
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      try {
        if ((await get(port, "/api/server-info")).code === 200) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const health = await get(port, "/api/health");
    expect(health.code).toBe(200);
    for (const page of ["/", "/services", "/local-dev", "/settings"]) {
      const r = await get(port, page);
      expect([page, r.code]).toEqual([page, 200]);
      expect(r.out).toMatch(/<title>/);
    }

    const vs = JSON.parse(
      (await get(port, "/api/sudo-password/vault-status")).out,
    );
    expect(vs).toMatchObject({
      backend: block === "none" ? "none" : "doppler",
      configured: false,
      backendAvailable: false,
      opAvailable: false,
      hasStored: false,
    });
    expect(vs.reason).toBe(
      "not configured: set secrets.provider and secrets.refs.sudo in config/acme.yml",
    );
    const load = JSON.parse(
      (await get(port, "/api/sudo-password/load-from-vault", "POST")).out,
    );
    expect(load).toEqual({
      ok: false,
      reason: "not-configured",
      message:
        "not configured: set secrets.provider and secrets.refs.sudo in config/acme.yml",
    });

    webLog = fs.readFileSync(
      path.join(f.tmp, "acme-home", "logs", "acme", "web.log"),
      "utf-8",
    );
    expect(webLog).not.toMatch(/warn|⚠|deprecated/i);
    const down = f.acme("web", "down", "--port", String(port));
    expect(down.code).toBe(0);
    port = 0;
  }, 120_000);

  it("op and doppler were never called", () => {
    expect(fs.existsSync(f.calls)).toBe(false);
  });
});

describe("no secrets.provider, but secrets.refs.sudo configured", () => {
  let f: ReturnType<typeof fixture>;
  let port = 0;

  beforeAll(async () => {
    f = fixture("implicit-ref", "absent");
    fs.appendFileSync(
      path.join(f.dist, "config", "acme.yml"),
      "secrets:\n  refs:\n    sudo: { key: ACME_LOCAL_ADMIN_PWD }\n",
    );
    port = await freePort();
  });

  afterAll(() => {
    if (port) f.acme("web", "down", "--port", String(port));
    fs.rmSync(f.tmp, { recursive: true, force: true });
  });

  it("resolves to doppler when the secret is asked for, and warns once", async () => {
    expect(f.acme("web", "up", "--no-open", "--port", String(port)).code).toBe(
      0,
    );
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      try {
        if ((await get(port, "/api/server-info")).code === 200) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const log = path.join(f.tmp, "acme-home", "logs", "acme", "web.log");
    expect(fs.readFileSync(log, "utf-8")).not.toMatch(/deprecated/);
    for (let i = 0; i < 2; i++) {
      const vs = JSON.parse(
        (await get(port, "/api/sudo-password/vault-status")).out,
      );
      // The fake doppler is "signed out" (exits 1): configured, not ready.
      expect(vs).toMatchObject({
        backend: "doppler",
        configured: true,
        backendAvailable: false,
      });
    }
    expect(fs.readFileSync(f.calls, "utf-8")).toMatch(/^doppler me/m);
    const warnings = fs
      .readFileSync(log, "utf-8")
      .split("\n")
      .filter((l) => l.includes("implicit doppler default is deprecated"));
    expect(warnings).toHaveLength(1);
    expect(f.acme("web", "down", "--port", String(port)).code).toBe(0);
    port = 0;
  }, 120_000);
});
