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

describe("SRV-P4: project_mode and agent_folder", () => {
  it("are agent-ops' checks and runs, with who asked; a Den without them refuses", async () => {
    const f = fakes();
    expect(await heldActions(f.deps).project_mode.check({})).toEqual({
      ok: false,
      error: "this Den can't set a project's mode here",
    });
    expect(await heldActions(f.deps).agent_folder.check({})).toEqual({
      ok: false,
      error: "this Den can't move agents here",
    });
    const asked: unknown[] = [];
    const ran: unknown[] = [];
    const op = (summary: string) => ({
      check: (x: Record<string, unknown>, who?: unknown) => {
        asked.push(who);
        return {
          ok: true as const,
          summary,
          params: {},
          details: [],
          args: { ...x },
        };
      },
      run: async (x: Record<string, unknown>) => {
        ran.push(x);
        return { ok: true };
      },
    });
    const acts = heldActions({
      ...f.deps,
      projectMode: op("set project north's mode: ask → edits"),
      agentFolder: op("move agent ana to north › shop"),
    });
    const who = { agent: "lead", project: "north" };
    const m = await acts.project_mode.check({ project: "north" }, who);
    expect(m.ok && m.summary).toBe("set project north's mode: ask → edits");
    const g = await acts.agent_folder.check({ agent: "ana" }, who);
    expect(g.ok && g.summary).toBe("move agent ana to north › shop");
    expect(asked).toEqual([who, who]);
    if (!m.ok || !g.ok) return;
    await acts.project_mode.run(m.args);
    await acts.agent_folder.run(g.args);
    expect(ran).toEqual([{ project: "north" }, { agent: "ana" }]);
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

describe("repo_clone's Allow card and the agents' signing key (issue 523)", () => {
  it("says the clone gets the agents' key when one is set, and not when none is", async () => {
    const f = fakes();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-held-clone-"));
    try {
      const card = async (key?: string) => {
        const c = await heldActions({
          ...f.deps,
          reposRoot: () => root,
          gitRun: async () => {},
          agentsGit: () => (key ? { signingKey: key } : undefined),
        }).repo_clone.check({ source: "acme/notes" }, {});
        if (!c.ok) throw new Error(c.error);
        return c as typeof c & { detailKeys?: ({ key: string } | null)[] };
      };
      const signed = await card("/keys/agents");
      const at = signed.details.findIndex((d) => /agents' signing key/.test(d));
      expect(at).toBeGreaterThan(-1);
      expect(signed.detailKeys?.[at]?.key).toBe("ap.det.repo_clone.sign");
      const plain = await card();
      expect(plain.details.join("\n")).not.toMatch(/signing key/);
      expect((plain.detailKeys ?? []).map((k) => k?.key)).not.toContain(
        "ap.det.repo_clone.sign",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("issue 160: agent_import and approval_policy are held writes", () => {
  it("agent_import: checks the asker's project, session and persona; on Allow brings it in", async () => {
    const f = fakes();
    const brought: unknown[] = [];
    f.deps.agentImport = async (a) => {
      brought.push(a);
      return { ok: true, id: "planner", project: a.project };
    };
    const a = heldActions(f.deps).agent_import;
    const c = await a.check(
      { session: "abc-123", persona: "planner" },
      { agent: "lead", project: "repos" },
    );
    expect(c).toMatchObject({
      ok: true,
      args: { project: "repos", session: "abc-123", persona: "planner" },
      params: { session: "abc-123", persona: "planner", project: "repos" },
    });
    if (!c.ok) return;
    await a.run(c.args);
    expect(brought).toEqual([
      { project: "repos", session: "abc-123", persona: "planner" },
    ]);
    // Another project's, a bad id, no persona: refused before anything waits.
    for (const [args, err] of [
      [{ session: "abc", persona: "p", project: "default" }, /own project/],
      [{ session: "../x", persona: "p" }, /conversation id/],
      [{ session: "abc" }, /persona/],
    ] as const)
      expect(
        await a.check({ ...args }, { agent: "lead", project: "repos" }),
      ).toMatchObject({ ok: false, error: expect.stringMatching(err) });
    // A Den without the bring-in refuses.
    expect(
      await heldActions(fakes().deps).agent_import.check(
        { session: "abc", persona: "p" },
        { project: "repos" },
      ),
    ).toMatchObject({ ok: false });
  });

  it("approval_policy: always the person's own Allow; writes the install's or a project's", async () => {
    const f = fakes();
    const written: unknown[] = [];
    f.deps.approvalPolicy = {
      read: () => ({ policy: "notify" }),
      write: (project, setting) => void written.push({ project, setting }),
    };
    const a = heldActions(f.deps).approval_policy;
    const c = await a.check(
      { project: "repos", approvals: { policy: "auto", watch: ["repo:api"] } },
      { agent: "lead", project: "repos" },
    );
    expect(c).toMatchObject({
      ok: true,
      personOnly: true,
      params: { inProject: "1", where: "repos" },
    });
    if (!c.ok) return;
    await a.run(c.args);
    expect(written).toEqual([
      {
        project: "repos",
        setting: { policy: "auto", watch: ["repo:api"] },
      },
    ]);
    // A project's agent can't ask about the install's, or another project's.
    expect(
      await a.check(
        { approvals: { policy: "auto" } },
        { agent: "lead", project: "repos" },
      ),
    ).toMatchObject({ ok: false });
    expect(
      await a.check(
        { project: "default", approvals: { policy: "auto" } },
        { agent: "lead", project: "repos" },
      ),
    ).toMatchObject({ ok: false });
    // A bad setting is refused, naming the key.
    expect(
      await a.check({ project: "repos", approvals: { policy: "always" } }, {}),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/policy/) });
  });
});

describe("issue 160: pr_close, closing a stale or superseded PR after a Hub note", () => {
  it("checks the repo, the pull request and the comment; on Allow closes it with a comment saying why", async () => {
    const f = fakes();
    const closed: unknown[] = [];
    f.deps.prClose = async (a) => {
      closed.push(a);
      return { ok: true, repo: a.repo, pr: a.pr };
    };
    const a = heldActions(f.deps).pr_close;
    const c = await a.check(
      { repo: "acme/api", pr: 42, comment: "Superseded by 57 (Hub note)" },
      { agent: "lead", project: "repos" },
    );
    expect(c).toMatchObject({
      ok: true,
      args: {
        project: "repos",
        repo: "acme/api",
        pr: 42,
        comment: "Superseded by 57 (Hub note)",
      },
      params: { repo: "acme/api", pr: "42" },
    });
    if (!c.ok) return;
    expect(c.personOnly).toBeUndefined();
    await a.run(c.args);
    expect(closed).toEqual([
      { repo: "acme/api", pr: 42, comment: "Superseded by 57 (Hub note)" },
    ]);
    // A bad repo, a bad number, no comment, another project: refused first.
    for (const [args, err] of [
      [{ repo: "api", pr: 1, comment: "x" }, /owner\/name/],
      [{ repo: "acme/api; rm", pr: 1, comment: "x" }, /owner\/name/],
      [{ repo: "acme/api", pr: 0, comment: "x" }, /pull request number/],
      [{ repo: "acme/api", pr: "1x", comment: "x" }, /pull request number/],
      [{ repo: "acme/api", pr: 1 }, /comment/],
      [{ repo: "acme/api", pr: 1, comment: "  " }, /comment/],
      [
        { repo: "acme/api", pr: 1, comment: "x", project: "default" },
        /own project/,
      ],
    ] as const)
      expect(
        await a.check({ ...args }, { agent: "lead", project: "repos" }),
      ).toMatchObject({ ok: false, error: expect.stringMatching(err) });
    // A Den without the close refuses.
    expect(
      await heldActions(fakes().deps).pr_close.check(
        { repo: "acme/api", pr: 1, comment: "x" },
        { project: "repos" },
      ),
    ).toMatchObject({ ok: false });
  });
});
