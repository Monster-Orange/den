/**
 * Sign-in on this machine too (0.4.71), on the real server: a request on
 * localhost with no session cookie and no bearer changes nothing and
 * reaches no shell, whatever headers it sends. It may send this server's
 * own Origin and a CSRF token it got hold of: neither is a sign-in.
 *
 *  - every route that changes something or reaches a shell answers 401
 *    `signin_required`: a terminal start, a terminal's input (the
 *    WebSocket), an agent start, Allow, a held write, a settings write, a
 *    gate route, and a GET that runs something;
 *  - GET /api/session hands such a caller no CSRF token;
 *  - the same requests with the session cookie get past the check (they
 *    may fail later for their own reasons, never with `signin_required`).
 *
 * No code, cookie or token is printed: a failure shows statuses and codes.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import * as path from "path";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";
import { signInUrl } from "./helpers/den-auth.js";
import { wsConnect } from "./helpers/ws-client.js";

let s: FrameServer;
let stateDir = "";
/** `den_session_<port>=<id>`, from a real sign-in link. */
let cookie = "";
/** That session's own CSRF token. */
let sessionCsrf = "";
/** What GET /api/session hands a caller with no credential (null once fixed). */
let anonCsrf: string | null = null;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A request with exactly these headers (no credential added). */
function raw(
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: "localhost",
        port: s.port,
        path: p,
        method,
        agent: false,
        timeout: 15_000,
        setHost: false,
        headers: {
          host: `localhost:${s.port}`,
          ...headers,
          ...(body !== undefined
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
              }
            : {}),
        },
      },
      (res) => {
        if (String(res.headers["content-type"]).includes("event-stream")) {
          res.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: "" });
          return;
        }
        let text = "";
        res.on("data", (d: Buffer) => (text += d.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      },
    );
    r.on("error", reject);
    r.on("timeout", () => r.destroy(new Error(`timeout: ${method} ${p}`)));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

function codeOf(r: Reply): string | null {
  try {
    return (JSON.parse(r.body) as { code?: string }).code ?? null;
  } catch {
    return null;
  }
}

/** The headers a page on this server sends, with a CSRF token it holds. */
function pageHeaders(csrf: string): Record<string, string> {
  return {
    origin: `http://localhost:${s.port}`,
    "sec-fetch-site": "same-origin",
    "x-den-csrf": csrf,
  };
}

/** Every CSRF token the caller might hold: the anonymous one (if any) and a session's. */
function tokens(): string[] {
  return [...(anonCsrf ? [anonCsrf] : []), sessionCsrf];
}

beforeAll(async () => {
  s = await startFrameServer({ prefix: "den-signin-machine-" });
  stateDir = path.join(s.tmp, "den-home");
  // What a caller with no credential is handed today.
  const anon = await raw("GET", "/api/session", {
    "sec-fetch-site": "same-origin",
  });
  anonCsrf = (JSON.parse(anon.body) as { csrf: string | null }).csrf;
  // A real sign-in, as `web up` opens it: the one-time link.
  const link = new URL(signInUrl(stateDir, s.base));
  const auth = await raw("GET", link.pathname + link.search, {
    "sec-fetch-site": "none",
  });
  expect(auth.status).toBe(303);
  const set = ([] as string[]).concat(auth.headers["set-cookie"] ?? []);
  const c = set.find((x) => x.startsWith(`den_session_${s.port}=`));
  expect(!!c).toBe(true);
  cookie = c!.split(";")[0];
  const me = await raw("GET", "/api/session", {
    cookie,
    "sec-fetch-site": "same-origin",
  });
  const b = JSON.parse(me.body) as { csrf: string; signedIn: boolean };
  expect(b.signedIn).toBe(true);
  sessionCsrf = b.csrf;
}, 60_000);

afterAll(async () => {
  await s?.stop();
  removeFrameTmp(s);
});

/** The routes that change something or reach a shell, one per kind. */
const WRITES: { what: string; method: string; path: string; body?: string }[] =
  [
    {
      what: "a terminal start",
      method: "POST",
      path: "/api/workspaces/default/sessions",
      body: "{}",
    },
    {
      what: "an agent start",
      method: "POST",
      path: "/api/workspaces/default/agents",
      body: '{"runtime":"claude"}',
    },
    {
      what: "Allow",
      method: "POST",
      path: "/api/approvals/no-such-id/decide",
      body: '{"decision":"allow"}',
    },
    {
      what: "a held write",
      method: "POST",
      path: "/api/approvals",
      body: '{"action":"workspace_create","args":{}}',
    },
    {
      what: "a settings write",
      method: "POST",
      path: "/api/settings",
      body: '{"path":"web.login_link_ttl","value":"60s"}',
    },
    {
      what: "a gate route",
      method: "POST",
      path: "/api/gate-slots/end",
      body: '{"id":"no-such-slot"}',
    },
  ];

describe("no sign-in on this machine: nothing changes, no shell", () => {
  it("GET /api/session hands no CSRF token without a session", async () => {
    const r = await raw("GET", "/api/session", {
      "sec-fetch-site": "same-origin",
      origin: `http://localhost:${s.port}`,
    });
    expect(r.status).toBe(200);
    const b = JSON.parse(r.body) as {
      csrf: string | null;
      signedIn: boolean;
      reason?: string;
    };
    expect(b.csrf).toBeNull();
    expect(b.signedIn).toBe(false);
    expect(typeof b.reason).toBe("string");
  });

  for (const w of WRITES)
    it(`${w.what} answers 401 signin_required`, async () => {
      for (const t of tokens()) {
        const r = await raw(w.method, w.path, pageHeaders(t), w.body);
        expect({ status: r.status, code: codeOf(r) }).toEqual({
          status: 401,
          code: "signin_required",
        });
      }
    });

  it("a GET that runs something answers 401 signin_required", async () => {
    for (const t of tokens()) {
      const r = await raw(
        "GET",
        "/api/workspace/exec?cmd=true",
        pageHeaders(t),
      );
      expect({ status: r.status, code: codeOf(r) }).toEqual({
        status: 401,
        code: "signin_required",
      });
    }
  });

  it("a terminal's input (the WebSocket) answers 401 signin_required", async () => {
    for (const t of tokens()) {
      const r = await wsConnect(s.port, "/api/sessions/no-such/io", {
        host: `localhost:${s.port}`,
        origin: `http://localhost:${s.port}`,
        "sec-websocket-protocol": `den.term, den.csrf.${t}`,
      });
      if (r.ok) r.ws.destroy();
      expect(r.ok ? 101 : { status: r.status, code: r.body.code }).toEqual({
        status: 401,
        code: "signin_required",
      });
    }
  });
});

describe("signed in on this machine: the same requests pass the check", () => {
  for (const w of WRITES)
    it(`${w.what} is not refused for sign-in`, async () => {
      const r = await raw(
        w.method,
        w.path,
        { ...pageHeaders(sessionCsrf), cookie },
        w.body,
      );
      expect(codeOf(r)).not.toBe("signin_required");
      expect(codeOf(r)).not.toBe("csrf");
    });

  it("a reload keeps the session", async () => {
    const r = await raw("GET", "/", {
      cookie,
      "sec-fetch-site": "none",
      "sec-fetch-dest": "document",
    });
    expect(r.status).toBe(200);
    const me = await raw("GET", "/api/session", {
      cookie,
      "sec-fetch-site": "same-origin",
    });
    expect((JSON.parse(me.body) as { signedIn: boolean }).signedIn).toBe(true);
  });
});
