/**
 * #70: which callers an agent's token counts from. Only "ok" (a process
 * inside the agent's session) gets in; the server refuses "elsewhere" and
 * "unknown" alike (403 agent_token_elsewhere, index.ts verifyBearer). So a
 * lookup that fails is a refusal, never an allow.
 */
import { describe, expect, it } from "@jest/globals";
import type * as http from "http";
import { tokenCaller } from "../../../src/ui/server/token-binding.js";

let port = 40000;
const req = (remoteAddress = "127.0.0.1") =>
  ({
    socket: { remoteAddress, remotePort: port++ },
  }) as unknown as http.IncomingMessage;

describe("#70 tokenCaller", () => {
  it("inside the session: ok; outside it: elsewhere", () => {
    const peer = () => 400;
    expect(tokenCaller(req(), 200, { peer, descends: () => true })).toBe("ok");
    expect(tokenCaller(req(), 200, { peer, descends: () => false })).toBe(
      "elsewhere",
    );
  });

  it("a caller Den can't find, or no session pid: unknown (refused)", () => {
    const yes = () => true;
    expect(tokenCaller(req(), 200, { peer: () => null, descends: yes })).toBe(
      "unknown",
    );
    expect(tokenCaller(req(), null, { peer: () => 400, descends: yes })).toBe(
      "unknown",
    );
    expect(tokenCaller(req(), 0, { peer: () => 400, descends: yes })).toBe(
      "unknown",
    );
  });

  it("not on loopback (the edge, another machine): elsewhere, without a lookup", () => {
    let looked = false;
    const peer = () => ((looked = true), 400);
    expect(
      tokenCaller(req("10.0.0.5"), 200, { peer, descends: () => true }),
    ).toBe("elsewhere");
    expect(looked).toBe(false);
  });
});
