/**
 * Issue 193, 0.4.57: Den restarts an idle Claude Code agent to load a tool
 * Hub added, and its session takes longer to end than stop's own wait
 * (5 s). Den waits for the stop to finish, then resumes the same
 * conversation (--resume <its token>): never an agent left stopped and
 * marked as tried. One restart, one audit row.
 *
 * The scripted PTY: no real claude. Invented names.
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

const TOKEN = "hubi_TESTONLY_tools_slow_stop_8d1a";

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

const auditRows = (): string[] =>
  fs
    .readdirSync(s.stateDir, { recursive: true })
    .map(String)
    .filter((f) => /audit.*\.jsonl$/.test(f))
    .flatMap((f) =>
      fs.readFileSync(path.join(s.stateDir, f), "utf8").split("\n"),
    )
    .filter((l) => l.includes("to load Hub's new tools"));

describe("issue 193, 0.4.57: a slow stop during Den's restart for Hub's tools", () => {
  it("waits for the stop, then resumes the same conversation; one restart audited", async () => {
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

    hub.tools = AS;
    await until(() => s.made[first].signals.length > 0, 30_000);
    // Its session ends well after stop's own 5 s wait.
    await new Promise((r) => setTimeout(r, 7_000));
    s.made[first].exit(143);

    await until(() => s.made.length > first + 1, 30_000);
    const next = s.made.length - 1;
    expect(runtimeArgs(s.made[next]).slice(0, 2)).toEqual(["--resume", token]);
    expect(seen().planner.conv).toBe(conv);
    const rows = (await call("GET", "/api/sessions")).json as {
      sessions: { agent?: string; state?: string }[];
    };
    expect(rows.sessions.find((x) => x.agent === "planner")?.state).not.toMatch(
      /stopped/,
    );

    await new Promise((r) => setTimeout(r, 3_000));
    expect(s.made.length).toBe(next + 1);
    const audited = auditRows();
    expect(audited).toHaveLength(1);
    expect(audited[0]).not.toMatch(/"refused"/);
  }, 120_000);
});
