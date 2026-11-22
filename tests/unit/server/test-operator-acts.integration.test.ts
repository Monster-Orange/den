/**
 * Issue 814 (option B): the test operator's acts on an operator install
 * (the demo distribution, the scripted PTY, made as a new test install).
 * A fixture session may start a terminal (in the project's folder, its
 * Den CLI sending no person credential, on this install only), use and
 * close its own shells (never a person's or an agent's), message an agent
 * and relaunch one, each audited as the test operator. Anything else stays
 * the fixture person's. Invented names only; no code, cookie or secret is
 * printed. Its subjects: test-operator.ts, request-guard.ts,
 * agent-routes.ts and agent-ops.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import {
  mintFixtureCode,
  readFixtureKey,
} from "../../../src/shared/fixture-person.js";

let s: AgentsPageServer;
let fx: { cookie: string; csrf: string };

interface Reply {
  status: number;
  json: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function raw(
  method: string,
  p: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "localhost",
        port: s.port,
        path: p,
        method,
        agent: false,
        timeout: 20_000,
        headers: {
          connection: "close",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(payload)),
              }),
          ...headers,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d: Buffer) => (buf += d.toString()));
        res.on("end", () => {
          let json: Record<string, unknown> = {};
          try {
            json = JSON.parse(buf) as Record<string, unknown>;
          } catch {
            /* a page */
          }
          resolve({
            status: res.statusCode ?? 0,
            json,
            headers: res.headers,
            body: buf,
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`timeout: ${p}`)));
    req.end(payload);
  });
}

/** A fixture session's write, shaped as the page's own. */
const asOperator = (method: string, p: string, body: unknown = {}) =>
  raw(
    method,
    p,
    {
      cookie: fx.cookie,
      origin: s.base,
      "x-den-csrf": fx.csrf,
    },
    body,
  );
/** The person's own call (the CLI's bearer). */
const asPerson = (method: string, p: string, body: unknown = {}) =>
  raw(method, p, denAuth(s.stateDir), body);

function auditRows(): Record<string, unknown>[] {
  return fs
    .readFileSync(path.join(s.stateDir, "audit.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeAll(async () => {
  s = await startAgentsPageServer({ testInstall: true });
  const code = mintFixtureCode(readFixtureKey(s.stateDir)!);
  const r = await raw("GET", `/auth?fixture=${encodeURIComponent(code)}`, {
    "sec-fetch-site": "none",
    accept: "text/html",
  });
  expect(r.status).toBe(303);
  const cookie =
    ([] as string[])
      .concat(r.headers["set-cookie"] ?? [])
      .map((c) => c.split(";")[0])
      .find((c) => /den_session_/.test(c)) ?? "";
  const me = await raw("GET", "/api/session", {
    cookie,
    "sec-fetch-site": "same-origin",
  });
  fx = { cookie, csrf: String(me.json.csrf ?? "") };
}, 90_000);
afterAll(async () => {
  await s?.stop();
});

describe("the test operator's terminal", () => {
  it("starts a shell in the project's folder, its CLI pinned here and sending no person credential", async () => {
    const before = s.made.length;
    const r = await asOperator("POST", "/api/workspaces/north/sessions");
    expect(r.status).toBe(200);
    expect(s.made.length).toBe(before + 1);
    const env = s.made.at(-1)!.opts.env as Record<string, string>;
    expect(env.DEN_AGENT).toBe("test-operator");
    expect(env.ACME_HOME).toBe(s.stateDir);
    expect(env.ACME_ROOT).toBeTruthy();
    const row = auditRows()
      .reverse()
      .find((e) => e.verb === "test-operator");
    expect(row?.principal).toBe("test:operator");
    expect(String(row?.detail)).toMatch(/^terminal-start /);
  });

  it("never in another folder (no cwd)", async () => {
    const r = await asOperator("POST", "/api/workspaces/north/sessions", {
      cwd: s.wsDir("north"),
    });
    expect(r.status).toBe(403);
  });

  it("closes its own shell", async () => {
    const open = await asOperator("POST", "/api/workspaces/north/sessions");
    const { id } = open.json.session as { id: string };
    const pty = s.made.at(-1)!;
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      if (sig === "SIGHUP") setTimeout(() => pty.exit(129), 10);
    };
    const r = await asOperator(
      "POST",
      `/api/sessions/${encodeURIComponent(id)}/close`,
    );
    expect([r.status, r.json.ok]).toEqual([200, true]);
  }, 30_000);

  it("never a person's shell: close and attach refused", async () => {
    const open = await asPerson("POST", "/api/workspaces/north/sessions");
    expect(open.status).toBe(200);
    const { id } = open.json.session as { id: string };
    const pty = s.made.at(-1)!;
    const c = await asOperator(
      "POST",
      `/api/sessions/${encodeURIComponent(id)}/close`,
    );
    expect([c.status, c.json.code]).toEqual([403, "fixture_scope"]);
    expect(pty.signals).toEqual([]);
  });
});

describe("the test operator's messages and relaunch", () => {
  it("a message to an agent passes the person-only check, audited as the test operator", async () => {
    s.seed({ id: "planner", workspace: "north" });
    const r = await asOperator(
      "POST",
      "/api/workspaces/north/agents/planner/say",
      { text: "hello" },
    );
    expect(r.status === 403 && /only a person/.test(r.body)).toBe(false);
    expect(r.json.code).not.toBe("fixture_scope");
    expect(
      auditRows().some(
        (e) =>
          e.principal === "test:operator" &&
          /^agent-say /.test(String(e.detail)),
      ),
    ).toBe(true);
  });

  it("a relaunch passes the gate", async () => {
    const r = await asOperator(
      "POST",
      "/api/workspaces/north/agents/planner/relaunch",
    );
    expect(r.json.code).not.toBe("fixture_scope");
    expect(r.status === 403 && /only a person/.test(r.body)).toBe(false);
  });
});

describe("what the test operator still can't do here", () => {
  it.each([
    ["POST", "/api/workspaces/north/agents/planner/restart"],
    ["POST", "/api/workspaces/north/agents/planner/move"],
    ["POST", "/api/agents/runtimes/claude/path"],
    ["POST", "/api/approvals/a1/decide"],
    ["POST", "/api/web/fixture-person"],
  ])("%s %s: refused", async (m, p) => {
    const r = await asOperator(m, p, {});
    expect(r.status).toBe(403);
  });

  it("a request through a proxy is refused", async () => {
    const r = await raw(
      "POST",
      "/api/workspaces/north/agents/planner/say",
      {
        cookie: fx.cookie,
        origin: s.base,
        "x-den-csrf": fx.csrf,
        "x-forwarded-for": "10.1.2.3",
      },
      { text: "hello" },
    );
    expect([r.status, r.json.code]).toEqual([403, "fixture_scope"]);
  });
});
