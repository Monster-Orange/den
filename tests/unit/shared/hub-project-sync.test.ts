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
