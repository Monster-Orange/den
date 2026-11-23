/**
 * Issue 771: an agent's terminal said its status with OSC 7501 (the
 * sessions host read it: SessionInfo.status). Den shows it: blocked or
 * error → waiting for its person (held until the program says otherwise,
 * not cleared by its output moving); working or idle → no longer waiting;
 * done → its turn ended. Only the agent whose session printed it.
 * A temp store; fake output marks and clock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotificationStore } from "../../../src/shared/notifications";
import { Attention, SETTLE_MS } from "../../../src/ui/server/attention";
import { statusesOf } from "../../../src/ui/server/notification-service";
import type { AgentRecord } from "../../../src/shared/agents/records";
import type { SessionInfo } from "../../../src/shared/sessions/types";

let dir = "";
let clock = 1_000_000;
const marks: Record<string, string | null> = {};

function mk() {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async (id) => marks[id] ?? null,
    nameOf: (id) => (id === "ag-1" ? "Planner" : id),
    now: () => clock,
    lookingMs: 10_000,
  });
  return { store, a };
}
const at = (ms: number) => new Date(ms).toISOString();
const st = (agent: string, state: string, ms = clock) => ({
  agent,
  workspace: "web",
  state: state as "working",
  at: at(ms),
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-att771-"));
  clock = 1_000_000;
  for (const k of Object.keys(marks)) delete marks[k];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("Attention.statuses (issue 771)", () => {
  it.each(["idle", "working", "done", "blocked", "error"])(
    "state=%s becomes the agent's status",
    async (state) => {
      const { a } = mk();
      await a.statuses([st("ag-1", state)]);
      expect(a.statusNow().get("ag-1")).toBe(state);
    },
  );

  it("termOf gives the state and its read time for agentStatus; another agent has none; gone clears it", async () => {
    const { a } = mk();
    await a.statuses([st("ag-1", "error", 999_000)]);
    expect(a.termOf("ag-1")).toEqual({ state: "error", at: at(999_000) });
    expect(a.termOf("ag-2")).toBeUndefined();
    a.gone("ag-1");
    expect(a.termOf("ag-1")).toBeUndefined();
  });

  it("blocked: waiting for its person, with a bell row; its output moving doesn't clear it; working does", async () => {
    const { store, a } = mk();
    marks["ag-1"] = "m1";
    await a.statuses([st("ag-1", "blocked")]);
    expect([...a.waitingNow()]).toEqual([["ag-1", "input"]]);
    expect(store.list()[0]).toMatchObject({
      kind: "waiting",
      subject: "agent:ag-1",
      text: "Planner is waiting for you",
    });
    clock += SETTLE_MS + 1000;
    marks["ag-1"] = "m2";
    await a.check();
    expect(a.waitingNow().size).toBe(1);
    clock += 1000;
    await a.statuses([st("ag-1", "working")]);
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("error waits too; idle clears it", async () => {
    const { a } = mk();
    await a.statuses([st("ag-1", "error")]);
    expect([...a.waitingNow()]).toEqual([["ag-1", "input"]]);
    clock += 1000;
    await a.statuses([st("ag-1", "idle")]);
    expect(a.waitingNow().size).toBe(0);
  });

  it("done: its turn ended (a finished row), any wait gone", async () => {
    const { store, a } = mk();
    await a.statuses([st("ag-1", "blocked")]);
    clock += 1000;
    await a.statuses([st("ag-1", "done")]);
    expect(a.waitingNow().size).toBe(0);
    expect(store.list().map((n) => n.kind)).toEqual(["finished"]);
  });

  it("the same status again does nothing", async () => {
    const { store, a } = mk();
    const now = st("ag-1", "done");
    await a.statuses([now]);
    await a.statuses([now]);
    expect(store.list()).toHaveLength(1);
  });

  it("first seen long ago (after a restart): blocked and error still raise a waiting; done raises nothing", async () => {
    const { store, a } = mk();
    await a.statuses([st("ag-1", "blocked", clock - 30_000)]);
    expect([...a.waitingNow()]).toEqual([["ag-1", "input"]]);
    await a.statuses([st("ag-2", "error", clock - 30_000)]);
    expect(a.waitingNow().has("ag-2")).toBe(true);
    await a.statuses([st("ag-3", "done", clock - 30_000)]);
    expect(a.statusNow().get("ag-3")).toBe("done");
    expect(store.list().filter((n) => n.subject === "agent:ag-3")).toEqual([]);
  });

  it.each(["working", "idle", "done"])(
    "a 7501 never lowers a waiting it didn't raise: a bell's waiting stays after state=%s",
    async (state) => {
      const { a } = mk();
      await a.event("ag-1", "web", { event: "waiting", why: "permission" });
      expect(a.waitingNow().get("ag-1")).toBe("permission");
      clock += 1000;
      await a.statuses([st("ag-1", state)]);
      expect(a.waitingNow().get("ag-1")).toBe("permission");
    },
  );

  it("a bell's waiting that a 7501 blocked then repeats is still not the 7501's to clear", async () => {
    const { a } = mk();
    await a.event("ag-1", "web", { event: "waiting", why: "permission" });
    clock += 1000;
    await a.statuses([st("ag-1", "blocked")]);
    clock += 1000;
    await a.statuses([st("ag-1", "working")]);
    expect(a.waitingNow().get("ag-1")).toBe("permission");
  });

  it.each([
    ["the screen's question (issue 828)", { why: "asked", dialog: true }],
    ["a permission dialog", { why: "permission" }],
  ] as const)(
    "a 7501-raised wait that %s then repeats is no longer the 7501's to lower",
    async (_w, ev) => {
      const { a } = mk();
      await a.statuses([st("ag-1", "blocked")]);
      clock += 1000;
      await a.event("ag-1", "web", { event: "waiting", ...ev });
      clock += 1000;
      await a.statuses([st("ag-1", "idle")]);
      expect(a.waitingNow().get("ag-1")).toBe(ev.why);
    },
  );

  it("applies only to the agent it names", async () => {
    const { a } = mk();
    await a.statuses([st("ag-2", "blocked")]);
    expect(a.statusNow().get("ag-1")).toBeUndefined();
    expect([...a.waitingNow().keys()]).toEqual(["ag-2"]);
    clock += 1000;
    await a.statuses([st("ag-1", "working")]);
    expect([...a.waitingNow().keys()]).toEqual(["ag-2"]);
  });

  it("an unknown state is ignored", async () => {
    const { a } = mk();
    await a.statuses([st("ag-1", "working")]);
    await expect(
      a.statuses([st("ag-1", "sleeping", clock + 1)]),
    ).resolves.toBeUndefined();
    expect(a.statusNow().get("ag-1")).toBe("working");
  });

  it("an agent gone loses its status", async () => {
    const { a } = mk();
    await a.statuses([st("ag-1", "working")]);
    a.gone("ag-1");
    expect(a.statusNow().has("ag-1")).toBe(false);
  });
});

describe("statusesOf: whose terminal said it (issue 771)", () => {
  const t = "2026-11-13T09:05:00.000Z";
  const info = (id: string, state?: string, exited = false): SessionInfo => ({
    ref: { backend: "den-pty", id },
    name: `acme-web:${id}`,
    pid: 1,
    startedAt: "2026-11-13T09:00:00.000Z",
    ...(state ? { status: { state: state as "working", at: t } } : {}),
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

  it("each status goes to the agent whose own session printed it; not den-claude's (its hooks say it), not a stopped or exited one", () => {
    expect(
      statusesOf(
        [
          info("s-cx", "blocked"),
          info("s-gm", "working"),
          info("s-cl", "done"),
          info("s-st", "error"),
          info("s-ex", "error", true),
          info("s-quiet"),
          info("s-orphan", "blocked"),
        ],
        [
          rec("cx", "codex"),
          rec("gm", "gemini"),
          rec("cl", "den-claude"),
          rec("st", "codex", { stoppedAt: t }),
          rec("ex", "gemini"),
          rec("quiet", "codex"),
        ],
      ),
    ).toEqual([
      { agent: "cx", workspace: "web", state: "blocked", at: t },
      { agent: "gm", workspace: "web", state: "working", at: t },
    ]);
  });
});
