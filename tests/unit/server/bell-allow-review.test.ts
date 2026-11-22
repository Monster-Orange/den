/**
 * Issue 746 follow-up (PR 747's review): the bell's Allow row has a Review
 * toggle that opens the held write's details lines under it, the lines the
 * approval dialog shows. Both render them with one function, shell.js's
 * denApDetailLines, so they can't differ. A tap opens and closes it; Allow
 * and Deny stay where they are.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import type { Approval } from "../../../src/ui/server/approvals.js";
import { heldWaiting } from "../../../src/ui/server/held-bell.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { gateBoxOps } from "../../../src/ui/server/gate-routes.js";
import { UI_LANGUAGES } from "../../../src/ui/server/ui-language.js";

type Table = Record<string, string>;
type Lines = (a: unknown) => string[];
const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

/** shell.js run for one page language: its catalogs and its lines function. */
function shellFor(lang: string): {
  messages: Record<string, Table>;
  lines: Lines;
} {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  const files = [
    ...UI_LANGUAGES.filter((l) => l !== "en").map((l) => `i18n/${l}.js`),
    "shell.js",
  ];
  for (const f of files)
    try {
      vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), "utf-8"), ctx, {
        filename: f,
      });
    } catch {
      // shell.js stops at its first DOM use; what this needs is set before.
    }
  return {
    messages: window.denMessages as Record<string, Table>,
    lines: window.denApDetailLines as Lines,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-bar-"));
const g = globalThis as unknown as { window?: unknown };
const had = g.window;
afterAll(() => {
  g.window = had;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ID = "bbbbbbbbbbbbbbbb";
let held: Record<string, unknown>;
beforeAll(async () => {
  // A real held write's card: gate_box_set's, whose lines all have keys.
  const ops = gateBoxOps({
    store: () => new GateStore({ dir: tmp }),
    audit: () => {},
  });
  const c = await ops.set.check({
    box: { name: "box1", ssh: "runner@box1.example", browser_slots: 2 },
  });
  if (!c.ok) throw new Error(c.error);
  const card = c as unknown as {
    summary: string;
    details: string[];
    detailKeys: unknown[];
  };
  const [w] = heldWaiting([
    {
      id: ID,
      action: "gate_box_set",
      summary: card.summary,
      details: card.details,
      detailKeys: card.detailKeys,
      agent: "north-planner",
      state: "pending",
      requestedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 9 * 60_000,
    } as unknown as Approval,
  ]);
  held = w as unknown as Record<string, unknown>;
});

/** The bell's panel in `lang`, the Review rows in `open` opened. */
async function needs(lang: string, open: string[] = []): Promise<string> {
  const s = shellFor(lang);
  const t = (k: string) => s.messages[lang]?.[k] ?? s.messages.en[k] ?? k;
  g.window = { denShell: { t }, denApDetailLines: s.lines };
  const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
  return bellPanel(
    { groups: [], waiting: [held], unread: 1 },
    { reviews: new Set(open) },
  ).sections.needs as string;
}

/** The details lines the row shows, as text. */
const shown = (html: string): string[] =>
  [...html.matchAll(/<div class="den-bell-detl">([^<]*)<\/div>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&"),
  );

describe("the bell's Allow row: Review", () => {
  it("Needs you's entry carries the held write's details lines and their keys", () => {
    expect((held.details as string[]).length).toBeGreaterThan(1);
    expect(held.detailKeys).toHaveLength((held.details as string[]).length);
  });

  it("closed: a Review toggle, the lines hidden; Allow and Deny where they were", async () => {
    const html = await needs("en");
    expect(html).toMatch(
      new RegExp(`data-bell="review" data-ap="${ID}" aria-expanded="false"`),
    );
    expect(html).toMatch(/<div class="den-bell-det" id="[^"]+" hidden>/);
    // Review sits in the row's text, so Allow and Deny keep their place:
    // still the row's last two elements, right after the text, in order.
    expect([...html.matchAll(/data-bell="(\w+)"/g)].map((m) => m[1])).toEqual([
      "review",
      "allow",
      "deny",
    ]);
    expect(html).toMatch(
      /<\/div><\/span><button[^>]*data-bell="allow"[^>]*>[^<]*<\/button><button[^>]*data-bell="deny"[^>]*>[^<]*<\/button><\/div><\/section>$/,
    );
  });

  it("open: the dialog's own lines, in en, es and ja", async () => {
    for (const lang of UI_LANGUAGES) {
      const html = await needs(lang, [ID]);
      expect(html).toContain(`data-ap="${ID}" aria-expanded="true"`);
      expect(html).not.toMatch(/<div class="den-bell-det" id="[^"]+" hidden>/);
      const dialog = shellFor(lang).lines(held);
      expect(dialog.length).toBe((held.details as string[]).length);
      expect(shown(html)).toEqual(dialog);
      // Each keyed line is in the page's language, not the English sent.
      const { messages } = shellFor(lang);
      (held.detailKeys as { key: string }[]).forEach((k) =>
        expect(messages[lang][k.key]).toBeDefined(),
      );
      if (lang !== "en") expect(dialog).not.toEqual(held.details as string[]);
    }
  });
});
