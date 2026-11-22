/**
 * Issue 565: who a report request comes from, as the report routes and the
 * held report match drafts by (`agent:<id>`, the bare agent id). An
 * agent's token gives its id; a claim that isn't an agent's own token is
 * still never the person; nothing at all is the person.
 */
import { describe, expect, it } from "@jest/globals";
import { reportAgentOf } from "../../../src/ui/server/report-routes.js";

describe("who a report comes from", () => {
  it("an agent's token: its bare id, the one its drafts are saved under", () => {
    expect(
      reportAgentOf(
        {
          kind: "agent",
          actor: "agent:be-dev",
          workspace: "north",
          grants: [],
          session: { name: "be-dev" },
        },
        null,
      ),
    ).toBe("be-dev");
  });

  it("a claim with no agent token (the fixture person): never the person, never an object", () => {
    const v = reportAgentOf(null, {
      kind: "agent",
      client: "fixture",
      clientVersion: "-",
      mcpPid: null,
      session: "",
      unverified: true,
    });
    expect(typeof v).toBe("string");
    expect(v).not.toMatch(/object/);
    expect(v).toBeTruthy();
  });

  it("nobody but the person: null", () => {
    expect(reportAgentOf(null, null)).toBeNull();
  });
});
