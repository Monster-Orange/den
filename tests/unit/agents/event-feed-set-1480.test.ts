/**
 * Issue 1480: an app's event feed is added and removed through Den, never
 * by editing workspaces.yml by hand: the held writes
 * project_event_feed_add and project_event_feed_remove (applied at once
 * with Undo on a personal install, held for the Allow on a strict one),
 * and the Settings row's own Add and Remove. The bearer is a secrets.refs
 * name, never a value, and a value is never echoed. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import { AUDIT_HEADERS } from "../../../src/shared/agent-actor.js";
import { criticalWhy } from "../../../src/shared/approval-policy.js";
import {
  checkEventFeedAdd,
  checkEventFeedRemove,
  resolveAgentsDeps,
  runEventFeedAdd,
  runEventFeedRemove,
  undoEventFeed,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import { notePolicyRun } from "../../../src/ui/server/approval-routes.js";
import { heldActions } from "../../../src/ui/server/held-actions.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

const VALUE = "chat_TESTONLY_never_shown_7c41";
const URL_A = "https://chat.example.test/events";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

/** A rig whose feeds live in memory, with agent "planner" in north. */
async function withFeeds(): Promise<{
  r: Rig;
  saved: Record<string, Record<string, unknown>[]>;
}> {
  const saved: Record<string, Record<string, unknown>[]> = {};
  const r = await rig({
    workspaceEventFeeds: (ws) => saved[ws],
    saveWorkspaceEventFeeds: (ws, list) => {
      saved[ws] = list;
    },
  });
  expect(
    await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
  ).toBe(0);
  return { r, saved };
}

describe("issue 1480: project_event_feed_add and _remove", () => {
  it("add checks the name, the agent (one of the project's) and the url, then writes it", async () => {
    const { r, saved } = await withFeeds();
    const d = resolveAgentsDeps(r.deps);
    const ask = (a: Record<string, unknown>, who = {}) =>
      checkEventFeedAdd(
        d,
        { project: "north", name: "chat", agent: "planner", url: URL_A, ...a },
        who,
      );
    expect(ask({ name: "Chat Feed!" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("name:"),
    });
    expect(ask({ agent: "nobody" })).toEqual({
      ok: false,
      error: 'agent: "nobody" is not one of project north\'s agents',
    });
    expect(ask({ url: "ftp://chat.example.test" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("url must be https"),
    });
    expect(ask({}, { agent: "scout", project: "south" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("south"),
    });
    const c = ask({ bearer: "chat_feed_token" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBeUndefined();
    expect(c.params).toEqual({
      project: "north",
      name: "chat",
      agent: "planner",
      url: URL_A,
    });
    expect(c.details.join("\n")).toContain("secrets.refs.chat_feed_token");
    const done = await runEventFeedAdd(d, { ...c.args });
    expect(done).toMatchObject({ ok: true, project: "north", name: "chat" });
    expect(saved.north).toEqual([
      { name: "chat", agent: "planner", url: URL_A, bearer: "chat_feed_token" },
    ]);
    expect(ask({})).toEqual({
      ok: false,
      error: 'project north already has an event feed "chat"',
    });
  });

  it("remove takes the named feed out and leaves the others as written", async () => {
    const { r, saved } = await withFeeds();
    const d = resolveAgentsDeps(r.deps);
    const other = { name: "odd", agent: "planner", url: "not a url" };
    saved.north = [{ name: "chat", agent: "planner", url: URL_A }, other];
    expect(checkEventFeedRemove(d, { project: "north", name: "nope" })).toEqual(
      { ok: false, error: 'project north has no event feed "nope"' },
    );
    const c = checkEventFeedRemove(d, { project: "north", name: "chat" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(await runEventFeedRemove(d, { ...c.args })).toMatchObject({
      ok: true,
      project: "north",
      name: "chat",
    });
    expect(saved.north).toEqual([other]);
  });

  it("a bearer that isn't a secrets.refs name is refused and never echoed", async () => {
    const { r, saved } = await withFeeds();
    const d = resolveAgentsDeps(r.deps);
    for (const bearer of [`Bearer ${VALUE}`, `${VALUE}!`, { v: VALUE }]) {
      const c = checkEventFeedAdd(d, {
        project: "north",
        name: "chat",
        agent: "planner",
        url: URL_A,
        bearer,
      });
      expect(c.ok).toBe(false);
      expect(JSON.stringify(c)).not.toContain(VALUE);
    }
    expect(saved.north).toBeUndefined();
  });
});

describe("issue 1480: the approval policy, as issue 1391's", () => {
  it("personal applies at once; strict holds it for the Allow", () => {
    for (const a of ["project_event_feed_add", "project_event_feed_remove"]) {
      expect(criticalWhy(a, false, [], "personal")).toBeNull();
      expect(criticalWhy(a, false, [], "strict")).toBe("critical");
    }
  });

  it("the held actions run them, and the bell row of one run without asking has Undo", () => {
    const held = heldActions({} as Parameters<typeof heldActions>[0]);
    expect(Object.keys(held)).toEqual(
      expect.arrayContaining([
        "project_event_feed_add",
        "project_event_feed_remove",
      ]),
    );
    const rows: Record<string, unknown>[] = [];
    const store = { add: (n: Record<string, unknown>) => rows.push(n) };
    for (const action of [
      "project_event_feed_add",
      "project_event_feed_remove",
    ])
      notePolicyRun(
        store as never,
        {
          id: `ap-${action}`,
          agent: "planner",
          summary: "s",
          action,
          result: { ok: true },
        },
        "north",
      );
    expect(rows.map((n) => n.undo)).toEqual([
      { approval: "ap-project_event_feed_add" },
      { approval: "ap-project_event_feed_remove" },
    ]);
  });

  it("Undo takes an added feed back out and puts a removed one back; never one the person allowed", async () => {
    const { r, saved } = await withFeeds();
    const d = resolveAgentsDeps(r.deps);
    const add = checkEventFeedAdd(d, {
      project: "north",
      name: "chat",
      agent: "planner",
      url: URL_A,
    });
    if (!add.ok) throw new Error(add.error);
    const added = await runEventFeedAdd(d, { ...add.args });
    const ap = (action: string, result: unknown, decidedBy: string) => ({
      id: "ap-1",
      action,
      result,
      decidedBy,
    });
    expect(
      undoEventFeed(d, ap("project_event_feed_add", added, "person:ward")),
    ).toMatchObject({ ok: false });
    expect(saved.north).toHaveLength(1);
    expect(
      undoEventFeed(d, ap("project_event_feed_add", added, "auto:personal")),
    ).toMatchObject({ ok: true });
    expect(saved.north).toEqual([]);

    saved.north = [{ name: "chat", agent: "planner", url: URL_A }];
    const rm = checkEventFeedRemove(d, { project: "north", name: "chat" });
    if (!rm.ok) throw new Error(rm.error);
    const removed = await runEventFeedRemove(d, { ...rm.args });
    expect(saved.north).toEqual([]);
    expect(
      undoEventFeed(
        d,
        ap("project_event_feed_remove", removed, "auto:personal"),
      ),
    ).toMatchObject({ ok: true });
    expect(saved.north).toEqual([
      { name: "chat", agent: "planner", url: URL_A },
    ]);
    // A feed of that name came back since: nothing to put back.
    expect(
      undoEventFeed(
        d,
        ap("project_event_feed_remove", removed, "auto:personal"),
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("issue 1480: the Settings row's Add and Remove", () => {
  async function serve(r: Rig): Promise<string> {
    const s = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleAgentRoutes(req, res, p, { agents: r.deps });
    });
    servers.push(s);
    await new Promise<void>((res) => s.listen(0, "localhost", () => res()));
    return `http://localhost:${(s.address() as AddressInfo).port}`;
  }

  it("a person adds one and removes it; an agent is refused; a bad bearer isn't echoed", async () => {
    const { r, saved } = await withFeeds();
    const base = await serve(r);
    const feeds = `${base}/api/workspaces/north/event-feeds`;
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      fetch(feeds, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    const leak = await post({
      name: "chat",
      agent: "planner",
      url: URL_A,
      bearer: `Bearer ${VALUE}`,
    });
    expect(leak.status).toBe(400);
    expect(await leak.text()).not.toContain(VALUE);
    const asAgent = await post(
      { name: "chat", agent: "planner", url: URL_A },
      {
        [AUDIT_HEADERS.actor]: "agent",
        [AUDIT_HEADERS.agent]: "agent:planner",
      },
    );
    expect(asAgent.status).toBe(403);
    expect(saved.north).toBeUndefined();
    const ok = await post({ name: "chat", agent: "planner", url: URL_A });
    expect(ok.status).toBe(200);
    expect(saved.north).toEqual([
      { name: "chat", agent: "planner", url: URL_A },
    ]);
    const gone = await fetch(`${feeds}/chat`, { method: "DELETE" });
    expect(gone.status).toBe(200);
    expect(saved.north).toEqual([]);
    expect((await fetch(`${feeds}/chat`, { method: "DELETE" })).status).toBe(
      404,
    );
  });

  it("GET names the project's agents for the Add form", async () => {
    const { r } = await withFeeds();
    const base = await serve(r);
    const v = (await (
      await fetch(`${base}/api/workspaces/north/event-feeds`)
    ).json()) as { agents?: string[] };
    expect(v.agents).toEqual(["planner"]);
  });
});
