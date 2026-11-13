/**
 * SEC-1c (SEC-1 spec §5, §7) on the real server: an agent started from the
 * page gets an actor token; the server resolves the actor from it (the
 * audit shows agent:<id>, never what a header claims); and the token
 * can't open another session's io, mint tokens, manage web.secret or pass
 * the lock (R8). Stop revokes it.
 *
 * Also SEC-1 §6b.2: the GETs that stream a run stay mutating (not
 * shell-grade) only because each takes the id of a declared command; each
 * is shown refusing an undeclared one, or a command string, argv or path
 * taken from the request.
 *
 * The demo distribution (acme; workspaces north and south), a session host
 * in this process with a scripted PTY (nothing really runs), a `claude`
 * shim that must never run, and a passwordless `sudo` shim (the lock reads
 * open for a person). No token is printed: a failure shows `<token>`.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

let s: AgentsPageServer;
let token = "";
let sessionId = "";

beforeAll(async () => {
  s = await startAgentsPageServer();
}, 60_000);
afterAll(async () => {
  await s?.stop();
});

interface Reply {
  status: number;
  body: string;
  json: Record<string, unknown>;
}
async function call(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Reply> {
  // A fresh connection per call (agent: false, Connection: close): a
  // kept-alive socket the server closed while a slow step left it idle
  // fails on reuse, and retrying a POST (the rotate) isn't safe.
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const r = await new Promise<{ status: number; text: () => Promise<string> }>(
    (resolve, reject) => {
      const req = http.request(
        `${s.base}${p}`,
        {
          method,
          agent: false,
          headers: {
            connection: "close",
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
            ...headers,
          },
        },
        (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (buf += c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, text: async () => buf }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    },
  );
  const text = await r.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* a stream or a page */
  }
  return { status: r.status, body: text, json };
}
const person = () => denAuth(s.stateDir);
const agent = () => ({ authorization: `Bearer ${token}` });
const mask = (t: string) =>
  /^den_at_[A-Za-z0-9_-]{43}$/.test(t) ? "<token>" : "<not a token>";
const activity = async () =>
  (await call("GET", "/api/activity?repo=notes")).json.entries as Record<
    string,
    unknown
  >[];

/** A WebSocket upgrade's status (the server answers and closes). */
function upgrade(p: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "localhost",
      port: s.port,
      path: p,
      agent: false,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("upgrade", (res, socket) => {
      socket.on("error", () => undefined);
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("agents start (the page) mints the agent's actor token", () => {
  it("the session gets DEN_ACTOR_TOKEN; the state dir holds only its hash", async () => {
    const r = await call("POST", "/api/workspaces/north/agents", person(), {
      persona: "planner",
    });
    expect(r.status).toBe(200);
    expect(s.made).toHaveLength(1);
    token = actorTokenOf(s.made[0].opts.env) ?? "";
    expect(mask(token)).toBe("<token>");
    const file = path.join(s.stateDir, "actor-tokens.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf-8").includes(token)).toBe(false);
    const rec = JSON.parse(
      fs.readFileSync(path.join(s.stateDir, "agents", "planner.json"), "utf-8"),
    ) as { session: { id: string } };
    sessionId = rec.session.id;
    expect(s.log().includes(token)).toBe(false);
  });
});

describe("the audit actor comes from the credential", () => {
  const report = { tool: "service_up", repo: "notes", reason: "test" };

  it("an actor token's call is agent:<id> in its workspace; a header claiming another agent is ignored", async () => {
    const r = await call(
      "POST",
      "/api/activity",
      {
        ...agent(),
        "x-den-actor": "agent",
        "x-den-mcp-client": "test-client",
        "x-den-mcp-agent": "agent:someone-else",
        "x-den-mcp-workspace": "south",
      },
      report,
    );
    expect(r.status).toBe(200);
    const e = (await activity())[0];
    expect(e).toMatchObject({
      actor: "agent",
      agent: "agent:planner",
      workspace: "north",
      principal: "agent:planner",
      client: "test-client",
    });
    expect(e).not.toHaveProperty("unverified");
  });

  it("a header alone (no credential) is never an agent: recorded as an unverified claim", async () => {
    const csrf = String(
      (await call("GET", "/api/session", { "sec-fetch-site": "same-origin" }))
        .json.csrf,
    );
    const r = await call(
      "POST",
      "/api/activity",
      {
        origin: s.base,
        "x-den-csrf": csrf,
        "x-den-actor": "agent",
        "x-den-mcp-client": "test-client",
        "x-den-mcp-agent": "agent:planner",
      },
      report,
    );
    expect(r.status).toBe(200);
    const e = (await activity())[0];
    expect(e).toMatchObject({
      actor: "user",
      unverified: true,
      claimed: { agent: "agent:planner" },
    });
    expect(e).not.toHaveProperty("agent");
    expect(e).not.toHaveProperty("principal");
  });
});

describe("what an agent's token can't do (403 agent_forbidden)", () => {
  it("open another session's io (HTTP or a WebSocket upgrade); its own passes the checks", async () => {
    const other = await call("GET", "/api/sessions/someone-else/io", agent());
    expect([other.status, other.json.code]).toEqual([403, "agent_forbidden"]);
    expect(await upgrade("/api/sessions/someone-else/io", agent())).toBe(403);
    // Its own: past the checks. The io is a WebSocket (AG-4a-term): a
    // plain GET is 426, an upgrade opens it (101).
    const own = await call("GET", `/api/sessions/${sessionId}/io`, agent());
    expect([own.status, own.json.code]).toEqual([426, "upgrade_required"]);
    expect(
      (
        await call(
          "GET",
          `/api/sessions/${encodeURIComponent("acme-north:planner")}/io`,
          agent(),
        )
      ).status,
    ).toBe(426);
    expect(await upgrade(`/api/sessions/${sessionId}/io`, agent())).toBe(101);
  });

  it("refused uploads are audited: an agent's to another session (agent_forbidden), a page's without its CSRF token", async () => {
    const r = await call(
      "POST",
      "/api/sessions/someone-else/uploads?name=x.png",
      agent(),
      {},
    );
    expect([r.status, r.json.code]).toEqual([403, "agent_forbidden"]);
    const c = await call(
      "POST",
      `/api/sessions/${sessionId}/uploads?name=y.png`,
      { origin: s.base, "sec-fetch-site": "same-origin" },
      {},
    );
    expect([c.status, c.json.code]).toEqual([403, "csrf"]);
    const lines = async (re: RegExp) => {
      for (let i = 0; i < 50; i++) {
        const l = s
          .log()
          .split("\n")
          .filter((x) => re.test(x));
        if (l.length) return l;
        await new Promise((res) => setTimeout(res, 100));
      }
      return [];
    };
    const forbidden = await lines(/✗ upload.*someone-else\/uploads/);
    expect(forbidden[0]).toMatch(/agent_forbidden/);
    expect(forbidden[0]).toMatch(/· by agent:planner/);
    const csrf = await lines(new RegExp(`✗ upload.*${sessionId}/uploads`));
    expect(csrf[0]).toMatch(/csrf/);
  });

  it("mint tokens: agent start and resume", async () => {
    for (const p of [
      "/api/workspaces/north/agents",
      "/api/workspaces/north/agents/planner/resume",
    ]) {
      const r = await call("POST", p, agent(), { persona: "planner", id: "x" });
      expect([p, r.status, r.json.code]).toEqual([p, 403, "agent_forbidden"]);
    }
    expect(s.made).toHaveLength(1);
  });

  it("web.secret's management and sign-in: /api/web/*, logout, /auth", async () => {
    for (const [m, p] of [
      ["GET", "/api/web/sessions"],
      ["POST", "/api/web/logout"],
      ["POST", "/api/web/restart"],
      ["POST", "/api/session/logout"],
      ["GET", "/auth?c=x"],
    ] as const) {
      const r = await call(m, p, agent(), m === "POST" ? {} : undefined);
      expect([p, r.status]).toEqual([p, 403]);
    }
    // And /api/session hands it no browser CSRF token.
    const sess = await call("GET", "/api/session", agent());
    expect(sess.json.csrf).toBeNull();
  });

  it("pass the lock (R8): it can't open it, and the lock reads shut to it", async () => {
    for (const p of [
      "/api/sudo-password",
      "/api/sudo-password/load-from-vault",
    ]) {
      const r = await call("POST", p, agent(), { password: "x" });
      expect([p, r.status, r.json.code]).toEqual([p, 403, "agent_forbidden"]);
    }
    // A person sees it open (the sudo shim is passwordless); the agent shut.
    const asPerson = (await call("GET", "/api/sudo-password/status", person()))
      .json;
    const asAgent = (await call("GET", "/api/sudo-password/status", agent()))
      .json;
    expect(asPerson.passwordless).toBe(true);
    expect([asAgent.set, asAgent.passwordless]).toEqual([false, false]);
  });
});

describe("§6b.2: the streaming GETs take a declared command's id, never free-form input", () => {
  const marker = () => path.join(s.tmp, "pwned");
  const freeForm = "touch ../pwned";
  const stream = (p: string) => call("GET", p, person());
  afterAll(() => {
    expect(fs.existsSync(marker())).toBe(false);
  });

  it("/api/service/exec: an undeclared cmd, or a command string as cmd, runs nothing", async () => {
    for (const cmd of ["deploy-everything", freeForm, "constructor"]) {
      const r = await stream(
        `/api/service/exec?repo=notes&service=notes&env=local&cmd=${encodeURIComponent(cmd)}`,
      );
      expect([cmd, r.status, /not found/.test(r.body)]).toEqual([
        cmd,
        200,
        true,
      ]);
    }
    expect(fs.existsSync(marker())).toBe(false);
  });

  it("/api/workspace/exec: an undeclared cmd, or a command string, runs nothing", async () => {
    for (const cmd of ["deploy-everything", freeForm, "constructor"]) {
      const r = await stream(
        `/api/workspace/exec?workspace=north&cmd=${encodeURIComponent(cmd)}`,
      );
      expect([cmd, /No services in this project have a/.test(r.body)]).toEqual([
        cmd,
        true,
      ]);
    }
    expect(fs.existsSync(marker())).toBe(false);
  });

  it("/api/run: an undeclared pillar runs nothing; a module path out of the tests is refused", async () => {
    const pillar = await stream(
      `/api/run?pillar=${encodeURIComponent(freeForm)}`,
    );
    expect(/No command configured for pillar/.test(pillar.body)).toBe(true);
    for (const mod of ["../../../../tmp/x", "/tmp/x", "--config=/tmp/x.ts"]) {
      const r = await stream(
        `/api/run?pillar=api&module=${encodeURIComponent(mod)}`,
      );
      expect([mod, r.status, /is not a module name/.test(r.body)]).toEqual([
        mod,
        400,
        true,
      ]);
    }
  });

  it("/api/workspace/sync: only a declared managed repo, by name", async () => {
    const r = await stream(
      `/api/workspace/sync?repo=${encodeURIComponent(freeForm)}`,
    );
    expect(/No managed repo named/.test(r.body)).toBe(true);
  });

  it("/api/aws/login: only a configured profile, by env", async () => {
    const r = await stream(
      `/api/aws/login?env=${encodeURIComponent(`local; ${freeForm}`)}`,
    );
    expect(/No AWS profile configured for env/.test(r.body)).toBe(true);
  });
});

describe("the stdio MCP server Den starts for an agent (item 5: --actor)", () => {
  const ENGINE = path.resolve(__dirname, "../../..");
  const mcp = (env: Record<string, string>, actor = "agent:planner") =>
    spawnSync(
      path.join(ENGINE, "node_modules", ".bin", "tsx"),
      [
        path.join(ENGINE, "src", "ui", "cli", "index.ts"),
        "mcp",
        "--port",
        String(s.port),
        "--workspace",
        "north",
        "--actor",
        actor,
        "--call",
        "services",
        JSON.stringify({ workspace: "south" }),
      ],
      {
        cwd: path.join(s.tmp, "dist"),
        encoding: "utf-8",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: path.join(s.tmp, "home"),
          DEN_ROOT: path.join(s.tmp, "dist"),
          DEN_ENGINE_ROOT: ENGINE,
          ACME_HOME: s.stateDir,
          DEN_HOME: path.join(s.tmp, "home", ".den"),
          NO_COLOR: "1",
          CI: "1",
          ...env,
        },
      },
    );

  it("carries the agent's token (DEN_ACTOR_TOKEN, inherited): its refused call is audited as agent:<id>, verified", async () => {
    const r = mcp({ DEN_ACTOR_TOKEN: token, DEN_AGENT: "agent:planner" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/scoped to project "north"/);
    expect(`${r.stdout}${r.stderr}`.includes(token)).toBe(false);
    // The audit line (the server log the /logs page shows): the token's
    // agent, verified (no "(unverified)"). The server's output may lag.
    let line: string | undefined;
    for (let i = 0; i < 50 && !line; i++) {
      line = s
        .log()
        .split("\n")
        .find((l) => /✗ services/.test(l));
      if (!line) await new Promise((res) => setTimeout(res, 100));
    }
    expect(line).toMatch(/· by agent:planner .*\(project north,/);
    expect(line).not.toMatch(/unverified/);
  }, 90_000);

  it("refuses to start with a token minted for another agent than --actor", () => {
    const r = mcp({ DEN_ACTOR_TOKEN: token }, "agent:someone-else");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(
      /--actor agent:someone-else does not match the agent's token, which is agent:planner's/,
    );
    expect(`${r.stdout}${r.stderr}`.includes(token)).toBe(false);
  }, 90_000);
});

describe("the stdio MCP server's startup line (SEC-1 §6c.3)", () => {
  const ENGINE = path.resolve(__dirname, "../../..");
  /** `mcp --workspace north --actor agent:planner` over stdio, stdin closed at once. */
  const stdio = (env: Record<string, string>) =>
    spawnSync(
      path.join(ENGINE, "node_modules", ".bin", "tsx"),
      [
        path.join(ENGINE, "src", "ui", "cli", "index.ts"),
        "mcp",
        "--port",
        String(s.port),
        "--workspace",
        "north",
        "--actor",
        "agent:planner",
      ],
      {
        cwd: path.join(s.tmp, "dist"),
        encoding: "utf-8",
        input: "",
        timeout: 60_000,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: path.join(s.tmp, "home"),
          DEN_ROOT: path.join(s.tmp, "dist"),
          DEN_ENGINE_ROOT: ENGINE,
          ACME_HOME: s.stateDir,
          DEN_HOME: path.join(s.tmp, "home", ".den"),
          NO_COLOR: "1",
          CI: "1",
          ...env,
        },
      },
    );
  const startLine = (r: ReturnType<typeof stdio>) =>
    r.stderr.split("\n").find((l) => / mcp: \d+ tools? /.test(l)) ?? "";

  it("says unverified with no DEN_ACTOR_TOKEN (the actor is a claim); as agent:<id> with the agent's token", () => {
    expect(startLine(stdio({}))).toMatch(
      /scoped to north as agent:planner \(unverified: no agent token\)/,
    );
    const r = stdio({ DEN_ACTOR_TOKEN: token });
    const line = startLine(r);
    expect(line).toMatch(/scoped to north as agent:planner/);
    expect(line).not.toMatch(/unverified/);
    expect(`${r.stdout}${r.stderr}`.includes(token)).toBe(false);
  }, 90_000);
});

describe("`web logout --all` revokes every agent token (SEC-1 §6c.2)", () => {
  it("without --all it is left alone; with --all the running agent's next call is 401 token_revoked, telling it to restart or resume", async () => {
    const plain = await call("POST", "/api/web/logout", person(), {});
    expect(plain.status).toBe(200);
    expect(plain.json.agentTokens).toBeUndefined();
    expect((await call("GET", "/api/settings", agent())).status).toBe(200);

    const r = await call("POST", "/api/web/logout", person(), {
      rotate: true,
    });
    expect([r.status, r.json.rotated, r.json.agentTokens]).toEqual([
      200,
      true,
      1,
    ]);
    const after = await call("GET", "/api/settings", agent());
    expect([after.status, after.json.code]).toEqual([401, "token_revoked"]);
    expect(String(after.json.error)).toMatch(
      /restart or resume the agent to get a new one/,
    );
    // The record is kept (revoked), hashed only: never the token.
    const file = fs.readFileSync(
      path.join(s.stateDir, "actor-tokens.json"),
      "utf-8",
    );
    expect(file.includes(token)).toBe(false);
    expect(file).toMatch(/"revokedAt"/);
  });
});

describe("stop revokes the token", () => {
  it("after `Stop`, the token is refused (401)", async () => {
    // The scripted runtime ends on TERM; stop answers once it has (0.4.8).
    const p = s.made[0];
    const kill = p.kill.bind(p);
    p.kill = (sig: string) => {
      kill(sig);
      setTimeout(() => p.exit(143), 50);
    };
    expect(
      (
        await call(
          "POST",
          "/api/workspaces/north/agents/planner/stop",
          person(),
        )
      ).status,
    ).toBe(200);
    const r = await call("GET", "/api/settings", agent());
    expect([r.status, r.json.code]).toEqual([401, "unauthorized"]);
  });
});
