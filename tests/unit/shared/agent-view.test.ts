/**
 * Issue 796: an agent's read-only view of its own Den. The pure parts:
 * the one-time link (once, in time, never a guessable shape), the view's
 * lifetime, and what a view may reach, by route class (never by page).
 */
import { describe, expect, it } from "@jest/globals";
import {
  AGENT_VIEW_LINK_TTL_MS,
  AGENT_VIEW_MINUTES,
  AGENT_VIEW_RANGE,
  AgentViewCodes,
  agentViewExpired,
  agentViewOffText,
  agentViewScopeRefusal,
} from "../../../src/shared/agent-view.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";

const AGENT = "agent:builder";
const who = { agent: AGENT, workspace: "north" };
const refusal = (method: string, p: string) =>
  agentViewScopeRefusal(method, p, routeClass(method, p), AGENT);

describe("the one-time link", () => {
  it("names the agent it was minted for, once", () => {
    const codes = new AgentViewCodes();
    const { code } = codes.mint(who);
    expect(codes.redeem(code)).toEqual(who);
    expect(codes.redeem(code)).toBeNull();
  });

  it("stops working after its time", () => {
    let t = 1_000_000;
    const codes = new AgentViewCodes(() => t);
    const { code, expiresAt } = codes.mint(who);
    expect(expiresAt).toBe(1_000_000 + AGENT_VIEW_LINK_TTL_MS);
    t += AGENT_VIEW_LINK_TTL_MS;
    expect(codes.redeem(code)).toBeNull();
  });

  it("a code it never minted, or a malformed one, names nobody", () => {
    const codes = new AgentViewCodes();
    codes.mint(who);
    expect(codes.redeem(`v1.${"A".repeat(43)}`)).toBeNull();
    expect(codes.redeem("")).toBeNull();
    expect(codes.redeem("../etc")).toBeNull();
  });
});

describe("clause 5: the view is short-lived", () => {
  it("lasts minutes by default, at most an hour", () => {
    expect(AGENT_VIEW_MINUTES).toBeLessThanOrEqual(15);
    expect(AGENT_VIEW_RANGE.max).toBeLessThanOrEqual(60);
    expect(agentViewExpired(0, AGENT_VIEW_MINUTES * 60_000 - 1, 10)).toBe(
      false,
    );
    expect(agentViewExpired(0, 10 * 60_000, 10)).toBe(true);
  });
});

describe("clause 2: viewing only, by route class", () => {
  it.each([
    ["GET", "/agents"],
    ["GET", "/settings"],
    ["GET", "/"],
    ["GET", "/shell.js"],
    ["GET", "/api/workspaces"],
    ["GET", "/api/settings"],
    ["GET", "/api/session"],
    ["POST", "/api/session/logout"],
  ])("%s %s is open", (m, p) => {
    expect(refusal(m, p)).toBeNull();
  });

  it.each([
    // No Allow or Deny.
    ["POST", "/api/approvals/a1/decide"],
    // No settings.
    ["POST", "/api/settings"],
    ["POST", "/api/scope"],
    // No agent start or stop.
    ["POST", "/api/workspaces/north/agents/builder/start"],
    ["POST", "/api/workspaces/north/agents/builder/stop"],
    ["POST", "/api/workspaces/north/agents/builder/resume"],
    // No typing into a terminal, nor the sessions that hold one.
    ["POST", "/api/sessions/s1/input"],
    ["GET", "/api/sessions/s1/io"],
    // Nothing that starts or streams something on a GET.
    ["GET", "/api/run"],
    // Hub, and who may sign in.
    ["GET", "/api/hub/status"],
    ["POST", "/api/hub/connect"],
    ["GET", "/api/web/sessions"],
    // Every other write method.
    ["DELETE", "/api/report/drafts/x"],
    ["PUT", "/api/anything"],
  ])("%s %s is refused, naming the agent", (m, p) => {
    expect(refusal(m, p)).toMatch(/agent:builder's view .* read-only/);
  });
});

describe("clause 4: off says so plainly", () => {
  it("names where it turns back on", () => {
    expect(agentViewOffText("acme")).toMatch(/off on this install/);
    expect(agentViewOffText("acme")).toMatch(/acme config web.agent_view/);
  });
});
