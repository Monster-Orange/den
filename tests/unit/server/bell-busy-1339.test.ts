/**
 * Issue 1339: the bell's panel while "Mark all read" or "Clear read" runs.
 *
 *   1. The button that was pressed stays, busy in itself (disabled,
 *      aria-busy, "Marking…" / "Clearing…"); the other one is disabled.
 *   2. bellAfter shows the bell as it will be: every row read (Mark all
 *      read), or the read rows gone (Clear read), the counts to match.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

const g = globalThis as unknown as { window?: unknown };
const had = g.window;
beforeAll(() => {
  g.window = { denShell: { t: (k: string) => `[${k}]` } };
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
  at,
  read,
});
const groups = (...items: ReturnType<typeof item>[]) => [
  {
    scope: "workspace/north",
    subjects: items.map((n) => ({ subject: n.subject, items: [n] })),
  },
];
const bell = () => ({
  unread: 2,
  groups: groups(
    item("a", "waiting"),
    item("b", "waiting"),
    item("c", "waiting", true),
  ),
  updates: {
    count: 2,
    unread: 1,
    groups: groups(item("d", "service"), item("e", "service", true)),
  },
  older: { count: 1, groups: groups(item("f", "waiting", true)) },
});
const ids = (gs: ReturnType<typeof groups>, read?: boolean) =>
  gs
    .flatMap((x) => x.subjects.flatMap((s) => s.items))
    .filter((n) => read === undefined || n.read === read)
    .map((n) => n.id);

describe("the busy button (issue 1339)", () => {
  it("Mark all read, running: busy in itself; Clear read waits", async () => {
    const { bellPanel, bellAfter } =
      await import("../../../src/ui/server/public/bell.js");
    const a = bellPanel(bellAfter(bell(), "all"), { busy: "all" }).actions;
    expect(a).toContain(
      '<button type="button" data-bell="all" disabled aria-busy="true">[bell.marking]</button>',
    );
    expect(a).toMatch(
      /data-bell="clear" disabled aria-busy="true">\[bell\.clearRead\]/,
    );
  });

  it("Clear read, running: busy in itself", async () => {
    const { bellPanel, bellAfter } =
      await import("../../../src/ui/server/public/bell.js");
    const a = bellPanel(bellAfter(bell(), "clear"), { busy: "clear" }).actions;
    expect(a).toContain(
      '<button type="button" data-bell="clear" disabled aria-busy="true">[bell.clearing]</button>',
    );
  });

  it("not running: the buttons as before", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const a = bellPanel(bell(), {}).actions;
    expect(a).toBe(
      '<button type="button" data-bell="all">[bell.markAll]</button>' +
        '<button type="button" data-bell="clear">[bell.clearRead]</button>',
    );
  });
});

describe("bellAfter (issue 1339)", () => {
  it("all: every row read, nothing unread, the rows all stay", async () => {
    const { bellAfter } = await import("../../../src/ui/server/public/bell.js");
    const b = bellAfter(bell(), "all");
    expect(b.unread).toBe(0);
    expect(b.updates.unread).toBe(0);
    expect(ids(b.groups, false)).toEqual([]);
    expect(ids(b.groups)).toEqual(["a", "b", "c"]);
    expect(ids(b.updates.groups)).toEqual(["d", "e"]);
    expect(b.updates.count).toBe(2);
  });

  it("clear: the read rows gone, the counts to match; the input unchanged", async () => {
    const { bellAfter } = await import("../../../src/ui/server/public/bell.js");
    const before = bell();
    const b = bellAfter(before, "clear");
    expect(ids(b.groups)).toEqual(["a", "b"]);
    expect(ids(b.updates.groups)).toEqual(["d"]);
    expect(b.updates.count).toBe(1);
    expect(b.older.groups).toEqual([]);
    expect(b.older.count).toBe(0);
    expect(b.unread).toBe(2);
    // What a failed POST goes back to.
    expect(ids(before.groups)).toEqual(["a", "b", "c"]);
    expect(ids(before.groups, false)).toEqual(["a", "b"]);
  });
});

/** Two projects: north and south, each with unread Updates. */
const inScope = (scope: string, n: ReturnType<typeof item>) => ({
  ...n,
  scope,
});
const twoScopes = () => ({
  unread: 2,
  groups: [
    {
      scope: "workspace/south",
      subjects: [
        {
          subject: "agent:a",
          items: [inScope("workspace/south", item("a", "waiting"))],
        },
      ],
    },
    ...groups(item("b", "waiting")),
  ],
  updates: {
    count: 3,
    unread: 3,
    groups: [
      {
        scope: "workspace/south",
        subjects: [
          {
            subject: "agent:d",
            items: [inScope("workspace/south", item("d", "service"))],
          },
          {
            subject: "agent:g",
            items: [inScope("workspace/south", item("g", "service"))],
          },
        ],
      },
      ...groups(item("e", "service")),
    ],
  },
  older: {
    count: 1,
    groups: [
      {
        scope: "workspace/south",
        subjects: [
          {
            subject: "agent:f",
            items: [inScope("workspace/south", item("f", "waiting"))],
          },
        ],
      },
    ],
  },
});

describe("a project's Mark read (issue 1339)", () => {
  it("running: its button busy in itself; the others and the heading's wait", async () => {
    const { bellPanel, bellAfter } =
      await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel(bellAfter(twoScopes(), "scope", "workspace/south"), {
      busy: "scope:workspace/south",
      updates: true,
    });
    const html = JSON.stringify(p);
    expect(html).toContain(
      'data-bell=\\"scope\\" data-scope=\\"workspace/south\\" disabled aria-busy=\\"true\\">[bell.marking]',
    );
    expect(html).toContain(
      'data-bell=\\"scope\\" data-scope=\\"workspace/north\\" disabled aria-busy=\\"true\\">[bell.read]',
    );
    expect(p.actions).toMatch(
      /data-bell="all" disabled aria-busy="true">\[bell\.markAll\]/,
    );
  });

  it("bellAfter: that project's rows read everywhere, the others as they were, the counts to match", async () => {
    const { bellAfter } = await import("../../../src/ui/server/public/bell.js");
    const before = twoScopes();
    const b = bellAfter(before, "scope", "workspace/south");
    expect(ids(b.groups, false)).toEqual(["b"]);
    expect(ids(b.updates.groups, false)).toEqual(["e"]);
    expect(ids(b.updates.groups)).toEqual(["d", "g", "e"]);
    expect(ids(b.older.groups, false)).toEqual([]);
    expect(b.unread).toBe(1);
    expect(b.updates.unread).toBe(1);
    expect(b.updates.count).toBe(3);
    // What a failed POST goes back to.
    expect(ids(before.updates.groups, false)).toEqual(["d", "g", "e"]);
  });
});
