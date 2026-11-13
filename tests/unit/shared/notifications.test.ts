/**
 * NT-3 / NT-6: the notification store and the bell's grouping. A temp
 * state dir; a clock the test moves.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AskLimit,
  groupNotifications,
  MAX_NOTIFICATIONS,
  NotificationStore,
  readNotificationConfig,
} from "../../../src/shared/notifications";

let dir = "";
let clock = Date.parse("2026-11-13T09:00:00Z");
const tick = (ms = 1000) => (clock += ms);
const mk = () => new NotificationStore(dir, () => new Date(clock));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-nt-"));
  clock = Date.parse("2026-11-13T09:00:00Z");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const waiting = (agent: string, ws = "web", text = "waiting for input") => ({
  kind: "waiting" as const,
  subject: `agent:${agent}`,
  scope: `workspace/${ws}`,
  text,
});

describe("the store", () => {
  it("adds, lists newest first, counts unread; the file is 0600", () => {
    const s = mk();
    s.add(waiting("a"));
    tick();
    s.add({ ...waiting("b"), kind: "finished", text: "finished its turn" });
    expect(s.list().map((n) => n.subject)).toEqual(["agent:b", "agent:a"]);
    expect(s.unread()).toBe(2);
    const st = fs.statSync(path.join(dir, "notifications.json"));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("a second waiting from the same agent updates the unread one", () => {
    const s = mk();
    const a = s.add(waiting("a", "web", "first"))!;
    tick();
    const b = s.add(waiting("a", "web", "asked: which branch?"))!;
    expect(b.id).toBe(a.id);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0].text).toBe("asked: which branch?");
    // Once read, a new one is a new item.
    s.markRead({ id: a.id });
    s.add(waiting("a"));
    expect(s.list()).toHaveLength(2);
  });

  it("text is one plain line, at most 300 characters, never terminal escapes", () => {
    const s = mk();
    const n = s.add(
      waiting("a", "web", `\u001b[31mred\u001b[0m\nnext ${"x".repeat(400)}`),
    )!;
    // No control characters left. Intentional.
    // eslint-disable-next-line no-control-regex
    expect(n.text).not.toMatch(/[\u0000-\u001f]/);
    expect(n.text.startsWith("[31mred [0m next")).toBe(true);
    expect(n.text.length).toBe(300);
  });

  it("withdraw: the agent is busy again, its unread waiting goes", () => {
    const s = mk();
    s.add(waiting("a"));
    s.add({ ...waiting("a"), kind: "finished", text: "done" });
    expect(s.withdraw("agent:a")).toBe(true);
    expect(s.list().map((n) => n.kind)).toEqual(["finished"]);
    expect(s.withdraw("agent:a")).toBe(false);
  });

  it("mark read per item, agent, project, or all; clear read", () => {
    const s = mk();
    const one = s.add(waiting("a", "web"))!;
    s.add(waiting("b", "web"));
    s.add(waiting("c", "api"));
    s.add({ ...waiting("c", "api"), kind: "finished", text: "done" });
    expect(s.markRead({ id: one.id })).toBe(1);
    expect(s.markRead({ subject: "agent:c" })).toBe(2);
    expect(s.markRead({ scope: "workspace/web" })).toBe(1);
    expect(s.unread()).toBe(0);
    s.add(waiting("d", "api"));
    expect(s.markRead({ all: true })).toBe(1);
    expect(s.clearRead({ scope: "workspace/api" })).toBe(3);
    expect(s.clearRead()).toBe(2);
    expect(s.list()).toEqual([]);
  });

  it("keeps the newest 500", () => {
    const s = mk();
    for (let i = 0; i < MAX_NOTIFICATIONS + 5; i++) {
      tick();
      s.add(waiting(`a${i}`));
    }
    const l = s.list();
    expect(l).toHaveLength(MAX_NOTIFICATIONS);
    expect(l.at(-1)!.subject).toBe("agent:a5");
  });

  it("mute an agent or a project for a time; nothing is kept meanwhile", () => {
    const s = mk();
    s.mute("agent:a", 30);
    s.mute("workspace/api", 10);
    expect(s.add(waiting("a"))).toBeNull();
    expect(s.add(waiting("z", "api"))).toBeNull();
    expect(s.add(waiting("b"))).not.toBeNull();
    tick(11 * 60_000);
    expect(s.add(waiting("z", "api"))).not.toBeNull();
    expect(s.mutes().map((m) => m.target)).toEqual(["agent:a"]);
    s.unmute("agent:a");
    expect(s.add(waiting("a"))).not.toBeNull();
  });

  it("a broken file starts empty", () => {
    fs.writeFileSync(path.join(dir, "notifications.json"), "{nope");
    expect(mk().list()).toEqual([]);
    expect(mk().add(waiting("a"))).not.toBeNull();
  });
});

describe("the bell's groups", () => {
  it("by project, then agent; a waiting agent first", () => {
    const s = mk();
    s.add({ ...waiting("a", "web"), kind: "finished", text: "done" });
    tick();
    s.add(waiting("b", "web"));
    tick();
    s.add({ ...waiting("c", "web"), kind: "finished", text: "done" });
    tick();
    s.add(waiting("d", "api"));
    const g = groupNotifications(s.list());
    expect(g.map((x) => x.scope)).toEqual(["workspace/api", "workspace/web"]);
    expect(g[1].subjects.map((x) => x.subject)).toEqual([
      "agent:b",
      "agent:c",
      "agent:a",
    ]);
  });
});

describe("ask_human's limit", () => {
  it("notifications.asks_per_hour: 30 by default; user.yml over the org's; a bad value names its key", () => {
    expect(readNotificationConfig({}, {})).toMatchObject({ asksPerHour: 30 });
    expect(
      readNotificationConfig(
        { notifications: { asks_per_hour: 10 } },
        { notifications: { asks_per_hour: 4 } },
      ),
    ).toMatchObject({ asksPerHour: 4 });
    expect(() =>
      readNotificationConfig({}, { notifications: { asks_per_hour: 0 } }),
    ).toThrow("notifications.asks_per_hour");
    expect(() =>
      readNotificationConfig({}, { notifications: { asks_per_hour: "x" } }),
    ).toThrow("notifications.asks_per_hour");
  });

  it("per agent, in the last hour: the next one is held back until the oldest is an hour old", () => {
    const l = new AskLimit(() => clock);
    expect(l.take("a", 2)).toBe(true);
    tick(60_000);
    expect(l.take("a", 2)).toBe(true);
    expect(l.take("a", 2)).toBe(false);
    // Another agent has its own.
    expect(l.take("b", 2)).toBe(true);
    tick(3_600_000 - 60_000);
    expect(l.take("a", 2)).toBe(true);
    expect(l.take("a", 2)).toBe(false);
  });
});
