/**
 * #384: an agent's MCP server is a child of its session, started with it.
 * When Den updates itself (npm replaces the engine on disk) and restarts
 * its web server, the agent keeps its session, so that MCP server keeps
 * running the old Den's tools code: after 0.4.63 → 0.4.64, the server
 * agent's release_status had no denUpdate, because its tools were 0.4.63's.
 *
 * The MCP server compares the engine it loaded with the one on disk (MD-2's
 * engineWatch, the web server's own check). When they differ, every answer
 * says so in one more line. #390: an agent is told Den restarts it at its
 * next idle to load the new Den (server_agent.refresh_agents, default on);
 * with that off, or for any other client, the line gives the versions only.
 * It never asks the person to do anything.
 *
 * The engine here is a temp folder (DEN_ENGINE_ROOT); the web server is a
 * fake API; the server agent's real scope (--workspace den-server --actor
 * agent:server) is used.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createDenMcpServer } from "../../../src/ui/mcp/server.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";
import { SERVER_SCOPE } from "../../../src/shared/agents/server-agent.js";

const cfg: ResolvedMcpConfig = {
  actions: [],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
};

const UPDATE = {
  state: "good",
  from: "0.4.63",
  to: "0.4.64",
  at: "2026-11-17T19:34:40.000Z",
  doctor: { at: "2026-11-17T19:34:38.000Z", lines: [] },
};

const api: DenApi = {
  baseUrl: "http://localhost:1",
  async get(p) {
    if (p === "/api/server-agent/update") return { update: UPDATE };
    if (p === "/api/release/runs") return { runs: [] };
    return {};
  },
  async stream() {
    return { events: [], lines: [], ended: "done", exitCode: 0 };
  },
};

let tmp = "";
let saved: string | undefined;
const pkg = () => path.join(tmp, "package.json");
const install = (version: string) =>
  fs.writeFileSync(
    pkg(),
    JSON.stringify({ name: "@example/den", version }, null, 2),
  );

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-384-"));
  saved = process.env.DEN_ENGINE_ROOT;
  process.env.DEN_ENGINE_ROOT = tmp;
  install("0.4.63");
});
afterEach(() => {
  if (saved === undefined) delete process.env.DEN_ENGINE_ROOT;
  else process.env.DEN_ENGINE_ROOT = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Start the MCP server now (its tools load), then run `after`, then call. */
async function call(
  scope: { workspace: string; actor: string } | undefined,
  after: () => void,
  refreshOn = true,
): Promise<{ isError?: boolean; content: { text: string }[] }> {
  const server = createDenMcpServer({
    cfg,
    baseUrl: api.baseUrl,
    cli: "acme",
    api,
    ...(scope ? { scope } : {}),
    log: () => {},
    refreshOn: () => refreshOn,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "acme-test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    after();
    return (await client.callTool({
      name: "release_status",
      arguments: {},
    })) as { isError?: boolean; content: { text: string }[] };
  } finally {
    await client.close();
  }
}

const SERVER_AGENT = { workspace: SERVER_SCOPE, actor: "agent:server" };

describe("#384: tools that started before Den updated itself say so", () => {
  it("the server agent, after Den updated itself under its tools: the answer says its tools are the old Den's, and that Den restarts it at its next idle", async () => {
    const r = await call(SERVER_AGENT, () => install("0.4.64"));
    expect(r.isError).toBeFalsy();
    const all = r.content.map((c) => c.text).join("\n");
    expect(all).toContain(
      "Den was updated to 0.4.64 after these tools started on 0.4.63; Den restarts you at your next idle to load 0.4.64.",
    );
    expect(all).not.toMatch(/person/i);
    // The answer itself is still the tools' JSON, first and whole.
    expect(JSON.parse(r.content[0].text)).toHaveProperty("denUpdate");
  });

  it("nothing changed on disk: the answer is the JSON alone", async () => {
    const r = await call(SERVER_AGENT, () => {});
    expect(r.content).toHaveLength(1);
    expect(JSON.parse(r.content[0].text).denUpdate).toEqual(UPDATE);
  });

  it("server_agent.refresh_agents off: the versions only, and no one is asked to do anything", async () => {
    const r = await call(SERVER_AGENT, () => install("0.4.64"), false);
    expect(r.content).toHaveLength(2);
    expect(r.content[1].text).toBe(
      "Den was updated to 0.4.64 after these tools started on 0.4.63.",
    );
  });

  it("a person's own MCP client (no agent): the versions only", async () => {
    const r = await call(undefined, () => install("0.4.64"));
    expect(r.content[1].text).toBe(
      "Den was updated to 0.4.64 after these tools started on 0.4.63.",
    );
  });
});
