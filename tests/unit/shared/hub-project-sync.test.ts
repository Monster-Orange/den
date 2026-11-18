import * as fs from "fs";
import * as path from "path";
import {
  githubUrlOk,
  projectList,
  ProjectSync,
  readCoverage,
  readSyncReply,
  syncAgents,
  type SyncProject,
} from "../../../src/shared/hub-project-sync";
import type { WorkspacesFile } from "../../../src/shared/types";

const file = (w: Record<string, unknown>) =>
  ({ workspaces: w }) as unknown as WorkspacesFile;

describe("H5 sync: the project list Den sends", () => {
  it("every project but the server agent's, with its name, repos and Hub link", () => {
    const list = projectList(
      file({
        "den-server": {},
        "back-office": {
          name: "back office",
          hub_project: { id: "proj_abc", slug: "bo", name: "BO" },
        },
        web: {},
      }),
      (ws) =>
        ws === "web"
          ? ["Acme-Co/Web-App", "acme-co/web-app", "not a repo"]
          : [],
    );
    expect(list).toEqual([
      {
        workspace: "back-office",
        name: "back office",
        repos: [],
        hub_project: "proj_abc",
        agents: [],
      },
      {
        workspace: "web",
        name: "web",
        repos: ["acme-co/web-app"],
        hub_project: null,
        agents: [],
      },
    ]);
  });

  it("each project's agents: id, the name people see, the handle; never the server agent", () => {
    const a = syncAgents([
      { id: "planner", workspace: "web", displayName: "Planner Pat" },
      { id: "rev", workspace: "web", persona: "reviewer" },
      { id: "srv", workspace: "den-server" },
    ]);
    expect(a.get("web")).toEqual([
      { agent: "planner", name: "Planner Pat", handle: "web/planner" },
      { agent: "rev", name: "reviewer", handle: "web/rev" },
    ]);
    expect(a.has("den-server")).toBe(false);
    const [p] = projectList(
      file({ web: {} }),
      () => [],
      (ws) => a.get(ws) ?? [],
    );
    expect(p.agents.map((x) => x.handle)).toEqual(["web/planner", "web/rev"]);
  });

  it("stays under Hub's limits (50 repos)", () => {
    const repos = Array.from({ length: 60 }, (_, i) => `acme-co/r${i}`);
    const [p] = projectList(file({ a: {} }), () => repos);
    expect(p.repos).toHaveLength(50);
  });
});

describe("H5 sync: a link the person is sent to", () => {
  it.each([
    ["https://github.com/apps/den-hub/installations/new?target_id=1", true],
    ["https://github.com/organizations/acme-co/settings/installations/9", true],
    ["http://github.com/apps/x", false],
    ["https://github.com.example.net/apps/x", false],
    ["https://evil@github.com/apps/x", false],
    ["https://github.com:8443/apps/x", false],
    ["javascript:alert(1)", false],
    ["https://hub.example.net/install", false],
  ])("%s → %s", (u, ok) => expect(githubUrlOk(u)).toBe(ok));
});

describe("H5 sync: Hub's answers", () => {
  it("uncovered repos keep only a github.com install link", () => {
    const r = readSyncReply({
      ok: true,
      setups: 2,
      errors: [{ workspace: "web", error: "bad repo" }],
      uncovered: [
        {
          workspace: "web",
          repo: "acme-co/web-app",
          org: "acme-co",
          install_url: "https://github.com/apps/den-hub/installations/new",
        },
        {
          workspace: "web",
          repo: "acme-co/api",
          org: "acme-co",
          install_url: "https://phish.example/x",
        },
        { workspace: "web", repo: "nope", org: "acme-co" },
      ],
    });
    expect(r.setups).toBe(2);
    expect(r.errors).toEqual([{ workspace: "web", error: "bad repo" }]);
    expect(r.uncovered).toEqual([
      {
        workspace: "web",
        repo: "acme-co/web-app",
        org: "acme-co",
        installUrl: "https://github.com/apps/den-hub/installations/new",
      },
      { workspace: "web", repo: "acme-co/api", org: "acme-co" },
    ]);
  });

  it("coverage per org: all, some, none", () => {
    expect(
      readCoverage({
        orgs: [
          {
            org: "acme-co",
            access: "some",
            covered: 2,
            total: 5,
            manage_url:
              "https://github.com/organizations/acme-co/settings/installations/9",
          },
          {
            org: "other-co",
            access: "none",
            covered: 0,
            total: 3,
            install_url: "https://github.com/apps/den-hub/installations/new",
          },
          { org: "bad org!", access: "all" },
          { org: "x", access: "maybe" },
        ],
      }),
    ).toEqual([
      {
        org: "acme-co",
        access: "some",
        covered: 2,
        total: 5,
        manageUrl:
          "https://github.com/organizations/acme-co/settings/installations/9",
      },
      {
        org: "other-co",
        access: "none",
        covered: 0,
        total: 3,
        installUrl: "https://github.com/apps/den-hub/installations/new",
      },
    ]);
  });
});

describe("H5 sync: the loop", () => {
  const timers: { fn: () => void; ms: number }[] = [];
  beforeEach(() => (timers.length = 0));
  const mk = (
    send: (p: SyncProject[]) => Promise<Record<string, unknown> | null>,
    list: () => SyncProject[],
  ) =>
    new ProjectSync({
      list,
      send,
      setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimer: () => undefined,
      now: () => new Date("2026-11-12T00:00:00Z"),
    });
  const p = (ws: string): SyncProject => ({
    workspace: ws,
    name: ws,
    repos: [],
    hub_project: null,
    agents: [],
  });

  it("sends once per list; a change sends again", async () => {
    let cur = [p("a")];
    const send = jest.fn(async () => ({ ok: true, setups: 1 }));
    const s = mk(send, () => cur);
    await s.run();
    s.check();
    expect(timers).toHaveLength(0);
    cur = [p("a"), p("b")];
    s.check();
    expect(timers).toHaveLength(1);
    await s.run();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual([p("a"), p("b")]);
  });

  it("the answer's uncovered repos are kept per project; an install then a re-send clears them", async () => {
    const replies = [
      {
        ok: true,
        uncovered: [
          {
            workspace: "a",
            repo: "acme-co/x",
            org: "acme-co",
            install_url: "https://github.com/apps/den-hub/installations/new",
          },
        ],
      },
      { ok: true, uncovered: [] },
    ];
    const s = mk(
      async () => replies.shift()!,
      () => [p("a")],
    );
    await s.run();
    expect(s.uncoveredFor("a").map((u) => u.org)).toEqual(["acme-co"]);
    expect((await s.now())?.uncovered).toEqual([]);
    expect(s.uncoveredFor("a")).toEqual([]);
  });

  it("a network failure retries with backoff; Hub's 400 waits for a change", async () => {
    const fail = Object.assign(new Error("Hub could not be reached"), {
      kind: "unreachable",
    });
    const s1 = mk(
      async () => Promise.reject(fail),
      () => [p("a")],
    );
    await s1.run();
    await s1.run();
    expect(timers.map((t) => t.ms)).toEqual([5000, 10000]);
    expect(s1.last()?.ok).toBe(false);

    timers.length = 0;
    const no = Object.assign(new Error("Hub refused it (400)"), {
      kind: "refused",
    });
    const s2 = mk(
      async () => Promise.reject(no),
      () => [p("a")],
    );
    await s2.run();
    expect(timers).toHaveLength(0);
    s2.check();
    expect(timers).toHaveLength(0);
  });

  it("the 0.4.39 gate: the 30 s check never cuts a retry short; the wait grows to 5 min", async () => {
    const fail = Object.assign(new Error("Hub could not be reached"), {
      kind: "unreachable",
    });
    const s = mk(
      async () => Promise.reject(fail),
      () => [p("a")],
    );
    const waits: number[] = [];
    await s.run();
    for (let i = 0; i < 9; i++) {
      // The periodic check runs between retries: it must not schedule.
      const before = timers.length;
      s.check();
      s.check();
      expect(timers.length).toBe(before);
      const t = timers.at(-1)!;
      waits.push(t.ms);
      t.fn();
      await new Promise((r) => setImmediate(r));
    }
    expect(waits).toEqual([
      5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000,
    ]);
    // A connect (request) still sends soon.
    s.request();
    expect(timers.at(-1)!.ms).toBe(1500);
  });

  it("Hub not set up here: nothing recorded, no retry", async () => {
    const s = mk(
      async () => null,
      () => [p("a")],
    );
    await s.run();
    expect(s.last()).toBeNull();
    expect(timers).toHaveLength(0);
  });
});

// Issue 526: Hub's own sample answers (tests/fixtures/hub-coverage).
const fixture = (f: string) =>
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "..", "fixtures", "hub-coverage", f),
      "utf-8",
    ),
  ) as Record<string, unknown>;

describe("issue 526: an org Hub couldn't check", () => {
  it("keeps access error with Hub's reason, and never a link", () => {
    const orgs = readCoverage(fixture("github.json"));
    expect(orgs.map((o) => [o.org, o.access])).toEqual([
      ["acme", "all"],
      ["acme-labs", "some"],
      ["globex", "none"],
      ["initech", "error"],
    ]);
    const e = orgs.find((o) => o.org === "initech")!;
    expect(e.error).toBe("GitHub answered 503");
    expect(e.installUrl).toBeUndefined();
    expect(e.manageUrl).toBeUndefined();
  });

  it("an error org that carries links still has none", () => {
    const [e] = readCoverage({
      orgs: [
        {
          org: "initech",
          access: "error",
          error: "Hub couldn't ask GitHub (GitHub didn't answer)",
          install_url: "https://github.com/apps/den-hub/installations/new",
          manage_url:
            "https://github.com/organizations/initech/settings/installations/9",
        },
      ],
    });
    expect(e).toEqual({
      org: "initech",
      access: "error",
      covered: 0,
      total: 0,
      error: "GitHub didn't answer",
    });
  });

  it.each([
    ["two\nlines", "two"],
    ["bell\u0007 and \u001b[31mred", "bell and [31mred"],
    ["x".repeat(500), "x".repeat(200)],
    ["see https://evil.example/x", ""],
    ["go to www.evil.example", ""],
    ["<a href=x>y</a>", "<a href=x>y</a>"],
    [42, ""],
  ])("Hub's error text %j is one plain bounded line: %j", (raw, want) => {
    const [e] = readCoverage({
      orgs: [{ org: "initech", access: "error", error: raw }],
    });
    expect(e.access).toBe("error");
    expect(e.error ?? "").toBe(want);
  });

  it("none may carry manage_url (an installation that leaves these repos out)", () => {
    const [o] = readCoverage({
      orgs: [
        {
          org: "globex",
          access: "none",
          covered: 0,
          total: 2,
          manage_url:
            "https://github.com/organizations/Globex/settings/installations/7",
        },
      ],
    });
    expect(o.manageUrl).toBe(
      "https://github.com/organizations/Globex/settings/installations/7",
    );
  });

  it("a user account's change-repos link is accepted", () => {
    expect(githubUrlOk("https://github.com/settings/installations/<id>")).toBe(
      true,
    );
    expect(githubUrlOk("https://github.com/settings/installations/42")).toBe(
      true,
    );
  });

  it("Den matches its own Acme-Labs/Widget-API to Hub's lowercased repo, and shows its own spelling", async () => {
    const s = new ProjectSync({
      list: () => [
        {
          workspace: "<workspace>",
          name: "w",
          repos: ["acme-labs/widget-api", "globex/portal"],
          hub_project: null,
          agents: [],
        },
      ],
      send: async () => fixture("projects-reply.json"),
      spelling: () => ["Acme-Labs/Widget-API", "globex/portal"],
      setTimer: () => 0,
      clearTimer: () => undefined,
    });
    await s.run();
    expect(s.uncoveredFor("<workspace>").map((u) => [u.repo, u.org])).toEqual([
      ["Acme-Labs/Widget-API", "Acme-Labs"],
      ["globex/portal", "globex"],
    ]);
    // The link is Hub's, kept as sent: never derived from or matched on the URL.
    expect(s.uncoveredFor("<workspace>")[0].installUrl).toBe(
      "https://github.com/organizations/acme-labs/settings/installations/<id>",
    );
  });
});
