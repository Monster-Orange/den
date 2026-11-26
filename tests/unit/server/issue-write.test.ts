/**
 * issue_write: an agent creates and updates GitHub issues in its own
 * project's repos, as a direct, audited action (not a held write). The
 * server runs `gh issue …` through the same call path pr_close's close
 * uses (runGh: the person's own gh and its credentials); here that call is
 * a fake that records what was asked, at the same seam pr_close's tests
 * fake (a dep the route is given).
 *
 * One action per call: create, comment, label, milestone. Closing,
 * deleting, transferring and locking are refused. Only the agent's own
 * project's repos; only roles the setting (agents.issue_writes) allows;
 * at most agents.issue_writes_per_hour per install. Every create and
 * comment carries a footer naming the agent and the install; the audit
 * row names the agent, project, repo, issue and action, never the body.
 */
import { describe, expect, it } from "@jest/globals";
import {
  ISSUE_WRITE_DEFAULT_ROLES,
  IssueWriteLimit,
  checkIssueWrite,
  issueWriteFooter,
  issueWriteSettings,
} from "../../../src/shared/issue-write.js";
import {
  PERSON_ONLY_SETTINGS,
  patchCliRows,
} from "../../../src/shared/settings-cli-rows.js";
import { DEN_SETTINGS } from "../../../src/ui/server/public/settings-registry.js";
import { SERVER_SCOPE } from "../../../src/shared/agents/server-agent.js";
import { orgPatterns } from "../../../src/shared/org-names.js";
import {
  installOwnNames,
  ownNamePatterns,
} from "../../../src/shared/filed-text-check.js";
import { settingKind } from "../../../src/ui/cli/setting-change.js";
import {
  runIssueWrite,
  type IssueWriteAudit,
  type IssueWriteDeps,
} from "../../../src/ui/server/issue-write-routes.js";

interface GhCall {
  args: string[];
  stdin?: string;
}

const BODY = "Steps: open the page, press Save. It fails with a 500.";

function fakes(
  opts: {
    role?: string;
    name?: string;
    roles?: string[];
    perHour?: number;
    gh?: (args: string[]) => { code: number; stdout: string; stderr: string };
    now?: () => number;
    /** Issue 1127: the listed names (none: nothing refused). */
    names?: string;
    visibility?: "public" | "private" | "internal" | null;
    publicRepos?: boolean;
    own?: string[];
  } = {},
) {
  const calls: GhCall[] = [];
  const audits: IssueWriteAudit[] = [];
  const lookups: { repo: string; maxAgeMs: number }[] = [];
  const deps: IssueWriteDeps = {
    agentOf: (id) =>
      id === "a1"
        ? { name: opts.name ?? "Builder", role: opts.role ?? "sde" }
        : id === "den-own"
          ? { name: "Den", role: undefined }
          : null,
    projectExists: (p) => p === "north" || p === "south",
    projectRepos: (p) =>
      p === "north"
        ? ["acme/api", "acme/web"]
        : p === "south"
          ? ["acme/ops"]
          : [],
    settings: () => ({
      roles: opts.roles ?? [...ISSUE_WRITE_DEFAULT_ROLES],
      perHour: opts.perHour ?? 60,
      visibilityMinutes: 10,
      publicRepos: opts.publicRepos ?? true,
    }),
    limit: new IssueWriteLimit(opts.now),
    namePatterns: () => orgPatterns({ DEN_ORG_NAMES: opts.names ?? "" }),
    visibility: async (repo, maxAgeMs) => {
      lookups.push({ repo, maxAgeMs });
      return opts.visibility === undefined ? "public" : opts.visibility;
    },
    gh: async (args, stdin) => {
      calls.push({ args, ...(stdin !== undefined ? { stdin } : {}) });
      return (
        opts.gh?.(args) ?? {
          code: 0,
          stdout:
            args[1] === "create"
              ? "https://github.com/acme/api/issues/42\n"
              : "",
          stderr: "",
        }
      );
    },
    installLabel: () => "den on box",
    ownNames: () => opts.own ?? [],
    audit: (e) => audits.push(e),
  };
  return { deps, calls, audits, lookups };
}

const agent = { agent: "a1", workspace: "north" };

describe("issue_write: each action calls gh with the right arguments", () => {
  it("create: title, body on stdin with the footer, labels and milestone", async () => {
    const f = fakes({ visibility: "private" });
    const r = await runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "Save fails with a 500",
      body: BODY,
      labels: ["bug", "p1"],
      milestone: "0.5",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      action: "create",
      repo: "acme/api",
      issue: 42,
      url: "https://github.com/acme/api/issues/42",
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].args).toEqual([
      "issue",
      "create",
      "--repo",
      "acme/api",
      "--title",
      "Save fails with a 500",
      "--body-file",
      "-",
      "--label",
      "bug",
      "--label",
      "p1",
      "--milestone",
      "0.5",
    ]);
    expect(f.calls[0].stdin).toBe(
      `${BODY}\n\n— written by agent Builder in den on box`,
    );
  });

  it("comment: the issue, the body on stdin with the footer", async () => {
    const f = fakes({ visibility: "private" });
    const r = await runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/web",
      issue: 7,
      body: "Fixed in the open pull request.",
    });
    expect(r.status).toBe(200);
    expect(f.calls[0].args).toEqual([
      "issue",
      "comment",
      "7",
      "--repo",
      "acme/web",
      "--body-file",
      "-",
    ]);
    expect(f.calls[0].stdin).toBe(
      "Fixed in the open pull request.\n\n— written by agent Builder in den on box",
    );
  });

  it("label: adds and removes in one edit", async () => {
    const f = fakes();
    const r = await runIssueWrite(f.deps, agent, {
      action: "label",
      repo: "acme/api",
      issue: 9,
      add: ["bug"],
      remove: ["needs-triage", "question"],
    });
    expect(r.status).toBe(200);
    expect(f.calls[0].args).toEqual([
      "issue",
      "edit",
      "9",
      "--repo",
      "acme/api",
      "--add-label",
      "bug",
      "--remove-label",
      "needs-triage",
      "--remove-label",
      "question",
    ]);
    expect(f.calls[0].stdin).toBeUndefined();
  });

  it("milestone: sets it by title", async () => {
    const f = fakes();
    await runIssueWrite(f.deps, agent, {
      action: "milestone",
      repo: "acme/api",
      issue: 9,
      milestone: "0.5",
    });
    expect(f.calls[0].args).toEqual([
      "issue",
      "edit",
      "9",
      "--repo",
      "acme/api",
      "--milestone",
      "0.5",
    ]);
  });
});

describe("issue_write: scope", () => {
  it("a repo outside the agent's project is refused and nothing is sent", async () => {
    const f = fakes();
    const r = await runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/ops",
      issue: 1,
      body: "x",
    });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toMatch(
      /acme\/ops is not one of project north's repos/,
    );
    expect(f.calls).toEqual([]);
  });

  it("naming another project is refused for a project's agent", async () => {
    const f = fakes();
    const r = await runIssueWrite(f.deps, agent, {
      project: "south",
      action: "comment",
      repo: "acme/ops",
      issue: 1,
      body: "x",
    });
    expect(r.status).toBe(403);
    expect(f.calls).toEqual([]);
  });

  it("Den's own agent names a project, and writes in that project's repos only", async () => {
    const f = fakes();
    const own = { agent: "den-own", workspace: SERVER_SCOPE };
    const none = await runIssueWrite(f.deps, own, {
      action: "comment",
      repo: "acme/ops",
      issue: 1,
      body: "x",
    });
    expect(none.status).toBe(400);
    expect(String(none.body.error)).toMatch(/name the project/);
    const ok = await runIssueWrite(f.deps, own, {
      project: "south",
      action: "comment",
      repo: "acme/ops",
      issue: 1,
      body: "x",
    });
    expect(ok.status).toBe(200);
    const wrong = await runIssueWrite(f.deps, own, {
      project: "south",
      action: "comment",
      repo: "acme/api",
      issue: 1,
      body: "x",
    });
    expect(wrong.status).toBe(403);
    expect(f.calls).toHaveLength(1);
  });
});

describe("issue_write: who may (agents.issue_writes)", () => {
  it("is on by default for planner, orchestrator, sde, builder and reviewer; off for tester and designer", () => {
    expect([...ISSUE_WRITE_DEFAULT_ROLES]).toEqual(
      expect.arrayContaining([
        "planner",
        "orchestrator",
        "sde",
        "builder",
        "reviewer",
      ]),
    );
    expect(ISSUE_WRITE_DEFAULT_ROLES).not.toContain("tester");
    expect(ISSUE_WRITE_DEFAULT_ROLES).not.toContain("designer");
  });

  it("a role the setting leaves out is refused, naming the setting; nothing is sent", async () => {
    const f = fakes({ role: "tester" });
    const r = await runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/api",
      issue: 1,
      body: "x",
    });
    expect(r.status).toBe(403);
    expect(String(r.body.error)).toMatch(/agents\.issue_writes/);
    expect(String(r.body.error)).toMatch(/tester/);
    expect(f.calls).toEqual([]);
  });

  it("the setting set to none refuses every role", async () => {
    const f = fakes({ roles: [] });
    const r = await runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/api",
      issue: 1,
      body: "x",
    });
    expect(r.status).toBe(403);
    expect(f.calls).toEqual([]);
  });

  it("reads user.yml agents.issue_writes and agents.issue_writes_per_hour, with their defaults", () => {
    expect(issueWriteSettings(() => ({}))).toEqual({
      roles: [...ISSUE_WRITE_DEFAULT_ROLES],
      perHour: 60,
      visibilityMinutes: 10,
      publicRepos: true,
    });
    expect(
      issueWriteSettings(() => ({
        agents: { issue_writes: ["tester"], issue_writes_per_hour: 5 },
      })),
    ).toEqual({
      roles: ["tester"],
      perHour: 5,
      visibilityMinutes: 10,
      publicRepos: true,
    });
    // Issue 1127: how long a repo's visibility is kept for the words check.
    expect(
      issueWriteSettings(() => ({
        agents: { issue_writes_visibility_minutes: 3 },
      })).visibilityMinutes,
    ).toBe(3);
    expect(() =>
      issueWriteSettings(() => ({
        agents: { issue_writes_visibility_minutes: 0 },
      })),
    ).toThrow(/agents\.issue_writes_visibility_minutes/);
    expect(() =>
      issueWriteSettings(() => ({ agents: { issue_writes_per_hour: 0 } })),
    ).toThrow(/agents\.issue_writes_per_hour/);
    expect(() =>
      issueWriteSettings(() => ({ agents: { issue_writes: "sde" } })),
    ).toThrow(/agents\.issue_writes/);
    // The distribution's config is the fallback; user.yml wins.
    const den = () => ({
      agents: { issue_writes: ["sde"], issue_writes_per_hour: 9 },
    });
    expect(issueWriteSettings(() => ({}), den)).toEqual({
      roles: ["sde"],
      perHour: 9,
      visibilityMinutes: 10,
      publicRepos: true,
    });
    expect(
      issueWriteSettings(() => ({ agents: { issue_writes: [] } }), den),
    ).toEqual({
      roles: [],
      perHour: 9,
      visibilityMinutes: 10,
      publicRepos: true,
    });
  });
});

describe("issue_write: the per-install rate limit", () => {
  it("refuses past the limit, counted across agents, with the time to wait", async () => {
    let t = 1_000_000;
    const f = fakes({ perHour: 2, now: () => t });
    const ask = () =>
      runIssueWrite(f.deps, agent, {
        action: "comment",
        repo: "acme/api",
        issue: 1,
        body: "x",
      });
    expect((await ask()).status).toBe(200);
    t += 60_000;
    expect((await ask()).status).toBe(200);
    t += 60_000;
    const r = await ask();
    expect(r.status).toBe(429);
    // The first write leaves the window 58 minutes from now.
    expect(String(r.body.error)).toMatch(/2 issue writes in the last hour/);
    expect(String(r.body.error)).toMatch(/try again in 58 minutes/);
    expect(f.calls).toHaveLength(2);
  });
});

describe("issue_write: identity and audit", () => {
  it("writes an audit row with the agent, project, repo, issue and action, never the body", async () => {
    const f = fakes();
    await runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "Save fails",
      body: BODY,
    });
    await runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/api",
      issue: 42,
      body: BODY,
    });
    expect(f.audits).toHaveLength(2);
    expect(f.audits[0]).toMatchObject({
      agent: "a1",
      project: "north",
      repo: "acme/api",
      issue: 42,
      action: "create",
    });
    expect(f.audits[1]).toMatchObject({ issue: 42, action: "comment" });
    for (const a of f.audits) {
      expect(JSON.stringify(a)).not.toContain("Steps: open the page");
      expect(a.summary.length).toBeLessThanOrEqual(200);
    }
  });

  it("a refusal is audited too, without the body", async () => {
    const f = fakes();
    await runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/ops",
      issue: 1,
      body: BODY,
    });
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]).toMatchObject({ refused: true, action: "comment" });
    expect(JSON.stringify(f.audits[0])).not.toContain("Steps: open the page");
  });

  it("the footer is on create and comment, not on label or milestone", async () => {
    const f = fakes({ name: "Night Planner", visibility: "private" });
    await runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "t",
    });
    await runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/api",
      issue: 1,
      body: "b",
    });
    await runIssueWrite(f.deps, agent, {
      action: "label",
      repo: "acme/api",
      issue: 1,
      add: ["bug"],
    });
    const foot = "— written by agent Night Planner in den on box";
    expect(f.calls[0].stdin).toBe(foot);
    expect(f.calls[1].stdin?.endsWith(`\n\n${foot}`)).toBe(true);
    expect(f.calls[2].stdin).toBeUndefined();
  });
});

describe("issue_write: the footer by the repo's visibility", () => {
  const SHORT = "— written by an agent";
  const FULL = "— written by agent Builder in den on box";
  async function posted(
    visibility: "public" | "private" | "internal" | null,
    action: "create" | "comment" = "create",
  ) {
    const f = fakes({ visibility });
    const r = await runIssueWrite(
      f.deps,
      agent,
      action === "create"
        ? { action, repo: "acme/api", title: "Save fails", body: BODY }
        : { action, repo: "acme/api", issue: 3, body: BODY },
    );
    expect(r.status).toBe(200);
    return { stdin: f.calls[0].stdin ?? "", lookups: f.lookups };
  }

  it("a public repo: the short footer, naming no agent, install or host", async () => {
    const { stdin } = await posted("public");
    expect(stdin).toBe(`${BODY}\n\n${SHORT}`);
    expect(stdin).not.toContain("den on box");
    expect(stdin).not.toContain("Builder");
  });

  it("a public repo's comment: the short footer too", async () => {
    expect((await posted("public", "comment")).stdin).toBe(
      `${BODY}\n\n${SHORT}`,
    );
  });

  it("a repo whose visibility isn't known: the short footer", async () => {
    expect((await posted(null)).stdin).toBe(`${BODY}\n\n${SHORT}`);
  });

  it("a private repo keeps the full footer", async () => {
    expect((await posted("private")).stdin).toBe(`${BODY}\n\n${FULL}`);
  });

  it("an internal repo keeps the full footer", async () => {
    expect((await posted("internal")).stdin).toBe(`${BODY}\n\n${FULL}`);
  });

  it("the visibility is asked once a write, with no names list too", async () => {
    expect((await posted("private")).lookups).toEqual([
      { repo: "acme/api", maxAgeMs: 600_000 },
    ]);
  });

  it("issueWriteFooter: public or unknown is short; private or internal names the agent and install", () => {
    expect(issueWriteFooter("Builder", "den on box", "public")).toBe(SHORT);
    expect(issueWriteFooter("Builder", "den on box", null)).toBe(SHORT);
    expect(issueWriteFooter("Builder", "den on box", "private")).toBe(FULL);
    expect(issueWriteFooter("Builder", "den on box", "internal")).toBe(FULL);
  });
});

describe("issue_write: agents.issue_writes_public", () => {
  const write = (f: ReturnType<typeof fakes>) =>
    runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "Save fails",
      body: BODY,
    });

  it("on by default; a person can turn it off; any other value is refused by name", () => {
    expect(issueWriteSettings(() => ({})).publicRepos).toBe(true);
    expect(
      issueWriteSettings(() => ({ agents: { issue_writes_public: false } }))
        .publicRepos,
    ).toBe(false);
    expect(() =>
      issueWriteSettings(() => ({ agents: { issue_writes_public: "no" } })),
    ).toThrow(/agents\.issue_writes_public/);
  });

  it("off: a write to a public repo is refused in Den, with a plain reason, and nothing is sent", async () => {
    const f = fakes({ visibility: "public", publicRepos: false });
    const r = await write(f);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("issue_write_public");
    expect(String(r.body.error)).toContain("acme/api is public");
    expect(String(r.body.error)).toContain("agents.issue_writes_public");
    expect(f.calls).toEqual([]);
  });

  it("off: a private or internal repo keeps working", async () => {
    for (const visibility of ["private", "internal"] as const) {
      const f = fakes({ visibility, publicRepos: false });
      expect((await write(f)).status).toBe(200);
    }
  });

  it("off: a repo whose visibility isn't known isn't refused outright", async () => {
    const f = fakes({ visibility: null, publicRepos: false });
    expect((await write(f)).status).toBe(200);
    expect(f.calls[0].stdin).toBe(`${BODY}\n\n— written by an agent`);
  });

  it("a body with a listed name: refused on a public repo, sent on a private one", async () => {
    const body = "Seen on the Zorblax build.";
    const pub = fakes({ names: "zorblax", visibility: "public" });
    const p = await runIssueWrite(pub.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "Save fails",
      body,
    });
    expect(p.body.code).toBe("issue_write_words");
    expect(pub.calls).toEqual([]);
    const priv = fakes({ names: "zorblax", visibility: "private" });
    const q = await runIssueWrite(priv.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "Save fails",
      body,
    });
    expect(q.status).toBe(200);
  });

  it("a Settings toggle a person sets; it saves to user.yml and clears with null", () => {
    expect(
      (DEN_SETTINGS as { keys?: string[] }[]).find((r) =>
        r.keys?.includes("agent_issue_writes.public"),
      ),
    ).toMatchObject({
      id: "agents.issue_writes_public",
      category: "agents",
      scope: "user",
      control: { type: "toggle" },
    });
    const user: Record<string, unknown> = {};
    expect(
      patchCliRows(user, { agent_issue_writes: { public: false } }),
    ).toEqual({ ok: true });
    expect((user.agents as Record<string, unknown>).issue_writes_public).toBe(
      false,
    );
    expect(issueWriteSettings(() => user).publicRepos).toBe(false);
    expect(
      patchCliRows(user, { agent_issue_writes: { public: "yes" } }).ok,
    ).toBe(false);
    patchCliRows(user, { agent_issue_writes: { public: null } });
    expect(issueWriteSettings(() => user).publicRepos).toBe(true);
  });

  for (const mode of ["personal", "strict"] as const)
    it(`${mode}: turning it on widens and needs the person; turning it off doesn't`, () => {
      expect(
        settingKind("agents.issue_writes_public", mode, true, false).widens,
      ).toBe(true);
      expect(settingKind("agents.issue_writes_public", mode, true).widens).toBe(
        true,
      );
      expect(
        settingKind("agents.issue_writes_public", mode, false, true).widens,
      ).toBe(false);
      expect(
        settingKind("agents.issue_writes_public", mode, "off", true).widens,
      ).toBe(false);
    });

  it("a repo whose visibility isn't known: its body is checked too", async () => {
    const f = fakes({ names: "zorblax", visibility: null });
    const r = await runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/api",
      issue: 2,
      body: "Zorblax again.",
    });
    expect(r.body.code).toBe("issue_write_words");
  });
});

describe("issue_write: the install's own names stay out of public text", () => {
  const OWN = ["den on mac-studio-7", "mac-studio-7", "north", "acme", "api"];
  const send = (
    visibility: "public" | "private" | "internal" | null,
    body: string,
    name?: string,
  ) => {
    const f = fakes({ visibility, own: OWN, ...(name ? { name } : {}) });
    return runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/api",
      issue: 4,
      body,
    }).then((r) => ({ r, f }));
  };

  it("a public body naming the machine is refused with the names list empty", async () => {
    const { r, f } = await send("public", "Seen on mac-studio-7 today.");
    expect(r.body.code).toBe("issue_write_words");
    expect(f.calls).toEqual([]);
  });

  it("the same body goes to a private repo", async () => {
    expect(
      (await send("private", "Seen on mac-studio-7 today.")).r.status,
    ).toBe(200);
  });

  it("a repo whose visibility isn't known is checked too", async () => {
    expect((await send(null, "Seen on mac-studio-7 today.")).r.body.code).toBe(
      "issue_write_words",
    );
  });

  it("the target repo's own owner and name pass; another project's name doesn't", async () => {
    expect((await send("public", "The api from acme is down.")).r.status).toBe(
      200,
    );
    expect((await send("public", "Same as in north.")).r.body.code).toBe(
      "issue_write_words",
    );
  });

  it("the writing agent's own name is checked", async () => {
    expect(
      (await send("public", "Night Planner saw it first.", "Night Planner")).r
        .body.code,
    ).toBe("issue_write_words");
  });

  it("a name matches as a whole word, any case, never inside another word", async () => {
    expect((await send("public", "MAC-STUDIO-7 again.")).r.body.code).toBe(
      "issue_write_words",
    );
    const box = fakes({ visibility: "public", own: ["box"] });
    const r = await runIssueWrite(box.deps, agent, {
      action: "comment",
      repo: "acme/api",
      issue: 4,
      body: "Check your inbox.",
    });
    expect(r.status).toBe(200);
  });

  it("ownNamePatterns: names under 3 characters, and the repo's owner, name and slug, are skipped", () => {
    const ps = ownNamePatterns(
      ["ab", "acme", "API", "acme/api", "north", "north"],
      "acme/api",
    );
    expect(ps).toHaveLength(1);
    expect(ps[0].test("in North today")).toBe(true);
  });

  it("installOwnNames: the label, the short hostname, the projects and the git user", () => {
    expect(
      installOwnNames({
        label: "den on mac-studio-7",
        host: "mac-studio-7.local",
        projects: ["north", "south"],
        git: { name: "Pat Example", email: "pat@example.test" },
      }),
    ).toEqual([
      "den on mac-studio-7",
      "mac-studio-7",
      "north",
      "south",
      "Pat Example",
      "pat@example.test",
    ]);
  });
});

describe("issue_write: what it never does", () => {
  it.each(["close", "delete", "transfer", "lock", "reopen"])(
    "%s is refused, pointing to a person, and nothing is sent",
    async (action) => {
      const f = fakes();
      const r = await runIssueWrite(f.deps, agent, {
        action,
        repo: "acme/api",
        issue: 1,
      });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toMatch(/person/);
      expect(String(r.body.error)).toMatch(/no held write for it yet/);
      expect(f.calls).toEqual([]);
    },
  );
});

describe("issue_write: input checks at the boundary", () => {
  const bad: [string, Record<string, unknown>, RegExp][] = [
    ["no action", { repo: "acme/api" }, /action/],
    [
      "a bad repo",
      { action: "create", repo: "api", title: "t" },
      /owner\/name/,
    ],
    ["an empty title", { action: "create", repo: "a/b", title: " " }, /title/],
    [
      "a title over 256",
      { action: "create", repo: "a/b", title: "x".repeat(257) },
      /title/,
    ],
    [
      "a body over the limit",
      { action: "comment", repo: "a/b", issue: 1, body: "x".repeat(65_537) },
      /body/,
    ],
    ["no comment body", { action: "comment", repo: "a/b", issue: 1 }, /body/],
    [
      "issue 0",
      { action: "comment", repo: "a/b", issue: 0, body: "x" },
      /issue/,
    ],
    [
      "issue 1.5",
      { action: "comment", repo: "a/b", issue: 1.5, body: "x" },
      /issue/,
    ],
    [
      "issue as words",
      { action: "comment", repo: "a/b", issue: "one", body: "x" },
      /issue/,
    ],
    [
      "an empty label",
      { action: "label", repo: "a/b", issue: 1, add: [""] },
      /label/,
    ],
    [
      "no labels at all",
      { action: "label", repo: "a/b", issue: 1 },
      /add or remove/,
    ],
    [
      "labels not a list",
      { action: "create", repo: "a/b", title: "t", labels: "bug" },
      /labels/,
    ],
    [
      "an empty milestone",
      { action: "milestone", repo: "a/b", issue: 1, milestone: "" },
      /milestone/,
    ],
  ];
  it.each(bad)("%s is refused", (_why, args, re) => {
    const c = checkIssueWrite(args);
    expect(c.ok).toBe(false);
    expect(c.ok ? "" : c.error).toMatch(re);
  });

  it("the route refuses bad input before anything is sent", async () => {
    const f = fakes();
    const r = await runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "",
    });
    expect(r.status).toBe(400);
    expect(f.calls).toEqual([]);
  });
});

describe("issue_write: GitHub's errors", () => {
  it("come back as a plain refusal with the status, and never echo a token", async () => {
    const f = fakes({
      gh: () => ({
        code: 1,
        stdout: "",
        stderr:
          "HTTP 404: Not Found (https://api.github.com/repos/acme/api/issues/99)\nauth ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      }),
    });
    const r = await runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/api",
      issue: 99,
      body: "x",
    });
    expect(r.status).toBe(502);
    expect(String(r.body.error)).toMatch(/GitHub answered 404/);
    expect(JSON.stringify(r.body)).not.toContain("ghp_abcdefghij");
    expect(f.audits[0]).toMatchObject({ refused: true });
  });
});

describe("issue_write: its Settings rows", () => {
  it("Settings has both rows, and the page's POST field writes user.yml agents.issue_writes and agents.issue_writes_per_hour", () => {
    const rows = DEN_SETTINGS as {
      id: string;
      category: string;
      scope: string;
      keys?: string[];
      control: Record<string, unknown>;
    }[];
    expect(
      rows.find((r) => r.keys?.includes("agent_issue_writes.roles")),
    ).toMatchObject({
      category: "agents",
      scope: "user",
      control: { type: "text" },
    });
    expect(
      rows.find((r) => r.keys?.includes("agent_issue_writes.per_hour")),
    ).toMatchObject({
      category: "agents",
      scope: "user",
      control: { type: "number", min: 1, max: 10000 },
    });
    // A person's only: an agent never widens who writes issues.
    expect(PERSON_ONLY_SETTINGS).toContain("agent_issue_writes");
    const user: Record<string, unknown> = { agents: { git: { key: "k" } } };
    expect(
      patchCliRows(user, {
        agent_issue_writes: { roles: ["sde", "reviewer"], per_hour: 30 },
      }),
    ).toEqual({ ok: true });
    expect(user.agents).toEqual({
      git: { key: "k" },
      issue_writes: ["sde", "reviewer"],
      issue_writes_per_hour: 30,
    });
    expect(issueWriteSettings(() => user)).toEqual({
      roles: ["sde", "reviewer"],
      perHour: 30,
      visibilityMinutes: 10,
      publicRepos: true,
    });
    // Issue 1127: the words check's visibility age, its own row.
    expect(
      rows.find((r) =>
        r.keys?.includes("agent_issue_writes.visibility_minutes"),
      ),
    ).toMatchObject({
      category: "agents",
      scope: "user",
      control: { type: "number", min: 1, max: 1440 },
    });
    expect(
      patchCliRows(user, { agent_issue_writes: { visibility_minutes: 5 } }),
    ).toEqual({ ok: true });
    expect(
      (user.agents as Record<string, unknown>).issue_writes_visibility_minutes,
    ).toBe(5);
    expect(issueWriteSettings(() => user).visibilityMinutes).toBe(5);
    expect(
      patchCliRows(user, { agent_issue_writes: { visibility_minutes: 0 } }).ok,
    ).toBe(false);
    patchCliRows(user, { agent_issue_writes: { visibility_minutes: null } });
    for (const bad of [
      { per_hour: 0 },
      { per_hour: 1.5 },
      { roles: "sde" },
      { roles: ["Not A Role"] },
    ])
      expect(patchCliRows(user, { agent_issue_writes: bad }).ok).toBe(false);
    // null clears both, back to the defaults; the rest of agents stays.
    patchCliRows(user, { agent_issue_writes: { roles: null, per_hour: null } });
    expect(user.agents).toEqual({ git: { key: "k" } });
  });
});

describe("issue 1127: issue_write checks the text it files for listed names", () => {
  const LISTED = "zorblax";

  it("refuses a create whose title holds a listed name: nothing sent, the answer quotes the agent's phrase, the audit never holds it", async () => {
    const f = fakes({ names: LISTED });
    const r = await runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "Crash at Zorblax",
      body: BODY,
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("issue_write_words");
    expect(String(r.body.error)).toContain('title line 1: "Zorblax"');
    expect(String(r.body.error)).toMatch(/"the person"/);
    expect(f.calls).toEqual([]);
    expect(f.audits[0]).toMatchObject({ refused: true });
    expect(JSON.stringify(f.audits)).toContain("title line 1");
    expect(JSON.stringify(f.audits).toLowerCase()).not.toContain(LISTED);
  });

  it("refuses a body and a comment that hold one, and lets clean text through", async () => {
    const f = fakes({ names: LISTED });
    const body = await runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "A crash",
      body: "Steps:\nopen zorblax.example",
    });
    expect(String(body.body.error)).toContain("body line 2");
    const comment = await runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/api",
      issue: 7,
      body: "Seen on ZORBLAX too",
    });
    expect(comment.body.code).toBe("issue_write_words");
    expect(f.calls).toEqual([]);
    const clean = await runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "A crash",
      body: BODY,
    });
    expect(clean.status).toBe(200);
    expect(f.calls).toHaveLength(1);
  });

  it("a private repo is not checked; a repo whose visibility isn't known is", async () => {
    const priv = fakes({ names: LISTED, visibility: "private" });
    const p = await runIssueWrite(priv.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "Crash at Zorblax",
      body: BODY,
    });
    expect(p.status).toBe(200);
    const unknown = fakes({ names: LISTED, visibility: null });
    const u = await runIssueWrite(unknown.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "Crash at Zorblax",
      body: BODY,
    });
    expect(u.body.code).toBe("issue_write_words");
  });

  it("asks for the repo's visibility no older than agents.issue_writes_visibility_minutes", async () => {
    const f = fakes({ names: LISTED });
    await runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "A crash",
      body: BODY,
    });
    expect(f.lookups).toEqual([{ repo: "acme/api", maxAgeMs: 600_000 }]);
  });

  it("a refusal doesn't use up the hour's writes", async () => {
    const f = fakes({ names: LISTED, perHour: 1 });
    await runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "Crash at Zorblax",
      body: BODY,
    });
    const ok = await runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "A crash",
      body: BODY,
    });
    expect(ok.status).toBe(200);
  });
});

describe("issue 1127: issue_write never echoes the list, and checks label and milestone names", () => {
  it("a bad line in the list refuses with a fixed message: no part of the line", async () => {
    const f = fakes({ names: "zorblax\nqx(secretword" });
    const r = await runIssueWrite(f.deps, agent, {
      action: "create",
      repo: "acme/api",
      title: "A crash",
      body: BODY,
    });
    expect(r.status).toBe(500);
    expect(JSON.stringify([r.body, f.audits])).not.toMatch(
      /qx|secretword|zorblax/,
    );
    expect(f.calls).toEqual([]);
  });

  it("whatever the list reader throws, the refusal is a fixed message", async () => {
    const f = fakes({ names: "zorblax" });
    f.deps.namePatterns = () => {
      throw new Error("Invalid regular expression: /qx(secretword/i");
    };
    const r = await runIssueWrite(f.deps, agent, {
      action: "comment",
      repo: "acme/api",
      issue: 7,
      body: BODY,
    });
    expect(r.status).toBe(500);
    expect(JSON.stringify([r.body, f.audits])).not.toMatch(/qx|secretword/);
  });

  it("refuses a label or a milestone name that holds a listed name", async () => {
    const f = fakes({ names: "zorblax" });
    const label = await runIssueWrite(f.deps, agent, {
      action: "label",
      repo: "acme/api",
      issue: 7,
      add: ["zorblax-customer"],
    });
    expect(label.body.code).toBe("issue_write_words");
    expect(String(label.body.error)).toContain("label line 1");
    const ms = await runIssueWrite(f.deps, agent, {
      action: "milestone",
      repo: "acme/api",
      issue: 7,
      milestone: "Zorblax launch",
    });
    expect(ms.body.code).toBe("issue_write_words");
    expect(f.calls).toEqual([]);
  });
});
