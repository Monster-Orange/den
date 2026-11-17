/**
 * Issue 393: no Settings string tells the person to run, type or paste a
 * command. When the page can do a thing, it has a control for it; the
 * command line is only a bare equivalent beside it ("... __DEN_CLI__
 * config x=1" at the end of a description is fine).
 *
 * What is read: settings-registry.js (its own text: labels, descriptions,
 * the fallbacks it passes to L()), and in the en, es and ja catalogs,
 * every "set." key plus every key the registry looks up.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { allCatalogs } from "./helpers/en-catalog.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");

/** A command: the {cmd} slot, the CLI's name, or code markup. */
const CMD = String.raw`(?:\{cmd\}|__DEN_CLI__|<code>)`;
/** Words that tell the person to do it, per language. */
const CHORE: Record<string, RegExp[]> = {
  en: [
    new RegExp(String.raw`\b(?:run|type|paste)\b[^.!?\n]{0,30}?${CMD}`, "i"),
    // Issue 395: "…, then {cmd}" gives the command as the next step too
    // (the slot or code markup; a bare __DEN_CLI__ line is another sweep).
    new RegExp(String.raw`\bthen\s+(?:\{cmd\}|<code>)`, "i"),
  ],
  es: [
    new RegExp(
      String.raw`\b(?:ejecut[ae]r?|escrib[ae]|escribir|peg[ae]|pegue|pegar)\b[^.!?\n]{0,30}?${CMD}`,
      "i",
    ),
    new RegExp(String.raw`\b(?:luego|despu[eé]s)\s+(?:\{cmd\}|<code>)`, "i"),
  ],
  ja: [
    new RegExp(String.raw`${CMD}[^。\n]{0,30}?(?:実行|入力|貼り付け)`),
    new RegExp(String.raw`(?:実行|入力|貼り付け)[^。\n]{0,10}?${CMD}`),
  ],
};
const chore = (lang: string, s: string) => CHORE[lang].some((r) => r.test(s));

const REGISTRY = read("settings-registry.js");
const messages = allCatalogs();
/** Keys the registry looks up: L("key", …) and t("key", …). */
const LOOKED_UP = new Set(
  [...REGISTRY.matchAll(/\b(?:L|t)\(\s*"([\w.-]+)"/g)].map((m) => m[1]),
);
const keys = (lang: string) =>
  Object.keys(messages[lang] ?? {}).filter(
    (k) => k.startsWith("set.") || LOOKED_UP.has(k),
  );

describe("issue 393: Settings never gives a person a command to run", () => {
  it("the catalogs loaded, with Settings' keys in each", () => {
    for (const lang of ["en", "es", "ja"])
      expect([lang, keys(lang).length > 100]).toEqual([lang, true]);
    expect(LOOKED_UP.size).toBeGreaterThan(50);
  });

  it("the guard sees a chore, and lets a bare equivalent be", () => {
    expect(chore("en", "Not signed in: run {cmd}")).toBe(true);
    expect(chore("en", "Type <code>x</code> in a terminal")).toBe(true);
    expect(chore("es", "Sin sesión iniciada: ejecuta {cmd}")).toBe(true);
    expect(
      chore("ja", "サインインしていません: {cmd} を実行してください"),
    ).toBe(true);
    expect(chore("en", "Add one to the edge block, then {cmd}.")).toBe(true);
    expect(chore("es", "Añade uno y luego {cmd}.")).toBe(true);
    expect(chore("en", "How many lines. __DEN_CLI__ config x=1")).toBe(false);
    expect(chore("en", "Runs at start. __DEN_CLI__ config x=1")).toBe(false);
  });

  it("settings-registry.js says no such thing", () => {
    const bad = REGISTRY.split("\n")
      .map((line, i) => `${i + 1}: ${line.trim()}`)
      .filter((line) => chore("en", line));
    expect(bad).toEqual([]);
  });

  it.each(["en", "es", "ja"])(
    "%s Settings strings say no such thing",
    (lang) => {
      const table = messages[lang];
      const bad = keys(lang)
        .filter((k) => chore(lang, table[k]) || chore("en", table[k]))
        .map((k) => `${k}: ${table[k]}`);
      expect(bad).toEqual([]);
    },
  );
});
