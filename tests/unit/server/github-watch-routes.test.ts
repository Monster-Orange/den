/**
 * The shared GitHub watcher's routes, an agent's own (its actor token):
 *   POST /api/agents/self/github-watches          { repo, pr | run }
 *   GET  /api/agents/self/github-watches          its watches
 *   POST /api/agents/self/github-watches/cancel   { id }
 * The repo must be one of the agent's projects' repos (its project and
 * its grants). A person's request is refused: a watch tells an agent. The
 * watcher's GitHub is a fake; no network.
 */
import { describe, expect, it } from "@jest/globals";
import { Readable } from "stream";
import type * as http from "http";
import {
  handleGithubWatchRoutes,
  isGithubWatchPath,
} from "../../../src/ui/server/github-watch-routes.js";
import { GithubWatcher } from "../../../src/shared/github-watch/watcher.js";
import { FakeGithub } from "../shared/github-watch/fake-github.js";

const SHA = "d4".repeat(20);

function req(method: string, body?: unknown): http.IncomingMessage {
  const r = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as unknown as http.IncomingMessage;
  (r as { method?: string }).method = method;
  return r;
}

function res() {
  const out = { status: 0, body: undefined as unknown };
  const r = {
    writeHead(s: number) {
      out.status = s;
      return r;
    },
    setHeader() {},
    end(b?: string) {
      out.body = b ? JSON.parse(b) : undefined;
    },
  } as unknown as http.ServerResponse;
  return { r, out };
}

function setup(
  principal: unknown,
  { noAllRepos = false, northList = null as string[] | null } = {},
) {
  const gh = new FakeGithub(Date.now);
  gh.pr("acme/north", 5, SHA);
  gh.pr("other/elsewhere", 5, SHA);
  gh.pr("shared/pipeline", 7, SHA);
  gh.pr("acme/westshared", 7, SHA);
  gh.pr("acme/south", 3, SHA);
  const watcher = new GithubWatcher({
    get: gh.get,
    settings: () => ({
      intervalSeconds: 60,
      maxIntervalSeconds: 300,
      budgetFloor: 500,
      watchesMax: 50,
    }),
    relay: async () => true,
  });
  const deps = {
    watcher: () => watcher,
    principal: () => principal as never,
    reposOf: (project: string) =>
      project === "north"
        ? ["acme/north"]
        : project === "west"
          ? ["acme/west"]
          : project === "south"
            ? ["acme/south"]
            : [],
    allRepos: () => ["acme/north", "acme/west", "acme/south"],
    // Issue 1270: each project's agents.watch_repos, as read (checked).
    watchReposOf: (project: string) =>
      // acme/south is another Den project's repo (not granted to north).
      project === "north"
        ? (northList ?? ["shared/pipeline", "ACME/South"])
        : project === "west"
          ? ["acme/westshared"]
          : [],
  };
  if (noAllRepos) delete (deps as { allRepos?: unknown }).allRepos;
  const call = async (method: string, path: string, body?: unknown) => {
    const { r, out } = res();
    const handled = await handleGithubWatchRoutes(
      req(method, body),
      r,
      path,
      deps,
    );
    return { handled, ...out };
  };
  return { call, gh };
}

const agent = {
  kind: "agent",
  actor: "agent:planner",
  workspace: "north",
  grants: ["west"],
  session: { name: "s" },
};

describe("github watch routes", () => {
  it("knows its paths", () => {
    expect(isGithubWatchPath("/api/agents/self/github-watches")).toBe(true);
    expect(isGithubWatchPath("/api/agents/self/github-watches/cancel")).toBe(
      true,
    );
    expect(isGithubWatchPath("/api/github/watches")).toBe(false);
  });

  it("an agent watches its project's repo, lists it and cancels it", async () => {
    const { call } = setup(agent);
    const made = await call("POST", "/api/agents/self/github-watches", {
      repo: "acme/north",
      pr: 5,
    });
    expect(made.status).toBe(200);
    const id = (made.body as { watch: { id: string } }).watch.id;
    const listed = await call("GET", "/api/agents/self/github-watches");
    expect(
      (listed.body as { watches: { id: string }[] }).watches.map((w) => w.id),
    ).toEqual([id]);
    const gone = await call("POST", "/api/agents/self/github-watches/cancel", {
      id,
    });
    expect(gone.status).toBe(200);
    const after = await call("GET", "/api/agents/self/github-watches");
    expect((after.body as { watches: unknown[] }).watches).toEqual([]);
  });

  it("refuses another project's repo (403), asking GitHub nothing", async () => {
    const { call, gh } = setup(agent);
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "other/elsewhere",
      pr: 5,
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, code: "scope" });
    expect(gh.calls).toEqual([]);
  });

  it("a granted project's repo is in scope", async () => {
    const { call } = setup(agent);
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "acme/west",
      pr: 404,
    });
    // In scope: GitHub was asked (the fake has no such pull request).
    expect(r.body).toMatchObject({ ok: false, code: "not_found" });
  });

  it("a person's request is refused: a watch tells an agent", async () => {
    const { call } = setup(null);
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "acme/north",
      pr: 5,
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: "agent_only" });
  });

  it("an unknown cancel is a 404", async () => {
    const { call } = setup(agent);
    const r = await call("POST", "/api/agents/self/github-watches/cancel", {
      id: "gw-nope",
    });
    expect(r.status).toBe(404);
  });
});

describe("issue 1270: a project's agents.watch_repos", () => {
  it("a listed repo is watched, through the same watcher", async () => {
    const { call } = setup(agent);
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "shared/pipeline",
      pr: 7,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      watch: { repo: "shared/pipeline", pr: 7 },
    });
  });

  it("an unlisted repo is refused, naming the setting and that it adds read-only watching", async () => {
    const { call, gh } = setup(agent);
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "other/elsewhere",
      pr: 5,
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, code: "scope" });
    const error = String((r.body as { error: string }).error);
    expect(error).toMatch(/agents\.watch_repos/);
    expect(error).toMatch(
      /read-only watching of that repo, with Den's own GitHub sign-in/,
    );
    expect(gh.calls).toEqual([]);
  });

  it("a granted project's list is that project's own: it doesn't reach this agent", async () => {
    const { call, gh } = setup(agent);
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "acme/westshared",
      pr: 7,
    });
    expect(r.status).toBe(403);
    expect(gh.calls).toEqual([]);
  });

  it("a listed repo's watch only reads: every call is a GET path under that repo", async () => {
    const { call, gh } = setup(agent);
    await call("POST", "/api/agents/self/github-watches", {
      repo: "shared/pipeline",
      pr: 7,
    });
    expect(gh.calls.length).toBeGreaterThan(0);
    for (const path of gh.calls)
      expect(path.startsWith("repos/shared/pipeline/")).toBe(true);
  });
  it("another Den project's repo on the list is refused, pointing to grants: the list doesn't bypass them", async () => {
    const { call, gh } = setup(agent);
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "acme/south",
      pr: 3,
    });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ ok: false, code: "scope" });
    const error = String((r.body as { error: string }).error);
    expect(error).toMatch(/acme\/south is a repo of another Den project/);
    expect(error).toMatch(/agents\.watch_repos is for repos outside Den/);
    expect(error).toMatch(/grant/);
    // A scoped agent isn't shown other projects' names.
    expect(error).not.toMatch(/south\)/);
    expect(gh.calls).toEqual([]);
  });

  it("a granted project's repo on the list stays watchable (the grant reaches it)", async () => {
    const { call } = setup({ ...agent, grants: ["west", "south"] });
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "acme/south",
      pr: 3,
    });
    expect(r.status).toBe(200);
  });
  it("without Den's repo list wired, watch_repos is ignored (fails closed)", async () => {
    const { call, gh } = setup(agent, { noAllRepos: true });
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "shared/pipeline",
      pr: 7,
    });
    expect(r.status).toBe(403);
    expect(gh.calls).toEqual([]);
    const own = await call("POST", "/api/agents/self/github-watches", {
      repo: "acme/north",
      pr: 5,
    });
    expect(own.status).toBe(200);
  });
  it.each([
    ["acme/south.git", "acme/south"],
    ["acme/south.git", "acme/south.git"],
    ["acme/South.GIT", "ACME/south.Git"],
    ["acme/south.git.git.git", "acme/south.git.git"],
  ])(
    "another Den project's repo listed as %s, asked as %s: still refused, pointing to grants",
    async (listed, asked) => {
      const { call, gh } = setup(agent, { northList: [listed] });
      const r = await call("POST", "/api/agents/self/github-watches", {
        repo: asked,
        pr: 3,
      });
      expect(r.status).toBe(403);
      expect(String((r.body as { error: string }).error)).toMatch(
        /is a repo of another Den project/,
      );
      expect(gh.calls).toEqual([]);
    },
  );

  it("a repo outside Den asked as owner/name.git is watched as owner/name", async () => {
    const { call } = setup(agent);
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "shared/pipeline.git",
      pr: 7,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ watch: { repo: "shared/pipeline" } });
  });
  it("a repo arg over 200 characters is a 400, fast, asking GitHub nothing", async () => {
    const { call, gh } = setup(agent);
    const t0 = Date.now();
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "a/" + ".git".repeat(500) + "x",
      pr: 1,
    });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, code: "bad_request" });
    expect(String((r.body as { error: string }).error)).toMatch(/200/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(gh.calls).toEqual([]);
  });

  it("a body of megabytes is refused (400) without keeping it", async () => {
    const { call, gh } = setup(agent);
    const t0 = Date.now();
    const r = await call("POST", "/api/agents/self/github-watches", {
      repo: "a/" + ".git".repeat(1_000_000) + "x",
      pr: 1,
    });
    expect(r.status).toBe(400);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(gh.calls).toEqual([]);
  });
});
