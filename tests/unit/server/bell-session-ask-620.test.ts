/**
 * Issue 620: a question from a session that isn't a Den agent shows in the
 * bell's Needs you: the question, the session's own label, marked as not a
 * Den agent, what Den found (its command, folder and pid), and one button
 * per choice. A button posts the choice to the person-only answer route.
 * The caller's text is escaped. Each open ask counts in the badge. Its
 * words are in en, es and ja.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const ask = {
  kind: "session_ask",
  id: "sa_0123456789abcdef01234567",
  question: "Ship <b>0.4.87</b>?",
  choices: ["yes", "no"],
  session: "builder",
  caller: { pid: 4242, command: "node", cwd: "/w/app" },
  since: "2026-11-22T16:00:00.000Z",
  expiresAt: "2026-11-23T16:00:00.000Z",
};

describe("issue 620: the bell's row for a session's question", () => {
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

  it("is in Needs you: question, label, not an agent, what Den found, a button per choice", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const p = bellPanel({ groups: [], waiting: [ask], unread: 0 });
    if (!("sections" in p)) throw new Error("the bell has no sections");
    const needs = p.sections.needs as string;
    expect(needs).toContain('data-kind="session_ask"');
    expect(needs).toContain(
      "[bell.sa.row:builder|Ship &lt;b&gt;0.4.87&lt;/b&gt;?]",
    );
    expect(needs).not.toContain("<b>0.4.87</b>");
    expect(needs).toContain("[bell.sa.found:node|/w/app|4242]");
    expect(needs).toContain(
      `data-bell="sa-answer" data-sa="${ask.id}" data-choice="yes"`,
    );
    expect(needs).toContain(
      `data-bell="sa-answer" data-sa="${ask.id}" data-choice="no"`,
    );
  });

  it("a session with no label is named as such", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const { session: _, ...bare } = ask;
    const p = bellPanel({ groups: [], waiting: [bare], unread: 0 });
    if (!("sections" in p)) throw new Error("the bell has no sections");
    expect(p.sections.needs).toContain("[bell.sa.rowBare:");
  });

  it("a choice posts to the person-only answer route; open asks count in the badge", () => {
    const src = fs.readFileSync(path.join(PUBLIC, "bell.js"), "utf-8");
    expect(src).toMatch(/`\/api\/session-asks\/\$\{[^}]+\}\/answer`/);
    expect(src).toMatch(/sessionAsksOf\(b\)\.length/);
  });
});

describe("issue 620: the row's words in en, es and ja", () => {
  function catalogs(): Record<string, Record<string, string>> {
    const window: Record<string, unknown> = {};
    const document = {
      getElementById: () => null,
      documentElement: { lang: "en" },
      addEventListener: () => {},
    };
    const ctx = vm.createContext({ window, document, Intl });
    for (const f of ["i18n/es.js", "i18n/ja.js", "shell.js"]) {
      try {
        vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), "utf-8"), ctx);
      } catch {
        /* shell.js stops at its first DOM use */
      }
    }
    return window.denMessages as Record<string, Record<string, string>>;
  }

  it("each key is in all three, and es and ja aren't English", () => {
    const c = catalogs();
    for (const k of [
      "bell.sa.h",
      "bell.sa.row",
      "bell.sa.rowBare",
      "bell.sa.found",
      "bell.sa.answered",
    ]) {
      expect([k, typeof c.en[k]]).toEqual([k, "string"]);
      for (const l of ["es", "ja"]) {
        expect([k, l, typeof c[l][k]]).toEqual([k, l, "string"]);
        expect([k, l, c[l][k] === c.en[k]]).toEqual([k, l, false]);
      }
    }
  });
});
