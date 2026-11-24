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
import {
  operatorStubArgv,
  operatorStubEnv,
} from "../../../src/shared/test-operator.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";

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
  it("starts Den's fixed stub in the project's folder, never a shell; nothing from the request", async () => {
    const before = s.made.length;
    const r = await asOperator("POST", "/api/workspaces/north/sessions", {
      argv: ["/bin/sh", "-l"],
      env: { NODE_OPTIONS: "--require /x" },
    });
    expect(r.status).toBe(200);
    expect(s.made.length).toBe(before + 1);
    const pty = s.made.at(-1)!;
    expect([pty.file, ...pty.args]).toEqual(operatorStubArgv());
    expect(pty.opts.env).toEqual(operatorStubEnv());
    expect(pty.opts.cwd).toBe(s.wsDir("north"));
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

describe("a shell's name reused by an agent never lets the operator in", () => {
  const io = (target: string) =>
    raw("GET", `/api/sessions/${encodeURIComponent(target)}/io`, {
      cookie: fx.cookie,
      origin: s.base,
      "sec-fetch-site": "same-origin",
    });
  const closeIt = (id: string) =>
    asOperator("POST", `/api/sessions/${encodeURIComponent(id)}/close`);

  it("its own shell: attach by its host id passes; by its name, refused", async () => {
    const open = await asOperator("POST", "/api/workspaces/north/sessions");
    const { id, name } = open.json.session as { id: string; name: string };
    expect((await io(id)).json.code).not.toBe("fixture_scope");
    const byName = await io(name);
    expect([byName.status, byName.json.code]).toEqual([403, "fixture_scope"]);
    const pty = s.made.at(-1)!;
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      if (sig === "SIGHUP") setTimeout(() => pty.exit(129), 10);
    };
    await closeIt(id);
  }, 30_000);

  it("closed, it is forgotten: the same id is refused after", async () => {
    const open = await asOperator("POST", "/api/workspaces/north/sessions");
    const { id } = open.json.session as { id: string };
    const pty = s.made.at(-1)!;
    const kill = pty.kill.bind(pty);
    pty.kill = (sig: string) => {
      kill(sig);
      if (sig === "SIGHUP") setTimeout(() => pty.exit(129), 10);
    };
    expect((await closeIt(id)).status).toBe(200);
    const again = await io(id);
    expect([again.status, again.json.code]).toEqual([403, "fixture_scope"]);
  }, 30_000);

  it("a session an agent record owns is refused, even under an id the operator holds", async () => {
    const open = await asOperator("POST", "/api/workspaces/north/sessions");
    const { id, name } = open.json.session as { id: string; name: string };
    // An agent now owns that very session (its record names it).
    s.seed({
      id: "shell",
      workspace: "north",
      session: { id, name } as never,
      sessionName: name,
    });
    const r = await io(id);
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("agent_session");
  });
});

describe("say and relaunch: project agents only, never the server agent", () => {
  it.each(["say", "relaunch"])(
    "%s to the server agent: refused",
    async (verb) => {
      s.seed({ id: "helper", workspace: "den-server" });
      const r = await asOperator(
        "POST",
        `/api/workspaces/den-server/agents/helper/${verb}`,
        { text: "hello" },
      );
      expect([r.status, r.json.code]).toEqual([403, "fixture_scope"]);
      expect(
        auditRows().some(
          (e) =>
            e.principal === "test:operator" &&
            String(e.detail).includes("/den-server/"),
        ),
      ).toBe(false);
    },
  );
});

describe("the gate order with the test-person path (issue 636)", () => {
  it("a fixture session sending the test-person header is refused there, never the operator", async () => {
    const before = auditRows().filter(
      (e) => e.principal === "test:operator",
    ).length;
    const r = await raw(
      "POST",
      "/api/workspaces/north/agents/planner/say",
      {
        cookie: fx.cookie,
        origin: s.base,
        "x-den-csrf": fx.csrf,
        "x-den-test-person": "1",
      },
      { text: "hello" },
    );
    expect([r.status, r.json.code]).toEqual([403, "test_person_refused"]);
    expect(
      auditRows().filter((e) => e.principal === "test:operator").length,
    ).toBe(before);
  });
});

describe("the test operator's messages and relaunch", () => {
  it("a message to an agent passes the person-only check, audited as the test operator", async () => {
    // Issue 956: one of the bed's own agents (Den marked it at start).
    s.seed({ id: "planner", workspace: "north", testBed: true });
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
    s.seed({ id: "planner", workspace: "north", testBed: true });
    const r = await asOperator(
      "POST",
      "/api/workspaces/north/agents/planner/relaunch",
    );
    expect(r.json.code).not.toBe("fixture_scope");
    expect(r.status === 403 && /only a person/.test(r.body)).toBe(false);
  });
});

/**
 * Issue 956: the operator's message and relaunch reach only the bed's own
 * agents: those Den marked testBed when it started them on the test-person
 * path (issue 943). Any other agent on the install is refused, as a
 * person-only act is, and nothing reaches it.
 */
describe("the test operator reaches only the bed's own agents", () => {
  it.each(["say", "relaunch"])(
    "%s to an agent Den didn't mark: refused",
    async (verb) => {
      s.seed({ id: "real", workspace: "north" });
      const r = await asOperator(
        "POST",
        `/api/workspaces/north/agents/real/${verb}`,
        { text: "hello" },
      );
      expect(r.status).toBe(403);
      expect(r.body).toMatch(/only a person/);
    },
  );

  it("the person still sends an unmarked agent a message", async () => {
    s.seed({ id: "real", workspace: "north" });
    const r = await asPerson("POST", "/api/workspaces/north/agents/real/say", {
      text: "hello",
    });
    expect(r.status === 403 && /only a person/.test(r.body)).toBe(false);
  });
});

/**
 * Issue 1407: gate/1407 restarts the bed's own agents (a row's Restart,
 * Restart now, and the bulk restart-stale), under agent-relaunch's rules.
 */
describe("issue 1407: the test operator's restarts", () => {
  it("a restart of one of the bed's own agents passes the gate, audited as the test operator", async () => {
    s.seed({ id: "planner", workspace: "north", testBed: true });
    const r = await asOperator(
      "POST",
      "/api/workspaces/north/agents/planner/restart",
      { when: "now" },
    );
    expect(r.json.code).not.toBe("fixture_scope");
    expect(r.status).not.toBe(403);
    expect(
      auditRows().some(
        (e) =>
          e.principal === "test:operator" &&
          /^agent-restart /.test(String(e.detail)),
      ),
    ).toBe(true);
  });

  it("a restart of an agent Den didn't mark: refused", async () => {
    s.seed({ id: "real", workspace: "north" });
    const r = await asOperator(
      "POST",
      "/api/workspaces/north/agents/real/restart",
      { when: "now" },
    );
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/only a person/);
  });

  it("restart-stale passes the gate, and answers only for the bed's own agents", async () => {
    const r = await asOperator("POST", "/api/agents/restart-stale", {});
    expect(r.json.code).not.toBe("fixture_scope");
    expect(r.status).toBe(202);
    expect(
      auditRows().some(
        (e) =>
          e.principal === "test:operator" &&
          /^agents-restart-stale /.test(String(e.detail)),
      ),
    ).toBe(true);
  });

  it("the person's restart of an unmarked agent is as before", async () => {
    s.seed({ id: "real", workspace: "north" });
    const r = await asPerson(
      "POST",
      "/api/workspaces/north/agents/real/restart",
      { when: "now" },
    );
    expect(r.status === 403 && /only a person/.test(r.body)).toBe(false);
  });
});

describe("what the test operator still can't do here", () => {
  it.each([
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

/**
 * Issue 1414: the test operator may Allow and Undo a held write that one
 * of the bed's own agents asked for (testBed, issue 943), on this test
 * install, on loopback. Another agent's: refused. The trail names the test
 * operator. One started agent: unmarked first, then marked as Den marks
 * the bed's (the record's testBed).
 */
describe("issue 1414: the operator's Allow and Undo", () => {
  const AGENT = "reviewer";
  let token = "";
  const ask = async (key: string, value: number, held: boolean) => {
    const r = await raw(
      "POST",
      "/api/approvals",
      { authorization: `Bearer ${token}` },
      {
        action: "setting_change",
        args: { key, value, reason: "a live check" },
        ...(held ? { ask: true, note: "a live check of Allow" } : {}),
      },
    );
    if (r.status >= 300) throw new Error(`${r.status} ${r.body}`);
    return String(r.json.id ?? "");
  };
  const opRow = (verb: string, re: RegExp) =>
    auditRows().some(
      (e) =>
        e.principal === "test:operator" &&
        e.verb === verb &&
        re.test(String(e.detail)) &&
        e.outcome !== "refused",
    );
  const markBed = () => {
    const rec = readRecord(s.stateDir, AGENT);
    if (!rec) throw new Error("no record");
    writeRecord(s.stateDir, { ...rec, testBed: true });
  };

  beforeAll(async () => {
    // Routine limits run at once on personal: an Undo waits in the bell.
    const m = await asPerson("POST", "/api/settings", {
      install_mode: "personal",
    });
    expect(m.status).toBe(200);
    const before = s.made.length;
    const r = await asPerson("POST", "/api/workspaces/north/agents", {
      persona: AGENT,
    });
    expect(r.status).toBe(200);
    expect(s.made.length).toBeGreaterThan(before);
    token = actorTokenOf(s.made.at(-1)!.opts.env) ?? "";
    expect(token).toBeTruthy();
  });

  it("an agent Den didn't mark: Allow and Undo refused, and its ask still waits", async () => {
    const held = await ask("sessions.close_grace_seconds", 7, true);
    const a = await asOperator("POST", `/api/approvals/${held}/decide`, {
      decision: "allow",
    });
    expect(a.status).toBe(403);
    // The asker reads its own ask (a person's read needs a signed-in browser).
    const one = await raw("GET", `/api/approvals/${held}`, {
      authorization: `Bearer ${token}`,
    });
    expect(one.json.state).toBe("pending");
    const ran = await ask("sessions.close_grace_seconds", 8, false);
    const u = await asOperator("POST", "/api/settings/undo", { approval: ran });
    expect(u.status).toBe(403);
  });

  it("a test-bed agent's held write: Allow runs it, and the trail names the test operator", async () => {
    markBed();
    const id = await ask("sessions.close_grace_seconds", 9, true);
    const r = await asOperator("POST", `/api/approvals/${id}/decide`, {
      decision: "allow",
    });
    expect([r.status, r.json.state]).toEqual([200, "done"]);
    expect(opRow("approval-decide", new RegExp(`\\[${id}\\]`))).toBe(true);
  });

  it("a test-bed agent's change: Undo puts it back, and the trail names the test operator", async () => {
    markBed();
    const id = await ask("sessions.close_grace_seconds", 10, false);
    const r = await asOperator("POST", "/api/settings/undo", { approval: id });
    expect([r.status, r.json.ok]).toEqual([200, true]);
    expect(opRow("test-operator", /^setting-undo /)).toBe(true);
  });

  it("Allow or Undo through a proxy: refused", async () => {
    markBed();
    const id = await ask("sessions.close_grace_seconds", 11, true);
    const fwd = {
      cookie: fx.cookie,
      origin: s.base,
      "x-den-csrf": fx.csrf,
      "x-forwarded-for": "10.1.2.3",
    };
    const a = await raw("POST", `/api/approvals/${id}/decide`, fwd, {
      decision: "allow",
    });
    expect(a.status).toBe(403);
    const u = await raw("POST", "/api/settings/undo", fwd, { approval: id });
    expect(u.status).toBe(403);
  });
});
