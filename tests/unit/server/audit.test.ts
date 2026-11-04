/**
 * Agent audit: the MCP server sends who it is as headers; the web server
 * records each action with actor "agent", the client's self-reported name
 * and version (a label, never authorization) and the MCP pid + session.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  AUDIT_HEADERS,
  actorFromHeaders,
  actorLabel,
  agentAuditHeaders,
} from "../../../src/shared/agent-actor.js";
import {
  recentActions,
  recordAction,
  setAuditSink,
} from "../../../src/ui/server/audit.js";

const info = {
  client: "acme-client",
  clientVersion: "1.4.0",
  mcpPid: 4242,
  session: "0b9f6c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f",
};

afterEach(() => setAuditSink(null));

describe("agent audit headers", () => {
  it("round-trip: the client's headers become an agent actor on the server", () => {
    const headers = agentAuditHeaders(info);
    expect(headers[AUDIT_HEADERS.actor]).toBe("agent");
    // Node lower-cases incoming header names.
    const lower = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(actorFromHeaders(lower)).toEqual({ kind: "agent", ...info });
  });

  it("no actor header: a person in the UI (null)", () => {
    expect(actorFromHeaders({})).toBeNull();
    expect(actorFromHeaders({ "x-den-mcp-client": "acme" })).toBeNull();
  });

  it("self-reported values are sanitised before they reach a log line", () => {
    const a = actorFromHeaders({
      [AUDIT_HEADERS.actor]: "agent",
      [AUDIT_HEADERS.client]: "evil\u001b[31m\nname" + "x".repeat(200),
      [AUDIT_HEADERS.clientVersion]: "1.0\r\n",
      [AUDIT_HEADERS.pid]: "12; rm",
      [AUDIT_HEADERS.session]: "abc def/../",
    });
    expect(a).not.toBeNull();
    expect([...a!.client].every((ch) => ch.charCodeAt(0) >= 0x20)).toBe(true);
    expect(a!.client.length).toBeLessThanOrEqual(64);
    expect(a!.clientVersion).toBe("1.0");
    expect(a!.mcpPid).toBeNull();
    expect(a!.session).toBe("abcdef");
  });

  it("labels an agent with every field", () => {
    expect(actorLabel({ kind: "agent", ...info })).toBe(
      `agent acme-client 1.4.0 (mcp pid 4242, session ${info.session})`,
    );
  });
});

describe("recordAction", () => {
  it("records an agent action with all audit fields and tells the sink", () => {
    const lines: string[] = [];
    setAuditSink((line) => lines.push(line));
    const entry = recordAction(
      { kind: "agent", ...info },
      { verb: "exec", detail: "shop/api up (local) [abc123]" },
    );
    expect(entry).toMatchObject({
      actor: "agent",
      client: "acme-client",
      clientVersion: "1.4.0",
      mcpPid: 4242,
      session: info.session,
      verb: "exec",
      detail: "shop/api up (local) [abc123]",
    });
    expect(lines).toEqual([
      `▶ exec shop/api up (local) [abc123] · by agent acme-client 1.4.0 (mcp pid 4242, session ${info.session})`,
    ]);
    expect(recentActions().at(-1)).toEqual(entry);
  });

  it("a UI action keeps today's line and is recorded as the user", () => {
    const lines: string[] = [];
    setAuditSink((line) => lines.push(line));
    const entry = recordAction(null, { verb: "run", detail: "smoke/local" });
    expect(entry.actor).toBe("user");
    expect(lines).toEqual(["▶ run smoke/local"]);
  });
});
