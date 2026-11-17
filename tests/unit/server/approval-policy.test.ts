/**
 * Issue 160: the approval policy (shared/approval-policy.ts) as the held
 * writes' route applies it (approval-routes.ts). A write that widens what
 * an agent may do always waits for the person's Allow; every other one
 * runs at once under the defaults, logged, and the person's updates say
 * so. A project's "ask" brings the Allow back; no setting lowers a
 * critical write; an agent may still ask, saying why.
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
  pinsAsWatched,
  policyFor,
  readPolicySetting,
  writeTargets,
} from "../../../src/shared/approval-policy.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import {
  createApprovalQueue,
  handleApprovalRoutes,
  notePolicyRun,
  type HeldActions,
} from "../../../src/ui/server/approval-routes.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import {
  setPrincipal,
  type GuardResult,
  type Principal,
} from "../../../src/ui/server/request-guard.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-policy-"));
const store = new NotificationStore(stateDir);
const modes: unknown[] = [];
const clones: unknown[] = [];
const personas: unknown[] = [];
const prs: string[] = [];

const ok = (summary: string, args: Record<string, unknown>) => ({
  ok: true as const,
  args,
  summary,
  params: {},
  details: [],
});
const actions: HeldActions = {
  // As checkProjectMode words it: a looser mode is personOnly (widens).
  project_mode: {
    check: (a) => ({
      ...ok(`set project north's mode: edits → ${String(a.mode)}`, {
        project: "north",
        mode: String(a.mode),
      }),
      ...(a.mode === "auto" ? { personOnly: true } : {}),
    }),
    run: async (a) => {
      modes.push(a.mode);
      return { ok: true };
    },
  },
  repo_clone: {
    // Issue 160: `wipe` stands in for a check that says it deletes data.
    check: (a) => ({
      ...ok(`clone ${String(a.source)} into ~/repos`, {
        source: String(a.source),
      }),
      ...(a.wipe ? { areas: ["deletes" as const] } : {}),
    }),
    run: async (a) => {
      clones.push(a.source);
      return { ok: true };
    },
  },
  // Issue 160: closing a stale or superseded PR after a Hub note.
  pr_close: {
    check: (a) =>
      ok(`close PR ${String(a.pr)} on ${String(a.repo)}`, {
        repo: String(a.repo),
        pr: Number(a.pr),
        comment: String(a.comment),
      }),
    run: async (a) => {
      prs.push(`${String(a.repo)}#${String(a.pr)}`);
      return { ok: true };
    },
  },
  persona_update: {
    check: (a) =>
      ok(`change persona ${String(a.id)}`, {
        id: String(a.id),
        project: "north",
      }),
    run: async (a) => {
      personas.push(a.id);
      return { ok: true };
    },
  },
};
const queue = createApprovalQueue(actions, () => stateDir);

/** The settings as the server reads them: user.yml's and each project's. */
let install: unknown = undefined;
const projects: Record<string, unknown> = {};
/** The person's rail pins (user.yml shell.pins): their favorites. */
const pins: string[] = [];
const notified: { id: string; project?: string; from: string }[] = [];

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
  mintActorToken(stateDir, {
    agentId: "lead",
    workspace: "north",
    sessionName: "acme-north:lead",
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
        // As the server wires it (index.ts): what the write is on, the
        // person's watch lists and rail pins.
        policy: (action, project, widens, asked) =>
          policyFor(action, {
            widens,
            areas: asked?.areas,
            install: readPolicySetting(install),
            project: project
              ? readPolicySetting(projects[project], `${project}.approvals`)
              : undefined,
            targets: writeTargets(action, asked?.args ?? {}, project),
            pins: pinsAsWatched(pins),
          }),
        notify: (a, project, from) => {
          notified.push({ id: a.id, project, from });
          notePolicyRun(store, a, project);
        },
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

const ask = (body: Record<string, unknown>) =>
  fetch(`${base}/api/approvals`, {
    method: "POST",
    headers: { "x-test-agent": "lead", "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({
    status: r.status,
    body: (await r.json()) as {
      id: string;
      state: string;
      code?: string;
      askedBecause?: string;
    },
  }));

/** Fresh settings and records; what still waits is denied (5 may wait). */
const reset = async () => {
  for (const a of queue.pending()) await queue.decide(a.id, "deny", "s1");
  install = undefined;
  for (const k of Object.keys(projects)) delete projects[k];
  pins.length = 0;
  modes.length = 0;
  clones.length = 0;
  personas.length = 0;
  prs.length = 0;
  notified.length = 0;
};

describe("issue 160: the approval policy", () => {
  it("project_mode narrowing runs with no Allow and leaves a notify record", async () => {
    await reset();
    const r = await ask({ action: "project_mode", args: { mode: "ask" } });
    expect([r.status, r.body.state]).toEqual([202, "done"]);
    expect(modes).toEqual(["ask"]);
    expect(notified).toEqual([
      { id: r.body.id, project: "north", from: "default" },
    ]);
    const note = store
      .list()
      .find((n) => n.subject === `record:approval-${r.body.id}`);
    expect(note).toMatchObject({
      kind: "service",
      scope: "workspace/north",
      msg: {
        key: "bell.m.policyRan",
        vars: { name: "lead", what: "set project north's mode: edits → ask" },
      },
    });
  });

  it("project_mode widening is still held, even with every setting at auto", async () => {
    await reset();
    install = { policy: "auto", writes: { project_mode: "auto" } };
    projects.north = { policy: "auto", writes: { project_mode: "auto" } };
    const r = await ask({ action: "project_mode", args: { mode: "auto" } });
    expect(r.body.state).toBe("pending");
    expect(modes).toEqual([]);
    expect(notified).toEqual([]);
  });

  it("a routine held write runs with no Allow under the defaults", async () => {
    await reset();
    const r = await ask({ action: "repo_clone", args: { source: "o/r" } });
    expect(r.body.state).toBe("done");
    // Logged: the request says what allowed it (the trail has it too).
    expect(queue.get(r.body.id)?.decidedBy).toBe(
      "auto:approvals policy: notify (default)",
    );
    expect(clones).toEqual(["o/r"]);
  });

  it("auto runs it and tells no one; the trail still has it", async () => {
    await reset();
    install = { policy: "auto" };
    const r = await ask({ action: "repo_clone", args: { source: "o/a" } });
    expect(r.body.state).toBe("done");
    expect(clones).toEqual(["o/a"]);
    expect(notified).toEqual([]);
  });

  it('a project setting of "ask" brings the Allow back', async () => {
    await reset();
    projects.north = { policy: "ask" };
    const r = await ask({ action: "repo_clone", args: { source: "o/p" } });
    expect(r.body.state).toBe("pending");
    expect(clones).toEqual([]);
    // One write's own: also back to ask, over a permissive install.
    await reset();
    install = { policy: "auto" };
    projects.north = { writes: { repo_clone: "ask" } };
    expect(
      (await ask({ action: "repo_clone", args: { source: "o/q" } })).body.state,
    ).toBe("pending");
  });

  it("critical can't be lowered", async () => {
    await reset();
    install = { policy: "auto", writes: { persona_update: "auto" } };
    projects.north = { writes: { persona_update: "notify" } };
    const r = await ask({ action: "persona_update", args: { id: "p" } });
    expect(r.body.state).toBe("pending");
    expect(personas).toEqual([]);
    expect(
      policyFor("persona_update", {
        install: { writes: { persona_update: "auto" } },
      }),
    ).toEqual({ kind: "ask", from: "critical" });
    expect(
      policyFor("project_mode", { widens: true, install: { policy: "auto" } }),
    ).toEqual({ kind: "ask", from: "critical" });
    // A held write nobody placed is critical.
    expect(isCriticalWrite("something_new", false)).toBe(true);
  });

  it("a Verify run on a shared environment is critical (issue 208): no setting lowers it", () => {
    expect(isCriticalWrite("verify_run", false)).toBe(true);
    expect(
      policyFor("verify_run", {
        install: { policy: "auto", writes: { verify_run: "auto" } },
      }),
    ).toEqual({ kind: "ask", from: "critical" });
  });

  it("widening a project's reach is critical: repo_add gives its agents a repo they couldn't touch", () => {
    expect(isCriticalWrite("repo_add", false)).toBe(true);
    expect(policyFor("repo_add", { install: { policy: "auto" } })).toEqual({
      kind: "ask",
      from: "critical",
    });
  });

  it("a project's extra MCP servers are critical (issues 335, 352): add, remove and update; no setting lowers them", () => {
    for (const w of [
      "project_mcp_add",
      "project_mcp_remove",
      "project_mcp_update",
    ]) {
      expect([w, HELD_WRITE_RISK[w]?.risk]).toEqual([w, "critical"]);
      expect([w, isCriticalWrite(w, false)]).toEqual([w, true]);
      // project_mcp_remove's name also says "deletes" (CRITICAL_AREAS).
      const p = policyFor(w, {
        install: { policy: "auto", writes: { [w]: "auto" } },
      });
      expect([w, p.kind, p.from]).toEqual([
        w,
        "ask",
        expect.stringMatching(/^critical/),
      ]);
    }
  });

  it("an agent may still ask, and says why", async () => {
    await reset();
    const noWhy = await ask({
      action: "repo_clone",
      args: { source: "o/w" },
      ask: true,
    });
    expect([noWhy.status, noWhy.body.code]).toEqual([400, "ask_needs_note"]);
    const r = await ask({
      action: "repo_clone",
      args: { source: "o/w" },
      ask: true,
      note: "it is a big repo; you may not want it here",
    });
    expect(r.body.state).toBe("pending");
    expect(clones).toEqual([]);
  });

  it("a bad setting holds the write", async () => {
    await reset();
    install = { policy: "sometimes" };
    const r = await ask({ action: "repo_clone", args: { source: "o/b" } });
    expect(r.body.state).toBe("pending");
    expect(() => readPolicySetting({ policy: "sometimes" })).toThrow(
      /approvals.policy: auto, notify or ask/,
    );
  });

  it("every held write is placed on the critical list", () => {
    const names = Object.keys(
      heldActions({} as Parameters<typeof heldActions>[0]),
    );
    // Issue 160: pr_close too: it is a held write now, not only a kind.
    expect(names).toContain("pr_close");
    // Issue 271: asking Hub for a new project is a held write too.
    expect(names).toContain("hub_project_create");
    expect(Object.keys(HELD_WRITE_RISK).sort()).toEqual([...names].sort());
  });

  it("issue 271: hub_project_create is routine: Hub's owner still decides", () => {
    expect(HELD_WRITE_RISK.hub_project_create.risk).toBe("routine");
    expect(isCriticalWrite("hub_project_create", false)).toBe(false);
    expect(policyFor("hub_project_create", {})).toEqual({
      ...policyFor("repo_clone", {}),
      from: expect.any(String),
    });
  });
});

describe("issue 160 (0.4.65): watched, critical, person-only, first uses", () => {
  it("a write on something the person watches asks, even under auto", async () => {
    await reset();
    install = { policy: "auto", watch: ["repo:r"] };
    const r = await ask({ action: "repo_clone", args: { source: "o/r" } });
    expect([r.body.state, r.body.askedBecause]).toEqual([
      "pending",
      "watched repo:r",
    ]);
    expect(clones).toEqual([]);
    // Another repo still runs.
    expect(
      (await ask({ action: "repo_clone", args: { source: "o/other" } })).body
        .state,
    ).toBe("done");
    // A project's watch list: its own project, a bare name matching any kind.
    await reset();
    projects.north = { policy: "notify", watch: ["north"] };
    const m = await ask({ action: "project_mode", args: { mode: "ask" } });
    expect([m.body.state, m.body.askedBecause]).toEqual([
      "pending",
      "watched project:north",
    ]);
    expect(modes).toEqual([]);
  });

  it("a write on a repo or service the person pinned (their favorite) asks", async () => {
    await reset();
    install = { policy: "auto" };
    pins.push("r");
    const r = await ask({ action: "repo_clone", args: { source: "o/r" } });
    expect([r.body.state, r.body.askedBecause]).toEqual([
      "pending",
      "favorited repo:r",
    ]);
    expect(pinsAsWatched(["api", "api/web"])).toEqual([
      "repo:api",
      "service:api/web",
    ]);
    expect(
      writeTargets("service_try", { service: "api/web" }, "north"),
    ).toEqual(["project:north", "service:api/web", "repo:api"]);
  });

  it("secrets, deletes of data and money are critical by name, not by the unknown-write fallback", () => {
    const auto = { install: { policy: "auto" as const, writes: {} } };
    for (const [w, area] of [
      ["secret_set", "secrets"],
      ["token_rotate", "secrets"],
      ["data_delete", "deletes"],
      ["volume_purge", "deletes"],
      ["payment_send", "money"],
      ["billing_change", "money"],
    ])
      expect([
        w,
        policyFor(w, {
          ...auto,
          install: { policy: "auto", writes: { [w]: "auto" } },
        }),
      ]).toEqual([w, { kind: "ask", from: `critical: ${area}` }]);
    // A write nobody placed and that touches none of them: the fallback.
    expect(policyFor("something_new", auto)).toEqual({
      kind: "ask",
      from: "critical",
    });
  });

  it("a write whose check says it deletes data asks, though its kind is routine", async () => {
    await reset();
    install = { policy: "auto", writes: { repo_clone: "auto" } };
    const r = await ask({
      action: "repo_clone",
      args: { source: "o/x", wipe: true },
    });
    expect([r.body.state, r.body.askedBecause]).toEqual([
      "pending",
      "critical: deletes",
    ]);
    expect(clones).toEqual([]);
  });

  it("a project's own critical list makes those kinds ask", async () => {
    await reset();
    install = { policy: "auto" };
    projects.north = { critical: ["repo_clone"] };
    const r = await ask({ action: "repo_clone", args: { source: "o/c" } });
    expect([r.body.state, r.body.askedBecause]).toEqual([
      "pending",
      "project approvals.critical",
    ]);
    // Over the project's own writes setting too.
    expect(
      policyFor("repo_clone", {
        project: { critical: ["repo_clone"], writes: { repo_clone: "auto" } },
      }),
    ).toEqual({ kind: "ask", from: "project approvals.critical" });
    expect(() => readPolicySetting({ critical: ["Not A Kind"] })).toThrow(
      /approvals.critical/,
    );
  });

  it("a change to the policy itself always asks: no setting lowers it", () => {
    expect(
      policyFor("approval_policy", {
        install: { policy: "auto", writes: { approval_policy: "auto" } },
        project: { policy: "auto", writes: { approval_policy: "auto" } },
      }),
    ).toEqual({ kind: "ask", from: "critical" });
  });

  it("agent_import asks by default; only a writes setting naming it lowers it", () => {
    expect(isCriticalWrite("agent_import", false)).toBe(false);
    expect(policyFor("agent_import", {})).toEqual({
      kind: "ask",
      from: "agent_import's own kind",
    });
    expect(
      policyFor("agent_import", {
        install: { policy: "auto" },
        project: { policy: "notify" },
      }),
    ).toEqual({ kind: "ask", from: "agent_import's own kind" });
    expect(
      policyFor("agent_import", {
        install: { writes: { agent_import: "notify" } },
      }),
    ).toEqual({ kind: "notify", from: "approvals.writes.agent_import" });
  });

  it("pr_close runs at once under the defaults; on a watched or pinned repo it waits", async () => {
    await reset();
    const r = await ask({
      action: "pr_close",
      args: { repo: "acme/api", pr: 7, comment: "superseded" },
    });
    expect(r.body.state).toBe("done");
    expect(prs).toEqual(["acme/api#7"]);
    // Watched by its local name, or by owner/name; or pinned to the rail.
    for (const set of [
      () => (install = { watch: ["repo:api"] }),
      () => (install = { watch: ["repo:acme/api"] }),
      () => pins.push("api"),
    ]) {
      await reset();
      set();
      const w = await ask({
        action: "pr_close",
        args: { repo: "acme/api", pr: 8, comment: "stale" },
      });
      expect(w.body.state).toBe("pending");
      expect(w.body.askedBecause).toMatch(/^(watched|favorited) repo:/);
      expect(prs).toEqual([]);
    }
  });

  it("pr_close (closing a stale or superseded PR after a Hub note): auto unless watched", () => {
    expect(isCriticalWrite("pr_close", false)).toBe(false);
    expect(policyFor("pr_close", {})).toEqual({
      kind: "auto",
      from: "pr_close's own kind",
    });
    expect(
      policyFor("pr_close", {
        install: { watch: ["repo:api"] },
        targets: writeTargets("pr_close", { repo: "api" }, "north"),
      }),
    ).toEqual({ kind: "ask", from: "watched repo:api" });
    // A stricter policy wins over its own kind.
    expect(policyFor("pr_close", { install: { policy: "ask" } })).toEqual({
      kind: "ask",
      from: "approvals.policy",
    });
  });
});
