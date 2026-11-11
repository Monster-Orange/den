/**
 * D32: GET /api/sessions/helpers (the rail's running count) sits under
 * /api/sessions/ but is no session's route. The first cut sent it to the
 * terminal routes (404 "No such session route"), and an agent's token
 * would have been refused it as "another session". It is read-grade, the
 * list's, for a person and an agent alike; a session's own io stays
 * shell-grade and its own agent's only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  agentRefusal,
  type AgentPrincipal,
} from "../../../src/ui/server/request-guard.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";
import { SESSION_HELPERS_PATH } from "../../../src/ui/server/session-routes.js";

const agent: AgentPrincipal = {
  kind: "agent",
  actor: "agent:scout",
  workspace: "north",
  grants: [],
  session: { id: "s1", name: "acme-north:scout" },
};

describe("/api/sessions/helpers", () => {
  it("is the path the list's handler answers", () => {
    expect(SESSION_HELPERS_PATH).toBe("/api/sessions/helpers");
  });

  it("is read-grade, not a session's shell-grade route", () => {
    expect(routeClass("GET", SESSION_HELPERS_PATH)).toBe("readonly");
    expect(routeClass("GET", "/api/sessions/s1/io")).toBe("shell-grade");
  });

  it("an agent's token may read it; another session's io stays refused", () => {
    expect(
      agentRefusal(agent, "GET", SESSION_HELPERS_PATH, "readonly"),
    ).toBeNull();
    expect(
      agentRefusal(agent, "GET", "/api/sessions/s1/io", "shell-grade"),
    ).toBeNull();
    expect(
      agentRefusal(agent, "GET", "/api/sessions/s2/io", "shell-grade"),
    ).toBe("agent:scout can use its own session only, not s2.");
  });
});
