/**
 * NT: `<cli> notifications [list|read|clear]` reads and changes the same
 * store as the bell (<state>/notifications.json). list groups by project,
 * then agent, unread marked; --json is the bell's own groups. read marks
 * all, one id, or a project's read; clear drops the read ones. Inside an
 * agent's session only list runs: the bell is the person's to change. A
 * temp state dir; a fixed clock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdNotifications } from "../../../src/ui/cli/notifications-command";
import { NotificationStore } from "../../../src/shared/notifications";

let dir = "";
const NOW = Date.parse("2026-11-13T09:00:00Z");
let out: string[] = [];
let err: string[] = [];

const run = (args: string[], env: Record<string, string> = {}) =>
  cmdNotifications(args, {
    stateDir: dir,
    env,
    now: () => NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });

function seed() {
  const s = new NotificationStore(dir, () => new Date(NOW - 120_000));
  s.add({
    source: "den",
    kind: "waiting",
    subject: "agent:planner",
    scope: "workspace/north",
    text: "planner needs your permission",
    link: "/agents?ws=north&agent=planner",
  });
  const t = new NotificationStore(dir, () => new Date(NOW - 7_200_000));
  t.add({
    source: "den",
    kind: "finished",
    subject: "agent:builder",
    scope: "workspace/south",
    text: "builder finished its turn",
    link: "/agents?ws=south&agent=builder",
  });
  return s;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-ntcli-"));
  out = [];
  err = [];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("notifications list", () => {
  it("nothing: says so", async () => {
    expect(await run([])).toBe(0);
    expect(out).toEqual(["No notifications."]);
  });

  it("by project, then agent; unread marked; how long ago", async () => {
    seed();
    expect(await run(["list"])).toBe(0);
    expect(out).toEqual([
      "2 unread",
      "",
      "north",
      "  ● planner needs your permission · 2 min",
      "south",
      "  ● builder finished its turn · 2 h",
    ]);
  });

  it("Hub's items: under Hub's name for each project, else its slug; two projects, two headings", async () => {
    new NotificationStore(dir, () => new Date(NOW)).syncHub(
      [
        {
          id: "h1",
          kind: "mention",
          subject: "thread:th_1",
          scope: "hub/e2e/main",
          scopeName: "E2E fixtures",
          text: "Kim mentioned you",
          at: new Date(NOW).toISOString(),
          readBy: [],
        },
        {
          id: "h2",
          kind: "mention",
          subject: "thread:th_2",
          scope: "hub/shop/main",
          text: "Kim replied",
          at: new Date(NOW).toISOString(),
          readBy: [],
        },
      ],
      "pat",
    );
    expect(await run(["list"])).toBe(0);
    expect(out.filter((l) => l.startsWith("Hub"))).toEqual([
      "Hub · E2E fixtures",
      "Hub · shop",
    ]);
  });

  it("--json: the bell's own answer", async () => {
    seed();
    expect(await run(["list", "--json"])).toBe(0);
    const j = JSON.parse(out.join("\n")) as {
      unread: number;
      groups: { scope: string }[];
    };
    expect(j.unread).toBe(2);
    expect(j.groups.map((g) => g.scope)).toEqual([
      "workspace/north",
      "workspace/south",
    ]);
  });
});

describe("notifications read / clear", () => {
  it("read with no target: all; then clear drops them", async () => {
    seed();
    expect(await run(["read"])).toBe(0);
    expect(out).toEqual(["Marked 2 read."]);
    out = [];
    await run(["list"]);
    expect(out[0]).toBe("0 unread");
    expect(out).toContain("  ○ planner needs your permission · 2 min");
    out = [];
    expect(await run(["clear"])).toBe(0);
    expect(out).toEqual(["Cleared 2."]);
    expect(new NotificationStore(dir).list()).toEqual([]);
  });

  it("read -p <project>: that project's only", async () => {
    seed();
    expect(await run(["read", "-p", "north"])).toBe(0);
    expect(out).toEqual(["Marked 1 read."]);
    expect(new NotificationStore(dir).unread()).toBe(1);
  });

  it("read <id>: that one", async () => {
    const s = seed();
    const id = s.list().find((n) => n.subject === "agent:builder")!.id;
    expect(await run(["read", id])).toBe(0);
    expect(
      new NotificationStore(dir).list().find((n) => n.id === id)?.read,
    ).toBe(true);
  });

  it("in an agent's session: list runs, read and clear are refused", async () => {
    seed();
    const env = { DEN_ACTOR_TOKEN: "x" };
    expect(await run(["list"], env)).toBe(0);
    expect(await run(["read"], env)).toBe(1);
    expect(err.join("\n")).toMatch(/person's to change/);
    expect(await run(["clear"], env)).toBe(1);
    expect(new NotificationStore(dir).unread()).toBe(2);
  });

  it("a bad subcommand: usage, 2", async () => {
    expect(await run(["nope"])).toBe(2);
    expect(err.join("\n")).toMatch(
      /usage: .*notifications \[list\|read\|clear\]/,
    );
  });
});
