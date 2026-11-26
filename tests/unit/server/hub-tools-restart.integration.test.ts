/**
 * Issue 193, reopened: Claude Code reads its MCP tool list once, at launch.
 * Hub adds a tool while an idle den-claude agent runs (the scripted PTY:
 * no real claude). Den restarts it on the same conversation (--resume
 * <its token>), types nothing before that, and its new launch reaches Hub
 * through Den's /hub/mcp proxy, whose tools/list has the new tool. Then,
 * and only then, the note says its tool list has Hub's current tools.
 * Invented names.
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
import { runtimeArgs } from "../helpers/unwrap-sandbox.js";

const TOKEN = "hubi_TESTONLY_tools_restart_5c2e";

const tool = (name: string, props: string[], required: string[]) => ({
  name,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])),
    required,
  },
});
const A = [tool("hub_search", ["q"], ["q"])];
const AS = [...A, tool("hub_artifact_status", ["id"], ["id"])];

const hub = {
  url: "",
  server: null as http.Server | null,
  tools: A as unknown[],
};

let s: AgentsPageServer;
let tokenDir = "";

beforeAll(async () => {
  hub.server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end('{"error":"unauthorized"}');
    }
    if (u.pathname === "/mcp" && req.method === "POST") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const m = JSON.parse(raw) as { id?: number; method: string };
        if (m.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        const result =
          m.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
            : { tools: hub.tools };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not_found"}');
  });
  await new Promise<void>((r) =>
    hub.server!.listen(0, "127.0.0.1", () => {
      hub.url = `http://127.0.0.1:${(hub.server!.address() as AddressInfo).port}`;
      r();
    }),
  );
  tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-hubtok-"));
  const tokenFile = path.join(tokenDir, "hub-token");
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  s = await startAgentsPageServer({
    userYml:
      `hub:\n  url: ${hub.url}\n  token: "file:${tokenFile}"\n` +
      "  tools_check_seconds: 5\n",
  });
}, 90_000);

afterAll(async () => {
  await s?.stop();
  hub.server?.closeAllConnections();
  await new Promise<void>((r) =>
    hub.server ? hub.server.close(() => r()) : r(),
  );
  fs.rmSync(tokenDir, { recursive: true, force: true });
});

async function call(method: string, p: string, body?: unknown) {
  const r = await fetch(`${s.base}${p}`, {
    method,
    headers: {
      ...denAuth(s.stateDir),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: r.status,
    json: (await r.json()) as Record<string, unknown>,
  };
}

async function until(f: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

const seen = (): Record<string, { conv: string; hash: string }> => {
  try {
    return (
      JSON.parse(
        fs.readFileSync(
          path.join(s.stateDir, "hub", "tools-seen.json"),
          "utf8",
        ),
      ) as { agents: Record<string, { conv: string; hash: string }> }
    ).agents;
  } catch {
    return {};
  }
};
const typed = (i: number) => Buffer.concat(s.made[i].writes).toString();
const notes = (i: number) => typed(i).split("Hub's tools changed").length - 1;

/** Its conversation's transcript: a turn that ended (so after-turn can tell). */
function endedTurn(token: string, cwd: string): void {
  const dir = path.join(s.tmp, "home", ".claude", "projects", "-north");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd, message: { content: "Plan it" } },
      {
        type: "assistant",
        message: {
          model: "opus",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Planned." }],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(file, t, t);
}

describe("issue 193 reopened: Hub adds a tool while an idle Claude Code agent runs", () => {
  it("restarted with --resume on the same conversation, its proxy lists the new tool, nothing typed before", async () => {
    const start = await call("POST", "/api/workspaces/north/agents", {
      persona: "planner",
    });
    expect(start.status).toBe(200);
    s.made[0].emit("> ");
    await until(() => !!seen().planner);
    const conv = seen().planner.conv;
    const token = conv.replace(/^den-claude /, "");
    const first = s.made.length - 1;
    endedTurn(token, s.made[first].opts.cwd);

    // Hub adds hub_artifact_status; the agent waits at its prompt.
    hub.tools = AS;
    await until(() => s.made[first].signals.length > 0, 30_000);
    // Nothing claimed the tool to the old launch.
    expect(notes(first)).toBe(0);
    // Its row says Den is restarting it to load Hub's tools.
    const during = (await call("GET", "/api/sessions")).json as {
      sessions: { agent?: string; toolsRestarting?: boolean }[];
    };
    expect(
      during.sessions.find((x) => x.agent === "planner")?.toolsRestarting,
    ).toBe(true);
    s.made[first].exit(143);
    await until(() => s.made.length > first + 1, 30_000);
    const next = s.made.length - 1;
    // …and stops saying so once it has restarted.
    for (let i = 0; ; i++) {
      const after = JSON.stringify((await call("GET", "/api/sessions")).json);
      if (!after.includes('"toolsRestarting":true')) break;
      if (i > 300) throw new Error("row still says restarting");
      await new Promise((r) => setTimeout(r, 100));
    }
    const args = runtimeArgs(s.made[next]);
    expect(args.slice(0, 2)).toEqual(["--resume", token]);
    expect(seen().planner.conv).toBe(conv);

    // Its MCP config points at Den's /hub/mcp proxy; through it, the new
    // tool is in tools/list.
    const cfgFile = args[args.indexOf("--mcp-config") + 1];
    const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8")) as {
      mcpServers: Record<string, { url?: string }>;
    };
    const hubEntry = Object.values(cfg.mcpServers).find((x) => x.url);
    expect(hubEntry?.url).toMatch(/\/hub\/mcp$/);
    const env = s.made[next].opts.env;
    const agentToken = env.DEN_ACTOR_TOKEN_FILE
      ? fs.readFileSync(env.DEN_ACTOR_TOKEN_FILE, "utf8").trim()
      : env.DEN_ACTOR_TOKEN;
    expect(agentToken).toBeTruthy();
    const r = await fetch(`${s.base}/hub/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(200);
    const listed = (await r.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(listed.result.tools.map((t) => t.name)).toContain(
      "hub_artifact_status",
    );

    // At its prompt on the new launch: the note, now true, once.
    s.made[next].emit("> ");
    await until(() => notes(next) > 0, 30_000);
    expect(typed(next)).toContain(
      "Hub's tools changed since this conversation started: new tool hub_artifact_status. Your tool list has Hub's current tools now.",
    );
    await new Promise((res) => setTimeout(res, 7000));
    expect(notes(next)).toBe(1);
    expect(s.made.length).toBe(next + 1); // no second restart

    // The audit says Den did it, on the same conversation.
    const audit = fs
      .readdirSync(s.stateDir, { recursive: true })
      .map(String)
      .filter((f) => /audit.*\.jsonl$/.test(f))
      .map((f) => fs.readFileSync(path.join(s.stateDir, f), "utf8"))
      .join("");
    expect(audit).toContain(
      "restart planner in north (at its next idle), same conversation, to load Hub's new tools, by Den itself",
    );
  }, 120_000);
});
