/**
 * Issue 1008: an agent can withdraw a question it asked, once it is
 * settled elsewhere.
 *
 *  - The asking agent (its token) or the person withdraws it with a
 *    one-line reason: POST /api/notifications/withdraw { id, reason }, the
 *    MCP tool ask_withdraw, and `<cli> ask withdraw <id> --reason "…"`.
 *  - It leaves Needs you; the bell keeps it as a read update that says
 *    "settled: <reason>", who withdrew it and when.
 *  - Another agent's withdraw is refused (403) and recorded in the audit
 *    trail.
 *  - An answer that comes after the withdraw is kept (passed on, and the
 *    bell row says so), and the agent is told it came late.
 *  - The strings are in en, es and ja.
 *
 * The handlers in an in-process server, the principal set as request-guard
 * sets it. Invented names only; temp dirs only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  bellPrefs,
  bellView,
  NotificationStore,
} from "../../../src/shared/notifications.js";
import { Attention } from "../../../src/ui/server/attention.js";
import { recentActions } from "../../../src/ui/server/audit.js";
import { handleNotificationRoutes } from "../../../src/ui/server/notification-routes.js";
import {
  setPrincipal,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import { assertAllowedRequest } from "../../../src/ui/mcp/api.js";
import { cmdAsk } from "../../../src/ui/cli/ask-command.js";

const dirs: string[] = [];
const tmp = (p: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  dirs.push(d);
  return d;
};

const told: { agent: string; text: string }[] = [];

function mk(stateDir: string) {
  const store = new NotificationStore(stateDir);
  const attention = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: (a) => (a === "planner" ? "Planner" : "Scribe"),
    hooked: () => true,
    tell: async (agent: string, text: string) => {
      told.push({ agent, text });
      return true;
    },
  });
  return { store, attention };
}

describe("issue 1008: withdraw a question", () => {
  let stateDir = "";
  let store: NotificationStore;
  let attention: Attention;
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    stateDir = tmp("den-1008-");
    ({ store, attention } = mk(stateDir));
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url!, "http://x").pathname;
      const agent = req.headers["x-test-agent"];
      const p = (
        typeof agent === "string"
          ? {
              kind: "agent",
              actor: `agent:${agent}`,
              workspace: "north",
              grants: [],
              session: { name: `acme-north:${agent}` },
            }
          : { kind: "person-browser", session: "sess-1008" }
      ) as Principal;
      setPrincipal(req, p);
      void (async () => {
        if (
          await handleNotificationRoutes(req, res, pathname, {
            store,
            attention,
          })
        )
          return;
        res.writeHead(404);
        res.end();
      })();
    });
    await new Promise<void>((r) => server.listen(0, "localhost", r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  const post = async (p: string, body: unknown, agent?: string) => {
    const r = await fetch(`${base}${p}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(agent ? { "x-test-agent": agent } : {}),
      },
      body: JSON.stringify(body),
    });
    return {
      status: r.status,
      json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
    };
  };

  const ask = async (agent: string, text: string) => {
    const r = await post(
      "/api/agents/self/attention",
      { event: "waiting", why: "asked", text },
      agent,
    );
    expect(r.status).toBe(200);
    expect(typeof r.json.askId).toBe("string");
    return r.json.askId as string;
  };

  it("ask_human's answer names the question's id", async () => {
    const id = await ask("planner", "Ship the north fix today?");
    expect(store.list().find((n) => n.id === id)?.kind).toBe("waiting");
    await post("/api/notifications/withdraw", { id, reason: "x" }, "planner");
  });

  it("the asker withdraws: it leaves Needs you; history says settled: <reason>, who, when", async () => {
    const id = await ask("planner", "Which branch, main or next?");
    expect(
      bellView(store.list(), bellPrefs(null)).recent.map((n) => n.id),
    ).toContain(id);
    const r = await post(
      "/api/notifications/withdraw",
      { id, reason: "decided in chat: next" },
      "planner",
    );
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const v = bellView(store.list(), bellPrefs(null));
    expect(v.recent.map((n) => n.id)).not.toContain(id);
    expect(v.unread).toBe(0);
    const row = v.updates.find((n) => n.id === id)!;
    expect(row).toBeDefined();
    expect(row.text).toMatch(/settled: decided in chat: next/);
    expect(row.settled).toEqual({
      reason: "decided in chat: next",
      by: "agent:planner",
      at: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(row.settled!.at))).toBe(false);
    expect(row.msg?.key).toBe("bell.m.settled");
    // Its waiting mark went too.
    expect(attention.waitingNow().has("planner")).toBe(false);
    // Recorded.
    expect(
      recentActions().some(
        (e) =>
          e.verb === "ask_withdraw" && !e.outcome && /settled/.test(e.detail),
      ),
    ).toBe(true);
  });

  it("another agent's withdraw is refused and recorded", async () => {
    const id = await ask("planner", "Merge the south PR?");
    const r = await post(
      "/api/notifications/withdraw",
      { id, reason: "not mine to settle" },
      "scribe",
    );
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("not_yours");
    expect(store.list().find((n) => n.id === id)?.settled).toBeUndefined();
    expect(attention.waitingNow().get("planner")).toBe("asked");
    expect(
      recentActions().some(
        (e) =>
          e.verb === "ask_withdraw" &&
          e.outcome === "refused" &&
          e.principal === "agent:scribe",
      ),
    ).toBe(true);
    // The person may.
    const p = await post("/api/notifications/withdraw", {
      id,
      reason: "settled at standup",
    });
    expect(p.status).toBe(200);
    const row = store.list().find((n) => n.id === id)!;
    expect(row.settled?.by).toBe("person");
    expect(row.msg?.key).toBe("bell.m.settledYou");
  });

  it("refuses a missing reason, an unknown id, and a second withdraw", async () => {
    const id = await ask("planner", "Rename the north service?");
    expect(
      (await post("/api/notifications/withdraw", { id }, "planner")).status,
    ).toBe(400);
    expect(
      (
        await post(
          "/api/notifications/withdraw",
          { id: "nope", reason: "r" },
          "planner",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          "/api/notifications/withdraw",
          { id, reason: "r" },
          "planner",
        )
      ).status,
    ).toBe(200);
    const again = await post(
      "/api/notifications/withdraw",
      { id, reason: "r" },
      "planner",
    );
    expect(again.status).toBe(409);
  });

  it("an answer after the withdraw is kept, and the agent is told it came late", async () => {
    told.length = 0;
    const id = await ask("planner", "Tag tonight or tomorrow?");
    await post(
      "/api/notifications/withdraw",
      { id, reason: "another agent tagged it" },
      "planner",
    );
    // The person answers in its pane, and the prompt goes in.
    attention.typed("planner");
    await attention.event("planner", "north", {
      event: "resumed",
      from: "prompt",
    });
    expect(told).toHaveLength(1);
    expect(told[0].agent).toBe("planner");
    expect(told[0].text).toMatch(/after you withdrew/);
    expect(told[0].text).toMatch(/another agent tagged it/);
    const row = store.list().find((n) => n.id === id)!;
    expect(row.settled?.late).toBe(true);
    expect(row.msg?.key).toBe("bell.m.settledLate");
    // Once only.
    attention.typed("planner");
    await attention.event("planner", "north", {
      event: "resumed",
      from: "prompt",
    });
    expect(told).toHaveLength(1);
  });

  it("a prompt Den types (no person typing) is not an answer", async () => {
    told.length = 0;
    const id = await ask("planner", "Bump the pin?");
    await post(
      "/api/notifications/withdraw",
      { id, reason: "pinned already" },
      "planner",
    );
    await attention.event("planner", "north", {
      event: "resumed",
      from: "prompt",
    });
    expect(told).toHaveLength(0);
    expect(
      store.list().find((n) => n.id === id)?.settled?.late,
    ).toBeUndefined();
  });

  it("a settled row stays when the agent's next question clears", async () => {
    const id = await ask("planner", "Old question?");
    await post(
      "/api/notifications/withdraw",
      { id, reason: "moot" },
      "planner",
    );
    await ask("planner", "New question?");
    attention.answered("planner");
    expect(store.list().find((n) => n.id === id)?.settled?.reason).toBe("moot");
  });
});

describe("issue 1008: the tool and the CLI", () => {
  const ctx = (api: DenApi): ToolContext => ({
    api,
    cfg: {
      actions: [],
      runTestsEnvs: ["local"],
      logsRemote: false,
      approvals: true,
    },
    cli: "acme",
    scope: { workspace: "north", actor: "agent:planner" },
  });

  it("ask_withdraw posts the id and reason; the route is allowed", async () => {
    const calls: { path: string; method?: string; body?: unknown }[] = [];
    const api: DenApi = {
      baseUrl: "http://localhost:47003",
      async get(p, _q, method, body) {
        if (p === "/api/workspaces")
          return { active: ["north"], workspaces: { north: {} } };
        calls.push({ path: p, method, body });
        return { ok: true, id: "q1" };
      },
      async stream() {
        throw new Error("no streams");
      },
    };
    const r = await callTool(
      "ask_withdraw",
      { id: "q1", reason: " settled in chat " },
      ctx(api),
    );
    expect(r.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        path: "/api/notifications/withdraw",
        method: "POST",
        body: { id: "q1", reason: "settled in chat" },
      },
    ]);
    expect(() =>
      assertAllowedRequest("POST", "/api/notifications/withdraw", {}),
    ).not.toThrow();
  });

  it("ask_human says the question's id, for a withdraw", async () => {
    const api: DenApi = {
      baseUrl: "http://localhost:47003",
      async get(p) {
        if (p === "/api/workspaces")
          return { active: ["north"], workspaces: { north: {} } };
        return { ok: true, askId: "q-42" };
      },
      async stream() {
        throw new Error("no streams");
      },
    };
    const r = await callTool("ask_human", { question: "Go?" }, ctx(api));
    expect(r.text).toMatch(/q-42/);
  });

  it("`ask withdraw <id> --reason` posts; without a reason it is a usage error", async () => {
    const sent: { method: string; path: string; body?: unknown }[] = [];
    const out: string[] = [];
    const io = {
      out: (s: string) => void out.push(s),
      err: (s: string) => void out.push(s),
      api: async (method: "GET" | "POST", p: string, body?: unknown) => {
        sent.push({ method, path: p, body });
        return { status: 200, data: { ok: true } };
      },
    };
    expect(
      await cmdAsk(["withdraw", "q1", "--reason", "settled in chat"], io),
    ).toBe(0);
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/api/notifications/withdraw",
        body: { id: "q1", reason: "settled in chat" },
      },
    ]);
    expect(await cmdAsk(["withdraw", "q1"], io)).toBe(2);
    const refused = {
      ...io,
      api: async () => ({
        status: 403,
        data: { code: "not_yours", error: "Only the agent that asked." },
      }),
    };
    expect(await cmdAsk(["withdraw", "q1", "--reason", "r"], refused)).toBe(1);
  });
});

describe("issue 1008: the strings are in en, es and ja", () => {
  const PUBLIC = path.resolve(__dirname, "../../../src/ui/server/public");
  const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");
  it.each(["shell.js", "i18n/es.js", "i18n/ja.js"])("%s", (f) => {
    const src = read(f);
    for (const k of [
      "bell.m.settled",
      "bell.m.settledYou",
      "bell.m.settledLate",
    ])
      expect(src).toContain(`"${k}":`);
  });
});
