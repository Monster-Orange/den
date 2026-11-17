/**
 * Issue 327: after a self-update restart the server agent was shown
 * "waiting · permission" for hours, and every update pass said "waiting
 * on its person's Allow" without saying on what. A wait must not outlive
 * its dialog, each wait names what it saw and since when, and the update's
 * "waits" bell item goes once the update goes on, even when it was read
 * or posted before a restart. A temp store; fakes; invented versions.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NotificationStore } from "../../../src/shared/notifications";
import { Attention, RESUME_AFTER_MS } from "../../../src/ui/server/attention";
import {
  ATTENTION_EVENTS,
  attentionOf,
} from "../../../src/shared/agents/guardrails/attention-hook";
import { agentEnded } from "../../../src/ui/server/notification-service";
import { denClaude } from "../../../src/shared/agents/den-claude";
import { promptOnScreen } from "../../../src/shared/agents/trust-prompt";
import * as updateCheckMod from "../../../src/ui/server/update-check";
import {
  updateCheck,
  type UpdateCheckDeps,
  type UpdateWait,
} from "../../../src/ui/server/update-check";

let dir = "";
let clock = Date.parse("2026-01-02T03:04:05.000Z");

function mk() {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: () => "Server agent",
    now: () => clock,
    hooked: () => true,
  });
  return { store, a };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-327-"));
  clock = Date.parse("2026-01-02T03:04:05.000Z");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** What the hook would post for `input`, as the route hands it on. */
function ev(input: Record<string, unknown>) {
  const e = attentionOf(input);
  if (!e) throw new Error(`no event for ${JSON.stringify(input)}`);
  return e as Parameters<Attention["event"]>[2];
}

describe("a permission wait doesn't outlive its dialog", () => {
  it("the agent's session starts again after the restart: no longer waiting", async () => {
    const { a } = mk();
    await a.event(
      "server",
      "den-server",
      ev({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
    );
    expect(a.waitingNow().get("server")).toBe("permission");
    clock += 5 * 60_000;
    // The Den restart brings the agent back in a new Claude session: no
    // dialog from before it is on its screen.
    expect(ATTENTION_EVENTS).toContain("SessionStart");
    await a.event(
      "server",
      "den-server",
      ev({ hook_event_name: "SessionStart", source: "resume" }),
    );
    expect(a.waitingNow().has("server")).toBe(false);
  });

  it("a compaction keeps the session, and its dialog", () => {
    expect(
      attentionOf({ hook_event_name: "SessionStart", source: "compact" }),
    ).toBeNull();
  });

  it("Claude Code's idle notice (no dialog open) clears a permission wait", async () => {
    const { a } = mk();
    await a.event(
      "server",
      "den-server",
      ev({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
    );
    clock += RESUME_AFTER_MS + 60_000;
    await a.event(
      "server",
      "den-server",
      ev({
        hook_event_name: "Notification",
        notification_type: "idle_prompt",
        message: "Claude is waiting for your input",
      }),
    );
    expect(a.waitingNow().has("server")).toBe(false);
  });

  it("the permission notice for the same dialog keeps it waiting", async () => {
    const { a } = mk();
    await a.event(
      "server",
      "den-server",
      ev({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
    );
    clock += 6000;
    await a.event(
      "server",
      "den-server",
      ev({
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        message: "Claude needs your permission to use Bash",
      }),
    );
    expect(a.waitingNow().get("server")).toBe("permission");
  });

  it("an ask stays across a new session (Den holds the question)", async () => {
    const { a } = mk();
    await a.event("server", "den-server", {
      event: "waiting",
      why: "asked",
      text: "Which branch?",
      hooked: true,
    });
    await a.event("server", "den-server", {
      event: "resumed",
      from: "session",
    });
    expect(a.waitingNow().get("server")).toBe("asked");
  });
});

describe("a wait names what it saw, and since when", () => {
  it("the hook names the tool, or the notice trimmed", () => {
    expect(
      attentionOf({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
    ).toMatchObject({ why: "permission", what: "Bash" });
    const long = `Claude needs your permission to use ${"x".repeat(200)}`;
    const n = attentionOf({ hook_event_name: "Notification", message: long });
    expect(n).toMatchObject({ why: "permission" });
    expect((n as { what: string }).what.length).toBeLessThanOrEqual(80);
    expect((n as { what: string }).what.startsWith("Claude needs")).toBe(true);
  });

  it("the bell row says the tool; the wait keeps since when", async () => {
    const { store, a } = mk();
    await a.event(
      "server",
      "den-server",
      ev({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
    );
    const [n] = store.list();
    expect(n).toMatchObject({
      kind: "waiting",
      text: "Server agent needs your permission: Bash",
      msg: {
        key: "bell.m.permissionWhat",
        vars: { name: "Server agent", what: "Bash" },
      },
    });
    clock += 6000;
    // The notice for the same dialog keeps what and when it began.
    await a.event(
      "server",
      "den-server",
      ev({
        hook_event_name: "Notification",
        message: "Claude needs your permission to use Bash",
      }),
    );
    expect(a.waitingDetail("server")).toEqual({
      why: "permission",
      what: "Bash",
      since: "2026-01-02T03:04:05.000Z",
    });
  });
});

function fake(over: Partial<UpdateCheckDeps> = {}) {
  const notes: string[] = [];
  const logs: string[] = [];
  let wait: UpdateWait | null = "permission";
  const d: UpdateCheckDeps = {
    running: () => "1.2.0",
    latest: async () => "1.3.0",
    pinned: () => "1.2.0",
    role: () => "lead",
    mode: () => "auto",
    cantUpdate: () => null,
    last: () => null,
    idle: async () => wait === null,
    waitWhy: async () => wait,
    waitWhat: () => ({ what: "Bash", since: "2026-01-02T03:04:05.000Z" }),
    waitChecks: () => 2,
    update: async () => ({ ok: true }),
    ask: () => true,
    notice: () => undefined,
    log: (l) => logs.push(l),
    waitNote: (v, why, needs, at) =>
      notes.push(`wait ${v} ${why} ${needs} ${at?.what ?? "-"}`),
    waitDone: () => notes.push("wait done"),
    ...over,
  };
  return { d, notes, logs, set: (w: UpdateWait | null) => (wait = w) };
}

describe("the update check names the prompt", () => {
  it("its state, its log and its bell item say what and since when", async () => {
    const f = fake();
    const t = await updateCheck(f.d).tick();
    expect(t).toMatchObject({
      did: "waiting",
      wait: "permission",
      why: "the Den agent is waiting on its person's Allow: Bash since 2026-01-02T03:04:05.000Z",
    });
    expect(f.logs).toEqual([
      "update check: Den 1.3.0 waits: the Den agent is waiting on its person's Allow: Bash since 2026-01-02T03:04:05.000Z",
    ]);
    expect(f.notes).toEqual(["wait 1.3.0 permission false Bash"]);
  });
});

describe("the update's waits item goes when the update goes on", () => {
  it("after a restart, the first pass that doesn't wait clears an item from before it", async () => {
    // A new process: the item an earlier one posted is still in the bell.
    const f = fake();
    f.set(null);
    const t = await updateCheck(f.d).tick();
    expect(t).toMatchObject({ did: "updating" });
    expect(f.notes).toContain("wait done");
  });

  it("an item the person had read goes too: no 'waits' item after the update", () => {
    const { updateWaitNotes } = updateCheckMod as unknown as {
      updateWaitNotes?: (
        s: NotificationStore,
        title: string,
      ) => {
        note: (
          v: string,
          why: UpdateWait,
          needs: boolean,
          at?: { what: string; since: string } | null,
        ) => void;
        done: () => void;
      };
    };
    expect(typeof updateWaitNotes).toBe("function");
    const store = new NotificationStore(dir, () => new Date(clock));
    const w = updateWaitNotes!(store, "Den");
    w.note("1.3.0", "permission", true, {
      what: "Bash",
      since: "2026-01-02T03:04:05.000Z",
    });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({
      text: "Den's update to 1.3.0 waits: the Den agent is waiting on your Allow: Bash (since 2026-01-02T03:04:05.000Z)",
      msg: { key: "bell.m.updateWaitsWhat" },
    });
    store.markRead({ all: true });
    w.done();
    expect(
      store.list().filter((n) => n.subject === "record:den-update-wait"),
    ).toEqual([]);
  });
});

describe("a wait doesn't outlive its agent (stopped, removed, exited)", () => {
  const ended = new Map<string, "stopped" | "exited">();
  function mkEnded() {
    const store = new NotificationStore(dir, () => new Date(clock));
    const a = new Attention({
      store,
      outputMark: async () => "m",
      nameOf: () => "Planner",
      now: () => clock,
      hooked: () => true,
      ended: async (agents) =>
        new Map([...ended].filter(([x]) => agents.includes(x))),
    });
    return { store, a };
  }
  beforeEach(() => ended.clear());

  it("stopped (the CLI's stop too, which the server doesn't see): the wait and its bell row go on the next check", async () => {
    const { store, a } = mkEnded();
    await a.event(
      "planner",
      "north",
      ev({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
    );
    expect(store.list().map((n) => n.kind)).toEqual(["waiting"]);
    await a.check();
    expect(a.waitingNow().get("planner")).toBe("permission");
    ended.set("planner", "stopped");
    await a.check();
    expect(a.waitingNow().has("planner")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("stopped or removed ends an ask too; a session that exited by itself keeps it", async () => {
    const { store, a } = mkEnded();
    await a.event("planner", "north", {
      event: "waiting",
      why: "asked",
      text: "Which branch?",
      hooked: true,
    });
    ended.set("planner", "exited");
    await a.check();
    expect(a.waitingNow().get("planner")).toBe("asked");
    ended.set("planner", "stopped");
    await a.check();
    expect(a.waitingNow().has("planner")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("a session that exited by itself ends a permission wait", async () => {
    const { a } = mkEnded();
    await a.event(
      "planner",
      "north",
      ev({ hook_event_name: "PermissionRequest", tool_name: "Bash" }),
    );
    ended.set("planner", "exited");
    await a.check();
    expect(a.waitingNow().has("planner")).toBe(false);
  });

  it("agentEnded: removed, stopped since it started, exited, or running", () => {
    const session = { backend: "den-pty", id: "s1" } as const;
    const at = "2026-01-02T03:00:00.000Z";
    const later = "2026-01-02T03:10:00.000Z";
    const live = new Map([["s1", at]]);
    expect(agentEnded(null, live)).toBe("stopped");
    expect(agentEnded({ session }, live)).toBeNull();
    expect(agentEnded({ session, stoppedAt: later }, live)).toBe("stopped");
    // A stop from before this session started is history.
    expect(
      agentEnded({ session, stoppedAt: "2026-01-02T02:00:00.000Z" }, live),
    ).toBeNull();
    expect(agentEnded({ session }, new Map())).toBe("exited");
    expect(agentEnded({ session, stoppedAt: later }, new Map())).toBe(
      "stopped",
    );
    // The host didn't answer: only a stop counts.
    expect(agentEnded({ session }, null)).toBeNull();
    expect(agentEnded({ session, stoppedAt: later }, null)).toBe("stopped");
  });
});

describe("issue 369: waiting rows kept across a restart", () => {
  function mk369(d: {
    ended?: Record<string, "stopped" | "exited">;
    open?: Record<string, boolean | null>;
  }) {
    const store = new NotificationStore(dir, () => new Date(clock));
    const a = new Attention({
      store,
      outputMark: async () => "m",
      nameOf: (id) => id,
      now: () => clock,
      hooked: () => true,
      ended: async (ids) =>
        new Map(
          ids.flatMap((i) => (d.ended?.[i] ? [[i, d.ended[i]] as const] : [])),
        ),
      dialogOpen: async (id) => (d.open && id in d.open ? d.open[id] : false),
    });
    return { store, a };
  }
  const keep = (store: NotificationStore, id: string, key: string) =>
    store.add({
      kind: "waiting",
      subject: `agent:${id}`,
      scope: "workspace/north",
      text: `${id} ${key === "bell.m.asked" ? "asked: Ship it?" : "needs your permission: Bash"}`,
      msg: { key, vars: { name: id, what: "Bash", text: "Ship it?" } },
    });
  const subjects = (store: NotificationStore) =>
    store
      .list()
      .map((n) => n.subject)
      .sort();

  it("leaves a not-back-after-restart row alone, and decides the rest", async () => {
    const { store, a } = mk369({
      ended: { gone: "stopped", left: "exited" },
      open: { live: true },
    });
    keep(store, "gone", "bell.m.permissionWhat");
    keep(store, "idle", "bell.m.permission");
    keep(store, "live", "bell.m.permissionWhat");
    keep(store, "left", "bell.m.asked");
    keep(store, "back", "bell.m.restartFailed");
    await a.reconcile();
    expect(subjects(store)).toEqual(["agent:back", "agent:left", "agent:live"]);
    expect([...a.waitingNow()].sort()).toEqual([
      ["left", "asked"],
      ["live", "permission"],
    ]);
    expect(a.waitingDetail("live")?.what).toBe("Bash");
    // Adopted: a hook clears it as any other wait.
    clock += 5000;
    await a.event("live", "north", { event: "resumed", from: "tool" });
    expect(subjects(store)).toEqual(["agent:back", "agent:left"]);
  });

  it("a stopped agent's ask goes too", async () => {
    const { store, a } = mk369({ ended: { gone: "stopped" } });
    keep(store, "gone", "bell.m.asked");
    await a.reconcile();
    expect(subjects(store)).toEqual([]);
  });

  it("can't tell yet: the row stays, and the next check decides it", async () => {
    const open: Record<string, boolean | null> = { slow: null };
    const { store, a } = mk369({ open });
    keep(store, "slow", "bell.m.permissionWhat");
    await a.check();
    expect(subjects(store)).toEqual(["agent:slow"]);
    expect(a.waitingNow().has("slow")).toBe(false);
    open.slow = false;
    await a.check();
    expect(subjects(store)).toEqual([]);
  });
});

describe("issue 369: Claude Code's permission dialog on screen", () => {
  const p = denClaude.permissionPrompt;
  const dialog = (q: string) =>
    [
      "\x1b[2J\x1b[H",
      "Bash command\r\n  npm test\r\n\r\n",
      `${q}\r\n`,
      "\x1b[36m❯\x1b[0m 1. Yes\r\n",
      "  2. Yes, and don't ask again for npm test commands in /work/a/very/long/folder/name/for/the/notes/repo\r\n",
      "  3. No, and tell Claude what to do differently (esc)\r\n",
    ].join("");

  it("sees each wording, and not once answered", () => {
    for (const q of [
      "Do you want to proceed?",
      "Do you want to make this edit to notes.ts?",
      "Do you want to create plan.md?",
      "Do you want to allow Claude to fetch this content?",
    ])
      expect(promptOnScreen(dialog(q), p)).toBe(true);
    const answered = `${dialog("Do you want to proceed?")}\x1b[2J\x1b[H⏺ Bash(npm test)\r\n  ⎿ 12 passed\r\n> `;
    expect(promptOnScreen(answered, p)).toBe(false);
    expect(promptOnScreen("\x1b[2J\x1b[H> ", p)).toBe(false);
  });
});
