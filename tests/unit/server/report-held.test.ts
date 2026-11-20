/**
 * Issue 565: agents use Report. The held write `report` files through the
 * same path as the page's Send (report-routes.ts fileReport): the same
 * destinations and visibility labels, the same scrub, an optional
 * screenshot. To a public (or not known) destination it is the person's
 * own Allow and is never sent without one; to a private one it follows
 * the approval policy. The audit says who filed it and where. `gh` is a
 * fake: never the real one. Invented names only; a temp state directory.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { mintActorToken } from "../../../src/shared/actor-token.js";
import {
  HELD_WRITE_RISK,
  isCriticalWrite,
  policyFor,
  readPolicySetting,
  writeTargets,
} from "../../../src/shared/approval-policy.js";
import {
  feedbackSettings,
  draftStore,
} from "../../../src/shared/report-store.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
} from "../../../src/ui/server/approval-routes.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import { reportHeld } from "../../../src/ui/server/report-held.js";
import {
  reportDestinations,
  type GhResult,
  type ReportRouteDeps,
} from "../../../src/ui/server/report-routes.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-report-held-"));
const PUB = "acme-eng/engine";
const PRIV = "acme-eng/inside";
const VIS: Record<string, string> = { [PUB]: "public", [PRIV]: "private" };
const calls: { args: string[]; stdin?: string }[] = [];
const audits: unknown[] = [];

const gh = async (args: string[], stdin?: string): Promise<GhResult> => {
  calls.push({ args, stdin });
  if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
  const repo = /^repos\/([^/]+\/[^/]+)$/.exec(args[1] ?? "")?.[1];
  if (args[0] === "api" && repo)
    return VIS[repo]
      ? {
          code: 0,
          stdout: JSON.stringify({ visibility: VIS[repo] }),
          stderr: "",
        }
      : { code: 1, stdout: "", stderr: "HTTP 404" };
  if (args[0] === "api") return { code: 1, stdout: "", stderr: "HTTP 404" };
  if (args[0] === "issue" && args[1] === "list")
    return { code: 0, stdout: "[]", stderr: "" };
  if (args[0] === "issue" && args[1] === "create")
    return {
      code: 0,
      stdout: `https://github.com/${args[3]}/issues/77\n`,
      stderr: "",
    };
  return { code: 0, stdout: "", stderr: "" };
};

const filed = () =>
  calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");

const deps: ReportRouteDeps = {
  settings: () => ({
    ...feedbackSettings(
      { bugs: `https://github.com/${PUB}/issues` },
      { repo: PRIV },
      {},
    ),
    visibilityRetrySeconds: 0,
    visibilityCacheHours: 0,
  }),
  stateDir: () => stateDir,
  gh,
  names: () => ({ home: "/home/pat", hosts: ["pat-laptop.lan"] }),
  diagnostics: async () => ({ Den: "den 9.9.9", Machine: "os: test" }),
  agentOf: () => null,
  personOf: () => "person",
  readBody: async () => "",
  sendJson: () => undefined,
  audit: (e) => audits.push(e),
};

const report = reportHeld(deps);
// As the server wires it: heldActions' `report` is this one.
const actions = { report: heldActions({ report } as never).report! };
const queue = createApprovalQueue(actions, () => stateDir);
let install: unknown = undefined;

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

let server: http.Server;
let base = "";
beforeAll(async () => {
  mintActorToken(stateDir, {
    agentId: "scout",
    workspace: "north",
    sessionName: "acme-north:scout",
  });
  server = http.createServer((req, res) => {
    const p = principalFor(req);
    setPrincipal(req, p);
    const guard = {
      ok: true,
      principal: p,
      via: "loopback",
      beyond: false,
      session: null,
    } as unknown as Extract<GuardResult, { ok: true }>;
    void handleApprovalRoutes(
      req,
      res,
      new URL(req.url!, "http://x").pathname,
      guard,
      {
        queue,
        actions,
        enabled: () => true,
        policy: (action, project, widens, asked) =>
          policyFor(action, {
            widens,
            areas: asked?.areas,
            install: readPolicySetting(install),
            targets: writeTargets(action, asked?.args ?? {}, project),
          }),
      },
    ).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const ask = (args: Record<string, unknown>) =>
  fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: { "x-test-agent": "scout", "content-type": "application/json" },
    body: JSON.stringify({ action: "report", args }),
  }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as {
      id: string;
      state: string;
      details?: string[];
      askedBecause?: string;
      result?: { ok?: boolean; url?: string; repo?: string };
      error?: string;
    },
  }));

const reset = async () => {
  for (const a of queue.pending()) await queue.decide(a.id, "deny", "s1");
  calls.length = 0;
  audits.length = 0;
  install = undefined;
};

/** A secret-shaped token and a home path: the scrub must remove both. */
const LEAKY =
  "Broke at /home/pat/den/x.ts with ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 from pat@example.com";

describe("issue 565: the held write `report`", () => {
  it("is placed: critical when it widens (public), routine otherwise", () => {
    expect(HELD_WRITE_RISK.report?.risk).toBe("widens");
    expect(isCriticalWrite("report", true)).toBe(true);
    expect(isCriticalWrite("report", false)).toBe(false);
  });

  it("to a public destination waits for the person's Allow and is never sent without one", async () => {
    await reset();
    // Even with the policy at auto: public is the person's own Allow.
    install = { policy: "auto", writes: { report: "auto" } };
    const r = await ask({ kind: "bug", title: "Agents page blank", repo: PUB });
    expect(r.status).toBe(202);
    expect(r.body.state).toBe("pending");
    expect(r.body.askedBecause).toBe("critical");
    expect(filed()).toEqual([]);
    // The dialog says where, and that it is public.
    expect(r.body.details?.join("\n")).toMatch(
      /Goes to: acme-eng\/engine \(Public repository\)/,
    );
    expect(r.body.details?.join("\n")).toMatch(/visible to everyone/);
    // Denied: nothing was sent.
    await queue.decide(r.body.id, "deny", "s1");
    expect(filed()).toEqual([]);
  });

  it("a destination whose visibility is not known is treated as public", async () => {
    await reset();
    install = { policy: "auto" };
    const c = await report.check(
      { kind: "bug", title: "x", repo: PRIV },
      { agent: "scout", project: "north" },
    );
    expect(c.ok && c.personOnly).toBeFalsy();
    VIS[PRIV] = "";
    try {
      const u = await report.check(
        { kind: "bug", title: "x", repo: PRIV },
        { agent: "scout", project: "north" },
      );
      expect(u.ok && u.personOnly).toBe(true);
      expect(u.ok && u.details.join("\n")).toMatch(/Visibility not known/);
    } finally {
      VIS[PRIV] = "private";
    }
  });

  it("on Allow it files as the person, scrubbed exactly as the page's preview, and the audit names the agent", async () => {
    await reset();
    const r = await ask({
      kind: "bug",
      title: "Agents page blank",
      description: LEAKY,
      page: "/agents",
      repo: PUB,
    });
    expect(r.body.state).toBe("pending");
    const d = await queue.decide(r.body.id, "allow", "s1");
    expect(d.ok).toBe(true);
    const sent = filed();
    expect(sent).toHaveLength(1);
    const body = sent[0]!.stdin ?? "";
    expect(body).not.toMatch(/ghp_/);
    expect(body).not.toMatch(/\/home\/pat/);
    expect(body).not.toMatch(/pat@example\.com/);
    // The Den version and the page go with it.
    expect(body).toMatch(/den 9\.9\.9/);
    expect(body).toMatch(/\*\*Page:\*\* \/agents/);
    expect(audits).toEqual([
      {
        by: "agent:scout",
        repo: PUB,
        url: `https://github.com/${PUB}/issues/77`,
        added: false,
      },
    ]);
  });

  it("to a private destination follows the approval policy: runs at once by default", async () => {
    await reset();
    const r = await ask({ kind: "idea", title: "Sort by date", repo: PRIV });
    expect(r.body.state).toBe("done");
    expect(r.body.result?.ok).toBe(true);
    expect(filed()).toHaveLength(1);
    // A policy of ask holds it.
    await reset();
    install = { writes: { report: "ask" } };
    const h = await ask({ kind: "idea", title: "Sort by date", repo: PRIV });
    expect(h.body.state).toBe("pending");
    expect(filed()).toEqual([]);
  });

  it("only this install's destinations; never another repo", async () => {
    await reset();
    const r = await ask({ kind: "bug", title: "x", repo: "elsewhere/other" });
    expect(r.status).toBe(400);
    expect(filed()).toEqual([]);
  });

  it("the destinations and their labels are the page's (reportDestinations)", async () => {
    const d = await reportDestinations(deps);
    expect(d.repos).toEqual([
      { repo: PUB, visibility: "public" },
      { repo: PRIV, visibility: "private" },
    ]);
  });

  it("an optional screenshot goes with it from the agent's own draft", async () => {
    await reset();
    const png =
      "data:image/png;base64," +
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(32),
      ]).toString("base64");
    const draft = draftStore(stateDir).save({
      by: "agent:scout",
      kind: "bug",
      title: "Agents page blank",
      description: "",
      sections: {},
      redact: true,
      shot: png,
    });
    const r = await ask({
      kind: "bug",
      title: "Agents page blank",
      repo: PRIV,
      draftId: draft.id,
    });
    expect(r.body.state).toBe("done");
    expect(filed()[0]!.stdin).toMatch(
      new RegExp(`report_screenshot\\(${draft.id}\\)`),
    );
    // Another agent's draft is refused.
    const other = draftStore(stateDir).save({
      by: "agent:someone-else",
      kind: "bug",
      title: "t",
      description: "",
      sections: {},
      redact: true,
      shot: png,
    });
    const o = await ask({
      kind: "bug",
      title: "t",
      repo: PRIV,
      draftId: other.id,
    });
    expect(o.status).toBe(400);
  });
});
