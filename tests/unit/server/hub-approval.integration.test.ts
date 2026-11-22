/**
 * P0-D2 on the real server: the agent's turn ended on a question that
 * names its doc's Hub link (the turn-end hook, as attention-hook.ts posts
 * it), and the agent is busy. The person's plain comment on the doc
 * leaves the question; their approval clears it on arrival, through the
 * real delivery service. A fake Hub on 127.0.0.1, the scripted PTY.
 * Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";
import { attentionOf } from "../../../src/shared/agents/guardrails/attention-hook.js";

const TOKEN = "hubi_TESTONLY_appr_7d1e";

const hub = {
  url: "",
  server: null as http.Server | null,
  streams: [] as http.ServerResponse[],
  acks: [] as { id: string; state: string; reason?: string }[],
  lastEventIds: [] as (string | undefined)[],
  // Hub can't say who this Den's person is while Den starts.
  whoamiDown: true,
  whoamiCalls: 0,
};

function push(d: Record<string, unknown>): void {
  for (const r of hub.streams)
    r.write(`id: ${d.id}\nevent: delivery\ndata: ${JSON.stringify(d)}\n\n`);
}

const delivery = (
  id: string,
  agent: string,
  body: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  agent,
  project: "north",
  thread: {
    kind: "comment",
    id: `th_${id}`,
    url: `${hub.url}/c/acme-co/a/doc#th_${id}`,
    artifact: "Pricing page",
  },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body,
  created_at: "2026-11-13T09:00:00Z",
  ...extra,
});

let s: AgentsPageServer;
let tokenDir = "";

beforeAll(async () => {
  hub.server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"error":"unauthorized"}');
    }
    if (u.pathname === "/connect/whoami") {
      hub.whoamiCalls++;
      if (hub.whoamiDown) {
        res.writeHead(503, { "content-type": "application/json" });
        return res.end('{"error":"unavailable"}');
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({
          install: "den on test-box",
          role: "member",
          login: "pat",
          person: { id: "u_me" },
          company: { slug: "acme-co", name: "Acme" },
        }),
      );
    }
    if (u.pathname === "/api/installs/self/deliveries/stream") {
      hub.lastEventIds.push(req.headers["last-event-id"] as string | undefined);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      res.write(": hello\n\n");
      hub.streams.push(res);
      req.on("close", () => {
        hub.streams = hub.streams.filter((x) => x !== res);
      });
      return;
    }
    const ack = /^\/api\/installs\/self\/deliveries\/([^/]+)\/ack$/.exec(
      u.pathname,
    );
    if (ack && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const b = JSON.parse(raw) as { state: string; reason?: string };
        hub.acks.push({ id: decodeURIComponent(ack[1]), ...b });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }
    // H5 sync and anything else: answered plainly.
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not_found"}');
  });
  await new Promise<void>((r) =>
    hub.server!.listen(0, "127.0.0.1", () => {
      hub.url = `http://127.0.0.1:${(hub.server!.address() as AddressInfo).port}`;
      r();
    }),
  );
  tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-hubappr-"));
  const tokenFile = path.join(tokenDir, "hub-token");
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  s = await startAgentsPageServer({
    userYml:
      `hub:\n  url: ${hub.url}\n  token: "file:${tokenFile}"\n` +
      "  delivery_heartbeat_seconds: 5\n  delivery_poll_seconds: 5\n",
  });
  for (let i = 0; i < 100 && !hub.streams.length; i++)
    await new Promise((r) => setTimeout(r, 100));
  // Den asked while Hub was down; Hub answers from now on.
  expect(hub.whoamiCalls).toBeGreaterThan(0);
  hub.whoamiDown = false;
}, 90_000);

afterAll(async () => {
  await s?.stop();
  for (const r of hub.streams) r.end();
  hub.server?.closeAllConnections();
  await new Promise<void>((r) =>
    hub.server ? hub.server.close(() => r()) : r(),
  );
  fs.rmSync(tokenDir, { recursive: true, force: true });
});

let agentToken = "";

async function call(
  method: string,
  p: string,
  body?: unknown,
  as: "person" | "agent" = "person",
) {
  const r = await fetch(`${s.base}${p}`, {
    method,
    headers: {
      ...(as === "person"
        ? denAuth(s.stateDir)
        : { authorization: `Bearer ${agentToken}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: r.status,
    json: (await r.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

async function until(f: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const asks = async () =>
  (
    ((await call("GET", "/api/notifications")).json.waiting ?? []) as {
      agent: string;
      why: string;
    }[]
  ).filter((w) => w.agent === "planner" && w.why === "asked");

const acked = (id: string) => hub.acks.some((a) => a.id === id);

describe("P0-D2 on the real server", () => {
  it("a plain comment leaves the question; the owner's approval of that doc clears it on arrival", async () => {
    const start = await call("POST", "/api/workspaces/north/agents", {
      persona: "planner",
    });
    expect(start.status).toBe(200);
    agentToken = actorTokenOf(s.made.at(-1)!.opts.env) ?? "";
    expect(agentToken).toBeTruthy();
    const link = `${hub.url}/c/acme-co/a/doc#th_ap-1`;
    const ended = await call(
      "POST",
      "/api/agents/self/attention",
      attentionOf({
        session_id: "0b7c2c3e-1111-4222-8333-944445555777",
        transcript_path: "/nonexistent/den-d2/t.jsonl",
        cwd: "/nonexistent/den-d2",
        permission_mode: "default",
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: `Saved v2.\n\n1. Do you approve the doc at ${link}?`,
      }),
      "agent",
    );
    expect(ended.status).toBe(200);
    expect(await asks()).toHaveLength(1);
    // Someone else's comment on the doc: Den takes it (an ack), the question stays.
    push(
      delivery("ap-0", "planner", "Nice.", {
        author: {
          id: "u_sam",
          login: "sam",
          name: "Sam Example",
          kind: "person",
          verified: "hub_session",
        },
        thread: {
          kind: "comment",
          id: "th_ap-1",
          url: link,
          artifact: "Pricing page",
        },
      }),
    );
    await until(async () => acked("ap-0"));
    expect(await asks()).toHaveLength(1);
    // The owner approves it: the question goes, though the agent is busy.
    push(
      delivery("ap-1", "planner", "", {
        kind: "approve",
        version: 2,
        thread: {
          kind: "decision",
          id: "th_ap-1",
          url: link,
          artifact: "Pricing page",
        },
      }),
    );
    await until(async () => (await asks()).length === 0);
  }, 60_000);
});
