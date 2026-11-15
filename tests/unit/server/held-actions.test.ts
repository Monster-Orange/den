/**
 * The held writes' own logic (held-actions.ts), with fake deps: the
 * server agent's workspace_create makes the workspace active, and
 * service_try on an inactive workspace says it activates it and does, on
 * the one Allow. Nothing an agent calls activates a workspace otherwise.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  heldActions,
  type HeldActionDeps,
} from "../../../src/ui/server/held-actions.js";

function fakes(): {
  deps: HeldActionDeps;
  made: Set<string>;
  active: Set<string>;
  tried: string[];
} {
  const made = new Set<string>(["default", "repos"]);
  const active = new Set<string>(["default"]);
  const tried: string[] = [];
  const deps: HeldActionDeps = {
    rules: () => ({ home: "/home/x" }) as never,
    validate: () => ({ ok: true }) as never,
    workspaceCreateRefusal: () => null,
    createWorkspace: (n) => {
      made.add(n);
      return n;
    },
    activateWorkspace: (n) => void active.add(n),
    workspaceActive: (n) => active.has(n),
    workspaceExists: (n) => made.has(n),
    defaultWorkspace: () => "default",
    serviceTarget: (s) => ({ ok: true, address: s }),
    tryService: async (address, ws) => {
      tried.push(
        `${address}@${ws ?? ""}:${ws && active.has(ws) ? "active" : "inactive"}`,
      );
      return { ok: true, exitCode: null, ready: true, lines: [] };
    },
  };
  return { deps, made, active, tried };
}

describe("held actions activate the workspace they need", () => {
  it("workspace_create's run creates the workspace and makes it active", async () => {
    const f = fakes();
    const a = heldActions(f.deps).workspace_create;
    const c = await a.check({ name: "web" });
    expect(c.ok).toBe(true);
    const r = await a.run({ name: "web" });
    expect(f.made.has("web")).toBe(true);
    expect(f.active.has("web")).toBe(true);
    expect(r).toEqual({ ok: true, name: "web", slug: "web", active: true });
  });

  it("service_try on an inactive workspace: the Review says it activates it, and the Allow does both", async () => {
    const f = fakes();
    const a = heldActions(f.deps).service_try;
    const c = await a.check({ service: "shop", workspace: "repos" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.summary).toBe(
      'start shop in project "repos" (this activates repos)',
    );
    expect(c.params).toEqual({
      service: "shop",
      workspace: "repos",
      activates: "1",
    });
    await a.run(c.args);
    expect(f.tried).toEqual(["shop@repos:active"]);
  });

  it("service_try on an active workspace says nothing about activating", async () => {
    const f = fakes();
    const c = await heldActions(f.deps).service_try.check({
      service: "shop",
      workspace: "default",
    });
    expect(c.ok && c.summary).toBe('start shop in project "default"');
  });

  it("service_try on a workspace that doesn't exist is refused before anything waits", async () => {
    const f = fakes();
    const c = await heldActions(f.deps).service_try.check({
      service: "shop",
      workspace: "nope",
    });
    expect(c).toEqual({ ok: false, error: 'there is no project "nope"' });
  });
});

describe("SRV-P1: agent_create", () => {
  it("is agent-ops' check and start; a Den without them refuses", async () => {
    const f = fakes();
    expect(await heldActions(f.deps).agent_create.check({})).toEqual({
      ok: false,
      error: "this Den can't start agents here",
    });
    const ran: unknown[] = [];
    const a = heldActions({
      ...f.deps,
      agentCreate: {
        check: (x) => ({
          ok: true,
          summary: "start agent Ana (reviewer) in north, mode ask",
          params: {
            name: "Ana",
            persona: "reviewer",
            where: "north",
            mode: "ask",
          },
          details: [],
          args: {
            project: String(x.project),
            persona: "reviewer",
            mode: "ask",
          },
        }),
        run: async (x) => {
          ran.push(x);
          return { ok: true, id: "ana" };
        },
      },
    }).agent_create;
    const c = await a.check({ project: "north" });
    expect(c.ok && c.params.where).toBe("north");
    if (!c.ok) return;
    expect(await a.run(c.args)).toEqual({ ok: true, id: "ana" });
    expect(ran).toEqual([
      { project: "north", persona: "reviewer", mode: "ask" },
    ]);
  });
});

describe("SRV-P2: persona_create and persona_update", () => {
  it("are agent-ops' checks and writes; a Den without them refuses", async () => {
    const f = fakes();
    for (const k of ["persona_create", "persona_update"])
      expect(await heldActions(f.deps)[k].check({})).toEqual({
        ok: false,
        error: "this Den can't change personas here",
      });
    const wrote: unknown[] = [];
    const ok = {
      ok: true as const,
      summary: "s",
      params: {},
      details: [],
      args: { id: "x" },
    };
    const acts = heldActions({
      ...f.deps,
      personas: {
        checkCreate: () => ok,
        create: async (a) => {
          wrote.push(["create", a]);
          return { ok: true };
        },
        checkUpdate: () => ok,
        update: async (a) => {
          wrote.push(["update", a]);
          return { ok: true };
        },
      },
    });
    for (const k of ["persona_create", "persona_update"]) {
      const c = await acts[k].check({});
      if (c.ok) await acts[k].run(c.args);
    }
    expect(wrote).toEqual([
      ["create", { id: "x" }],
      ["update", { id: "x" }],
    ]);
  });
});

describe("SRV-P3: repo_clone", () => {
  it("says what it clones, where, with whose login; on Allow clones; a project's agent can't ask", async () => {
    const f = fakes();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-held-clone-"));
    try {
      const ran: string[][] = [];
      const acts = heldActions({
        ...f.deps,
        reposRoot: () => root,
        gitRun: async (args) => {
          ran.push(args);
        },
      });
      const c = await acts.repo_clone.check({ source: "acme/notes" }, {});
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      expect(c.summary).toBe(
        `clone acme/notes into ${path.join(root, "notes")}`,
      );
      expect(c.params).toEqual({
        source: "acme/notes",
        path: path.join(root, "notes"),
      });
      expect(c.details.join("\n")).toMatch(/your gh login/);
      expect(c.details.join("\n")).toMatch(/manifest_draft.*repo_add/);
      expect(await acts.repo_clone.run(c.args)).toEqual({
        ok: true,
        path: path.join(root, "notes"),
        next: expect.stringMatching(/manifest_draft/),
      });
      expect(ran).toHaveLength(1);
      const lead = await acts.repo_clone.check(
        { source: "acme/notes" },
        { agent: "lead", project: "north" },
      );
      expect(lead.ok ? "" : lead.error).toMatch(
        /the repos folder is shared by every project: Den's own agent or a person asks/,
      );
      const none = await heldActions(f.deps).repo_clone.check({
        source: "a/b",
      });
      expect(none.ok ? "" : none.error).toBe("this Den can't clone repos here");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
