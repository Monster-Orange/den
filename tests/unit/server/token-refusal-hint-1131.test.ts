/**
 * Issue 1131, item 3: when Den refuses an agent's token as not from its
 * own processes, the answer the agent sees (in its pane, as the tool's
 * error) says what to do: try the call again (a busy machine can make
 * Den miss the agent's own process), and run doctor if it keeps
 * happening. The token is never in it.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import {
  checkRequest,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";

const PORT = 4131;
const TOKEN = "den_at_TESTONLY_1131_hint";

function ctx(): GuardContext {
  return {
    port: PORT,
    loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
    edgeHosts: () => [],
    verifyBearer: () => "elsewhere",
    csrfToken: "server-start-csrf-token-aaaaaaaaaaaaaaaaaaaaaa",
    session: () => null,
  };
}

function refused() {
  const req = {
    method: "POST",
    url: "/hub/mcp",
    headers: {
      host: `127.0.0.1:${PORT}`,
      authorization: `Bearer ${TOKEN}`,
    },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;
  return checkRequest(req, ctx());
}

describe("issue 1131: an agent's refused call says what to do", () => {
  it("is still refused (403 agent_token_elsewhere)", () => {
    const g = refused();
    expect(g.ok).toBe(false);
    if (g.ok) return;
    expect(g.status).toBe(403);
    expect(g.code).toBe("agent_token_elsewhere");
  });

  it("tells the agent to try the call again, and to run doctor if it keeps happening", () => {
    const g = refused();
    if (g.ok) throw new Error("not refused");
    expect(g.error).toMatch(/try the call again/i);
    expect(g.error).toMatch(/doctor/);
  });

  it("never carries the token", () => {
    const g = refused();
    if (g.ok) throw new Error("not refused");
    expect(g.error).not.toContain(TOKEN);
  });
});
