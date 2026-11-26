/**
 * Issue 393: no Settings string tells the person to run, type or paste a
 * command. When the page can do a thing, it has a control for it; the
 * command line is only a bare equivalent beside it ("... __DEN_CLI__
 * config x=1" at the end of a description is fine).
 *
 * What is read: settings-registry.js (its own text: labels, descriptions,
 * the fallbacks it passes to L()), and in shell.js's en and in es and ja,
 * every "set." key plus every key the registry looks up.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { BUILTIN_CATALOG } from "../../../src/shared/agents/catalog.js";
import { readSettingsSources } from "./helpers/settings-sources.js";

type Table = Record<string, string>;
const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");

/** window.denMessages after running these classic scripts, in order. */
function catalogs(...files: string[]): Record<string, Table> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of files) {
    try {
      vm.runInContext(read(f), ctx, { filename: f });
    } catch {
      // shell.js stops at its first DOM use; its catalog is set before it.
    }
  }
  return window.denMessages as Record<string, Table>;
}

/**
 * Issue 399: the commands a vendor's own CLI names for its sign-in (the
 * runtime catalog's signIn.command, "claude setup-token"), so one named
 * inline, with no markup, is seen too. "Claude" alone, the account, is
 * not the command.
 */
const VENDOR_CMDS = BUILTIN_CATALOG.flatMap((e) =>
  e.signIn?.command ? [e.signIn.command] : [],
);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * A command: the {cmd} slot, the CLI's name, code markup, a backtick span
 * (catalog text only: the registry's own code is full of template
 * literals), or a vendor's sign-in command named inline (issue 399).
 */
const cmdOf = (ticks: boolean) =>
  String.raw`(?:\{cmd\}|__DEN_CLI__|<code>${ticks ? "|`[^`\n]+`" : ""}${VENDOR_CMDS.map((c) => `|${esc(c)}`).join("")})`;
/**
 * Words that tell the person to do it, per language. Issue 399 widened the
 * verbs from run/type/paste to make/create/use/enter and "then" (the next
 * step), and the command from the slot to anything cmdOf names.
 */
function rules(ticks: boolean): Record<string, RegExp[]> {
  const CMD = cmdOf(ticks);
  return {
    en: [
      new RegExp(
        String.raw`\b(?:run|type|paste|enter|make|create|use|then)\b[^.!?\n]{0,30}?${CMD}`,
        "i",
      ),
    ],
    es: [
      new RegExp(
        String.raw`(?:^|[^\p{L}])(?:ejecut[ae]r?|ejecute|escrib[ae]|escribir|peg[ae]|pegue|pegar|cr[eé]a(?:r|lo|la)?|cree|haz|haga|usa|usar|use|utiliza|luego)(?![\p{L}])[^.!?\n]{0,30}?${CMD}`,
        "iu",
      ),
      // "después" is as often "after" as "then": only right before one.
      new RegExp(String.raw`\bdespu[eé]s\s+${CMD}`, "i"),
    ],
    ja: [
      new RegExp(
        String.raw`${CMD}[^。\n]{0,30}?(?:実行|入力|貼り付け|作|保存)`,
      ),
      // The verb before the command is the weaker sign in Japanese (the
      // object comes first): the slot and markup only, not a backtick
      // span ("単体テスト実行 (`gate run`)" names a test run).
      new RegExp(
        String.raw`(?:実行|入力|貼り付け)[^。\n]{0,10}?${cmdOf(false)}`,
      ),
    ],
  };
}
const CHORE = rules(true);
const CODE_CHORE = rules(false);
/**
 * The one thing allowed: a bare CLI-equivalent note that ends a row's
 * description. It starts a sentence with the CLI's name or the {cmd} slot
 * and runs to the end with no further sentence ("... last. __DEN_CLI__
 * config x=1", "... 。__DEN_CLI__ web url と同じです。"). A config key's
 * dot ("agents.keep_running") is not a sentence end.
 */
const TAIL =
  /(?:^|[.!?]\s+|。)(?:__DEN_CLI__|\{cmd\})(?:(?![.!?]\s|。[\s\S])[\s\S])*$/;
const withoutTail = (s: string) => s.replace(TAIL, "");
const chore = (lang: string, s: string) =>
  CHORE[lang].some((r) => r.test(withoutTail(s)));

const REGISTRY = readSettingsSources();
const messages = catalogs("i18n/es.js", "i18n/ja.js", "shell.js");
/** Keys the registry looks up: L("key", …) and t("key", …). */
const LOOKED_UP = new Set(
  [...REGISTRY.matchAll(/\b(?:L|t)\(\s*"([\w.-]+)"/g)].map((m) => m[1]),
);
const keys = (lang: string) =>
  Object.keys(messages[lang] ?? {}).filter(
    (k) => k.startsWith("set.") || LOOKED_UP.has(k),
  );

/**
 * The one Settings line that still names a command for the person to run,
 * kept on purpose: making an agent sign-in token is the vendor's own
 * browser sign-in (the catalog's signIn.command), which Den can't run for
 * the person yet. Its command sits in the row's markup, next to a Copy
 * button, so the rules above never see it; it is named here instead.
 * Issue 405 (a "Make sign-in token" button) removes it, and then the
 * test below fails until this entry goes too.
 */
const VENDOR_STEP = {
  key: "keep.setup",
  reason: "the vendor's own sign-in command; no Den action can run it yet",
  issue: 405,
};

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
    // Issue 399: a command named inline, after make/then/use, in a code
    // span, backticks or the slot; and in es and ja.
    expect(VENDOR_CMDS).toContain("claude setup-token");
    expect(
      chore(
        "en",
        "Make one with claude setup-token, then __DEN_CLI__ agents token set.",
      ),
    ).toBe(true);
    expect(chore("en", "Make one with <code>claude setup-token</code>.")).toBe(
      true,
    );
    expect(chore("en", "Use `den agents token set` for it.")).toBe(true);
    expect(chore("en", "Saved, then __DEN_CLI__ agents token set.")).toBe(true);
    expect(chore("en", "Then {cmd} saves it. Off: nothing.")).toBe(true);
    expect(
      chore("es", "Crea uno con claude setup-token y luego __DEN_CLI__ x."),
    ).toBe(true);
    expect(
      chore(
        "ja",
        "claude setup-token で作り、__DEN_CLI__ agents token set で保存",
      ),
    ).toBe(true);
    // The bare equivalent at the end stays allowed, "then" and all, and a
    // config key's dot is not a sentence end; a mention is not a chore.
    expect(
      chore(
        "en",
        "Off: agents stop. __DEN_CLI__ config agents.keep=true, then __DEN_CLI__ service install",
      ),
    ).toBe(false);
    expect(chore("ja", "止まります。__DEN_CLI__ web url と同じです。")).toBe(
      false,
    );
    expect(chore("en", "Flagged in `gate status` and on the page.")).toBe(
      false,
    );
    expect(chore("en", "Sign in with your Claude account.")).toBe(false);
    // Only the last sentence is a note: one after it is checked again.
    expect(
      chore("en", "Saved. __DEN_CLI__ x. Then {cmd} saves it. Off: nothing."),
    ).toBe(true);
  });

  it("settings-registry.js says no such thing", () => {
    // Its string literals are text (a description, a fallback); the rest
    // of a line is code, checked without backticks (template literals).
    const LITERAL = /"((?:[^"\\\n]|\\.)*)"/g;
    const bad = REGISTRY.split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(
        ([, line]) =>
          [...line.matchAll(LITERAL)].some((m) => chore("en", m[1])) ||
          CODE_CHORE.en.some((r) => r.test(line.replace(LITERAL, '""'))),
      )
      .map(([n, line]) => `${n}: ${line.trim()}`);
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

  it("names its single exception, which is still on the page", () => {
    // Issue 405 removes the step; delete VENDOR_STEP with it.
    expect(VENDOR_STEP.issue).toBe(405);
    expect(REGISTRY).toMatch(
      new RegExp(`t\\("${esc(VENDOR_STEP.key)}"\\)\\)\\} <code>`),
    );
    for (const lang of ["en", "es", "ja"])
      expect(messages[lang][VENDOR_STEP.key]).toBeTruthy();
  });
});
