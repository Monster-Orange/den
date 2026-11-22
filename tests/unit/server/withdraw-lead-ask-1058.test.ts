/**
 * Issue 1058: withdraw a question that went to the project's lead.
 *
 *  - ask_human's answer gives an id for a question routed to the lead (its
 *    "asked the lead" row in the bell).
 *  - The asking agent (or the person) withdraws it with a reason: its
 *    waiting mark goes, that row says "settled: <reason>", and the lead is
 *    told the question is settled.
 *  - Another agent's withdraw is refused and recorded, as in issue 1008.
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
import { NotificationStore } from "../../../src/shared/notifications.js";
import { Attention } from "../../../src/ui/server/attention.js";
import { recentActions } from "../../../src/ui/server/audit.js";
import { handleNotificationRoutes } from "../../../src/ui/server/notification-routes.js";
import {
  setPrincipal,
  type Principal,
} from "../../../src/ui/server/request-guard.js";
import { callTool } from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";

const NAMES: Record<string, string> = {
  coder: "Coder",
  lead: "Lead",
  scribe: "Scribe",
};

describe("issue 1058: withdraw a question routed to the lead", () => {
  let dir = "";
  let store: NotificationStore;
  let attention: Attention;
  let server: http.Server;
  let base = "";
  const told: { to: string; text: string }[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1058-"));
    store = new NotificationStore(dir);
    attention = new Attention({
      store,
      outputMark: async () => "m",
      nameOf: (a) => NAMES[a] ?? a,
      hooked: () => true,
      leadOf: async () => "lead",
      tellLead: async (to, text) => {
        told.push({ to, text });
        return true;
      },
    });
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
          : { kind: "person-browser", session: "sess-1058" }
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
    fs.rmSync(dir, { recursive: true, force: true });
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

  const ask = async (text: string) => {
    const r = await post(
      "/api/agents/self/attention",
      { event: "waiting", why: "asked", text },
      "coder",
    );
    expect(r.status).toBe(200);
    expect(r.json.lead).toBe("Lead");
    return r.json.askId as string | undefined;
  };

  it("a question routed to the lead gets an id", async () => {
    const id = await ask("Squash or merge the north branch?");
    expect(typeof id).toBe("string");
    const row = store.list().find((n) => n.id === id)!;
    expect(row.msg?.key).toBe("bell.m.toLead");
    await post("/api/notifications/withdraw", { id, reason: "x" }, "coder");
  });

  it("its withdraw clears the asker's mark, settles the row, and tells the lead", async () => {
    told.length = 0;
    const id = await ask("Rename the south job?");
    expect(attention.waitingNow().get("coder")).toBe("asked");
    told.length = 0;
    const r = await post(
      "/api/notifications/withdraw",
      { id, reason: "decided in the pull request" },
      "coder",
    );
    expect(r.status).toBe(200);
    expect(attention.waitingNow().has("coder")).toBe(false);
    const row = store.list().find((n) => n.id === id)!;
    expect(row.settled?.reason).toBe("decided in the pull request");
    expect(row.settled?.by).toBe("agent:coder");
    expect(row.text).toMatch(/settled: decided in the pull request/);
    expect(told).toHaveLength(1);
    expect(told[0].to).toBe("lead");
    expect(told[0].text).toMatch(/Coder/);
    expect(told[0].text).toMatch(/settled: decided in the pull request/);
    expect(told[0].text).toMatch(/Rename the south job\?/);
  });

  it("another agent's withdraw is refused and recorded; the person's works", async () => {
    const id = await ask("Pin the north image?");
    const r = await post(
      "/api/notifications/withdraw",
      { id, reason: "not mine" },
      "scribe",
    );
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("not_yours");
    expect(attention.waitingNow().get("coder")).toBe("asked");
    expect(
      recentActions().some(
        (e) =>
          e.verb === "ask_withdraw" &&
          e.outcome === "refused" &&
          e.principal === "agent:scribe" &&
          e.detail.includes(id!),
      ),
    ).toBe(true);
    // Even the lead can't: it is the asker's or the person's.
    expect(
      (
        await post(
          "/api/notifications/withdraw",
          { id, reason: "I decided" },
          "lead",
        )
      ).status,
    ).toBe(403);
    expect(
      (await post("/api/notifications/withdraw", { id, reason: "at standup" }))
        .status,
    ).toBe(200);
    expect(store.list().find((n) => n.id === id)?.settled?.by).toBe("person");
  });

  it("another finished row (a turn's end) is not a question to withdraw", async () => {
    await attention.event("scribe", "north", { event: "finished" });
    const row = store
      .list()
      .find((n) => n.subject === "agent:scribe" && n.kind === "finished")!;
    expect(
      (
        await post(
          "/api/notifications/withdraw",
          { id: row.id, reason: "r" },
          "scribe",
        )
      ).status,
    ).toBe(404);
  });
});

describe("issue 1058: ask_human names the id when the lead has it", () => {
  it("says the lead and the id", async () => {
    const api: DenApi = {
      baseUrl: "http://localhost:47003",
      async get(p) {
        if (p === "/api/workspaces")
          return { active: ["north"], workspaces: { north: {} } };
        return { ok: true, lead: "Lead", askId: "q-7" };
      },
      async stream() {
        throw new Error("no streams");
      },
    };
    const r = await callTool(
      "ask_human",
      { question: "Go?" },
      {
        api,
        cfg: {
          actions: [],
          runTestsEnvs: ["local"],
          logsRemote: false,
          approvals: true,
        },
        cli: "acme",
        scope: { workspace: "north", actor: "agent:coder" },
      },
    );
    expect(r.text).toMatch(/lead, Lead/);
    expect(r.text).toMatch(/q-7/);
  });
});
