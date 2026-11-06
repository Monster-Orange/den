/**
 * Errors people can see and act on (R26, 0.3.0-dev.38), and the stale
 * engine (MD-2), against the real server (helpers/error-frame-server.ts:
 * a throwaway distribution, a temp engine copy, a minimal env).
 *
 *   R26b  every /api route, enumerated from the server's own routing code
 *         (never a hand-written list), is sent a request that fails where
 *         that is safe; every error answers JSON
 *         { ok: false, error, code, requestId } with that content-type
 *   R26a  a page request that fails gets the shell frame: 404 with the
 *         path (and the plugin, under /plugins/<id>/), 500 with the route
 *         template and a request id that the server log's line carries,
 *         and no stack in the page
 *   MD-2  bump the temp engine's version on disk: /api/server-info gains
 *         loaded and onDisk, every page carries the restart banner, and an
 *         unknown route answers the restart message instead of a 404
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  ENGINE,
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
  type Reply,
} from "./helpers/error-frame-server.js";

let s: FrameServer | null = null;

beforeAll(async () => {
  s = await startFrameServer();
}, 40_000);

afterAll(async () => {
  await s?.stop();
  removeFrameTmp(s);
});

/** The /api routes the server's code tests `pathname` against. */
function apiRoutes(): { route: string; guard: string | null }[] {
  const dir = path.join(ENGINE, "src", "ui", "server");
  const found = new Map<string, string | null>();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf-8");
    const re =
      /pathname\s*(?:===|!==)\s*"(\/api\/[^"]+)"([^\n{]*)|pathname\.startsWith\("(\/api\/[^"]+)"\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const route = (m[1] ?? m[3]).replace(/\/$/, "");
      const guard = m[2]?.match(/req\.method === "([A-Z]+)"/)?.[1] ?? null;
      if (!found.has(route) || (guard && !found.get(route)))
        found.set(route, guard);
    }
  }
  return [...found].map(([route, guard]) => ({ route, guard }));
}

/**
 * Routes a blind request would act on (they ignore the method and need no
 * argument), so the sweep never sends them one: what they do is not an
 * error to trigger. And POSTs that act on an empty body.
 */
const NEVER_BLIND: Record<string, string> = {
  "/api/aws/login": "runs `aws sso login` for env local on any request",
  "/api/workspace/sync": "syncs the active workspace's repos on any request",
};
const NEVER_POST: Record<string, string> = {
  "/api/web/restart": "restarts the server",
  "/api/sudo-password/load-from-vault": "asks the secrets backend",
  "/api/_den/throw": "the debug route (checked on its own below)",
};

function expectApiError(r: Reply, what: string): void {
  const ct = String(r.headers["content-type"] ?? "");
  expect({ what, ct }).toEqual({ what, ct: "application/json" });
  const body = JSON.parse(r.body) as Record<string, unknown>;
  expect({ what, ok: body.ok }).toEqual({ what, ok: false });
  expect(typeof body.error).toBe("string");
  expect(String(body.error).length).toBeGreaterThan(0);
  expect(body.code).toMatch(/^[a-z_0-9]+$/);
  expect(body.requestId).toMatch(/^[0-9a-f]{8}$/);
  expect(body.requestId).toBe(r.headers["x-request-id"]);
}

describe("R26b: every /api error is JSON", () => {
  it("enumerates the routes from the server's code", () => {
    const routes = apiRoutes().map((r) => r.route);
    // A scan that finds nothing would pass every check below.
    expect(routes.length).toBeGreaterThan(50);
    for (const r of ["/api/server-info", "/api/settings", "/api/stacks"])
      expect(routes).toContain(r);
  });

  it("answers every route's error with the one JSON shape", async () => {
    const errors: string[] = [];
    for (const { route, guard } of apiRoutes()) {
      // A method the route doesn't serve: the route's own 405, or the
      // router's 404 for that method.
      if (!(route in NEVER_BLIND) && route !== "/api/_den/throw") {
        const r = await s!.req("DELETE", route);
        const sse = String(r.headers["content-type"]).includes("event-stream");
        if (r.status >= 400 && !sse) {
          expectApiError(r, `DELETE ${route} → ${r.status}`);
          errors.push(`DELETE ${route}`);
        }
      }
      // A POST route with a body that isn't JSON: its 400 (or 500).
      if (guard === "POST" && !(route in NEVER_POST)) {
        const r = await s!.req("POST", route, {
          headers: { "Content-Type": "application/json" },
          body: "{",
        });
        if (r.status >= 400) {
          expectApiError(r, `POST ${route} → ${r.status}`);
          errors.push(`POST ${route}`);
        }
      }
    }
    // Most routes could be made to fail; each of those was checked.
    expect(errors.length).toBeGreaterThan(40);
  }, 120_000);

  it("a missing argument: the route's 400 as JSON, its message kept", async () => {
    const r = await s!.req("GET", "/api/modules");
    expect(r.status).toBe(400);
    expectApiError(r, "GET /api/modules");
    expect(JSON.parse(r.body)).toMatchObject({
      error: "pillar required",
      code: "bad_request",
    });
  });

  it("an unknown route: not_found, naming it", async () => {
    const r = await s!.req("GET", "/api/nope");
    expect(r.status).toBe(404);
    expectApiError(r, "GET /api/nope");
    expect(JSON.parse(r.body)).toMatchObject({
      code: "not_found",
      error: "No such API route: GET /api/nope",
    });
  });

  it("a route that throws: internal, its request id on the log line", async () => {
    const r = await s!.req("GET", "/api/_den/throw");
    expect(r.status).toBe(500);
    expectApiError(r, "GET /api/_den/throw");
    const { requestId, error } = JSON.parse(r.body) as {
      requestId: string;
      error: string;
    };
    expect(error).toBe("GET /api/_den/throw failed on the server");
    expect(error).not.toMatch(/debug route threw|\bat /);
    await new Promise((res) => setTimeout(res, 100));
    expect(s!.log()).toMatch(
      new RegExp(`failed \\(req ${requestId}\\): Error: a debug route threw`),
    );
  });
});

const HTML = { Accept: "text/html,application/xhtml+xml" };

function errorData(r: Reply): Record<string, unknown> {
  const m = r.body.match(
    /<script type="application\/json" id="den-error">([\s\S]*?)<\/script>/,
  );
  expect(m).not.toBeNull();
  return JSON.parse(m![1]) as Record<string, unknown>;
}

describe("R26a: a failed page request gets the shell frame", () => {
  it("404: the frame and the path", async () => {
    const r = await s!.req("GET", "/nope?secret=1", { headers: HTML });
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toMatch(/^text\/html/);
    expect(r.body).toContain('<div id="den-shell" data-page="error"');
    expect(r.body).toContain('<script src="/shell.js"></script>');
    const d = errorData(r);
    expect(d).toMatchObject({ status: 404, path: "/nope", plugin: null });
    expect(d.requestId).toBe(r.headers["x-request-id"]);
    expect(r.body).not.toContain("secret=1");
  });

  it("404 under /plugins/<id>/: names the plugin, not installed", async () => {
    const r = await s!.req("GET", "/plugins/runbook/", { headers: HTML });
    expect(r.status).toBe(404);
    expect(errorData(r).plugin).toEqual({
      id: "runbook",
      name: null,
      installed: false,
      locked: false,
    });
  });

  it("an asset or a non-browser request still gets a plain 404", async () => {
    const r = await s!.req("GET", "/nope.js");
    expect(r.status).toBe(404);
    expect(r.headers["content-type"]).toBe("text/plain");
  });

  it("500: the route template and the request id, the stack only in the log", async () => {
    const r = await s!.req("GET", "/_den/throw?token=abc", { headers: HTML });
    expect(r.status).toBe(500);
    const d = errorData(r);
    expect(d).toMatchObject({
      status: 500,
      method: "GET",
      route: "/_den/throw",
    });
    expect(d.requestId).toBe(r.headers["x-request-id"]);
    expect(r.body).not.toMatch(/debug route threw|token=abc|at handleRequest/);
    await new Promise((res) => setTimeout(res, 100));
    expect(s!.log()).toContain(
      `✗ GET /_den/throw failed (req ${String(d.requestId)}): Error: a debug route threw`,
    );
  });
});

describe("MD-2: the engine on disk is newer than the one running", () => {
  const loaded = (
    JSON.parse(fs.readFileSync(path.join(ENGINE, "package.json"), "utf-8")) as {
      version: string;
    }
  ).version;

  it("before: server-info has loaded and onDisk, the same", async () => {
    const info = JSON.parse((await s!.req("GET", "/api/server-info")).body);
    expect(info.loaded.version).toBe(loaded);
    expect(info.onDisk.version).toBe(loaded);
    expect(info.engineStale).toBe(false);
  });

  it("after a bump: both versions, the banner on every page, the message for unknown routes", async () => {
    s!.bumpEngine("9.9.9-test.1");
    // The comparison is cached for a few seconds.
    await new Promise((r) => setTimeout(r, 3_300));

    const info = JSON.parse((await s!.req("GET", "/api/server-info")).body);
    expect(info).toMatchObject({
      version: loaded,
      engineStale: true,
      loaded: { version: loaded },
      onDisk: { version: "9.9.9-test.1" },
    });

    const message =
      `Den was updated to 9.9.9-test.1. This server is still running ${loaded}. ` +
      "Restart it: den web restart (or your service restart).";
    for (const page of ["/settings", "/edge", "/tests"]) {
      const r = await s!.req("GET", page, { headers: HTML });
      expect(r.status).toBe(200);
      const attr = r.body.match(/data-engine-stale="([^"]*)"/)?.[1] ?? "";
      expect(
        JSON.parse(attr.replace(/&quot;/g, '"').replace(/&amp;/g, "&")),
      ).toMatchObject({ loaded, onDisk: "9.9.9-test.1", message });
    }

    const api = await s!.req("GET", "/api/added-in-a-later-den");
    expect(api.status).toBe(404);
    expectApiError(api, "a later route");
    expect(JSON.parse(api.body)).toMatchObject({
      code: "engine_stale",
      error: message,
      loaded,
      onDisk: "9.9.9-test.1",
    });

    const page = await s!.req("GET", "/a-later-page", { headers: HTML });
    expect(page.status).toBe(404);
    expect(errorData(page).engine).toEqual({
      loaded,
      onDisk: "9.9.9-test.1",
      message,
    });
  }, 20_000);
});
