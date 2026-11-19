/**
 * Issue 565: agents use Den's Report. An agent's report is the held write
 * `report` (report-held.ts), filed through the browser's own path
 * (report-routes.ts): the same targets and labels, the same scrub, the
 * same filing. To a public target it waits for the person's Allow and is
 * never sent without one, whatever the approval policy says; to a private
 * one it follows the policy like any other write. The issue says which
 * agent filed it, and the audit says who filed it and where.
 *
 * `gh` is a fake: never the real one. Invented names; a temp state dir.
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
import { mintActorToken } from "../../../src/shared/actor-token.js";
import { policyFor } from "../../../src/shared/approval-policy.js";
import { feedbackSettings } from "../../../src/shared/report-store.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
  type HeldActions,
} from "../../../src/ui/server/approval-routes.js";
import { agentLine, reportHeld } from "../../../src/ui/server/report-held.js";
import {
  handleReportRoutes,
  type GhResult,
  type ReportRouteDeps,
} from "../../../src/ui/server/report-routes.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const PUBLIC = "acme-eng/engine";
const PRIVATE = "acme-dist/tracker";
/** A token the scrub must take out (the shape redact.ts knows). */
const TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

let state = "";
let signedIn = true;
const calls: { args: string[]; stdin?: string }[] = [];
const audits: Record<string, unknown>[] = [];

const gh = async (args: string[], stdin?: string): Promise<GhResult> => {
  calls.push({ args, stdin });
  if (args[0] === "auth")
    return { code: signedIn ? 0 : 1, stdout: "", stderr: "" };
  if (args[0] === "api" && args[1] === `repos/${PUBLIC}`)
    return { code: 0, stdout: '{"visibility":"public"}', stderr: "" };
  if (args[0] === "api" && args[1] === `repos/${PRIVATE}`)
    return { code: 0, stdout: '{"visibility":"private"}', stderr: "" };
  if (args[0] === "api") return { code: 0, stdout: "{}", stderr: "" };
  if (args[0] === "issue" && args[1] === "list")
    return { code: 0, stdout: "[]", stderr: "" };
  if (args[0] === "issue" && args[1] === "create")
    return {
      code: 0,
      stdout: `https://github.com/${args[3]}/issues/42\n`,
      stderr: "",
    };
  return { code: 1, stdout: "", stderr: "unknown" };
};

const deps: ReportRouteDeps = {
  settings: () =>
    feedbackSettings(
      { bugs: { url: `https://github.com/${PUBLIC}/issues` } },
      { repo: PRIVATE },
      {},
    ),
  stateDir: () => state,
  gh,
  names: () => ({
    home: "/Users/pat",
    hosts: ["acme.local.example.com"],
    projects: ["rocket"],
  }),
  diagnostics: async () => ({ Den: "den 9.9.9" }),
  agentOf: (r) => {
    const a = r.headers["x-test-agent"];
    return typeof a === "string" ? a : null;
  },
  personOf: () => "person",
  audit: (e) => audits.push(e as unknown as Record<string, unknown>),
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

const actions: HeldActions = { report: reportHeld(deps) };
let queue = createApprovalQueue(actions, () => state);
let server: http.Server;
let base = "";

function principalFor(req: http.IncomingMessage): Principal {
  const id = req.headers["x-test-agent"];
  return typeof id === "string"
    ? {
        kind: "agent",
        actor: `agent:${id}`,
        workspace: "north",
        grants: [],
        session: { name: `acme-north:${id}` },
      }
    : { kind: "person-browser", session: "s1" };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const p = principalFor(req);
    setPrincipal(req, p);
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (handleReportRoutes(req, res, pathname, deps)) return;
    const guard = {
      ok: true,
      principal: p,
      via: "loopback",
      beyond: false,
      session: null,
    } as unknown as Extract<GuardResult, { ok: true }>;
    void handleApprovalRoutes(req, res, pathname, guard, {
      queue,
      actions,
      // The loosest policy there is: every routine write runs at once.
      policy: (action, _project, widens, ask) => ({
        ...policyFor(action, {
          widens,
          ...(ask?.areas ? { areas: ask.areas } : {}),
          install: { policy: "auto" },
        }),
      }),
      // And a setting that would allow every ask.
      autoAllow: () => "a setting that allows every ask",
    }).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "den-report-held-"));
  queue = createApprovalQueue(actions, () => state);
  mintActorToken(state, {
    agentId: "scout",
    workspace: "north",
    sessionName: "acme-north:scout",
  });
  signedIn = true;
  calls.length = 0;
  audits.length = 0;
});

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
      ...(agent ? { "x-test-agent": agent } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test reads nested JSON
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};

const FORM = {
  kind: "bug",
  title: "Pane at acme.local.example.com drops",
  description: `In /Users/pat/rocket the pane drops. Token ${TOKEN}.`,
};
const created = () =>
  calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");

describe("issue 565: an agent's report is a held write", () => {
  it("to a public target it waits for the person's Allow, and nothing is sent without one", async () => {
    const r = await call(
      "POST",
      "/api/approvals",
      { action: "report", args: { ...FORM, repo: PUBLIC } },
      "scout",
    );
    expect(r.status).toBe(202);
    expect(r.body.state).toBe("pending");
    expect(r.body.askedBecause).toMatch(/critical/);
    // The person sees what will be posted, with the public warning.
    const det = (r.body.details as string[]).join("\n");
    expect(det).toContain(PUBLIC);
    expect(det).toMatch(/visible to everyone/i);
    expect(created()).toEqual([]);
    // Denied: still nothing.
    await queue.decide(String(r.body.id), "deny", "s1");
    expect(created()).toEqual([]);
  });

  it("allowed, it is filed through the browser's path and says which agent filed it; the audit says who and where", async () => {
    const r = await call(
      "POST",
      "/api/approvals",
      { action: "report", args: { ...FORM, repo: PUBLIC } },
      "scout",
    );
    const d = await queue.decide(String(r.body.id), "allow", "s1");
    expect(d.ok).toBe(true);
    const c = created();
    expect(c).toHaveLength(1);
    expect(c[0]!.args.slice(0, 4)).toEqual(["issue", "create", "-R", PUBLIC]);
    expect(c[0]!.stdin).toMatch(/agent scout/);
    expect(audits).toEqual([
      expect.objectContaining({
        by: "agent:scout",
        repo: PUBLIC,
        url: `https://github.com/${PUBLIC}/issues/42`,
      }),
    ]);
  });

  it("an agent can't claim another agent filed it", async () => {
    const r = await call(
      "POST",
      "/api/approvals",
      { action: "report", args: { ...FORM, repo: PUBLIC, from: "other" } },
      "scout",
    );
    await queue.decide(String(r.body.id), "allow", "s1");
    expect(created()[0]!.stdin).toMatch(/agent scout/);
    expect(created()[0]!.stdin).not.toMatch(/agent other/);
  });

  it("to a private target it follows the approval policy like any other write", async () => {
    const r = await call(
      "POST",
      "/api/approvals",
      { action: "report", args: { ...FORM, repo: PRIVATE } },
      "scout",
    );
    expect(r.status).toBe(202);
    expect(r.body.state).toBe("done");
    expect(created()).toHaveLength(1);
    expect(created()[0]!.args[3]).toBe(PRIVATE);
  });

  it("the scrub runs exactly as the browser's preview", async () => {
    // The browser's preview of the same report, with the agent's line.
    const preview = await call("POST", "/api/report/preview", {
      ...FORM,
      description: `${FORM.description}\n\n${agentLine("scout")}`,
      repo: PRIVATE,
      sections: {},
    });
    expect(preview.status).toBe(200);
    await call(
      "POST",
      "/api/approvals",
      { action: "report", args: { ...FORM, repo: PRIVATE } },
      "scout",
    );
    const c = created()[0]!;
    expect(c.args[5]).toBe(preview.body.title);
    expect(c.stdin).toBe(preview.body.body);
    expect(c.stdin).not.toContain(TOKEN);
    expect(c.stdin).not.toMatch(/\/Users\/pat|acme\.local\.example\.com/);
  });

  it("the targets and their labels are the browser's", async () => {
    const info = await call("GET", "/api/report", undefined, "scout");
    expect(info.body.repos).toEqual([
      { repo: PUBLIC, visibility: "public" },
      { repo: PRIVATE, visibility: "private" },
    ]);
    const bad = await call(
      "POST",
      "/api/approvals",
      { action: "report", args: { ...FORM, repo: "acme-eng/elsewhere" } },
      "scout",
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/no such destination/);
  });

  it("not signed in to GitHub: nothing is asked, and the GitHub issue link is the fallback", async () => {
    signedIn = false;
    const r = await call(
      "POST",
      "/api/approvals",
      { action: "report", args: { ...FORM, repo: PUBLIC } },
      "scout",
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(
      /https:\/\/github\.com\/acme-eng\/engine\/issues\/new\?title=/,
    );
    expect(created()).toEqual([]);
  });

  it("a screenshot is an image file the person sees named before Allow", async () => {
    const shot = path.join(state, "pane.png");
    fs.writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await call(
      "POST",
      "/api/approvals",
      {
        action: "report",
        args: { ...FORM, repo: PUBLIC, screenshot: shot },
      },
      "scout",
    );
    expect(r.status).toBe(202);
    expect((r.body.details as string[]).join("\n")).toContain("pane.png");
    const notImage = await call(
      "POST",
      "/api/approvals",
      {
        action: "report",
        args: { ...FORM, repo: PUBLIC, screenshot: path.join(state, "x.txt") },
      },
      "scout",
    );
    expect(notImage.status).toBe(400);
  });
});
