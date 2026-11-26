/**
 * Issue 191: on a box run, a "127.0.0.1:*" base URL covers only the run's
 * own ports (issue 991). startFrameServer starts Den as a child on a port
 * freePort bound and closed, so the port counts only once the helper
 * claims it, as startDenServer does. Unclaimed, a box run's browser is
 * refused every page of it (net::ERR_BLOCKED_BY_CLIENT).
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { ownPorts } from "@monster-orange/den/pw-guard";
import {
  type FrameServer,
  removeFrameTmp,
  startFrameServer,
} from "./helpers/error-frame-server.js";

let s: FrameServer | null = null;

afterAll(async () => {
  await s?.stop();
  removeFrameTmp(s);
});

describe("issue 191: the frame server's port is the run's own", () => {
  it("counts once the server answers, and again after a restart", async () => {
    s = await startFrameServer({ prefix: "den-frame-own-" });
    expect(ownPorts().has(s.port)).toBe(true);
    await s.stop();
    await s.start();
    expect(ownPorts().has(s.port)).toBe(true);
  }, 90_000);
});
