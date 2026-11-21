/**
 * Issue 395: POST /api/edge/up, Settings' Start the edge (Apply, when it
 * runs). A person's only: shell-grade (Origin and CSRF, never an agent's
 * token), and an agent's actor header is refused by the route itself. It
 * runs what `edge up` runs and answers what happened, in the CLI's words
 * (#385): started, up to date, or recreated and why.
 *
 * The edge runner is a fake: nothing here reaches Docker.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { handleEdgeUpRoute } from "../../../src/ui/server/edge-up-routes.js";
import {
  checkRequest,
  type AgentPrincipal,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";
import { routeClass } from "../../../src/ui/server/route-classes.js";
import type { EdgeUpOutcome } from "../../../src/shared/edge/spec.js";

const PATH = "/api/edge/up";

describe("issue 395: the route's gate", () => {
  const PORT = 41235;
  const agent: AgentPrincipal = {
    kind: "agent",
    actor: "agent:scout",
    workspace: "north",
    grants: [],
    session: { name: "scout" },
  };
  const ctx: GuardContext = {
    port: PORT,
    loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
    edgeHosts: () => [],
    verifyBearer: (t) =>
      t === "den_at_agent" ? agent : t === "den_pt_good" ? "person:me" : null,
    // A signed-in browser (0.4.71: the page signs in on this machine too).
    session: (r) =>
      String(r.headers.cookie ?? "").includes("den_session_1=good")
        ? { key: "k".repeat(64), csrf: "the-csrf" }
        : null,
  };
  const req = (headers: Record<string, string>) =>
    ({
      method: "POST",
      url: PATH,
      headers: {
        host: `localhost:${PORT}`,
        cookie: "den_session_1=good",
        ...headers,
      },
    }) as unknown as http.IncomingMessage;
  const origin = `http://localhost:${PORT}`;

  it("is shell-grade: a person's, never an agent's token", () => {
    expect(routeClass("POST", PATH)).toBe("shell-grade");
  });

  it("an agent's bearer is refused, with or without the page's headers", () => {
    for (const h of [
      { authorization: "Bearer den_at_agent" },
      {
        authorization: "Bearer den_at_agent",
        origin,
        "x-den-csrf": "the-csrf",
      },
    ])
      expect(checkRequest(req(h), ctx)).toMatchObject({
        ok: false,
        status: 403,
        code: "agent_forbidden",
      });
  });

  it("the page without its CSRF token is refused; with it, it passes", () => {
    expect(checkRequest(req({ origin }), ctx)).toMatchObject({
      ok: false,
      code: "csrf",
    });
    expect(
      checkRequest(req({ origin, "x-den-csrf": "nope" }), ctx),
    ).toMatchObject({ ok: false, code: "csrf" });
    expect(
      checkRequest(req({ origin, "x-den-csrf": "the-csrf" }), ctx),
    ).toMatchObject({ ok: true });
    // Another site never reaches it.
    expect(
      checkRequest(
        req({ origin: "https://evil.example", "x-den-csrf": "the-csrf" }),
        ctx,
      ),
    ).toMatchObject({ ok: false, code: "origin_rejected" });
  });
});

describe("issue 395: what the route answers, against a fake edge runner", () => {
  let server: http.Server;
  let base = "";
  let next: () => Promise<EdgeUpOutcome>;
  let runs = 0;
  const logged: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://x").pathname;
      const handled = handleEdgeUpRoute(req, res, pathname, {
        isAgent: (r) => r.headers["x-test-agent"] === "1",
        run: () => (runs++, next()),
        log: (l) => logged.push(l),
        sendJson: (r, body, status = 200) => {
          r.writeHead(status, { "content-type": "application/json" });
          r.end(JSON.stringify(body));
        },
      });
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = async (headers: Record<string, string> = {}) => {
    const r = await fetch(base + PATH, { method: "POST", headers });
    return {
      status: r.status,
      body: (await r.json()) as {
        ok?: boolean;
        line?: string;
        error?: string;
        outcome?: Record<string, unknown>;
      },
    };
  };

  it("started", async () => {
    next = async () => ({ kind: "started", changes: [], downSeconds: null });
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      outcome: { kind: "started" },
      line: "Edge started",
    });
  });

  it("up to date, nothing restarted", async () => {
    next = async () => ({ kind: "current", changes: [], downSeconds: null });
    const r = await post();
    expect(r.body.line).toBe("Edge up to date, nothing restarted");
  });

  it("recreated, why, and for about how long", async () => {
    next = async () => ({
      kind: "recreated",
      changes: [{ field: "image", old: "traefik:v3.6", new: "traefik:v3.7" }],
      downSeconds: 27,
    });
    const r = await post();
    expect(r.body.outcome).toMatchObject({
      kind: "recreated",
      downSeconds: 27,
    });
    expect(r.body.line).toBe(
      "Edge recreated because image: traefik:v3.6 → traefik:v3.7; it was unreachable for about 27 s",
    );
    expect(logged.at(-1)).toContain("Edge recreated because image");
  });

  it("an agent's request runs nothing", async () => {
    const before = runs;
    const r = await post({ "x-test-agent": "1" });
    expect(r.status).toBe(403);
    expect(runs).toBe(before);
  });

  it("one at a time; a failure says why", async () => {
    let release!: () => void;
    next = () =>
      new Promise((ok) => {
        release = () => ok({ kind: "current", changes: [], downSeconds: null });
      });
    const first = post();
    await new Promise((r) => setTimeout(r, 50));
    expect((await post()).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    next = async () => {
      throw new Error("port 7080 is already in use");
    };
    const r = await post();
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("port 7080 is already in use");
  });
});
