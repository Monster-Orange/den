/**
 * Two labels that read wrong in 0.4.5:
 *  - a Linked devices line said "signed in with approved with a code";
 *  - an agent's refusal named "the lock", which 0.4.4 removed (the admin
 *    password is asked for only when sudo runs).
 */
import { describe, expect, it } from "@jest/globals";
import { deviceLine } from "../../../src/ui/server/public/settings-registry.js";
import {
  agentRefusal,
  type AgentPrincipal,
} from "../../../src/ui/server/request-guard.js";

const now = Date.now();
const base = { name: "Chrome on macOS", createdAt: now, lastSeenAt: now };

describe("Linked devices: how a device signed in", () => {
  it("reads as a phrase for each way in", () => {
    const d = (via: string, login?: string) =>
      deviceLine({ ...base, via, login }, now).detail.split(" · ")[0];
    expect(d("github", "octo")).toBe("signed in with GitHub (@octo)");
    expect(d("code")).toBe("approved with a code");
    expect(d("link")).toBe("signed in with a one-time link");
    // 0.4.12: the install's setup link (?claim=).
    expect(d("claim")).toBe("claimed with a setup link");
  });
});

describe("an agent's refusal names the admin password, not a lock", () => {
  it("says what is a person's", () => {
    const p: AgentPrincipal = {
      kind: "agent",
      actor: "agent:planner",
      workspace: "north",
      grants: [],
      session: { name: "planner" },
    };
    const msg = agentRefusal(p, "POST", "/api/web/approve", "mutate" as never);
    expect(msg).toBe(
      "agent:planner can't use /api/web/approve: signing in, web.secret and the admin password are a person's.",
    );
    expect(msg).not.toMatch(/lock/);
  });
});
