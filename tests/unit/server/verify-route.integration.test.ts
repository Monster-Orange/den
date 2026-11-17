/**
 * Issue 209, T2: Verify's page is /verify. /tests answers a 301 there
 * (people bookmarked it), and the older test kinds' page is /test-runs
 * while they retire. The real server, in a throwaway distribution.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";

let s: FrameServer | null = null;
const HTML = { accept: "text/html" };

beforeAll(async () => {
  s = await startFrameServer({ prefix: "den-verify-route-" });
}, 40_000);

afterAll(async () => {
  await s?.stop();
  removeFrameTmp(s);
});

describe("issue 209, T2: the Verify page's address", () => {
  it("/tests is a 301 to /verify", async () => {
    const r = await s!.req("GET", "/tests", { headers: HTML });
    expect(r.status).toBe(301);
    expect(r.headers.location).toBe("/verify");
  });

  it("/verify serves the Verify page", async () => {
    const r = await s!.req("GET", "/verify", { headers: HTML });
    expect(r.status).toBe(200);
    expect(r.body).toContain('data-page="verify"');
    expect(r.body).toContain("/verify-page.js");
  });

  it("/test-runs serves the older test kinds' page", async () => {
    const r = await s!.req("GET", "/test-runs", { headers: HTML });
    expect(r.status).toBe(200);
    expect(r.body).toContain('data-page="tests"');
  });

  it("/api/verify/overview answers the focused project's checks", async () => {
    const r = await s!.req("GET", "/api/verify/overview");
    // A throwaway distribution may have no project in focus: then it
    // asks for one (400), and never a 404 (the route exists).
    expect([200, 400]).toContain(r.status);
    expect(JSON.parse(r.body)).toHaveProperty("ok");
  });
});
