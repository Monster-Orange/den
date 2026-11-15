/**
 * Issue 167 (mock v6 B3): the bell's one pick item says what it is about
 * under its title ("Den can't tell which Hub project fits them. Click to
 * choose. …") and opens Settings › Agents › Unclear matches.
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

const group = (n: Record<string, unknown>) => ({
  groups: [
    {
      scope: "workspace/den-server",
      subjects: [{ subject: n.subject, items: [n] }],
    },
  ],
  unread: 1,
});

describe("the pick in the bell (B3)", () => {
  it("its body under the title, the whole row opening Unclear matches", async () => {
    const { bellHtml } = await import("../../../src/ui/server/public/bell.js");
    const h = bellHtml(
      group({
        id: "a",
        kind: "decision",
        subject: "record:hub-pick",
        scope: "workspace/den-server",
        text: "2 projects need your pick",
        msg: { key: "bell.m.pick", vars: { n: 2 } },
        link: "/settings#agents.hub_link_all",
        at: new Date().toISOString(),
        read: false,
      }),
    );
    expect(h).toMatch(
      /<a href="\/settings#agents\.hub_link_all" data-bell="open">\[bell\.m\.pick:2\]<span class="den-bell-sub">\[bell\.pickBody:2\]<\/span><\/a>/,
    );
  });

  it("any other item: no body", async () => {
    const { bellHtml } = await import("../../../src/ui/server/public/bell.js");
    const h = bellHtml(
      group({
        id: "b",
        kind: "waiting",
        subject: "agent:x",
        scope: "workspace/north",
        text: "x is waiting",
        msg: { key: "bell.m.input", vars: { name: "x" } },
        link: "/agents?agent=x",
        at: new Date().toISOString(),
        read: false,
      }),
    );
    expect(h).not.toContain("den-bell-sub");
  });
});
