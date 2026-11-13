/**
 * ON-4's dry run, on the two-agent shape (ON-6): the slim install-den
 * skill's steps (skills/install-den/SKILL.md), then the server agent's
 * onboarding through Den's MCP, on a scratch HOME with one tiny sample
 * repo. The test plays both agents (the fake runtime): nothing runs a real
 * claude, codex, gemini or grok (tests/setup.ts puts inert stand-ins first
 * on PATH), and nothing touches the real HOME.
 *
 * The install agent (each step twice, to show it is safe to re-run):
 *   1. create <name> <dir> --yes --json       (another "Den" holds the start
 *      port, so create picks the next free one; DEN_WEB_PORT_START stands in
 *      for the default, so nothing here touches 7777), then the engine
 *      linked into node_modules, standing in for `npm install`
 *   2. web up --no-open --json                (url and port)
 *   3. web claim-link --json                  (the one-time setup link)
 *
 * The person opens the link: it signs the browser in, and a fresh Den's
 * first page is its server agent. The server agent, through
 * `<cli> mcp --workspace den-server --actor agent:server --call …`:
 *   4. onboard_status, repos_detect           (reads)
 *   5. repo_add                               (held: nothing changes until
 *      the person's browser allows it)
 *   6. service_try                            (held, then started healthy)
 *
 * From the paste to one repo added and one service running must take 5
 * minutes or less (R11): asserted, and recorded as the metric.
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
  // In the person's home: the onboarding tools read only there.
  repo = path.join(tmp, "home", "code", "sample");
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
  fs.mkdirSync(repo, { recursive: true });
  spawnSync("git", ["init", "-q", repo]);
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

/** One request: status, headers and body (no keep-alive, as get). */
function req(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "localhost",
        port: webPort,
        path: p,
        method,
        agent: false,
        headers: {
          Connection: "close",
          ...headers,
          ...(data === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(data)),
              }),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (d: Buffer) => (out += d.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: out,
          }),
        );
      },
    );
    r.on("error", reject);
    r.end(data);
  });
}

/** The server agent's MCP one-shot, run in the background (writes wait). */
function serverAgentCall(
  tool: string,
  args: Record<string, unknown>,
): Promise<Step> {
  return new Promise((resolve) => {
    const c = spawn(
      path.join(dist, "bin", "acme"),
      [
        "mcp",
        "--workspace",
        "den-server",
        "--actor",
        "agent:server",
        "--call",
        tool,
        JSON.stringify(args),
      ],
      { cwd: dist, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    c.stdout.on("data", (d: Buffer) => (out += d.toString()));
    c.stderr.on("data", (d: Buffer) => (err += d.toString()));
    c.on("close", (code) => {
      let json: unknown = null;
      try {
        json = JSON.parse(out);
      } catch {
        json = { unparsed: out.slice(-2000), stderr: err.slice(-2000) };
      }
      resolve({ code: code ?? -1, json, out: `${out}${err}` });
    });
  });
}

describe("ON-4: install, hand over, and the server agent sets up one repo", () => {
  it("every install step is ok and safe to re-run; the server agent's writes wait for the person; it takes 5 minutes or less", async () => {
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

    // 2. web up --json, twice (the second finds it running).
    const [w1, w2] = twice("web", "up", "--no-open", "--json");
    for (const w of [w1, w2])
      // D80: the install's address. This one had none; the server took
      // its edge route's at start (the one-time migration).
      expect(w.json).toMatchObject({
        url: "http://acme.acme.localhost",
        port: webPort,
      });

    // 3. The setup link (never printed here: it signs a browser in).
    const cl = acme("web", "claim-link", "--json");
    expect(cl.code).toBe(0);
    const link = new URL(String(cl.json.url));
    // D80: on the install's address (taken from its edge route).
    expect(link.origin).toBe("http://acme.acme.localhost");
    expect(link.searchParams.has("claim")).toBe(true);

    // The person opens it: a session cookie, and the approval key in the
    // fragment of the redirect to the first page.
    const opened = await req("GET", link.pathname + link.search, {
      "sec-fetch-site": "none",
      accept: "text/html",
    });
    expect(opened.status).toBe(303);
    const to = String(opened.headers.location ?? "");
    const key = /#ak=([A-Za-z0-9_-]{43})$/.exec(to)?.[1] ?? "";
    expect(key).not.toBe("");
    const cookie =
      ([] as string[])
        .concat(opened.headers["set-cookie"] ?? [])
        .find((x) => x.startsWith(`den_session_${webPort}=`))
        ?.split(";")[0] ?? "";
    expect(cookie).not.toBe("");
    const browser = { cookie, "sec-fetch-site": "same-origin" };
    // A fresh Den's first page is its own agent.
    const first = await req("GET", to.split("#")[0], {
      ...browser,
      accept: "text/html",
    });
    expect(first.status).toBe(200);
    expect(first.body).toContain('data-page="server-agent"');
    const sa = JSON.parse(
      (await req("GET", "/api/server-agent", browser)).body,
    ) as Record<string, unknown>;
    expect(sa).toMatchObject({
      name: "Acme agent",
      scope: "den-server",
      fresh: true,
    });
    const csrf = String(
      (
        JSON.parse((await req("GET", "/api/session", browser)).body) as {
          csrf?: string;
        }
      ).csrf ?? "",
    );
    const person = {
      ...browser,
      origin: `http://localhost:${webPort}`,
      "x-den-csrf": csrf,
      "x-den-approve-key": key,
    };
    /** Allow the one request waiting (the person's dialog). */
    const allowNext = async (): Promise<string> => {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const l = JSON.parse(
          (await req("GET", "/api/approvals", person)).body,
        ) as {
          pending?: { id: string; action: string }[];
        };
        const p = l.pending?.[0];
        if (p) {
          const d = await req("POST", `/api/approvals/${p.id}/decide`, person, {
            decision: "allow",
          });
          expect(d.status).toBe(200);
          return p.action;
        }
        if (Date.now() > deadline) throw new Error("nothing waited");
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    const services = async () =>
      (
        JSON.parse((await req("GET", "/api/workspaces")).body) as {
          workspaces: Record<string, { services?: Record<string, unknown> }>;
        }
      ).workspaces;

    // 4. The server agent reads.
    const st = await serverAgentCall("onboard_status", {});
    expect(st.code).toBe(0);
    const det = await serverAgentCall("repos_detect", {
      path: path.dirname(repo),
    });
    expect(det.code).toBe(0);
    expect(JSON.stringify(det.json)).toContain("sample");

    // 5. repo_add waits for the person; until they allow it, nothing changes.
    const repoBefore = treeDigest(repo);
    const health = `http://localhost:${appPort}/`;
    const adding = serverAgentCall("repo_add", { path: repo, health });
    await new Promise((r) => setTimeout(r, 500));
    expect(
      Object.values(await services()).some(
        (w) => "sample" in (w.services ?? {}),
      ),
    ).toBe(false);
    expect(await allowNext()).toBe("repo_add");
    const added = await adding;
    expect([added.code, added.json.approved]).toEqual([0, true]);
    expect(treeDigest(repo)).toBe(repoBefore);
    expect(
      Object.values(await services()).some(
        (w) => "sample" in (w.services ?? {}),
      ),
    ).toBe(true);

    // 6. service_try, held the same way, then running and healthy.
    const trying = serverAgentCall("service_try", { service: "sample" });
    expect(await allowNext()).toBe("service_try");
    const tried = await trying;
    expect([tried.code, tried.json.approved]).toEqual([0, true]);
    const appDeadline = Date.now() + 30_000;
    while ((await get(appPort, "/")) !== 200 && Date.now() < appDeadline)
      await new Promise((r) => setTimeout(r, 200));
    expect(await get(appPort, "/")).toBe(200);

    // The metric: paste to one repo added and one service running.
    const seconds = (Date.now() - started) / 1000;
    expect(seconds).toBeLessThan(300);

    // Set up: the first page is Workspaces again.
    const after = await req("GET", "/", { ...browser, accept: "text/html" });
    expect(after.body).not.toContain('data-page="server-agent"');

    // Clean up the way a person would, in JSON too, each twice.
    const [x1] = twice("down", "sample", "--json");
    expect(x1.json).toMatchObject({ ok: true, services: ["sample"] });
    const [y1, y2] = twice("web", "down", "--json");
    // The whole answer: a failure shows it (0.4.29-dev.1's gate;
    // toMatchObject shows only the keys it compares).
    if (y1.json.stopped !== true)
      throw new Error(`web down --json: ${JSON.stringify(y1)}`);
    expect(y2.json.stopped).toBe(false);
    expect(await get(webPort, "/api/server-info")).toBe(0);
    process.stderr.write(
      `\n  ON-4 dry run: paste → one repo added, one service running in ${seconds.toFixed(1)}s (target ≤ 300s)\n`,
    );
    if (process.env.DEN_ON4_METRIC_FILE)
      fs.writeFileSync(
        process.env.DEN_ON4_METRIC_FILE,
        `${JSON.stringify({ metric: "on4-dry-run-seconds", seconds })}\n`,
      );
  }, 600_000);
});
