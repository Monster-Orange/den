/**
 * When two or more agents ask to be restarted
 * (agent_restart_self), the bell groups those asks into one card,
 * "Restart N agents when idle", listing them, with one Allow. Each row can
 * be taken out before Allow. One ask alone stays its own Allow row.
 *
 * Invented names only.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NotificationStore } from "../../../src/shared/notifications.js";
import type { Approval } from "../../../src/ui/server/approvals.js";
import {
  RESTART_GROUP_SUBJECT,
  syncHeldBell,
} from "../../../src/ui/server/held-bell.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-1406-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const g = globalThis as unknown as { window?: unknown };
const had = g.window;
beforeAll(() => {
  g.window = {
    denShell: {
      t: (k: string, v?: Record<string, unknown>) =>
        `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`,
    },
  };
});
afterAll(() => {
  g.window = had;
});

const ask = (id: string, agent: string, n = 1): Approval => ({
  id,
  actor: `agent:${agent}`,
  agent,
  action: "agent_restart_self",
  args: { agent, project: "north", reason: "tools" },
  summary: `restart ${agent} when idle`,
  requestedAt: n,
  expiresAt: n + 1000,
  state: "pending",
});
const other: Approval = {
  id: "zzzzzzzzzzzzzzzz",
  actor: "agent:north-planner",
  agent: "north-planner",
  action: "workspace_create",
  args: { name: "orchard" },
  summary: 'create the workspace "orchard"',
  requestedAt: 9,
  expiresAt: 99,
  state: "pending",
};
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const C = "cccccccccccccccc";
const three = [ask(A, "ana", 1), ask(B, "bo", 2), ask(C, "cy", 3)];
/** The panel's Needs you section ("" when the panel is empty). */
const needsOf = (p: object): string =>
  "sections" in p
    ? String((p as { sections: { needs: string } }).sections.needs)
    : "";
const held = (s: NotificationStore) =>
  s.list().filter((n) => n.subject.startsWith("record:held-"));

describe("issue 1406: the bell groups restart asks", () => {
  it("three agents asking give one grouped card; other asks keep their own", () => {
    const s = new NotificationStore(tmp());
    syncHeldBell(s, [...three, other], { projectOf: () => "north" });
    const items = held(s);
    expect(items.map((n) => n.subject).sort()).toEqual(
      [RESTART_GROUP_SUBJECT, `record:held-${other.id}`].sort(),
    );
    const card = items.find((n) => n.subject === RESTART_GROUP_SUBJECT)!;
    expect(card).toMatchObject({
      kind: "decision",
      text: "Restart 3 agents when idle: ana, bo, cy",
      msg: { key: "bell.m.restartGroup", vars: { n: 3, names: "ana, bo, cy" } },
      link: "/agents",
    });
  });

  it("the card follows the asks: down to one, it is that ask's own row", () => {
    const s = new NotificationStore(tmp());
    syncHeldBell(s, three, {});
    syncHeldBell(s, three.slice(0, 2), {});
    expect(held(s).find((n) => n.subject === RESTART_GROUP_SUBJECT)?.text).toBe(
      "Restart 2 agents when idle: ana, bo",
    );
    syncHeldBell(s, three.slice(0, 1), {});
    expect(held(s).map((n) => n.subject)).toEqual([`record:held-${A}`]);
  });

  const waiting = (a: Approval) => ({
    kind: "allow",
    id: a.id,
    action: a.action,
    what: a.summary,
    agent: a.agent,
    since: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  it("Needs you shows one card with a row per agent and one Allow", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel({ groups: [], waiting: three.map(waiting), unread: 1 });
    const needs: string = needsOf(p);
    expect(needs.match(/data-kind="restart-group"/g)).toHaveLength(1);
    expect(needs).toContain("[bell.rg.title:3]");
    for (const id of [A, B, C])
      expect(needs).toContain(`data-bell="restart-out" data-ap="${id}"`);
    expect(needs.match(/data-bell="allow-group"/g)).toHaveLength(1);
    expect(needs).toContain(`data-ids="${A},${B},${C}"`);
    // Not three separate Allow rows.
    expect(needs).not.toContain(`data-bell="allow" data-ap="${A}"`);
  });

  it("a row taken out before Allow is left out of it", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel(
      { groups: [], waiting: three.map(waiting), unread: 1 },
      { restartOut: new Set([B]) },
    );
    const needs: string = needsOf(p);
    expect(needs).toContain(`data-ids="${A},${C}"`);
    expect(needs).toContain("[bell.rg.allow:2]");
    expect(needs).toContain(`data-bell="restart-in" data-ap="${B}"`);
  });

  it("one ask alone stays its own Allow row", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel({
      groups: [],
      waiting: [waiting(three[0])],
      unread: 1,
    });
    expect(needsOf(p)).toContain(`data-bell="allow" data-ap="${A}"`);
    expect(needsOf(p)).not.toContain("restart-group");
  });

  it("the card's own bell item is not shown a second time", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const item = {
      id: "g1",
      kind: "decision",
      subject: RESTART_GROUP_SUBJECT,
      scope: "workspace/den-server",
      text: "Restart 3 agents when idle: ana, bo, cy",
      link: "/agents",
      at: new Date().toISOString(),
      read: false,
    };
    const p = bellPanel({
      groups: [
        {
          scope: "workspace/den-server",
          subjects: [{ subject: item.subject, items: [item] }],
        },
      ],
      waiting: three.map(waiting),
      unread: 1,
    });
    expect(needsOf(p)).not.toContain('data-id="g1"');
  });

  it("every key the card and the ask use is in en, es and ja", () => {
    const root = path.join(__dirname, "../../../src/ui/server/public");
    const keys = [
      "bell.m.restartGroup",
      "bell.rg.title",
      "bell.rg.sub",
      "bell.rg.allow",
      "bell.rg.allowing",
      "bell.rg.takeOut",
      "bell.rg.putBack",
      "bell.rg.out",
      "bell.rg.done",
      "bell.rg.partly",
      "ap.det.agent_restart_self.when",
      "ap.det.agent_restart_self.tools",
      "ap.det.agent_restart_self.update",
      "ap.det.agent_restart_self.why",
    ];
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"]) {
      const src = fs.readFileSync(path.join(root, f), "utf-8");
      for (const k of keys)
        expect({ f, k, has: src.includes(`"${k}"`) }).toEqual({
          f,
          k,
          has: true,
        });
    }
  });
});
