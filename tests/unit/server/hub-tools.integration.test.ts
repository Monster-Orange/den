/**
 * Issue 193, end to end on this machine: the real server with a hub block
 * (a token file, 0600), a fake Hub on 127.0.0.1 whose /mcp serves
 * tools/list, and agents on the scripted PTY. An agent's conversation
 * began on Hub's old list; Hub adds a parameter; Den resumes the same
 * conversation and, once the agent waits at its prompt, types one note
 * saying what changed. Never twice, not after another resume. A new
 * agent (a new conversation) gets no note. Invented names.
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

const TOKEN = "hubi_TESTONLY_tools_93a1";

const tool = (name: string, props: string[], required: string[]) => ({
  name,
  inputSchema: {
    type: "object",
    properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])),
    required,
  },
});
const OLD = [
  tool(
    "hub_artifact_upload_part",
    ["upload_id", "text"],
    ["upload_id", "text"],
  ),
];
const NEW = [
  tool(
    "hub_artifact_upload_part",
    ["upload_id", "text", "base64"],
    ["upload_id"],
  ),
];
const NOTE =
  "Hub's tools changed since this conversation started: hub_artifact_upload_part: new parameters base64; text no longer required. You can call them with the new parameters now.";

const hub = {
  url: "",
  server: null as http.Server | null,
  tools: OLD as unknown[],
  lists: 0,
};

let s: AgentsPageServer;
let tokenDir = "";
const seenFile = () => path.join(s.stateDir, "hub", "tools-seen.json");
const seen = (): Record<string, { conv: string; hash: string }> => {
  try {
    return (
      JSON.parse(fs.readFileSync(seenFile(), "utf8")) as {
        agents: Record<string, { conv: string; hash: string }>;
      }
    ).agents;
  } catch {
    return {};
  }
};

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
        if (m.method === "tools/list") hub.lists++;
        const result =
          m.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
            : { tools: hub.tools };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
      });
      return;
    }
    // whoami, deliveries, H5 sync: answered plainly.
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

const typed = (i: number) => Buffer.concat(s.made[i].writes).toString();
const notes = (i: number) => typed(i).split("Hub's tools changed").length - 1;

describe("issue 193: a resumed agent hears what changed in Hub's tools", () => {
  it("started on the old list; Hub adds base64; resumed, it is told once", async () => {
    const start = await call("POST", "/api/workspaces/north/agents", {
      persona: "planner",
    });
    expect(start.status).toBe(200);
    s.made[0].emit("> ");
    await until(() => !!seen().planner);
    const conv = seen().planner.conv;
    expect(conv).toMatch(/^den-claude /);
    expect(fs.statSync(seenFile()).mode & 0o777).toBe(0o600);
    expect(notes(0)).toBe(0);

    hub.tools = NEW;
    await call("POST", "/api/workspaces/north/agents/planner/stop");
    s.made[0].exit(143);
    await new Promise((r) => setTimeout(r, 500));
    const resumed = await call(
      "POST",
      "/api/workspaces/north/agents/planner/resume",
    );
    expect(resumed.status).toBe(200);
    const pty = s.made.length - 1;
    // Busy (output keeps coming): nothing typed.
    const spin = setInterval(() => s.made[pty].emit("."), 200);
    await new Promise((r) => setTimeout(r, 6000));
    clearInterval(spin);
    expect(notes(pty)).toBe(0);
    // At its prompt: the note, once.
    s.made[pty].emit("> ");
    await until(() => notes(pty) > 0, 30_000);
    expect(typed(pty)).toContain(NOTE);
    expect(seen().planner.conv).toBe(conv);
    await new Promise((r) => setTimeout(r, 7000));
    expect(notes(pty)).toBe(1);

    // Resumed again, the same conversation: never again.
    await call("POST", "/api/workspaces/north/agents/planner/stop");
    s.made[pty].exit(143);
    await new Promise((r) => setTimeout(r, 500));
    expect(
      (await call("POST", "/api/workspaces/north/agents/planner/resume"))
        .status,
    ).toBe(200);
    const again = s.made.length - 1;
    s.made[again].emit("> ");
    await new Promise((r) => setTimeout(r, 7000));
    expect(notes(again)).toBe(0);
  }, 90_000);

  it("a new agent (a new conversation) records the current list: no note", async () => {
    const start = await call("POST", "/api/workspaces/north/agents", {
      persona: "reviewer",
    });
    expect(start.status).toBe(200);
    const i = s.made.length - 1;
    s.made[i].emit("> ");
    await until(() => !!seen().reviewer);
    await new Promise((r) => setTimeout(r, 4000));
    expect(notes(i)).toBe(0);
  }, 60_000);
});
