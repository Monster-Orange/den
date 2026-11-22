/**
 * Issue 169 (T1, the reporter's naming rule): a terminal is a terminal.
 * The UI never says "shell" for one, in en, es or ja. The Settings rows
 * about the shell Den starts to read the PATH for agent CLIs (a login or
 * interactive shell, a real thing on the machine, not a terminal of the
 * person's) keep the word.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.join(__dirname, "../../../src/ui/server/public");
const CATALOGS: Record<string, string> = {
  en: "shell.js",
  es: "i18n/es.js",
  ja: "i18n/ja.js",
};
/** The PATH lookup's own words: the machine's shell, not a terminal. */
const KEEPS_THE_WORD = new Set([
  "set.ui.rt.src.login-shell",
  "set.ui.rt.src.interactive-shell",
  "set.agents.shell_path_wait",
  "set.agents.shell_path_wait.d",
]);
const WORD = /\bshells?\b|シェル/i;

function strings(file: string): Array<[string, string]> {
  const src = fs.readFileSync(path.join(PUBLIC, file), "utf8");
  return [
    ...src.matchAll(/\n\s+"([\w.-]+)":\s*\n?\s*"((?:[^"\\]|\\.)*)"/g),
  ].map((m) => [m[1], m[2]]);
}

describe('issue 169: the UI never says "shell" for a terminal', () => {
  it.each(Object.entries(CATALOGS))("%s", (_lang, file) => {
    const all = strings(file);
    expect(all.length).toBeGreaterThan(500);
    const said = all
      .filter(([k, v]) => WORD.test(v) && !KEEPS_THE_WORD.has(k))
      .map(([k, v]) => `${k}: ${v}`);
    expect(said).toEqual([]);
  });
});
