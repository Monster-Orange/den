import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import {
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";
import { denAuth } from "./helpers/den-auth.js";

let s: FrameServer | null = null;
const QUERY_TOKEN = "sk-query-token-1681";
const BODY_SECRET = "body-secret-1681";

beforeAll(async () => {
  s = await startFrameServer({ prefix: "den-slow-1681-" });
  const user = path.join(s.tmp, "dist", "config", "local", "user.yml");
  fs.mkdirSync(path.dirname(user), { recursive: true });
  fs.writeFileSync(
    user,
    "server_log:\n  slow_request_ms: 300\n  event_loop_lag_ms: 300\n",
  );
}, 60_000);

afterAll(async () => {
  await s?.stop();
});

const settle = () => new Promise((r) => setTimeout(r, 150));
const slowLines = () =>
  s!
    .log()
    .split("\n")
    .filter((l) => l.includes("slow request:"));
const lagLines = () =>
  s!
    .log()
    .split("\n")
    .filter((l) => l.includes("event loop blocked"));

describe("issue 1681: the server names a slow request and a blocked event loop", () => {
  it("a fast request logs no slow-request line", async () => {
    const r = await s!.req("GET", `/api/_den/slow?ms=5&token=${QUERY_TOKEN}`);
    expect(r.status).toBe(200);
    await settle();
    expect(slowLines()).toEqual([]);
  });

  it("a slow one logs one line: method, pattern, ms and caller", async () => {
    const r = await s!.req("GET", `/api/_den/slow?ms=600&token=${QUERY_TOKEN}`);
    expect(r.status).toBe(200);
    await settle();
    const lines = slowLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /slow request: GET \/api\/_den\/slow took (\d{3,}) ms \(unsigned\)$/,
    );
    expect(Number(/took (\d+) ms/.exec(lines[0])![1])).toBeGreaterThanOrEqual(
      550,
    );
  });

  it("never the query string or the body, anywhere in the log", async () => {
    const r = await s!.req(
      "POST",
      `/api/_den/slow?ms=600&token=${QUERY_TOKEN}`,
      {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret: BODY_SECRET }),
      },
    );
    expect(r.status).toBe(200);
    await settle();
    expect(
      slowLines().some((l) =>
        /slow request: POST \/api\/… took \d+ ms \(cli\)$/.test(l),
      ),
    ).toBe(true);
    expect(s!.log()).not.toContain(QUERY_TOKEN);
    expect(s!.log()).not.toContain(BODY_SECRET);
    expect(s!.log()).not.toContain("token=");
  });

  it("a client that leaves first is logged too, at the time it left", async () => {
    await new Promise<void>((done) => {
      const r = http.request({
        host: "localhost",
        port: s!.port,
        method: "DELETE",
        path: `/api/_den/slow?ms=3000&token=${QUERY_TOKEN}`,
        headers: denAuth(path.join(s!.tmp, "den-home")),
        agent: false,
      });
      r.on("error", () => done());
      r.end();
      setTimeout(() => {
        r.destroy();
        done();
      }, 700);
    });
    await settle();
    const left = slowLines().filter((l) => /slow request: DELETE /.test(l));
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(
      /DELETE \/api\/… took (\d+) ms \(cli, client left\)$/,
    );
    const ms = Number(/took (\d+) ms/.exec(left[0])![1]);
    expect(ms).toBeGreaterThanOrEqual(600);
    expect(ms).toBeLessThan(2500);
    await new Promise((r) => setTimeout(r, 2600));
    expect(
      slowLines().filter((l) => /slow request: DELETE /.test(l)),
    ).toHaveLength(1);
    expect(s!.log()).not.toContain(QUERY_TOKEN);
  });

  it("a short block logs no lag line; a long one logs one", async () => {
    fs.writeFileSync(
      path.join(s!.tmp, "dist", "config", "local", "user.yml"),
      "server_log:\n  slow_request_ms: 300\n  event_loop_lag_ms: 2000\n",
    );
    await s!.req("GET", "/api/_den/block?ms=20");
    await new Promise((r) => setTimeout(r, 1200));
    expect(lagLines()).toEqual([]);
    await s!.req("GET", "/api/_den/block?ms=3500");
    await new Promise((r) => setTimeout(r, 1200));
    const lines = lagLines();
    expect(lines).toHaveLength(1);
    const ms = Number(/blocked for (\d+) ms/.exec(lines[0])![1]);
    expect(ms).toBeGreaterThanOrEqual(3000);
  }, 20_000);
});
