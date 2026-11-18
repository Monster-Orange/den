/**
 * Issue 403: a filed report's screenshot, the server's side.
 *
 *   GET  /api/report/shot-share?repo=   Hub's preflight, for Review's line
 *   POST /api/report/send               with `shot` (the masked PNG) and
 *                                       `shareShot`: kept here always; sent
 *                                       to Hub first when ticked; filed
 *                                       anyway when Hub says no
 *   GET  /api/report/shots/<id>         the kept PNG: the person or this
 *                                       install's server agent only
 *
 * The issue body names the report id and the tool, never a URL, a data:
 * URL or a path. A fake Hub (a local http server) and a fake `gh`: never
 * the real ones. Invented names only; a temp state directory.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  decideReport,
  handleReportRoutes,
  type GhResult,
  type ReportRouteDeps,
} from "../../../src/ui/server/report-routes.js";
import { reportShotHub } from "../../../src/ui/server/report-shot-hub.js";
import { feedbackSettings } from "../../../src/shared/report-store.js";
import { shotKeepDays, shotStore } from "../../../src/shared/report-shots.js";
import { DeviceFlows } from "../../../src/ui/server/device-flows.js";
import type { GithubDeviceClient } from "../../../src/shared/github-device.js";

/** Everything that happened, in order: Hub's calls and gh's. */
const events: string[] = [];

// ── The fake Hub ────────────────────────────────────────────────────────
let hubAnswer: [number, unknown] = [201, {}];
let preflightAnswer: [number, unknown] = [200, {}];
const hubSeen: {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}[] = [];
let hub: http.Server;
let hubBase = "";
let connected = true;

// ── Den's report routes, on a fake gh ───────────────────────────────────
const ghCalls: { args: string[]; stdin?: string }[] = [];
const gh = async (args: string[], stdin?: string): Promise<GhResult> => {
  ghCalls.push({ args, stdin });
  if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
  if (args[0] === "api") return { code: 0, stdout: "{}", stderr: "" };
  if (args[0] === "issue" && args[1] === "list")
    return { code: 0, stdout: "[]", stderr: "" };
  if (args[0] === "issue" && (args[1] === "create" || args[1] === "comment")) {
    events.push(`gh:${args[1]}`);
    return {
      code: 0,
      stdout: "https://github.com/acme-eng/engine/issues/42\n",
      stderr: "",
    };
  }
  return { code: 1, stdout: "", stderr: "unknown" };
};

const apiCalls: { path: string; body?: unknown }[] = [];
const timers: (() => void)[] = [];
const fakeClient: GithubDeviceClient = {
  start: async () => ({
    deviceCode: "device-code-never-shown",
    userCode: "ABCD-1234",
    expiresIn: 900,
    interval: 5,
  }),
  poll: async () => ({
    kind: "token",
    token: "user-token-never-shown",
    expiring: false,
  }),
  user: async () => ({ id: 1, login: "pat" }),
  orgMember: async () => "unreadable",
  api: async (_t, _method, p, body) => {
    if (/\/labels\//.test(p)) return { status: 200, body: {} };
    apiCalls.push({ path: p, body });
    events.push("app:create");
    return {
      status: 201,
      body: { html_url: "https://github.com/acme-eng/engine/issues/43" },
    };
  },
};
const flows = new DeviceFlows({
  client: fakeClient,
  clientId: () => "Iv-test",
  decide: (purpose, _i, ctx) =>
    purpose === "report" ? decideReport(ctx) : "refused",
  schedule: (fn) => {
    timers.push(fn);
    return () => undefined;
  },
});

let state = "";
let server: http.Server;
let base = "";

const deps: ReportRouteDeps = {
  settings: () =>
    feedbackSettings(
      { bugs: { url: "https://github.com/acme-eng/engine/issues" } },
      {},
      {},
    ),
  stateDir: () => state,
  gh,
  names: () => ({ home: "/Users/pat", hosts: [], projects: [] }),
  diagnostics: async () => ({ Den: "den 9.9.9" }),
  agentOf: (r) => (r.headers["x-den-agent"] as string | undefined) ?? null,
  personOf: () => "person",
  flows,
  searchOpen: async () => null,
  shotHub: reportShotHub({
    hub: async () =>
      connected ? { url: hubBase, token: "install-token-never-shown" } : null,
    timeoutMs: 2000,
  }),
  // The test's stand-in for Den's principals: x-den-agent names an agent,
  // x-den-scope its project ("den-server": the server agent).
  shotReader: (r) => {
    const a = r.headers["x-den-agent"] as string | undefined;
    if (!a) return { ok: true };
    return r.headers["x-den-scope"] === "den-server"
      ? { ok: true }
      : { ok: false, who: `agent:${a}` };
  },
  readBody: (req) =>
    new Promise((ok) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => ok(b));
    }),
  sendJson: (res, body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  },
};

beforeAll(async () => {
  hub = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const pre = (req.url ?? "").includes("/preflight");
      events.push(pre ? "hub:preflight" : "hub:upload");
      hubSeen.push({
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const [status, body] = pre ? preflightAnswer : hubAnswer;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((ok) => hub.listen(0, "127.0.0.1", ok));
  hubBase = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://den.invalid").pathname;
    if (!handleReportRoutes(req, res, pathname, deps)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  hub.closeAllConnections();
  await new Promise<void>((ok) => hub.close(() => ok()));
  await new Promise<void>((ok) => server.close(() => ok()));
});

beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "den-report-shot-"));
  events.length = 0;
  hubSeen.length = 0;
  ghCalls.length = 0;
  apiCalls.length = 0;
  connected = true;
  preflightAnswer = [
    200,
    { share: true, recipient: "Acme maintainers", why: null },
  ];
  hubAnswer = [
    201,
    {
      id: "shot_7",
      tool: "hub_report_screenshot shot_7",
      sha256: "cd".repeat(32),
      expires: "2026-12-17T00:00:00.000Z",
      recipient: "Acme maintainers",
    },
  ];
});

const call = async (
  method: string,
  p: string,
  body?: unknown,
  headers: Record<string, string> = {},
) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads nested JSON
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

/** A real 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const SHOT = `data:image/png;base64,${PNG.toString("base64")}`;
const FORM = {
  kind: "bug",
  title: "Pane drops",
  description: "It drops.",
  sections: { Den: true },
  repo: "acme-eng/engine",
};

/** The body gh filed (stdin of `issue create`). */
const filedBody = () =>
  ghCalls.find((c) => c.args[0] === "issue" && c.args[1] === "create")?.stdin ??
  "";

/** Nothing in a filed body that points at the image. */
function noPointer(body: string) {
  expect(body).not.toMatch(/https?:\/\//i);
  expect(body).not.toMatch(/data:/i);
  expect(body).not.toMatch(/reports[\\/]shots|\.png\b/i);
  expect(body).not.toContain(state);
}

describe("issue 403: Review's line (shot-share)", () => {
  it("Hub would share it: share, and to whom", async () => {
    const r = await call("GET", "/api/report/shot-share?repo=acme-eng/engine");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      share: true,
      recipient: "Acme maintainers",
    });
    expect(hubSeen[0]!.url).toBe(
      "/api/installs/self/reports/screenshots/preflight?target=acme-eng%2Fengine",
    );
  });

  it("Hub says no, not connected, or unreachable: text only", async () => {
    preflightAnswer = [
      200,
      { share: false, recipient: "Acme maintainers", why: "off" },
    ];
    expect(
      (await call("GET", "/api/report/shot-share?repo=acme-eng/engine")).body,
    ).toEqual({ ok: true, share: false });
    preflightAnswer = [503, {}];
    expect(
      (await call("GET", "/api/report/shot-share?repo=acme-eng/engine")).body,
    ).toEqual({ ok: true, share: false });
    connected = false;
    expect(
      (await call("GET", "/api/report/shot-share?repo=acme-eng/engine")).body,
    ).toEqual({ ok: true, share: false });
  });

  it("a repo that isn't a destination: refused, Hub not asked", async () => {
    const r = await call("GET", "/api/report/shot-share?repo=other/repo");
    expect(r.status).toBe(400);
    expect(hubSeen).toHaveLength(0);
  });
});

describe("issue 403: filing with a screenshot", () => {
  it("ticked and connected: sent to Hub BEFORE the issue; the body names Hub's tool; a local copy is kept with Hub's record", async () => {
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      draftId: "0123456789abcdef",
      shot: SHOT,
      shareShot: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.shot).toEqual({
      where: "hub",
      recipient: "Acme maintainers",
    });
    expect(events).toEqual(["hub:upload", "gh:create"]);
    const up = hubSeen[0]!;
    expect(up.url).toBe("/api/installs/self/reports/screenshots");
    expect(up.headers["x-den-report"]).toBe("0123456789abcdef");
    expect(up.headers["x-den-target"]).toBe("acme-eng/engine");
    expect(up.headers.authorization).toBe("Bearer install-token-never-shown");
    expect(up.body.equals(PNG)).toBe(true);
    const body = filedBody();
    expect(body).toContain(
      "Screenshot: hub_report_screenshot shot_7 (Hub, Acme maintainers)",
    );
    noPointer(body);
    const kept = shotStore(state).get("0123456789abcdef");
    expect(kept?.png.equals(PNG)).toBe(true);
    expect(kept?.record.hub).toEqual({
      id: "shot_7",
      sha256: "cd".repeat(32),
      expires: "2026-12-17T00:00:00.000Z",
      recipient: "Acme maintainers",
    });
  });

  it.each([
    [403, { why: "off" }, "off"],
    [403, { why: "not-a-person" }, "not-a-person"],
    [409, {}, "conflict"],
    [413, {}, "too-big"],
    [415, {}, "not-png"],
    [429, {}, "limit"],
    [500, {}, "unreachable"],
  ])(
    "Hub answers %i: filed anyway, kept here, the body names the local tool (%s)",
    async (status, answer, why) => {
      hubAnswer = [status, answer];
      const r = await call("POST", "/api/report/send", {
        ...FORM,
        shot: SHOT,
        shareShot: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.shot).toMatchObject({ where: "local", why });
      const id = r.body.shot.id as string;
      expect(id).toMatch(/^[a-f0-9]{16}$/);
      const body = filedBody();
      expect(body).toContain(
        `Screenshot: kept on the reporting install; its agent can read it with report_screenshot(${id})`,
      );
      noPointer(body);
      expect(shotStore(state).get(id)?.png.equals(PNG)).toBe(true);
    },
  );

  it("not connected: filed, kept here, no Hub call", async () => {
    connected = false;
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      shot: SHOT,
      shareShot: true,
    });
    expect(r.body.shot).toMatchObject({ where: "local", why: "not-connected" });
    expect(hubSeen).toHaveLength(0);
    noPointer(filedBody());
  });

  it("the box unticked: never sent to Hub, kept here", async () => {
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      shot: SHOT,
      shareShot: false,
    });
    expect(r.body.shot).toEqual({ where: "local", id: r.body.shot.id });
    expect(hubSeen).toHaveLength(0);
    expect(filedBody()).toContain("report_screenshot(");
    noPointer(filedBody());
  });

  it("no screenshot: no line, nothing kept", async () => {
    const r = await call("POST", "/api/report/send", FORM);
    expect(r.body.shot).toBeUndefined();
    expect(filedBody()).not.toMatch(/Screenshot:/);
    noPointer(filedBody());
    expect(fs.existsSync(path.join(state, "reports", "shots"))).toBe(false);
  });

  it("a shot that isn't a PNG data URL: refused before anything is filed", async () => {
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      shot: "https://example.com/x.png",
      shareShot: true,
    });
    expect(r.status).toBe(400);
    expect(events).toEqual([]);
  });

  it("Hub's recipient with a link in it: the body still has none", async () => {
    hubAnswer = [
      201,
      {
        id: "shot_8",
        tool: "hub_report_screenshot shot_8",
        sha256: "ef".repeat(32),
        expires: "2026-12-17T00:00:00.000Z",
        recipient: "Acme https://evil.example/x.png data:x",
      },
    ];
    await call("POST", "/api/report/send", {
      ...FORM,
      shot: SHOT,
      shareShot: true,
    });
    expect(filedBody()).toMatch(
      /Screenshot: hub_report_screenshot shot_8 \(Hub, /,
    );
    noPointer(filedBody());
  });

  it("the GitHub App's way: sent to Hub before the issue, the body names it", async () => {
    const r = await call("POST", "/api/report/github-send", {
      ...FORM,
      shot: SHOT,
      shareShot: true,
    });
    expect(r.status).toBe(200);
    expect(events).toEqual(["hub:upload"]);
    // The person approves: the flow polls once and files it.
    for (let i = 0; i < 3 && !apiCalls.length; i++) {
      for (const fn of timers.splice(0)) fn();
      await new Promise((ok) => setTimeout(ok, 30));
    }
    expect(events).toEqual(["hub:upload", "app:create"]);
    const body = String((apiCalls[0]!.body as { body: string }).body);
    expect(body).toContain(
      "Screenshot: hub_report_screenshot shot_7 (Hub, Acme maintainers)",
    );
    noPointer(body);
    const flow = await call("GET", `/api/report/github-send/${r.body.flow.id}`);
    expect(flow.body.flow.result.shot).toEqual({
      where: "hub",
      recipient: "Acme maintainers",
    });
  });
});

describe("issue 403: reading a kept screenshot", () => {
  let id = "";
  beforeEach(async () => {
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      shot: SHOT,
      shareShot: false,
    });
    id = r.body.shot.id;
  });

  it("the person (a CLI bearer or the browser): the PNG, base64, with its type", async () => {
    const r = await call("GET", `/api/report/shots/${id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id, mime: "image/png" });
    expect(Buffer.from(r.body.base64, "base64").equals(PNG)).toBe(true);
  });

  it("this install's own server agent: the PNG", async () => {
    const r = await call("GET", `/api/report/shots/${id}`, undefined, {
      "x-den-agent": "server",
      "x-den-scope": "den-server",
    });
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body.base64, "base64").equals(PNG)).toBe(true);
  });

  it("a project agent: refused, naming who can", async () => {
    const r = await call("GET", `/api/report/shots/${id}`, undefined, {
      "x-den-agent": "builder",
      "x-den-scope": "north",
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/person who runs this install/);
    expect(r.body.error).toMatch(/server agent/);
    expect(r.body.base64).toBeUndefined();
  });

  it("an unknown id: 404", async () => {
    expect(
      (await call("GET", "/api/report/shots/ffffffffffffffff")).status,
    ).toBe(404);
  });
});

describe("issue 403: the janitor", () => {
  it("reports.screenshot_keep_days: 30 by default, whole days from 1", () => {
    expect(shotKeepDays({})).toBe(30);
    expect(shotKeepDays({ reports: { screenshot_keep_days: 7 } })).toBe(7);
    expect(shotKeepDays({ reports: { screenshot_keep_days: 0 } })).toBe(30);
    expect(shotKeepDays({ reports: { screenshot_keep_days: 1.5 } })).toBe(30);
  });

  it("a screenshot older than its days goes, with its record; a newer one stays", () => {
    const day = 86_400_000;
    const now = Date.parse("2026-11-17T12:00:00Z");
    const s = shotStore(state);
    s.save("aaaaaaaaaaaaaaaa", PNG, "acme-eng/engine", now - 31 * day);
    s.save("bbbbbbbbbbbbbbbb", PNG, "acme-eng/engine", now - 29 * day);
    expect(s.sweep(30, now)).toBe(1);
    expect(s.get("aaaaaaaaaaaaaaaa")).toBeNull();
    expect(fs.readdirSync(s.dir).sort()).toEqual([
      "bbbbbbbbbbbbbbbb.json",
      "bbbbbbbbbbbbbbbb.png",
    ]);
    expect(s.sweep(7, now)).toBe(1);
    expect(fs.readdirSync(s.dir)).toEqual([]);
  });
});
