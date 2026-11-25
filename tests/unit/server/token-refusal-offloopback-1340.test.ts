/**
 * Issue 1340 follow-up: an agent's token that came over a connection off
 * this machine's loopback (a bound LAN or mesh address, a proxy on another
 * address) is refused as "elsewhere" without Den ever looking for its
 * process. Its audit detail says so, with the address, instead of "outside
 * the agent's own processes (pid ?)", which reads as a placed process.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import * as tb from "../../../src/ui/server/token-binding.js";

const ROOT = 4242;
const reqFrom = (remoteAddress: string | undefined) =>
  ({
    socket: { remoteAddress },
    headers: {},
    method: "POST",
    url: "/api/agents/self/attention?x=1",
  }) as unknown as http.IncomingMessage;

describe("issue 1340: a refusal off loopback says where it came from", () => {
  it("off loopback: the detail names the address, not the agent's processes", () => {
    const req = reqFrom("192.168.64.7");
    expect(tb.tokenCaller(req, ROOT)).toBe("elsewhere");
    const d = tb.requestRefusalDetail(req, {
      actor: "agent:planner",
      from: "elsewhere",
      root: ROOT,
    });
    expect(d).toBe(
      `agent:planner's token from a connection off this machine's loopback (address 192.168.64.7, agent pid ${ROOT}): POST /api/agents/self/attention`,
    );
    expect(d).not.toContain("outside the agent's own processes");
  });

  it("an IPv6 address and an unreadable one", () => {
    const at = (a: string | undefined) =>
      tb.requestRefusalDetail(reqFrom(a), {
        actor: "agent:planner",
        from: "elsewhere",
        root: ROOT,
      });
    expect(at("fd00::12")).toContain("(address fd00::12,");
    expect(at(undefined)).toContain("(address unknown,");
    expect(at("not an address\nx")).toContain("(address unknown,");
  });

  it("on loopback, a placed caller outside the agent keeps its words and pid", () => {
    expect(
      tb.refusalDetail({
        actor: "agent:planner",
        from: "elsewhere",
        caller: 777,
        root: ROOT,
        method: "POST",
        path: "/api/agents/self/attention",
      }),
    ).toBe(
      `agent:planner's token from outside the agent's own processes (pid 777, agent pid ${ROOT}): POST /api/agents/self/attention`,
    );
  });
});
