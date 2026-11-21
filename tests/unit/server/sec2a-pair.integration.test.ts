/**
 * SEC-2a's approve-with-a-code on a real server reached beyond loopback (a
 * plain-http LAN bind, DEN_BIND_HOST=0.0.0.0 with
 * web.allow_plain_http_remote, this machine's own name as the Host, as
 * sec1b's LAN-bind suite does), with an edge block too:
 *  - the signed-out page names the machine (web.machine_name, else the
 *    short hostname; never the browser's Host) and the ssh target (that
 *    Host), and every command it prints starts with what runs here;
 *  - the page asks for a code; a person's signed-in browser approves it
 *    (issue 819: only there; the CLI's bearer and `<cli> web approve
 *    <code>` can't); the page's poll then sets the session cookie, once,
 *    and the device is listed, approved by code;
 *  - a wrong code fails, as does a second use; deny tells the page;
 *    another site can't ask for a code; `web approve --list`;
 *  - `web login`'s link opens the pairing screen once the install is set
 *    up; approved, the CLI says who signed in; denied, it says so.
 *
 * No code, cookie or link is printed: the server's output is searched for
 * them, and a failure shows booleans.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { cliAuthHeaders } from "../../../src/shared/web-secret.js";
import { cliPrefix } from "../../../src/shared/cli-command.js";
import { startDenServer, stopServer } from "../../child-servers.js";
import { inTerminal, linkIn } from "./helpers/in-terminal.js";
import { signedIn, type SignedIn } from "./helpers/signed-in.js";

const ENGINE = path.resolve(__dirname, "../../..");
const TSX = path.join(ENGINE, "node_modules", ".bin", "tsx");
const NAME = os.hostname().toLowerCase();
const SHORT = os.hostname().split(".")[0];
/** The account the server runs as: the ssh link logs in as it (SEC-2a-UX). */
const USER = os.userInfo().username;
const EDGE = "den.svc.example.test";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
let tmp = "";
let root = "";
let home = "";
let stateDir = "";
let port = 0;
let server: ChildProcess | null = null;
let serverLog: () => string = () => "";
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
async function askCode(): Promise<{ id: string; code: string }> {
  const r = await call("POST", "/api/signin/code", lan(), "{}");
  expect(r.status).toBe(200);
  const b = json(r) as { id: string; code: string };
  secrets.push(b.code, b.id);
  return b;
}
/** Issue 819: the person's signed-in browser on this machine. */
let person: SignedIn | null = null;
async function me(): Promise<SignedIn> {
  if (!person) {
    person = await signedIn(stateDir, `http://localhost:${port}`);
    secrets.push(person.value, person.approveKey);
  }
  return person;
}
/** Settings › Access's Approve or Deny, from that browser. */
async function decide(verb: "approve" | "deny", code: string): Promise<Reply> {
  const p = await me();
  return call(
    "POST",
    `/api/web/${verb}`,
    {
      ...p.headers,
      host: `localhost:${port}`,
      "sec-fetch-site": "same-origin",
      "x-den-approve-key": p.approveKey,
    },
    JSON.stringify({ code }),
  );
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
    // Issue 320: the server ends a code its page hasn't polled for 15 s.
    // This suite asks for codes and approves them (spawning the CLI) with
    // no page polling in between; a slow machine could take that long.
    // The unseen bound has its own suite (pair-unseen.integration).
    DEN_PAIR_UNSEEN_MS: "600000",
  };
}
function writeUser(extra = ""): void {
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    `web:\n  allow_plain_http_remote: true\n${extra}`,
  );
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
  const started = await startDenServer(
    TSX,
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    { cwd: root, env: env(), stdio: ["ignore", "pipe", "pipe"] },
    { timeoutMs: 40_000 },
  );
  server = started.server;
  port = started.port;
  serverLog = started.out;
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
      user: USER,
      name: true,
      login: `ssh ${USER}@${NAME} '${s.cmd as string}'`,
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

  it('web.ssh_user names another account, "" leaves it off, a wrong one keeps the default (read at once)', async () => {
    const sshOf = async () =>
      signinOf(await call("GET", "/", { accept: "text/html" })).ssh as {
        user: string;
        login: string;
      };
    try {
      writeUser("  ssh_user: ops\n");
      let ssh = await sshOf();
      expect([ssh.user, ssh.login.startsWith(`ssh ops@${NAME} '`)]).toEqual([
        "ops",
        true,
      ]);
      writeUser('  ssh_user: ""\n');
      ssh = await sshOf();
      expect([ssh.user, ssh.login.startsWith(`ssh ${NAME} '`)]).toEqual([
        "",
        true,
      ]);
      writeUser("  ssh_user: a@b\n");
      expect((await sshOf()).user).toBe(USER);
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
  it("the page asks for a code; a signed-in browser approves it (any case, no dash), the CLI can't; the poll sets the cookie once", async () => {
    await me();
    const a = await askCode();
    expect(a.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
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

    // Issue 819: the CLI can't approve it, nor can its bearer.
    const typed = a.code.replace("-", "").toLowerCase();
    const viaCli = cli(["web", "approve", typed, "--port", String(port)]);
    expect([viaCli.status, viaCli.stdout]).toEqual([1, ""]);
    expect(viaCli.stderr).toMatch(
      /approved only from a browser that is signed in/,
    );
    const viaBearer = await call(
      "POST",
      "/api/web/approve",
      { ...bearer(), host: `localhost:${port}` },
      JSON.stringify({ code: a.code }),
    );
    expect([viaBearer.status, json(viaBearer).code]).toEqual([
      403,
      "approve_needs_browser",
    ]);
    expect(json(await call("GET", `/api/signin/code/${a.id}`)).state).toBe(
      "pending",
    );
    const ok = await decide("approve", typed);
    expect([ok.status, json(ok).ok]).toEqual([200, true]);
    const done = await call("GET", `/api/signin/code/${a.id}`, {
      "user-agent": UA,
    });
    expect([done.status, json(done).state]).toEqual([200, "ok"]);
    const cookie = cookieOf(done);
    expect(cookie.length).toBeGreaterThan(0);
    const line = ([] as string[])
      .concat(done.headers["set-cookie"] ?? [])
      .find((c) => c.startsWith(`den_session_${port}=`))!;
    expect(line).toMatch(/; HttpOnly; SameSite=Lax; Max-Age=34560000/);
    // Signed in, beyond loopback.
    expect((await call("GET", "/api/settings", { cookie })).status).toBe(200);
    // Listed as a linked device, approved by code.
    const sessions = json(await call("GET", "/api/web/sessions", bearer()))
      .sessions as Record<string, unknown>[];
    expect(
      sessions.some((x) => x.name === "Safari on macOS" && x.via === "code"),
    ).toBe(true);

    // A second use: the poll gets nothing, and the code is gone.
    const twice = await call("GET", `/api/signin/code/${a.id}`);
    expect([twice.status, cookieOf(twice)]).toEqual([404, ""]);
    const again = await decide("approve", a.code);
    expect([again.status, json(again).error]).toEqual([
      404,
      expect.stringMatching(/No device is waiting with that code/),
    ]);
  }, 120_000);

  it("a wrong code fails, and approves nothing", async () => {
    const a = await askCode();
    const wrong = a.code === "000-000" ? "000-001" : "000-000";
    const r = await decide("approve", wrong);
    expect([r.status, json(r).error]).toEqual([
      404,
      expect.stringMatching(/No device is waiting with that code/),
    ]);
    const bad = await decide("approve", "not-a-code");
    expect([bad.status, json(bad).error]).toEqual([
      400,
      expect.stringMatching(/That isn't a code/),
    ]);
    const wait = await call("GET", `/api/signin/code/${a.id}`);
    expect(json(wait).state).toBe("pending");
  }, 120_000);

  it("deny (Settings › Access, in a signed-in browser) tells the page; no cookie", async () => {
    const a = await askCode();
    const r = await decide("deny", a.code);
    expect(r.status).toBe(200);
    const p = await call("GET", `/api/signin/code/${a.id}`);
    expect([json(p).state, cookieOf(p)]).toEqual(["denied", ""]);
  });

  it("#320: approving a code its page withdrew does nothing and says it ended; no cookie", async () => {
    const a = await askCode();
    const gone = await call("DELETE", `/api/signin/code/${a.id}`, lan());
    expect(json(gone)).toEqual({ ok: true, withdrawn: true });
    const r = await decide("approve", a.code);
    expect([r.status, json(r).code, json(r).error]).toEqual([
      410,
      "ended",
      "That request has ended: that computer closed its page or is already signed in. Nothing was allowed.",
    ]);
    const p = await call("GET", `/api/signin/code/${a.id}`);
    expect([p.status, cookieOf(p)]).toEqual([404, ""]);
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

describe("`web login` waits; once set up, its link opens the pairing screen (issue 819)", () => {
  /** `web login` running (it waits): its link, and its end. */
  function startLogin(): {
    link: Promise<string>;
    done: Promise<{ status: number | null; out: string }>;
  } {
    // Sign-in: a link is printed only in a terminal; what it shows is
    // stdout and stderr together.
    const term = inTerminal(
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
      { cwd: root, env: { ...env(), CI: "1" } },
    );
    let gotLink: (s: string) => void = () => {};
    const link = new Promise<string>((r) => (gotLink = r));
    term.onText((all) => {
      if (/waiting for the link/.test(all)) gotLink(linkIn(all));
    });
    const done = term.done.then((r) => ({
      status: r.status as number | null,
      out: r.text,
    }));
    return { link, done };
  }
  /** Open the link: the pairing screen, no cookie. Its request. */
  async function open(where: string): Promise<{ id: string; code: string }> {
    const page = await call("GET", where, {
      accept: "text/html",
      "user-agent": UA,
    });
    expect([page.status, cookieOf(page)]).toEqual([401, ""]);
    const pair = signinOf(page).pair as { id: string; code: string };
    expect(pair.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{3}$/);
    expect(signinOf(page).pairLead).toBe("err.signin.pairLinkLead");
    expect(signinOf(page).confirm).toBeUndefined();
    secrets.push(pair.id, pair.code);
    return pair;
  }

  it("the link alone signs nothing in; approved in a signed-in browser, the poll signs in once; the CLI says who", async () => {
    await me();
    const run = startLogin();
    const link = new URL(await run.link);
    secrets.push(link.href, link.searchParams.get("c") ?? "");
    const where = link.pathname + link.search;
    const pair = await open(where);
    // The old typed code is retired: a POST to the link signs nothing in.
    const posted = await call(
      "POST",
      where,
      lan(),
      JSON.stringify({ code: "0000-0000" }),
    );
    expect([posted.status, cookieOf(posted)]).toEqual([410, ""]);
    // Opened again: spent, no new request.
    const again = await call("GET", where, { accept: "text/html" });
    expect([again.status, cookieOf(again), signinOf(again).pair]).toEqual([
      401,
      "",
      undefined,
    ]);
    const ok = await decide("approve", pair.code);
    expect(ok.status).toBe(200);
    const done = await call("GET", `/api/signin/code/${pair.id}`, {
      "user-agent": UA,
    });
    const cookie = cookieOf(done);
    expect([done.status, json(done).state, cookie.length > 0]).toEqual([
      200,
      "ok",
      true,
    ]);
    expect((await call("GET", "/api/settings", { cookie })).status).toBe(200);
    const r = await run.done;
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/approve it in a browser that is signed in/i);
    expect(
      r.out
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("Signed in:")),
    ).toMatch(/^Signed in: Safari on macOS \(.+\) at \d\d:\d\d$/);
  }, 120_000);

  it("denied in a signed-in browser: the page is told, and the CLI says Denied, exit 1", async () => {
    const run = startLogin();
    const link = new URL(await run.link);
    secrets.push(link.href, link.searchParams.get("c") ?? "");
    const pair = await open(link.pathname + link.search);
    expect((await decide("deny", pair.code)).status).toBe(200);
    const p = await call("GET", `/api/signin/code/${pair.id}`);
    expect([json(p).state, cookieOf(p)]).toEqual(["denied", ""]);
    const r = await run.done;
    expect([r.status, /Denied in a signed-in browser/.test(r.out)]).toEqual([
      1,
      true,
    ]);
  }, 120_000);
});

describe("secrets and the audit", () => {
  it("approve and deny are audited with the actor; no code, poll id, link or cookie reaches the server's output", () => {
    expect(serverLog()).toMatch(/approve a waiting device \(Safari on macOS/);
    expect(serverLog()).toMatch(/deny a waiting device/);
    const leaked = secrets
      .filter(Boolean)
      .filter((s) => serverLog().includes(s));
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
