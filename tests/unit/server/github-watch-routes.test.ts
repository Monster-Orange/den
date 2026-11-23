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

function setup(principal: unknown) {
  const gh = new FakeGithub(Date.now);
  gh.pr("acme/north", 5, SHA);
  gh.pr("other/elsewhere", 5, SHA);
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
          : [],
  };
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
