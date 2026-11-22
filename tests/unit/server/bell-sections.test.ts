/**
 * Issue 101: Den's bell gives the kit the rows of its two sections:
 * Needs you (an agent waiting, a pick, a mention), first, with no Mark
 * read; Earlier (Updates and Older, as before).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

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

const at = new Date().toISOString();
const item = (id: string, kind: string, read = false) => ({
  id,
  kind,
  subject: `agent:${id}`,
  scope: "workspace/north",
  text: `${id} text`,
  link: `/agents?project=north&agent=${id}`,
  at,
  read,
});
const groups = (...items: ReturnType<typeof item>[]) => [
  {
    scope: "workspace/north",
    subjects: items.map((n) => ({ subject: n.subject, items: [n] })),
  },
];

describe("issue 101: Needs you first, then Earlier", () => {
  it("a waiting agent is in Needs you, before Earlier's Updates; no Mark read there", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel({
      groups: groups(item("asker", "waiting")),
      unread: 1,
      updates: {
        count: 1,
        unread: 1,
        groups: groups(item("shipper", "service")),
      },
    });
    expect(p.sections).toBeDefined();
    expect(p.sections.needs).toContain('data-kind="waiting"');
    expect(p.sections.needs).not.toContain('data-bell="scope"');
    expect(p.sections.earlier).toContain('data-bell="updates"');
    expect(p.sections.needs).not.toContain('data-bell="updates"');
    // The panel's own heading actions stay (Mark all read).
    expect(p.actions).toContain('data-bell="all"');
    const { bellHtml } = await import("../../../src/ui/server/public/bell.js");
    const h = bellHtml({
      groups: groups(item("asker", "waiting")),
      unread: 1,
      updates: {
        count: 1,
        unread: 0,
        groups: groups(item("shipper", "service")),
      },
    });
    expect(h.indexOf('data-sec="needs"')).toBeGreaterThan(-1);
    expect(h.indexOf('data-kind="waiting"')).toBeLessThan(
      h.indexOf('data-sec="earlier"'),
    );
  });

  it("nothing needs you, only updates: Needs you still heads the panel", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel({
      groups: [],
      unread: 0,
      updates: { count: 1, unread: 0, groups: groups(item("s", "service")) },
    });
    expect(p.sections).toEqual({
      needs: "",
      earlier: expect.stringContaining('data-bell="updates"'),
    });
  });

  it("Older is in Earlier, and its open items keep their Mark read", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel(
      {
        groups: [],
        unread: 0,
        foldDays: 7,
        older: { count: 1, groups: groups(item("o", "waiting")) },
      },
      { older: true },
    );
    expect(p.sections.earlier).toContain('data-bell="older"');
    expect(p.sections.earlier).toContain('data-bell="scope"');
  });

  it("issue 773: Done, not seen has its own section under Needs you; a row opens the agent", async () => {
    const { bellPanel, bellCountOf } =
      await import("../../../src/ui/server/public/bell.js");
    const b = {
      groups: groups(item("asker", "waiting")),
      unread: 1,
      done: [
        {
          agent: "builder",
          name: "builder",
          workspace: "acme",
          at,
          link: "/agents?project=acme&agent=builder",
        },
      ],
    };
    const p = bellPanel(b);
    if (!("sections" in p)) throw new Error("no sections");
    expect(p.sections.needs).toContain('data-kind="waiting"');
    expect(p.sections.done).toContain('data-kind="done"');
    expect(p.sections.done).toContain("[bell.doneRow:builder]");
    expect(p.sections.done).toContain(
      'href="/agents?project=acme&amp;agent=builder"',
    );
    expect(p.sections.done).toContain('data-agent="builder"');
    expect(p.sections.done).toContain(">acme<");
    // Mock v3: the project's display name, and "Server" for the server
    // agent (as everywhere else).
    const named = bellPanel({
      groups: [],
      unread: 0,
      done: [
        { ...b.done[0], project: "Acme Shop" },
        {
          agent: "helper",
          name: "helper",
          workspace: "den-server",
          server: true,
          project: "den-server",
          at,
          link: "/agents?agent=helper",
        },
      ],
    });
    if (!("sections" in named)) throw new Error("no sections");
    expect(named.sections.done).toContain(">Acme Shop<");
    expect(named.sections.done).toContain(">[ag.tag.server]<");
    expect(named.sections.done).not.toContain("[bell.server]");
    // Counts: the bell shows Needs you plus Done, not seen.
    expect(bellCountOf(b)).toBe(2);
    // Nothing else: Done alone still shows (no empty state).
    const only = bellPanel({ groups: [], unread: 0, done: b.done });
    if (!("sections" in only)) throw new Error("no sections");
    expect(only.sections.done).toContain('data-kind="done"');
    expect(only.sections.needs).toBe("");
    expect(bellCountOf({ unread: 0, done: b.done })).toBe(1);
  });

  it("nothing at all: the empty state, no sections", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel({ groups: [], unread: 0 });
    expect(p.sections).toBeUndefined();
    expect(p.empty.text).toBe("[bell.empty]");
  });
});
