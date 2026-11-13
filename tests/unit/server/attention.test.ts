/**
 * NT-1 / NT-2 / NT-3b: attention events, the waiting mark, and the
 * notifications they make. A temp store; fake output marks and clock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotificationStore } from "../../../src/shared/notifications";
import {
  Attention,
  RESUME_AFTER_MS,
  SETTLE_MS,
} from "../../../src/ui/server/attention";
import { bellsOf } from "../../../src/ui/server/notification-service";
import type { AgentRecord } from "../../../src/shared/agents/records";

let dir = "";
let clock = 1_000_000;
const marks: Record<string, string | null> = {};
const hookedIds = new Set<string>();

function mk() {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async (id) => marks[id] ?? null,
    nameOf: (id) => (id === "ag-1" ? "Planner" : id),
    now: () => clock,
    lookingMs: 10_000,
    hooked: (id) => hookedIds.has(id),
  });
  return { store, a };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-att-"));
  clock = 1_000_000;
  for (const k of Object.keys(marks)) delete marks[k];
  hookedIds.clear();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("attention", () => {
  it("waiting: marked, and a notification that links to the agent", async () => {
    const { store, a } = mk();
    marks["ag-1"] = "m1";
    await a.event("ag-1", "web", { event: "waiting", why: "permission" });
    expect([...a.waitingNow()]).toEqual([["ag-1", "permission"]]);
    const [n] = store.list();
    expect(n).toMatchObject({
      kind: "waiting",
      subject: "agent:ag-1",
      scope: "workspace/web",
      text: "Planner needs your permission",
      link: "/agents?ws=web&agent=ag-1",
      read: false,
    });
  });

  it("its output moves (answered, or it went on): no longer waiting, notification withdrawn", async () => {
    const { store, a } = mk();
    marks["ag-1"] = "m1";
    await a.event("ag-1", "web", { event: "waiting", why: "input" });
    await a.check();
    expect(a.waitingNow().size).toBe(1);
    // Output in the first seconds is the agent drawing its own call.
    marks["ag-1"] = "m1b";
    clock += 1000;
    await a.check();
    expect(a.waitingNow().size).toBe(1);
    clock += SETTLE_MS;
    marks["ag-1"] = "m2";
    await a.check();
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toEqual([]);
  });

  describe("the 0.4.41 gate: a runtime with hooks (Claude Code)", () => {
    it("its output never clears it (it redraws the prompt); a tool run after does", async () => {
      const { store, a } = mk();
      hookedIds.add("ag-1");
      marks["ag-1"] = "m1";
      await a.event("ag-1", "web", {
        event: "waiting",
        why: "permission",
        hooked: true,
      });
      for (let i = 0; i < 5; i++) {
        clock += 3000;
        marks["ag-1"] = `redraw-${i}`;
        await a.check();
      }
      expect([...a.waitingNow()]).toEqual([["ag-1", "permission"]]);
      expect(store.list()).toHaveLength(1);
      await a.event("ag-1", "web", { event: "resumed", from: "tool" });
      expect(a.waitingNow().size).toBe(0);
      expect(store.list()).toEqual([]);
    });

    it("a tool that finished right as it began waiting (one run beside it) doesn't clear it", async () => {
      const { a } = mk();
      await a.event("ag-1", "web", {
        event: "waiting",
        why: "permission",
        hooked: true,
      });
      clock += RESUME_AFTER_MS - 1;
      await a.event("ag-1", "web", { event: "resumed", from: "tool" });
      expect(a.waitingNow().size).toBe(1);
      clock += 1;
      await a.event("ag-1", "web", { event: "resumed", from: "prompt" });
      expect(a.waitingNow().size).toBe(0);
    });

    it("an ask stays until the answer: not its own call's end, not the turn's end", async () => {
      const { store, a } = mk();
      hookedIds.add("ag-1");
      await a.event("ag-1", "web", {
        event: "waiting",
        why: "asked",
        text: "A or B?",
      });
      clock += 2000;
      await a.event("ag-1", "web", { event: "resumed", from: "tool" });
      await a.event("ag-1", "web", { event: "finished" });
      // Claude Code's idle notice later: still the ask.
      await a.event("ag-1", "web", {
        event: "waiting",
        why: "input",
        hooked: true,
      });
      expect([...a.waitingNow()]).toEqual([["ag-1", "asked"]]);
      expect(store.list().map((n) => [n.kind, n.text])).toEqual([
        ["waiting", "Planner asked: A or B?"],
      ]);
      await a.event("ag-1", "web", { event: "resumed", from: "prompt" });
      expect(a.waitingNow().size).toBe(0);
    });

    it("a second call while waiting keeps when it began", async () => {
      const { a } = mk();
      await a.event("ag-1", "web", {
        event: "waiting",
        why: "permission",
        hooked: true,
      });
      clock += 900;
      // Notification after PermissionRequest, for the same dialog.
      await a.event("ag-1", "web", {
        event: "waiting",
        why: "permission",
        hooked: true,
      });
      clock += 200;
      await a.event("ag-1", "web", { event: "resumed", from: "tool" });
      expect(a.waitingNow().size).toBe(0);
    });
  });

  it("its person typing into its terminal answers it, whatever it waited on", async () => {
    const { store, a } = mk();
    hookedIds.add("ag-1");
    await a.event("ag-1", "web", { event: "waiting", why: "asked", text: "?" });
    a.typed("ag-1");
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toEqual([]);
    a.typed("ag-1"); // nothing waiting: nothing happens
  });

  it("(k): each item keeps its text as a key and values, for the page's language", async () => {
    const { store, a } = mk();
    await a.event("ag-1", "web", { event: "waiting", why: "permission" });
    expect(store.list()[0].msg).toEqual({
      key: "bell.m.permission",
      vars: { name: "Planner" },
    });
    await a.event("ag-1", "web", { event: "finished" });
    expect(store.list().map((n) => n.msg)).toEqual([
      { key: "bell.m.turn", vars: { name: "Planner" } },
    ]);
    // Finished Hub comments update that unread finished item.
    a.hubFinished("ag-1", "web", { count: 2, artifact: "Spec" });
    expect(store.list().map((n) => n.msg)).toEqual([
      {
        key: "bell.m.hubOn",
        vars: { name: "Planner", n: 2, artifact: "Spec" },
      },
    ]);
  });

  it("finished: a finished notification; any waiting mark goes", async () => {
    const { store, a } = mk();
    await a.event("ag-1", "web", { event: "waiting", why: "input" });
    await a.event("ag-1", "web", { event: "finished" });
    expect(a.waitingNow().size).toBe(0);
    expect(store.list().map((n) => [n.kind, n.text])).toEqual([
      ["finished", "Planner finished its turn"],
    ]);
  });

  it("NT-2: on screen, no notification (still marked); off screen after 10 s, one", async () => {
    const { store, a } = mk();
    a.lookingAt(["ag-1"]);
    await a.event("ag-1", "web", { event: "waiting", why: "input" });
    expect(a.waitingNow().size).toBe(1);
    expect(store.list()).toEqual([]);
    clock += 11_000;
    await a.event("ag-1", "web", { event: "finished" });
    expect(store.list().map((n) => n.kind)).toEqual(["finished"]);
  });

  it("asked (ask_human): its question in the text; gone() clears", async () => {
    const { store, a } = mk();
    await a.event("ag-1", "web", {
      event: "waiting",
      why: "asked",
      text: "Which branch?",
    });
    expect(store.list()[0].text).toBe("Planner asked: Which branch?");
    a.gone("ag-1");
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("NT-1 bell: a new bellAt marks it waiting for input; the same one again doesn't; one from before the server saw it doesn't", async () => {
    const { store, a } = mk();
    marks["ag-1"] = "m1";
    const at = (ms: number) => new Date(ms).toISOString();
    // First sight: a bell older than 10 s is history, not a new one.
    await a.bells([
      { agent: "ag-1", workspace: "web", bellAt: at(clock - 60_000) },
    ]);
    expect(a.waitingNow().size).toBe(0);
    clock += 1000;
    const rang = at(clock);
    await a.bells([{ agent: "ag-1", workspace: "web", bellAt: rang }]);
    expect([...a.waitingNow()]).toEqual([["ag-1", "input"]]);
    expect(store.list()[0].text).toBe("Planner is waiting for you");
    // Its output moves (after it settled): cleared. The same bell again: nothing.
    clock += SETTLE_MS;
    marks["ag-1"] = "m2";
    await a.check();
    await a.bells([{ agent: "ag-1", workspace: "web", bellAt: rang }]);
    expect(a.waitingNow().size).toBe(0);
  });

  it("NT-1 bell: an agent already waiting keeps why (permission stays permission)", async () => {
    const { a } = mk();
    marks["ag-1"] = "m1";
    await a.event("ag-1", "web", { event: "waiting", why: "permission" });
    clock += 1000;
    await a.bells([
      {
        agent: "ag-1",
        workspace: "web",
        bellAt: new Date(clock).toISOString(),
      },
    ]);
    expect([...a.waitingNow()]).toEqual([["ag-1", "permission"]]);
  });
});

describe("Hub comments finished", () => {
  it("one bell item: how many, on what, linking to the comment; plain for one", () => {
    const { store, a } = mk();
    a.hubFinished("ag-1", "web", {
      count: 2,
      artifact: "Pricing page",
      url: "https://hub.example.test/a/doc#th_1",
    });
    const [n] = store.list();
    expect(n).toMatchObject({
      kind: "finished",
      subject: "agent:ag-1",
      scope: "workspace/web",
      text: "Planner finished 2 Hub comments on Pricing page",
      link: "https://hub.example.test/a/doc#th_1",
    });
    a.hubFinished("ag-1", "web", { count: 1 });
    expect(store.list()[0].text).toBe("Planner finished 1 Hub comment");
    expect(store.list()[0].link).toBe("/agents?ws=web&agent=ag-1");
  });

  it("on screen: nothing", () => {
    const { store, a } = mk();
    a.lookingAt(["ag-1"]);
    a.hubFinished("ag-1", "web", { count: 1 });
    expect(store.list()).toEqual([]);
  });
});

describe("NT-1 bell: which agents rang", () => {
  const info = (id: string, bellAt?: string, exited = false) => ({
    ref: { backend: "den-pty", id },
    name: `acme-web:${id}`,
    pid: 1,
    startedAt: "2026-11-13T09:00:00.000Z",
    ...(bellAt ? { bellAt } : {}),
    ...(exited ? { exited: true } : {}),
  });
  const rec = (id: string, runtime: string, extra = {}) =>
    ({
      id,
      persona: id,
      runtime,
      workspace: "web",
      cwd: "/w",
      session: { backend: "den-pty", id: `s-${id}` },
      sessionName: `acme-web:${id}`,
      startedAt: "2026-11-13T09:00:00.000Z",
      ...extra,
    }) as unknown as AgentRecord;
  it("a running agent's rung session; not den-claude's (its hooks say it), not a stopped or exited one", () => {
    const t = "2026-11-13T09:05:00.000Z";
    expect(
      bellsOf(
        [
          info("s-cx", t),
          info("s-cl", t),
          info("s-st", t),
          info("s-ex", t, true),
          info("s-quiet"),
        ],
        [
          rec("cx", "codex"),
          rec("cl", "den-claude"),
          rec("st", "codex", { stoppedAt: t }),
          rec("ex", "gemini"),
          rec("quiet", "codex"),
        ],
      ),
    ).toEqual([{ agent: "cx", workspace: "web", bellAt: t }]);
  });
});
