/**
 * Issue 746: the bell's Needs you starts with each held write waiting for
 * the person's Allow (`waiting` entries of kind "allow"): what it is, who
 * asked, how long it has waited, when it expires, and Allow and Deny in
 * the row. Its plain "waits for your Allow" item is not shown twice.
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

const at = new Date(Date.now() - 3 * 60_000).toISOString();
const expires = new Date(Date.now() + 7 * 60_000).toISOString();
const ID = "aaaaaaaaaaaaaaaa";
const allow = {
  kind: "allow",
  id: ID,
  agent: "north-planner",
  action: "agent_create",
  what: 'start the agent "helper"',
  since: at,
  expiresAt: expires,
};
const question = {
  id: "q1",
  kind: "waiting",
  subject: "agent:quiet-scribe",
  scope: "workspace/north",
  text: "quiet-scribe asked you",
  link: "/agents?agent=quiet-scribe",
  at,
  read: false,
};
const heldItem = {
  id: "h1",
  kind: "decision",
  subject: `record:held-${ID}`,
  scope: "workspace/north",
  text: 'north-planner waits for your Allow: start the agent "helper"',
  link: "/agents?agent=north-planner",
  at,
  read: false,
};
const groups = [
  {
    scope: "workspace/north",
    subjects: [
      { subject: question.subject, items: [question] },
      { subject: heldItem.subject, items: [heldItem] },
    ],
  },
];

describe("issue 746: held writes lead Needs you", () => {
  it("the Allow row is first in Needs you, with Allow and Deny, who asked, age and expiry", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel({ groups, waiting: [allow], unread: 2 });
    const needs: string = p.sections.needs;
    const row = needs.indexOf('data-kind="allow"');
    expect(row).toBeGreaterThan(-1);
    expect(row).toBeLessThan(needs.indexOf('data-kind="waiting"'));
    expect(needs).toContain(`data-bell="allow" data-ap="${ID}"`);
    expect(needs).toContain(`data-bell="deny" data-ap="${ID}"`);
    expect(needs).toContain("[bell.ap.row:north-planner|");
    expect(needs).toContain("[bell.ap.waits:");
    // Its plain held item isn't shown a second time.
    expect(needs).not.toContain(`data-id="h1"`);
  });

  it("only an Allow waiting: Needs you shows it (no empty state)", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel({ groups: [], waiting: [allow], unread: 1 });
    expect(p.sections?.needs).toContain('data-kind="allow"');
  });
});
