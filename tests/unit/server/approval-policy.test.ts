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
  policyFor,
  readPolicySetting,
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
    check: (a) =>
      ok(`clone ${String(a.source)} into ~/repos`, {
        source: String(a.source),
      }),
    run: async (a) => {
      clones.push(a.source);
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
        policy: (action, project, widens) =>
          policyFor(action, {
            widens,
            install: readPolicySetting(install),
            project: project
              ? readPolicySetting(projects[project], `${project}.approvals`)
              : undefined,
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
    },
  }));

/** Fresh settings and records; what still waits is denied (5 may wait). */
const reset = async () => {
  for (const a of queue.pending()) await queue.decide(a.id, "deny", "s1");
  install = undefined;
  for (const k of Object.keys(projects)) delete projects[k];
  modes.length = 0;
  clones.length = 0;
  personas.length = 0;
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
    ).sort();
    expect(Object.keys(HELD_WRITE_RISK).sort()).toEqual(names);
  });
});
