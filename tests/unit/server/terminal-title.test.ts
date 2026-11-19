/**
 * Issue 169 part 2 (Den Design, option a): a terminal is named "Terminal N"
 * everywhere (es "Terminal N", ja "ターミナル N"): the Terminals rows, the
 * open terminal's title bar, the palette ("Terminals › <project> /
 * Terminal N") and the aria-labels. An older session named "shell-2" is
 * never shown as "shell". A name a person chose wins. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { sessionPaletteLabel } from "../../../src/ui/server/public/topbar.js";
import { terminalTitle } from "../../../src/ui/server/public/terminals-list.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

function catalogs(): Record<string, Record<string, string>> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"])
    try {
      vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), "utf-8"), ctx);
    } catch {
      // shell.js stops at its first DOM use; its catalog is set before it.
    }
  return window.denMessages as Record<string, Record<string, string>>;
}

const m = catalogs();
const tr =
  (lang: string) =>
  (k: string, v: Record<string, unknown> = {}): string =>
    (m[lang]?.[k] ?? m.en![k] ?? k).replace(/\{(\w+)\}/g, (_, x: string) =>
      String(v[x] ?? `{${x}}`),
    );

describe("issue 169: a terminal's title", () => {
  it("the words: Terminal N, Terminal N, ターミナル N", () => {
    expect(m.en!["tm.title"]).toBe("Terminal {n}");
    expect(m.es!["tm.title"]).toBe("Terminal {n}");
    expect(m.ja!["tm.title"]).toBe("ターミナル {n}");
  });

  it("the server's number wins: shell-2 numbered 2 reads Terminal 2", () => {
    const r = { kind: "session", label: "shell-2", terminalNo: 2 };
    expect(terminalTitle(r, tr("en"))).toBe("Terminal 2");
    expect(terminalTitle(r, tr("es"))).toBe("Terminal 2");
    expect(terminalTitle(r, tr("ja"))).toBe("ターミナル 2");
  });

  it("without one, the name's own number: shell is 1, terminal-3 is 3", () => {
    expect(terminalTitle({ kind: "session", label: "shell" }, tr("en"))).toBe(
      "Terminal 1",
    );
    expect(
      terminalTitle({ kind: "session", label: "terminal-3" }, tr("ja")),
    ).toBe("ターミナル 3");
  });

  it("a name a person chose wins", () => {
    expect(terminalTitle({ kind: "session", label: "scratch" }, tr("en"))).toBe(
      "scratch",
    );
    expect(
      terminalTitle(
        {
          kind: "session",
          label: "shell-2",
          terminalNo: 2,
          displayName: "logs",
        },
        tr("en"),
      ),
    ).toBe("logs");
  });
});

describe("issue 169: the palette uses the same title", () => {
  const x = {
    id: "ab12",
    kind: "session",
    workspace: "north",
    label: "shell-2",
    terminalNo: 2,
  };

  it("Terminals › north / Terminal 2, in en, es and ja; never shell", () => {
    expect(sessionPaletteLabel(x, tr("en"))).toBe(
      "Terminals › north / Terminal 2",
    );
    expect(sessionPaletteLabel(x, tr("es"))).toBe(
      "Terminales › north / Terminal 2",
    );
    expect(sessionPaletteLabel(x, tr("ja"))).toBe(
      "ターミナル一覧 › north / ターミナル 2",
    );
    for (const lang of ["en", "es", "ja"])
      expect(sessionPaletteLabel(x, tr(lang))).not.toMatch(/shell/i);
  });

  it("an agent's palette words are as before", () => {
    expect(
      sessionPaletteLabel(
        {
          id: "cd34",
          kind: "agent",
          workspace: "north",
          label: "planner",
          persona: "planner",
        },
        tr("en"),
      ),
    ).toBe("Agents › north / planner");
  });
});
