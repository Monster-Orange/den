/**
 * SEC-2a's approve-with-a-code on a real server reached beyond loopback (a
 * plain-http LAN bind, DEN_BIND_HOST=0.0.0.0 with
 * web.allow_plain_http_remote, this machine's own name as the Host, as
 * sec1b's LAN-bind suite does), with an edge block too:
 *  - the signed-out page names the machine (web.machine_name, else the
 *    short hostname; never the browser's Host) and the ssh target (that
 *    Host), and every command it prints starts with what runs here;
 *  - the page asks for a code; `<cli> web approve <code>` (the CLI's
 *    bearer) approves it; the page's poll then sets the session cookie,
 *    once, and the device is listed, approved by code;
 *  - a wrong code fails (non-zero exit), as does a second use; deny tells
 *    the page; another site can't ask for a code; `web approve --list`.
 *
 * No code, cookie or link is printed: the server's output is searched for
 * them, and a failure shows booleans.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { cliAuthHeaders } from "../../../src/shared/web-secret.js";
import { cliPrefix } from "../../../src/shared/cli-command.js";
import { spawnServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const NAME = os.hostname().toLowerCase();
const SHORT = os.hostname().split(".")[0];
const EDGE = "den.svc.example.test";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
let tmp = "";
let root = "";
let home = "";
let stateDir = "";
let port = 0;
let server: ChildProcess | null = null;
let serverOut = "";
/** Every code and cookie this suite saw: none may reach the server's log. */
const secrets: string[] = [];

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}
function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: p,
        method,
        agent: false,
        timeout: 20_000,
        setHost: false,
        headers: {
          host: `${NAME}:${port}`,
          connection: "close",
          ...headers,
          ...(body !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
              }
            : {}),
        },
      },
      (res) => {
        let out = "";
        res.on("data", (d: Buffer) => (out += d.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: out,
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(body);
  });
}
const json = (r: Reply) => JSON.parse(r.body) as Record<string, unknown>;
const cookieOf = (r: Reply) => {
  const line =
    ([] as string[])
      .concat(r.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith(`den_session_${port}=`)) ?? "";
  const pair = line.split(";")[0];
  if (pair) secrets.push(pair.split("=")[1] ?? "");
  return pair;
};
/** The signed-out page's own requests, on this machine's LAN name. */
const lan = (extra: Record<string, string> = {}) => ({
  origin: `http://${NAME}:${port}`,
  "user-agent": UA,
  ...extra,
});
const bearer = () => ({
  authorization: cliAuthHeaders(stateDir).Authorization ?? "",
});
/** The signed-out page's data (the JSON the server fills in). */
function signinOf(r: Reply): Record<string, unknown> {
  const m =
    /<script type="application\/json" id="den-error">\s*([\s\S]*?)\s*<\/script>/.exec(
      r.body,
    );
  return (JSON.parse(m![1]) as { signin: Record<string, unknown> }).signin;
}
async function askCode(): Promise<{
  id: string;
  code: string;
  approve: string;
  ssh: string;
}> {
  const r = await call("POST", "/api/signin/code", lan(), "{}");
  expect(r.status).toBe(200);
  const b = json(r) as {
    id: string;
    code: string;
    approve: string;
    ssh: string;
  };
  secrets.push(b.code, b.id);
  return b;
}
function cli(args: string[]) {
  return spawnSync(
    TSX,
    [path.join(ENGINE, "src", "ui", "cli", "index.ts"), ...args],
    {
      cwd: root,
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...env(),
        CI: "1",
      },
    },
  );
}
function env() {
  return {
    ...process.env,
    DEN_ROOT: root,
    DEN_ENGINE_ROOT: ENGINE,
    DEN_EDGE_DIR: path.join(tmp, "edge-state"),
    DEN_HOME: stateDir,
    HOME: home,
    DEN_NO_OPEN: "1",
    NO_COLOR: "1",
    PORT: String(port),
    DEN_BIND_HOST: "0.0.0.0",
  };
}
function writeUser(extra = ""): void {
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    `web:\n  allow_plain_http_remote: true\n${extra}`,
  );
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-sec2a-pair-")),
  );
  root = path.join(tmp, "dist");
  home = path.join(tmp, "home");
  stateDir = path.join(home, ".den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: svc.example.test",
      "  tls: none",
      "",
    ].join("\n"),
  );
  writeUser();
  port = await freePort();
  server = spawnServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    { cwd: root, env: env(), stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await call("GET", "/api/server-info", bearer())).status === 200)
        break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}, 60_000);

afterAll(async () => {
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** What every printed command starts with on this server (its PATH). */
const prefix = () =>
  cliPrefix("den", root, ENGINE, { pathEnv: process.env.PATH ?? "" });

describe("the signed-out page names the machine and prints commands that run here", () => {
  it("beyond loopback: the short hostname as the label, the Host as the ssh target, and commands with this server's own prefix", async () => {
    const r = await call("GET", "/", { accept: "text/html" });
    expect(r.status).toBe(401);
    const s = signinOf(r);
    expect(s.machine).toBe(SHORT);
    expect(s.cmd).toBe(`${prefix()} web login --origin http://${NAME}:${port}`);
    expect(s.ssh).toEqual({
      target: NAME,
      name: true,
      login: `ssh ${NAME} '${s.cmd as string}'`,
    });
    // Never a bare <cli> that isn't this distribution's on PATH.
    if (prefix() !== "den")
      expect(String(s.cmd).startsWith("den ")).toBe(false);
  });

  it("web.machine_name overrides the label (read at once, no restart)", async () => {
    writeUser("  machine_name: Studio Box\n");
    try {
      const s = signinOf(await call("GET", "/", { accept: "text/html" }));
      expect([s.machine, (s.ssh as { target: string }).target]).toEqual([
        "Studio Box",
        NAME,
      ]);
    } finally {
      writeUser();
    }
  });

  it("through a service-name Host (the edge), the label is still the machine's; the ssh target is that Host", async () => {
    const r = await call("GET", "/", {
      host: EDGE,
      "x-forwarded-for": "203.0.113.7",
      accept: "text/html",
    });
    expect(r.status).toBe(401);
    const s = signinOf(r);
    expect([s.machine, (s.ssh as { target: string }).target]).toEqual([
      SHORT,
      EDGE,
    ]);
  });
});

describe("approve this computer with a code", () => {
  it("the page asks for a code; `web approve <code>` (any case, no dash) approves it; the poll sets the cookie once", async () => {
    const a = await askCode();
    expect(a.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
    expect(a.approve).toBe(`${prefix()} web approve ${a.code}`);
    expect(a.ssh).toBe(`ssh ${NAME} '${a.approve}'`);
    // Waiting: the poll (bare: a plain-http LAN origin sends no metadata).
    const wait = await call("GET", `/api/signin/code/${a.id}`);
    expect([wait.status, json(wait).state, cookieOf(wait)]).toEqual([
      200,
      "pending",
      "",
    ]);
    // `web approve --list` shows it: code, browser and OS.
    const list = cli([
      "web",
      "approve",
      "--list",
      "--json",
      "--port",
      String(port),
    ]);
    expect(list.status).toBe(0);
    const rows = JSON.parse(list.stdout) as Record<string, string>[];
    expect(rows.find((x) => x.code === a.code)).toMatchObject({
      device: "Safari on macOS",
    });

    const typed = a.code.replace("-", "").toLowerCase();
    const ok = cli(["web", "approve", typed, "--port", String(port)]);
    expect([ok.status, ok.stdout.trim()]).toEqual([
      0,
      expect.stringMatching(/^Approved: Safari on macOS/),
    ]);
    const done = await call("GET", `/api/signin/code/${a.id}`, {
      "user-agent": UA,
    });
    expect([done.status, json(done).state]).toEqual([200, "ok"]);
    const cookie = cookieOf(done);
    expect(cookie.length).toBeGreaterThan(0);
    const line = ([] as string[])
      .concat(done.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith(`den_session_${port}=`))!;
    expect(line).toMatch(/; HttpOnly; SameSite=Strict; Max-Age=34560000/);
    // Signed in, beyond loopback.
    expect((await call("GET", "/api/settings", { cookie })).status).toBe(200);
    // Listed as a linked device, approved by code.
    const sessions = json(await call("GET", "/api/web/sessions", bearer()))
      .sessions as Record<string, unknown>[];
    expect(sessions[0]).toMatchObject({ name: "Safari on macOS", via: "code" });

    // A second use: the poll gets nothing, and the code is gone.
    const twice = await call("GET", `/api/signin/code/${a.id}`);
    expect([twice.status, cookieOf(twice)]).toEqual([404, ""]);
    const again = cli(["web", "approve", a.code, "--port", String(port)]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/No device is waiting with that code/);
  }, 120_000);

  it("a wrong code fails with a non-zero exit, and approves nothing", async () => {
    const a = await askCode();
    const wrong = a.code === "000-000" ? "000-001" : "000-000";
    const r = cli(["web", "approve", wrong, "--port", String(port)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No device is waiting with that code/);
    const bad = cli(["web", "approve", "not-a-code", "--port", String(port)]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/That isn't a code/);
    const wait = await call("GET", `/api/signin/code/${a.id}`);
    expect(json(wait).state).toBe("pending");
  }, 120_000);

  it("deny (Settings › Access, with a bearer here) tells the page; no cookie", async () => {
    const a = await askCode();
    const r = await call(
      "POST",
      "/api/web/deny",
      bearer(),
      JSON.stringify({ code: a.code }),
    );
    expect(r.status).toBe(200);
    const p = await call("GET", `/api/signin/code/${a.id}`);
    expect([json(p).state, cookieOf(p)]).toEqual(["denied", ""]);
  });

  it("another site can't ask for a code; signed out, nobody can approve one", async () => {
    const cross = await call(
      "POST",
      "/api/signin/code",
      lan({ origin: "https://evil.example" }),
      "{}",
    );
    expect(cross.status).toBe(403);
    const a = await askCode();
    const r = await call(
      "POST",
      "/api/web/approve",
      lan(),
      JSON.stringify({ code: a.code }),
    );
    expect([r.status, json(r).code]).toEqual([401, "signin_required"]);
    expect(json(await call("GET", `/api/signin/code/${a.id}`)).state).toBe(
      "pending",
    );
  });
});

describe("`web login` waits, and its link asks for the code", () => {
  /** `web login` running (it waits): its link, its code, and its end. */
  function startLogin(): {
    link: Promise<string>;
    code: Promise<string>;
    done: Promise<{ status: number | null; out: string; err: string }>;
  } {
    const child = spawn(
      TSX,
      [
        path.join(ENGINE, "src", "ui", "cli", "index.ts"),
        "web",
        "login",
        "--port",
        String(port),
        "--origin",
        `http://${NAME}:${port}`,
      ],
      {
        cwd: root,
        env: { ...env(), CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    let err = "";
    let gotLink: (s: string) => void = () => {};
    let gotCode: (s: string) => void = () => {};
    const link = new Promise<string>((r) => (gotLink = r));
    const code = new Promise<string>((r) => (gotCode = r));
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      const l = out.split("\n")[0];
      if (out.includes("\n")) gotLink(l);
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      const m = /It asks for this code: (\S+)/.exec(err);
      if (m) gotCode(m[1]);
    });
    const done = new Promise<{
      status: number | null;
      out: string;
      err: string;
    }>((r) => child.on("close", (status) => r({ status, out, err })));
    return { link, code, done };
  }

  it("the link alone signs nothing in; a wrong code is refused; the right one signs in once; the CLI says who", async () => {
    const run = startLogin();
    const link = new URL(await run.link);
    const code = await run.code;
    secrets.push(link.href, link.searchParams.get("c") ?? "", code);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const where = link.pathname + link.search;
    // Opened: the page asks for the code. No cookie.
    const page = await call("GET", where, {
      accept: "text/html",
      "user-agent": UA,
    });
    expect([page.status, cookieOf(page)]).toEqual([401, ""]);
    expect(signinOf(page).confirm).toBe(true);
    // A wrong code: refused, no cookie; the link still works.
    const wrong = code.startsWith("0") ? "1111-1111" : "0000-0000";
    const bad = await call(
      "POST",
      where,
      lan(),
      JSON.stringify({ code: wrong }),
    );
    expect([bad.status, json(bad).code, cookieOf(bad)]).toEqual([
      401,
      "wrong_code",
      "",
    ]);
    // Another site can't post one.
    const cross = await call(
      "POST",
      where,
      lan({ origin: "https://evil.example" }),
      JSON.stringify({ code }),
    );
    expect([cross.status, cookieOf(cross)]).toEqual([403, ""]);
    // The right code (any case, no dash): signed in.
    const ok = await call(
      "POST",
      where,
      lan(),
      JSON.stringify({ code: code.replace("-", "").toLowerCase() }),
    );
    expect([ok.status, json(ok).ok, json(ok).next]).toEqual([200, true, "/"]);
    const cookie = cookieOf(ok);
    expect(cookie.length).toBeGreaterThan(0);
    expect((await call("GET", "/api/settings", { cookie })).status).toBe(200);
    // Single use: the link and the code are spent.
    const again = await call("POST", where, lan(), JSON.stringify({ code }));
    expect([again.status, cookieOf(again)]).toEqual([410, ""]);
    expect((await call("GET", where, { accept: "text/html" })).status).toBe(
      401,
    );
    const r = await run.done;
    expect(r.status).toBe(0);
    expect(r.out.trim().split("\n")[1]).toMatch(
      /^Signed in: Safari on macOS \(.+\) at \d\d:\d\d$/,
    );
  }, 120_000);

  it("five wrong codes burn the link: the CLI says Refused, exit 1", async () => {
    const run = startLogin();
    const link = new URL(await run.link);
    const code = await run.code;
    secrets.push(link.href, link.searchParams.get("c") ?? "", code);
    const where = link.pathname + link.search;
    await call("GET", where, { accept: "text/html" });
    const wrong = code.startsWith("0") ? "1111-1111" : "0000-0000";
    for (let i = 0; i < 5; i++)
      await call("POST", where, lan(), JSON.stringify({ code: wrong }));
    const late = await call("POST", where, lan(), JSON.stringify({ code }));
    expect([late.status, cookieOf(late)]).toEqual([410, ""]);
    const r = await run.done;
    expect([r.status, /Refused: too many wrong codes/.test(r.err)]).toEqual([
      1,
      true,
    ]);
  }, 120_000);
});

describe("secrets and the audit", () => {
  it("approve and deny are audited with the actor; no code, poll id, link or cookie reaches the server's output", () => {
    expect(serverOut).toMatch(/approve a waiting device \(Safari on macOS/);
    expect(serverOut).toMatch(/deny a waiting device/);
    const leaked = secrets.filter(Boolean).filter((s) => serverOut.includes(s));
    // What leaked, by kind (never the value).
    expect(
      leaked.map((s) =>
        /^[0-9A-Z]{3}-[0-9A-Z]{3}$/.test(s)
          ? "code"
          : s.length === 32
            ? "poll id"
            : "cookie",
      ),
    ).toEqual([]);
  });
});
