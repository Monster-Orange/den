/**
 * Issue 746 clause 4 (and issue 205): a held write reads in the page's
 * language everywhere the person sees it, not only in the Allow dialog.
 * The dialog words a request from its action and params (shell.js apWhat,
 * "ap.do.<action>"); the bell's Allow row and its lapsed item now do the
 * same, with Den's English summary only as the fallback.
 *
 *  - every held action has its "ap.do.<action>" words in en, es and ja;
 *  - Needs you's entry carries the request's params;
 *  - a lapsed item keeps the action and params, so the bell can word it;
 *  - the bell's Allow row and lapsed item use the shell's wording.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { HELD_WRITE_RISK } from "../../../src/shared/approval-policy.js";
import type { Approval } from "../../../src/ui/server/approvals.js";
import { heldLapsed, heldWaiting } from "../../../src/ui/server/held-bell.js";
import { enCatalog, langCatalog } from "./helpers/en-catalog.js";

const g = globalThis as unknown as { window?: unknown };
const had = g.window;
afterAll(() => {
  g.window = had;
});

const req = (over: Partial<Approval> = {}): Approval =>
  ({
    id: "aaaaaaaaaaaaaaaa",
    actor: "agent:quiet-scribe",
    agent: "quiet-scribe",
    action: "workspace_create",
    args: { name: "proof-a" },
    summary: 'create the project "proof-a"',
    params: { name: "proof-a" },
    state: "pending",
    requestedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 60_000,
    ...over,
  }) as Approval;

describe("issue 746: every held action has its words in en, es and ja", () => {
  const catalogs = {
    en: enCatalog(),
    es: langCatalog("es"),
    ja: langCatalog("ja"),
  };
  for (const action of Object.keys(HELD_WRITE_RISK))
    it(`${action}: ap.do.${action}`, () => {
      for (const [lang, c] of Object.entries(catalogs))
        expect([lang, typeof c[`ap.do.${action}`]]).toEqual([lang, "string"]);
    });
  it("hub_connect that clears the address has its own words", () => {
    for (const c of Object.values(catalogs))
      expect(typeof c["ap.do.hub_connect.clear"]).toBe("string");
  });
});

describe("issue 746: the bell gets what it needs to word a request", () => {
  it("Needs you's entry carries the request's params", () => {
    const [w] = heldWaiting([req()]);
    expect(w.params).toEqual({ name: "proof-a" });
  });

  it("a lapsed item keeps the action and params", async () => {
    const added: { msg?: { vars?: Record<string, unknown> } }[] = [];
    await heldLapsed(req({ state: "expired" }), {
      store: { add: (n) => void added.push(n as (typeof added)[number]) },
    });
    const vars = added[0]?.msg?.vars ?? {};
    expect(vars.action).toBe("workspace_create");
    expect(JSON.parse(String(vars.params))).toEqual({ name: "proof-a" });
    // The English summary stays, for a page without the words.
    expect(vars.what).toBe('create the project "proof-a"');
  });
});

describe("issue 746: the bell words a request as the Allow dialog does", () => {
  beforeAll(() => {
    g.window = {
      denShell: {
        t: (k: string, v?: Record<string, unknown>) =>
          `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`,
      },
      // shell.js's apWhat: the page's words for a request.
      denApWhat: (a: { action: string; params?: Record<string, string> }) =>
        `<${a.action}:${a.params?.name ?? ""}>`,
    };
  });

  it("the Allow row", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const [w] = heldWaiting([req()]);
    const p = bellPanel({ groups: [], waiting: [w], unread: 1 });
    expect(p.sections.needs).toContain(
      "[bell.ap.row:quiet-scribe|&lt;workspace_create:proof-a&gt;]",
    );
  });

  it("the lapsed item", async () => {
    const { noteText } = await import("../../../src/ui/server/public/bell.js");
    const text = noteText({
      text: "English",
      msg: {
        key: "bell.m.heldLapsed",
        vars: {
          name: "quiet-scribe",
          what: 'create the project "proof-a"',
          action: "workspace_create",
          params: JSON.stringify({ name: "proof-a" }),
        },
      },
    });
    expect(text).toContain("<workspace_create:proof-a>");
  });

  it("an item from before (no action): the stored English, as before", async () => {
    const { noteText } = await import("../../../src/ui/server/public/bell.js");
    const text = noteText({
      msg: {
        key: "bell.m.heldLapsed",
        vars: { name: "quiet-scribe", what: "an old request" },
      },
    });
    expect(text).toContain("an old request");
  });
});
