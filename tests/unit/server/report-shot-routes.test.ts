/**
 * Issue 403: a filed report's screenshot, the server's side.
 *
 *   GET  /api/report/shot-share?repo=   Hub's preflight, for Review's line
 *   POST /api/report/send               with `shot` (the masked PNG) and
 *                                       `shareShot`: the issue is filed
 *                                       first; then the PNG is kept here,
 *                                       and when ticked sent to Hub, and
 *                                       the issue's screenshot line updated.
 *                                       Hub saying no never stops a filing
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
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { AddressInfo } from "net";
import {
  decideReport,
  handleReportRoutes,
  shotReaderOf,
  type GhResult,
  type ReportRouteDeps,
} from "../../../src/ui/server/report-routes.js";
import { reportShotHub } from "../../../src/ui/server/report-shot-hub.js";
import { feedbackSettings } from "../../../src/shared/report-store.js";
import {
  shotKeepDays,
  shotLimits,
  shotStore,
} from "../../../src/shared/report-shots.js";
import {
  PERSON_ONLY_SETTINGS,
  patchCliRows,
} from "../../../src/shared/settings-cli-rows.js";
import {
  checkRequest,
  type GuardContext,
} from "../../../src/ui/server/request-guard.js";
import { DeviceFlows } from "../../../src/ui/server/device-flows.js";
import type { GithubDeviceClient } from "../../../src/shared/github-device.js";

/** Everything that happened, in order: Hub's calls and gh's. */
const events: string[] = [];

// ── The fake Hub ────────────────────────────────────────────────────────
let hubAnswer: [number, unknown] = [201, {}];
/** How long the fake Hub waits before it answers an upload (ms). */
let hubDelay = 0;
/** The user.yml the limits are read from (Settings). */
let user: Record<string, unknown> = {};
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
/** gh's exit code for filing (issue create or comment), and for the edit. */
let ghFileCode = 0;
let ghEditCode = 0;
const ghCalls: { args: string[]; stdin?: string }[] = [];
const gh = async (args: string[], stdin?: string): Promise<GhResult> => {
  ghCalls.push({ args, stdin });
  if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
  if (args[0] === "api" && args.includes("PATCH")) {
    events.push("gh:patch");
    return { code: ghEditCode, stdout: "{}", stderr: "" };
  }
  if (args[0] === "api") return { code: 0, stdout: "{}", stderr: "" };
  if (args[0] === "issue" && args[1] === "edit") {
    events.push("gh:edit");
    return { code: ghEditCode, stdout: "", stderr: "" };
  }
  if (args[0] === "issue" && args[1] === "list")
    return { code: 0, stdout: "[]", stderr: "" };
  if (args[0] === "issue" && (args[1] === "create" || args[1] === "comment")) {
    events.push(`gh:${args[1]}`);
    if (ghFileCode !== 0)
      return { code: ghFileCode, stdout: "", stderr: "HTTP 403: refused" };
    return {
      code: 0,
      stdout:
        args[1] === "create"
          ? "https://github.com/acme-eng/engine/issues/42\n"
          : "https://github.com/acme-eng/engine/issues/7#issuecomment-77\n",
      stderr: "",
    };
  }
  return { code: 1, stdout: "", stderr: "unknown" };
};

const apiCalls: { method: string; path: string; body?: unknown }[] = [];
/** What the GitHub App's create answers (201, or a refusal). */
let appStatus = 201;
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
  api: async (_t, method, p, body) => {
    if (/\/labels\//.test(p)) return { status: 200, body: {} };
    apiCalls.push({ method, path: p, body });
    if (method === "PATCH") {
      events.push("app:patch");
      return { status: 200, body: {} };
    }
    const comment = /\/comments$/.test(p);
    events.push(comment ? "app:comment" : "app:create");
    if (appStatus !== 201) return { status: appStatus, body: {} };
    return {
      status: 201,
      body: comment
        ? {
            id: 88,
            html_url:
              "https://github.com/acme-eng/engine/issues/7#issuecomment-88",
          }
        : {
            number: 43,
            html_url: "https://github.com/acme-eng/engine/issues/43",
          },
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

/** The guard's view: the person's CLI token, this install's agent, a project's. */
function guardCtx(): GuardContext {
  const agent = (workspace: string) => ({
    kind: "agent" as const,
    actor: `agent:${workspace}-a` as const,
    workspace,
    grants: [],
    session: { name: workspace },
  });
  return {
    port: Number(new URL(base).port),
    loopbackNames: ["127.0.0.1", "localhost"],
    edgeHosts: () => [],
    verifyBearer: (t) =>
      t === "den_pt_person"
        ? "person:pat"
        : t === "den_at_server"
          ? agent("den-server")
          : t === "den_at_project"
            ? agent("north")
            : null,
    csrfToken: "server-start-csrf-token",
    // Issue 946: the fixture person's session (a test install's live checks).
    session: (req) =>
      String(req.headers.cookie ?? "").includes("den_session_fx=1")
        ? FIXTURE_SESSION
        : null,
  };
}
const PERSON = { authorization: "Bearer den_pt_person" };
const FIXTURE_SESSION = {
  key: "sess-fixture",
  csrf: "fixture-session-csrf-token",
  via: "fixture" as const,
};
/** The fixture person's signed-in browser, as the bed sends it. */
const FIXTURE = {
  cookie: "den_session_fx=1",
  "x-den-csrf": FIXTURE_SESSION.csrf,
};

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
    maxBytes: () => shotLimits(user).hubBytes,
    timeoutMs: () => shotLimits(user).hubTimeoutMs,
  }),
  shotMaxBytes: () => shotLimits(user).keptBytes,
  // Den's own check, on the real request guard (tokens below).
  shotReader: (r) => shotReaderOf(r, checkRequest(r, guardCtx())),
  // Issue 946: whether a filing comes from the fixture person's session.
  filedByFixture: (r) => {
    const g = checkRequest(r, guardCtx());
    return (
      g.ok && g.principal?.kind === "person-browser" && !!g.principal.fixture
    );
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
      setTimeout(
        () => {
          if (res.destroyed) return;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        },
        pre ? 0 : hubDelay,
      );
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
  ghFileCode = 0;
  ghEditCode = 0;
  hubDelay = 0;
  user = {};
  appStatus = 201;
  preflightAnswer = [
    200,
    { share: true, recipient: "Acme maintainers", why: null },
  ];
  hubAnswer = [
    201,
    {
      id: "shot_7",
      tool: "hub_report_screenshot shot_7",
      sha256: PNG_SHA,
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

/** A real 1×1 PNG, and its sha256 (what Hub answers it stored). */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_SHA = createHash("sha256").update(PNG).digest("hex");
const SHOT = `data:image/png;base64,${PNG.toString("base64")}`;
/** Another PNG (a 2×1), so a replaced screenshot shows. */
const PNG_2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M9QzwAEjDAAEPYB/qFqXnoAAAAASUVORK5CYII=",
  "base64",
);
const SHOT_2 = `data:image/png;base64,${PNG_2.toString("base64")}`;
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
/** The body the issue was updated to (`gh issue edit`), or "". */
const editedBody = () =>
  ghCalls.find((c) => c.args[0] === "issue" && c.args[1] === "edit")?.stdin ??
  "";
/** The local line, and Hub's: never a recipient, link or path. */
const LOCAL_LINE = (id: string) =>
  `Screenshot: kept on the reporting install; its agent can read it with report_screenshot(${id})`;
const HUB_LINE = "Screenshot: hub_report_screenshot shot_7 (sent to Den Hub)";
const NOT_KEPT_LINE = "Screenshot: not kept on the reporting install";
/** Approve the held GitHub App send: its flow polls and files it. */
async function approve() {
  for (let i = 0; i < 5 && !apiCalls.some((c) => c.method !== "GET"); i++) {
    for (const fn of timers.splice(0)) fn();
    await new Promise((ok) => setTimeout(ok, 30));
  }
  await new Promise((ok) => setTimeout(ok, 60));
}

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
  it("ticked and connected: the issue first, then Hub, then the line updated; no recipient in the issue; a local copy with Hub's record", async () => {
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
    expect(events).toEqual(["gh:create", "hub:upload", "gh:edit"]);
    const up = hubSeen[0]!;
    expect(up.url).toBe("/api/installs/self/reports/screenshots");
    expect(up.headers["x-den-report"]).toBe("0123456789abcdef");
    expect(up.headers["x-den-target"]).toBe("acme-eng/engine");
    expect(up.headers.authorization).toBe("Bearer install-token-never-shown");
    expect(up.body.equals(PNG)).toBe(true);
    // Filed with the line that was true then; updated once Hub had it.
    expect(filedBody()).toContain(LOCAL_LINE("0123456789abcdef"));
    const edit = ghCalls.find((c) => c.args[1] === "edit")!;
    expect(edit.args).toEqual([
      "issue",
      "edit",
      "42",
      "-R",
      "acme-eng/engine",
      "--body-file",
      "-",
    ]);
    expect(editedBody()).toContain(HUB_LINE);
    expect(editedBody()).not.toContain("report_screenshot(");
    for (const b of [filedBody(), editedBody()]) {
      expect(b).not.toContain("Acme maintainers");
      noPointer(b);
    }
    const kept = shotStore(state).get("0123456789abcdef");
    expect(kept?.png.equals(PNG)).toBe(true);
    expect(kept?.record.hub).toEqual({
      id: "shot_7",
      sha256: PNG_SHA,
      expires: "2026-12-17T00:00:00.000Z",
      recipient: "Acme maintainers",
      confirmed: true,
    });
  });

  it("adding to an existing issue: the comment first, then Hub, then the comment updated", async () => {
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      addTo: 7,
      shot: SHOT,
      shareShot: true,
    });
    expect(r.status).toBe(200);
    expect(events).toEqual(["gh:comment", "hub:upload", "gh:patch"]);
    const comment = ghCalls.find((c) => c.args[1] === "comment")!;
    expect(r.body.shot).toMatchObject({ where: "hub" });
    expect(comment.stdin).toMatch(
      /Screenshot: kept on the reporting install; its agent can read it with report_screenshot\([a-f0-9]{16}\)/,
    );
    noPointer(comment.stdin ?? "");
    const patch = ghCalls.find((c) => c.args.includes("PATCH"))!;
    expect(patch.args).toEqual([
      "api",
      "-X",
      "PATCH",
      "repos/acme-eng/engine/issues/comments/77",
      "--input",
      "-",
    ]);
    const sent = JSON.parse(patch.stdin ?? "{}") as { body: string };
    expect(sent.body).toContain(HUB_LINE);
    expect(sent.body).not.toContain("Acme maintainers");
    noPointer(sent.body);
  });

  it("the line's update fails: still filed, and Hub has it", async () => {
    ghEditCode = 1;
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      shot: SHOT,
      shareShot: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.shot).toMatchObject({ where: "hub" });
    noPointer(filedBody());
  });

  it("GitHub refuses the filing: nothing to Hub, nothing kept, and the link carries no screenshot line", async () => {
    ghFileCode = 1;
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      draftId: "0123456789abcdef",
      shot: SHOT,
      shareShot: true,
    });
    expect(r.status).toBe(502);
    expect(hubSeen).toHaveLength(0);
    expect(shotStore(state).get("0123456789abcdef")).toBeNull();
    const link = new URL(r.body.newIssueUrl as string);
    const linkBody = link.searchParams.get("body") ?? "";
    expect(linkBody).not.toMatch(/Screenshot:/);
    expect(linkBody).not.toMatch(/data:|reports[\\/]shots|\.png\b/i);
  });

  it.each([
    [403, { why: "off" }, "off"],
    [403, { why: "not-a-person" }, "not-a-person"],
    [413, {}, "too-big"],
    [415, {}, "not-png"],
    [429, {}, "limit"],
    [500, {}, "unreachable"],
  ])(
    "Hub answers %i: filed first, kept here, the line stays local (%s)",
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
      expect(events).toEqual(["gh:create", "hub:upload"]);
      expect(filedBody()).toContain(LOCAL_LINE(id));
      noPointer(filedBody());
      expect(shotStore(state).get(id)?.png.equals(PNG)).toBe(true);
    },
  );

  it("a retry Hub answers 'conflict': Hub has it (its earlier record), never 'stayed local'", async () => {
    await call("POST", "/api/report/send", {
      ...FORM,
      draftId: "0123456789abcdef",
      shot: SHOT,
      shareShot: true,
    });
    events.length = 0;
    ghCalls.length = 0;
    hubAnswer = [409, {}];
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      fileNew: true,
      draftId: "0123456789abcdef",
      shot: SHOT,
      shareShot: true,
    });
    expect(r.status).toBe(200);
    expect(r.body.shot).toEqual({
      where: "hub",
      recipient: "Acme maintainers",
    });
    expect(editedBody()).toContain(HUB_LINE);
  });

  it("'conflict' with no earlier record here: still Hub's, by the report id", async () => {
    hubAnswer = [409, {}];
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      draftId: "0123456789abcdef",
      shot: SHOT,
      shareShot: true,
    });
    expect(r.body.shot).toMatchObject({ where: "hub" });
    expect(r.body.shot.why).toBeUndefined();
    expect(editedBody()).toContain(
      "Screenshot: hub_report_screenshot for report 0123456789abcdef (sent to Den Hub)",
    );
    noPointer(editedBody());
  });

  it("Hub answers 201 with a badly shaped id: kept here, the local line, no update", async () => {
    hubAnswer = [
      201,
      {
        id: "../../shot 7",
        tool: "hub_report_screenshot x",
        sha256: PNG_SHA,
        expires: "2026-12-17T00:00:00.000Z",
        recipient: "Acme maintainers",
      },
    ];
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      shot: SHOT,
      shareShot: true,
    });
    expect(r.body.shot).toMatchObject({ where: "local", why: "refused" });
    expect(events).toEqual(["gh:create", "hub:upload"]);
    expect(shotStore(state).get(r.body.shot.id)?.record.hub).toBeUndefined();
    noPointer(filedBody());
  });

  it("Hub's sha256 isn't the one sent: Hub has it, recorded as not confirmed", async () => {
    hubAnswer = [
      201,
      {
        id: "shot_7",
        tool: "hub_report_screenshot shot_7",
        sha256: "ab".repeat(32),
        expires: "2026-12-17T00:00:00.000Z",
        recipient: "Acme maintainers",
      },
    ];
    await call("POST", "/api/report/send", {
      ...FORM,
      draftId: "0123456789abcdef",
      shot: SHOT,
      shareShot: true,
    });
    expect(
      shotStore(state).get("0123456789abcdef")?.record.hub?.confirmed,
    ).toBe(false);
  });

  it("Hub doesn't answer within reports.hub_timeout_seconds: filed, kept here, 'unreachable'", async () => {
    user = { reports: { hub_timeout_seconds: 1 } };
    hubDelay = 1500;
    const t0 = Date.now();
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      shot: SHOT,
      shareShot: true,
    });
    expect(Date.now() - t0).toBeLessThan(1450);
    expect(r.status).toBe(200);
    expect(r.body.shot).toMatchObject({ where: "local", why: "unreachable" });
    expect(filedBody()).toContain(LOCAL_LINE(r.body.shot.id));
    noPointer(filedBody());
  });

  it("over reports.hub_screenshot_max_mb: kept here, never sent ('too-big')", async () => {
    user = { reports: { hub_screenshot_max_mb: 1 } };
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      shot: `data:image/png;base64,${big.toString("base64")}`,
      shareShot: true,
    });
    expect(r.body.shot).toMatchObject({ where: "local", why: "too-big" });
    expect(hubSeen).toHaveLength(0);
  });

  it("over reports.screenshot_max_mb: refused before anything is filed", async () => {
    user = { reports: { screenshot_max_mb: 1 } };
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    const r = await call("POST", "/api/report/send", {
      ...FORM,
      shot: `data:image/png;base64,${big.toString("base64")}`,
      shareShot: true,
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at most 1 MB/);
    expect(events).toEqual([]);
  });

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

  it("Hub's recipient with a link in it: never in the issue", async () => {
    hubAnswer = [
      201,
      {
        id: "shot_7",
        tool: "hub_report_screenshot shot_7",
        sha256: PNG_SHA,
        expires: "2026-12-17T00:00:00.000Z",
        recipient: "Acme https://evil.example/x.png data:x",
      },
    ];
    await call("POST", "/api/report/send", {
      ...FORM,
      shot: SHOT,
      shareShot: true,
    });
    expect(editedBody()).toContain(HUB_LINE);
    expect(editedBody()).not.toContain("Acme");
    noPointer(filedBody());
    noPointer(editedBody());
  });

  it("the GitHub App's way: nothing reaches Hub until the person approved and the issue is filed", async () => {
    const r = await call("POST", "/api/report/github-send", {
      ...FORM,
      draftId: "0123456789abcdef",
      shot: SHOT,
      shareShot: true,
    });
    expect(r.status).toBe(200);
    expect(events).toEqual([]);
    expect(shotStore(state).get("0123456789abcdef")).toBeNull();
    await approve();
    expect(events).toEqual(["app:create", "hub:upload", "app:patch"]);
    const created = String((apiCalls[0]!.body as { body: string }).body);
    expect(created).toContain(LOCAL_LINE("0123456789abcdef"));
    noPointer(created);
    const patch = apiCalls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/repos/acme-eng/engine/issues/43");
    const updated = String((patch.body as { body: string }).body);
    expect(updated).toContain(HUB_LINE);
    expect(updated).not.toContain("Acme maintainers");
    noPointer(updated);
    const flow = await call("GET", `/api/report/github-send/${r.body.flow.id}`);
    expect(flow.body.flow.result.shot).toEqual({
      where: "hub",
      recipient: "Acme maintainers",
    });
    expect(shotStore(state).get("0123456789abcdef")?.record.hub?.id).toBe(
      "shot_7",
    );
  });

  it("the GitHub App's way, adding to an issue: the comment is updated", async () => {
    await call("POST", "/api/report/github-send", {
      ...FORM,
      addTo: 7,
      shot: SHOT,
      shareShot: true,
    });
    await approve();
    expect(events).toEqual(["app:comment", "hub:upload", "app:patch"]);
    const patch = apiCalls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/repos/acme-eng/engine/issues/comments/88");
    noPointer(String((patch.body as { body: string }).body));
  });

  it("the GitHub App's way, the box unticked: kept here, the local line, Hub never asked", async () => {
    const r = await call("POST", "/api/report/github-send", {
      ...FORM,
      shot: SHOT,
      shareShot: false,
    });
    await approve();
    expect(events).toEqual(["app:create"]);
    expect(hubSeen).toHaveLength(0);
    const created = String((apiCalls[0]!.body as { body: string }).body);
    const id = /report_screenshot\(([a-f0-9]{16})\)/.exec(created)?.[1] ?? "";
    expect(shotStore(state).get(id)?.png.equals(PNG)).toBe(true);
    noPointer(created);
    const flow = await call("GET", `/api/report/github-send/${r.body.flow.id}`);
    expect(flow.body.flow.result.shot).toEqual({ where: "local", id });
  });

  it("the GitHub App's way, GitHub refuses: nothing to Hub, nothing kept, the page keeps its link", async () => {
    appStatus = 403;
    const r = await call("POST", "/api/report/github-send", {
      ...FORM,
      draftId: "0123456789abcdef",
      shot: SHOT,
      shareShot: true,
    });
    const link = new URL(r.body.newIssueUrl as string);
    expect(link.searchParams.get("body") ?? "").not.toMatch(/Screenshot:/);
    await approve();
    expect(events).toEqual(["app:create"]);
    expect(hubSeen).toHaveLength(0);
    expect(shotStore(state).get("0123456789abcdef")).toBeNull();
    const flow = await call("GET", `/api/report/github-send/${r.body.flow.id}`);
    expect(JSON.stringify(flow.body.flow)).toMatch(/GitHub refused it \(403\)/);
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

  it("the person's command-line token: the PNG, base64, with its type", async () => {
    const r = await call("GET", `/api/report/shots/${id}`, undefined, PERSON);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, id, mime: "image/png" });
    expect(Buffer.from(r.body.base64, "base64").equals(PNG)).toBe(true);
  });

  it("no token (an agent that left its token off): 401, no PNG", async () => {
    const r = await call("GET", `/api/report/shots/${id}`);
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/sign in on this page/);
    expect(r.body.base64).toBeUndefined();
    const claimed = await call("GET", `/api/report/shots/${id}`, undefined, {
      "x-den-actor": "agent:north-a",
    });
    expect(claimed.status).toBe(401);
    expect(claimed.body.base64).toBeUndefined();
  });

  it("this install's own agent, with its token: the PNG", async () => {
    const r = await call("GET", `/api/report/shots/${id}`, undefined, {
      authorization: "Bearer den_at_server",
    });
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body.base64, "base64").equals(PNG)).toBe(true);
  });

  it("a project agent, with its token: refused, naming who can", async () => {
    const r = await call("GET", `/api/report/shots/${id}`, undefined, {
      authorization: "Bearer den_at_project",
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/person who runs this install/);
    expect(r.body.error).toMatch(/this install's own agent/);
    expect(r.body.base64).toBeUndefined();
  });

  it("an unknown id: 404", async () => {
    expect(
      (
        await call(
          "GET",
          "/api/report/shots/ffffffffffffffff",
          undefined,
          PERSON,
        )
      ).status,
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

  it("Settings and `config` set it (whole days, 1 to 3650), null clears it; a person's only", () => {
    const user: Record<string, unknown> = {};
    expect(
      patchCliRows(user, { reports: { screenshot_keep_days: 7 } }),
    ).toEqual({ ok: true });
    expect(user.reports).toEqual({ screenshot_keep_days: 7 });
    expect(shotKeepDays(user)).toBe(7);
    expect(
      patchCliRows(user, { reports: { screenshot_keep_days: 0 } }).ok,
    ).toBe(false);
    expect(
      patchCliRows(user, { reports: { screenshot_keep_days: 2.5 } }).ok,
    ).toBe(false);
    expect(user.reports).toEqual({ screenshot_keep_days: 7 });
    expect(
      patchCliRows(user, { reports: { screenshot_keep_days: null } }),
    ).toEqual({ ok: true });
    expect(user.reports).toBeUndefined();
    expect(PERSON_ONLY_SETTINGS).toContain("reports");
  });

  it("the limits are Settings with permissive defaults: 8 MB kept, 6 MB to Hub, 10 s for Hub", () => {
    expect(shotLimits({})).toEqual({
      keptBytes: 8 * 1024 * 1024,
      hubBytes: 6 * 1024 * 1024,
      hubTimeoutMs: 10_000,
    });
    expect(
      shotLimits({
        reports: {
          screenshot_max_mb: 32,
          hub_screenshot_max_mb: 16,
          hub_timeout_seconds: 60,
        },
      }),
    ).toEqual({
      keptBytes: 32 * 1024 * 1024,
      hubBytes: 16 * 1024 * 1024,
      hubTimeoutMs: 60_000,
    });
    // Out of range, or not a number: the default.
    expect(
      shotLimits({
        reports: {
          screenshot_max_mb: 0,
          hub_screenshot_max_mb: "6",
          hub_timeout_seconds: 9999,
        },
      }),
    ).toEqual(shotLimits({}));
    const u: Record<string, unknown> = {};
    expect(
      patchCliRows(u, {
        reports: {
          screenshot_max_mb: 16,
          hub_screenshot_max_mb: 12,
          hub_timeout_seconds: 30,
        },
      }),
    ).toEqual({ ok: true });
    expect(u.reports).toEqual({
      screenshot_max_mb: 16,
      hub_screenshot_max_mb: 12,
      hub_timeout_seconds: 30,
    });
    expect(patchCliRows(u, { reports: { hub_timeout_seconds: 0 } }).ok).toBe(
      false,
    );
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

describe("issue 946: the fixture person reads only what a fixture session filed", () => {
  const file = async (headers: Record<string, string>) =>
    (
      await call(
        "POST",
        "/api/report/send",
        { ...FORM, shot: SHOT, shareShot: false },
        // A POST from the page carries its Origin, as the bed's does.
        { origin: base, ...headers },
      )
    ).body.shot.id as string;

  it("a screenshot the fixture person filed: it reads it", async () => {
    const id = await file(FIXTURE);
    const r = await call("GET", `/api/report/shots/${id}`, undefined, FIXTURE);
    expect(r.status).toBe(200);
    expect(Buffer.from(r.body.base64, "base64").equals(PNG)).toBe(true);
  });

  it("a screenshot the person filed: 404 to the fixture person, as if none were kept", async () => {
    const id = await file(PERSON);
    const r = await call("GET", `/api/report/shots/${id}`, undefined, FIXTURE);
    expect(r.status).toBe(404);
    expect(r.body.base64).toBeUndefined();
    expect(r.body.error).toMatch(/no screenshot is kept/);
  });

  it("the person still reads one the fixture person filed", async () => {
    const id = await file(FIXTURE);
    const r = await call("GET", `/api/report/shots/${id}`, undefined, PERSON);
    expect(r.status).toBe(200);
  });

  // Issue 957: a filing never replaces a kept screenshot of another kind
  // of filer (the fixture person's, or anyone else's).
  it("the fixture person reusing a person's report id is refused, and the person's stays", async () => {
    const id = await file(PERSON);
    const r = await call(
      "POST",
      "/api/report/send",
      { ...FORM, shot: SHOT_2, shareShot: false, draftId: id },
      { origin: base, ...FIXTURE },
    );
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/another/);
    const kept = shotStore(state).get(id);
    expect(kept?.record.byFixture).toBeUndefined();
    expect(kept?.png.equals(PNG)).toBe(true);
    const read = await call(
      "GET",
      `/api/report/shots/${id}`,
      undefined,
      FIXTURE,
    );
    expect(read.status).toBe(404);
  });

  it("the person reusing the fixture person's report id is refused, and the fixture's stays", async () => {
    const id = await file(FIXTURE);
    const r = await call(
      "POST",
      "/api/report/send",
      { ...FORM, shot: SHOT_2, shareShot: false, draftId: id },
      PERSON,
    );
    expect(r.status).toBe(409);
    expect(shotStore(state).get(id)?.record.byFixture).toBe(true);
  });

  it("held for the person's approval: a filing of the other kind in between is never replaced", async () => {
    const id = "0123456789abcdef";
    const held = await call("POST", "/api/report/github-send", {
      ...FORM,
      draftId: id,
      shot: SHOT,
      shareShot: false,
    });
    expect(held.status).toBe(200);
    // Before the person's Allow, the fixture person files under that id.
    const r = await call(
      "POST",
      "/api/report/send",
      { ...FORM, shot: SHOT_2, shareShot: false, draftId: id },
      { origin: base, ...FIXTURE },
    );
    expect(r.status).toBe(200);
    await approve();
    const kept = shotStore(state).get(id);
    expect(kept?.record.byFixture).toBe(true);
    expect(kept?.png.equals(PNG_2)).toBe(true);
    // The person's filed issue never names an id that holds another
    // filer's screenshot: its line says this one wasn't kept.
    const patch = apiCalls.find((c) => c.method === "PATCH");
    const updated = String((patch?.body as { body?: string })?.body ?? "");
    expect(updated).toContain(NOT_KEPT_LINE);
    expect(updated).not.toContain(LOCAL_LINE(id));
  });

  it("the same filer sending its own report id again still keeps it", async () => {
    const id = await file(FIXTURE);
    const r = await call(
      "POST",
      "/api/report/send",
      { ...FORM, shot: SHOT, shareShot: false, draftId: id },
      { origin: base, ...FIXTURE },
    );
    expect(r.status).toBe(200);
    expect(shotStore(state).get(id)?.record.byFixture).toBe(true);
  });
});
