/**
 * FB (den#81): Report an issue, the server's side (report-routes.ts). The
 * destination comes from the engine's bugs.url; the preview shows no host,
 * path or name when "Redact names" is on; not signed in to GitHub sends
 * nothing (F4) and gives the browser-tab path; a sixth report in an hour is
 * refused (F7); an open issue with the same title is offered (F5); an agent
 * saves a draft but never sends one. `gh` is a fake: never the real one.
 * Invented names only; a temp state directory.
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
  handleReportRoutes,
  type GhResult,
  type ReportRouteDeps,
} from "../../../src/ui/server/report-routes.js";
import { feedbackSettings } from "../../../src/shared/report-store.js";

let state = "";
let server: http.Server;
let base = "";
let signedIn = true;
let openIssues: { number: number; title: string; url: string }[] = [];
const calls: { args: string[]; stdin?: string }[] = [];

const gh = async (args: string[], stdin?: string): Promise<GhResult> => {
  calls.push({ args, stdin });
  if (args[0] === "auth")
    return { code: signedIn ? 0 : 1, stdout: "", stderr: "" };
  if (args[0] === "issue" && args[1] === "list")
    return { code: 0, stdout: JSON.stringify(openIssues), stderr: "" };
  if (args[0] === "issue" && args[1] === "create")
    return {
      code: 0,
      stdout: "https://github.com/acme-eng/engine/issues/42\n",
      stderr: "",
    };
  if (args[0] === "issue" && args[1] === "comment")
    return {
      code: 0,
      stdout: "https://github.com/acme-eng/engine/issues/7#issuecomment-1\n",
      stderr: "",
    };
  return { code: 1, stdout: "", stderr: "unknown" };
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
  names: () => ({
    home: "/Users/pat",
    hosts: ["acme.local.example.com"],
    projects: ["rocket"],
  }),
  diagnostics: async () => ({
    Den: "den 9.9.9 at acme.local.example.com",
    Config: "home /Users/pat/rocket, project rocket",
  }),
  agentOf: (r) => (r.headers["x-den-agent"] as string | undefined) ?? null,
  personOf: () => "person",
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
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://den.invalid").pathname;
    if (!handleReportRoutes(req, res, pathname, deps)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "den-report-"));
  signedIn = true;
  openIssues = [];
  calls.length = 0;
});

const FORM = {
  kind: "bug",
  title: "Pane at acme.local.example.com drops",
  description: "In /Users/pat/rocket the rocket pane drops.",
  sections: { Den: true, Config: true },
};

const call = async (
  method: string,
  p: string,
  body?: unknown,
  agent?: string,
) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(agent ? { "x-den-agent": agent } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads nested JSON
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

describe("FB: Report an issue, the server's side", () => {
  it("the destination is the engine's bugs.url", async () => {
    const r = await call("GET", "/api/report");
    expect(r.body).toMatchObject({
      ok: true,
      enabled: true,
      repos: [{ repo: "acme-eng/engine" }],
      github: { signedIn: true },
      maxPerHour: 5,
      sentThisHour: 0,
    });
  });

  it("the preview shows no host, path or name with Redact names on", async () => {
    const r = await call("POST", "/api/report/preview", FORM);
    expect(r.status).toBe(200);
    const all = `${r.body.title}\n${r.body.body}`;
    expect(all).not.toMatch(/acme\.local\.example\.com|\/Users\/pat|rocket/);
    expect(r.body.repo).toBe("acme-eng/engine");
    const off = await call("POST", "/api/report/preview", {
      ...FORM,
      redact: false,
    });
    expect(off.body.body).toMatch(/rocket/);
  });

  it("not signed in to GitHub: nothing is sent, and the browser-tab path is given (F4)", async () => {
    signedIn = false;
    const r = await call("POST", "/api/report/send", FORM);
    expect(r.status).toBe(409);
    expect(r.body.need).toBe("github");
    expect(r.body.newIssueUrl).toMatch(
      /^https:\/\/github\.com\/acme-eng\/engine\/issues\/new\?title=/,
    );
    expect(decodeURIComponent(r.body.newIssueUrl)).not.toMatch(/rocket/);
    expect(calls.filter((c) => c.args[1] === "create")).toEqual([]);
  });

  it("a sent report is filed as the person, the redacted body on stdin", async () => {
    const r = await call("POST", "/api/report/send", FORM);
    expect(r.body).toEqual({
      ok: true,
      url: "https://github.com/acme-eng/engine/issues/42",
      repo: "acme-eng/engine",
      added: false,
    });
    const c = calls.find((x) => x.args[1] === "create");
    expect(c?.args.slice(0, 4)).toEqual([
      "issue",
      "create",
      "-R",
      "acme-eng/engine",
    ]);
    expect(c?.stdin).not.toMatch(/rocket|\/Users\/pat/);
  });

  it("a sixth report in an hour is refused (F7)", async () => {
    for (let i = 0; i < 5; i++)
      expect(
        (await call("POST", "/api/report/send", { ...FORM, title: `t${i}` }))
          .status,
      ).toBe(200);
    const r = await call("POST", "/api/report/send", { ...FORM, title: "t6" });
    expect(r.status).toBe(429);
    expect(r.body.limit).toBe(5);
    expect(typeof r.body.nextAt).toBe("string");
    expect(calls.filter((c) => c.args[1] === "create")).toHaveLength(5);
  });

  it("an open issue with the same title is offered (F5); addTo comments there", async () => {
    const title = (await call("POST", "/api/report/preview", FORM)).body.title;
    openIssues = [
      { number: 7, title, url: "https://github.com/acme-eng/engine/issues/7" },
    ];
    const r = await call("POST", "/api/report/send", FORM);
    expect(r.status).toBe(409);
    expect(r.body.duplicate).toMatchObject({ number: 7 });
    expect(calls.filter((c) => c.args[1] === "create")).toEqual([]);
    const add = await call("POST", "/api/report/send", { ...FORM, addTo: 7 });
    expect(add.body).toMatchObject({ ok: true, added: true });
    const neu = await call("POST", "/api/report/send", {
      ...FORM,
      fileNew: true,
    });
    expect(neu.body).toMatchObject({ ok: true, added: false });
  });

  it("an agent saves a draft but never sends or discards one", async () => {
    const s = await call("POST", "/api/report/drafts", FORM, "builder");
    expect(s.status).toBe(200);
    const list = await call("GET", "/api/report/drafts");
    expect(list.body.drafts).toHaveLength(1);
    expect(list.body.drafts[0]).toMatchObject({
      by: "agent:builder",
      title: FORM.title,
    });
    const send = await call("POST", "/api/report/send", FORM, "builder");
    expect(send.status).toBe(403);
    expect(calls.filter((c) => c.args[0] === "issue")).toEqual([]);
    const del = await call(
      "DELETE",
      `/api/report/drafts/${s.body.draft.id}`,
      undefined,
      "builder",
    );
    expect(del.status).toBe(403);
    const mine = await call("DELETE", `/api/report/drafts/${s.body.draft.id}`);
    expect(mine.status).toBe(200);
  });

  it("feedback.enabled: false turns every route off", () => {
    expect(feedbackSettings({}, { enabled: false }, {}).enabled).toBe(false);
    expect(feedbackSettings({}, {}, { enabled: false }).enabled).toBe(false);
    expect(
      feedbackSettings(
        { bugs: "https://github.com/acme-eng/engine/issues" },
        { repo: "acme-dist/den" },
        { max_per_hour: 2 },
      ),
    ).toEqual({
      enabled: true,
      maxPerHour: 2,
      repos: ["acme-eng/engine", "acme-dist/den"],
    });
  });
});
