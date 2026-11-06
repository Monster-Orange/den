/**
 * `web up` under an invalid config (0.3.0-dev.42, a consumer's dev.41
 * finding): the server starts and serves the 422 page, Settings and Logs,
 * so its readiness check must call it ready. It asked /api/health (422 by
 * design under an invalid config) and /index.html (the 422 page), and
 * `web up` reported "web did not become ready" with the server running.
 *
 * The real server (helpers/error-frame-server.ts). Invented orgs only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { isDenWebRunning } from "../../../src/ui/cli/web-command.js";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "../server/helpers/error-frame-server.js";

let s: FrameServer | null = null;

beforeAll(async () => {
  s = await startFrameServer({
    prefix: "den-web-ready-",
    denConfig: [
      "environments: [local]",
      "orgs:",
      "  acme:",
      "    sources: not-a-list",
      "",
    ].join("\n"),
  });
}, 60_000);

afterAll(async () => {
  await s?.stop();
  removeFrameTmp(s);
});

describe("web readiness with an invalid config", () => {
  it("the server answers 422 on /api/health by design", async () => {
    expect((await s!.req("GET", "/api/health")).status).toBe(422);
  });

  it("is ready: its own server, up and serving the shell", async () => {
    expect(await isDenWebRunning(s!.port)).toBe(true);
  });
});
