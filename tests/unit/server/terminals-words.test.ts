/**
 * Issue 482 (ruling on the issue, 11-18): the page is "Terminals", and
 * the words of Terminals never say "shell": a terminal is a terminal, in
 * en, es and ja. Checked on the strings Terminals and its notes use.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
type Table = Record<string, string>;

function catalogs(): Record<string, Table> {
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
  return window.denMessages as Record<string, Table>;
}

/** The strings of Terminals, its rail item and the Agents page's notes. */
const OURS = (k: string) =>
  k.startsWith("tm.") ||
  k.startsWith("ag.moved.") ||
  [
    "ag.sub.only",
    "ag.none.scope",
    "n.terminal",
    "n.terminalTip",
    "ws.termHere",
    "ws.termHereTip",
  ].includes(k);

const SAYS_SHELL: Record<string, RegExp> = {
  en: /\bshells?\b/i,
  es: /\bshells?\b/i,
  ja: /シェル/,
};

describe("issue 482: Terminals never says shell", () => {
  const m = catalogs();
  for (const lang of ["en", "es", "ja"])
    it(`${lang}: no "shell" in Terminals' words`, () => {
      const table = m[lang]!;
      const keys = Object.keys(m.en!).filter(OURS);
      expect(keys.length).toBeGreaterThan(20);
      const hits = keys.filter((k) => SAYS_SHELL[lang]!.test(table[k] ?? ""));
      expect(hits.map((k) => `${k}: ${table[k]}`)).toEqual([]);
    });
});
