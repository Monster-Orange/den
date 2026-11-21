/**
 * Issue 773: four agent states for each person, from the attention hooks
 * and the seen mark. One test per rule of the approved mock that the
 * server owns, and per acceptance clause 1, 2, 3, 6 and 7:
 *   Done, not seen   a turn finished after this person last opened it
 *   Done → Idle      opening the agent (POST /api/notifications/looking)
 *   Seen per person  the same person's two sessions agree; a second
 *                    person still sees Done; it survives a restart
 *   Working again    a new turn is Working; its end, unseen, is Done again
 *   Needs you        a permission, a question or an Allow, before the rest
 *   Stopped          outside the four states
 *   Bell             Done agents for the person, oldest first
 * A temp state folder and a fake clock. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NotificationStore } from "../../../src/shared/notifications.js";
import { SeenMarks } from "../../../src/shared/seen-mark.js";
import { Attention } from "../../../src/ui/server/attention.js";
import {
  agentStateOf,
  agentSubject,
  doneAgents,
  personKey,
  withAgentStates,
  type AgentStateDeps,
} from "../../../src/ui/server/agent-state.js";
import { handleNotificationRoutes } from "../../../src/ui/server/notification-routes.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";

let dir = "";
let clock = 1_800_000_000_000;
beforeEach(() => {
  clock = 1_800_000_000_000;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-773-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function mk(seen = new SeenMarks(dir), hooked = true) {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: (id) => id,
    now: () => clock,
    hooked: () => hooked,
    endedAsking: async () => null,
    turnEnded: (agent, at) =>
      seen.noteVersion(
        agentSubject(agent),
        String(at),
        new Date(at).toISOString(),
      ),
  });
  const deps: AgentStateDeps = {
    seen,
    working: () => a.workingNow(),
    waitingSince: (agent) => a.waitingDetail(agent)?.since,
  };
  return { store, a, seen, deps };
}

const row = (agent: string, extra: Record<string, unknown> = {}) => ({
  id: `s-${agent}`,
  kind: "agent",
  agent,
  workspace: "north",
  state: "running",
  ...extra,
});

/** A request as the route sees it: a body, and who it proved to be. */
function req(method: string, url: string, body: unknown, actor?: string) {
  const r = new PassThrough() as unknown as http.IncomingMessage & PassThrough;
  Object.assign(r, { method, url, headers: {} });
  if (actor)
    setPrincipal(r, { kind: "person", actor: actor as `person:${string}` });
  (r as PassThrough).end(body === undefined ? "" : JSON.stringify(body));
  return r;
}
function res() {
  const out = { status: 0, body: "" };
  const r = {
    headersSent: false,
    setHeader: () => undefined,
    writeHead: (s: number) => {
      out.status = s;
      return r;
    },
    end: (b?: string) => {
      out.body = b ?? "";
    },
  } as unknown as http.ServerResponse;
  return { r, out };
}

async function look(
  d: ReturnType<typeof mk>,
  agents: string[],
  actor?: string,
) {
  const { r, out } = res();
  await handleNotificationRoutes(
    req("POST", "/api/notifications/looking", { agents }, actor),
    r,
    "/api/notifications/looking",
    { store: d.store, attention: d.a, seen: d.seen },
  );
  return out;
}

describe("issue 773 clause 1: Done, not seen", () => {
  it("an agent that finishes while the person has not opened it since is Done for them", async () => {
    const d = mk();
    await d.a.event("builder", "north", { event: "resumed", from: "prompt" });
    expect(agentStateOf(row("builder"), "person:a", d.deps)?.attn).toBe(
      "working",
    );
    clock += 60_000;
    await d.a.event("builder", "north", { event: "finished" });
    const s = agentStateOf(row("builder"), "person:a", d.deps);
    expect(s?.attn).toBe("done");
    expect(s?.attnSince).toBe(new Date(clock).toISOString());
  });

  it("an agent that never finished a turn is Idle", () => {
    const d = mk();
    expect(agentStateOf(row("scribe"), "person:a", d.deps)?.attn).toBe("idle");
  });
});

describe("issue 773 clause 2: opening the agent is seen", () => {
  it("the page's looking call records a seen mark, and the agent becomes Idle", async () => {
    const d = mk();
    await d.a.event("builder", "north", { event: "finished" });
    const out = await look(d, ["builder"], "person:a");
    expect(out.status).toBe(200);
    expect(agentStateOf(row("builder"), "person:a", d.deps)?.attn).toBe("idle");
  });
});

describe("issue 773 clause 3: seen is per person", () => {
  it("one person's two sessions agree; a second person still sees Done", async () => {
    const d = mk();
    await d.a.event("builder", "north", { event: "finished" });
    // The phone opens it: the desktop (the same person) sees Idle too.
    await look(d, ["builder"], "person:a");
    const phone = withAgentStates([row("builder")], "person:a", d.deps)[0];
    const desk = withAgentStates([row("builder")], "person:a", d.deps)[0];
    expect(phone.attn).toBe("idle");
    expect(desk.attn).toBe("idle");
    expect(withAgentStates([row("builder")], "person:b", d.deps)[0].attn).toBe(
      "done",
    );
  });

  it("the person is who the request proved: a person token, else the one person", () => {
    const withActor = req("GET", "/", undefined, "person:a");
    expect(personKey(withActor)).toBe("person:a");
    expect(personKey(req("GET", "/", undefined))).toBe("person");
  });
});

describe("issue 773 clause 7: seen marks survive a restart", () => {
  it("a new server (a new store and tracker) keeps Done and Idle per person", async () => {
    const d = mk();
    await d.a.event("builder", "north", { event: "finished" });
    await d.a.event("tester", "north", { event: "finished" });
    await look(d, ["builder"], "person:a");
    const again = mk(new SeenMarks(dir));
    expect(agentStateOf(row("builder"), "person:a", again.deps)?.attn).toBe(
      "idle",
    );
    expect(agentStateOf(row("tester"), "person:a", again.deps)?.attn).toBe(
      "done",
    );
  });
});

describe("issue 773: Working again", () => {
  it("a Done agent that starts a new turn is Working; that turn's end, unseen, is Done again", async () => {
    const d = mk();
    await d.a.event("builder", "north", { event: "finished" });
    await look(d, ["builder"], "person:a");
    clock += 1000;
    await d.a.event("builder", "north", {
      event: "resumed",
      from: "tool",
      what: "Bash",
    });
    expect(agentStateOf(row("builder"), "person:a", d.deps)?.attn).toBe(
      "working",
    );
    clock += 1000;
    await d.a.event("builder", "north", { event: "finished" });
    expect(agentStateOf(row("builder"), "person:a", d.deps)?.attn).toBe("done");
  });

  it("a new session is not a turn: it doesn't make the agent Working", async () => {
    const d = mk();
    await d.a.event("builder", "north", { event: "resumed", from: "session" });
    expect(agentStateOf(row("builder"), "person:a", d.deps)?.attn).toBe("idle");
  });
});

describe("issue 773: Needs you", () => {
  it("a permission, a question or an Allow needs the person, over Working and Done", async () => {
    const d = mk();
    await d.a.event("planner", "north", { event: "finished" });
    clock += 5000;
    await d.a.event("planner", "north", {
      event: "waiting",
      why: "permission",
      what: "Bash",
      hooked: true,
    });
    const s = agentStateOf(
      row("planner", { waiting: true, waitingWhy: "permission" }),
      "person:a",
      d.deps,
    );
    expect(s?.attn).toBe("needs");
    expect(s?.attnSince).toBe(new Date(clock).toISOString());
    for (const why of ["asked", "approval", "trust"])
      expect(
        agentStateOf(
          row("x", { waiting: true, waitingWhy: why }),
          "person:a",
          d.deps,
        )?.attn,
      ).toBe("needs");
  });

  it("an idle notice (input) waits on nobody: not Needs you", () => {
    const d = mk();
    expect(
      agentStateOf(
        row("x", { waiting: true, waitingWhy: "input" }),
        "person:a",
        d.deps,
      )?.attn,
    ).toBe("idle");
  });

  it("a hookless agent's idle notice ends its turn: Done until opened", async () => {
    const d = mk(new SeenMarks(dir), false);
    await d.a.event("coder", "north", {
      event: "waiting",
      why: "input",
      hooked: false,
    });
    expect(agentStateOf(row("coder"), "person:a", d.deps)?.attn).toBe("done");
  });
});

describe("issue 773: Stopped agents stay outside the four states", () => {
  it("a stopped agent and a plain shell get no state", async () => {
    const d = mk();
    await d.a.event("old", "north", { event: "finished" });
    expect(
      agentStateOf(row("old", { state: "stopped" }), "person:a", d.deps),
    ).toBeNull();
    expect(
      agentStateOf(
        { id: "s1", kind: "session", workspace: "north", state: "running" },
        "person:a",
        d.deps,
      ),
    ).toBeNull();
    const [r] = withAgentStates(
      [row("old", { state: "stopped" })],
      "p",
      d.deps,
    );
    expect("attn" in r).toBe(false);
  });
});

describe("issue 773 clause 6: the bell's Done, not seen", () => {
  it("the person's Done agents, oldest first; seen and stopped ones left out", async () => {
    const d = mk();
    await d.a.event("late", "north", { event: "finished" });
    clock -= 60_000;
    await d.a.event("early", "south", { event: "finished" });
    await d.a.event("looked", "north", { event: "finished" });
    await look(d, ["looked"], "person:a");
    await d.a.event("halted", "north", { event: "finished" });
    const recs = [
      { id: "late", workspace: "north" },
      { id: "early", workspace: "south", displayName: "Early bird" },
      { id: "looked", workspace: "north" },
      {
        id: "halted",
        workspace: "north",
        stoppedAt: new Date(clock + 1000).toISOString(),
      },
    ];
    const done = doneAgents(recs, "person:a", d.deps);
    expect(done.map((x) => x.agent)).toEqual(["early", "late"]);
    expect(done[0]).toMatchObject({
      name: "Early bird",
      workspace: "south",
      link: "/agents?project=south&agent=early",
    });
    // A second person has seen none of them.
    expect(doneAgents(recs, "person:b", d.deps).map((x) => x.agent)).toEqual([
      "early",
      "looked",
      "late",
    ]);
  });

  it("GET /api/notifications says the person's Done agents", async () => {
    const d = mk();
    await d.a.event("builder", "north", { event: "finished" });
    const { r, out } = res();
    await handleNotificationRoutes(
      req("GET", "/api/notifications", undefined, "person:a"),
      r,
      "/api/notifications",
      {
        store: d.store,
        attention: d.a,
        seen: d.seen,
        doneAgents: (person) =>
          doneAgents([{ id: "builder", workspace: "north" }], person, d.deps),
      },
    );
    const b = JSON.parse(out.body) as { done: { agent: string }[] };
    expect(b.done.map((x) => x.agent)).toEqual(["builder"]);
  });
});
