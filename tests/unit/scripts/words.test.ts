/**
 * LOGICAL-ERD.md "Words people see": the words gate's rules
 * (scripts/words.js). A string people read never says the "never shown"
 * words; code a person may see (flags, `code`, command names, paths, keys)
 * and the protocol's name ("MCP server") stay.
 */
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "@jest/globals";
import {
  languageOf,
  movedLines,
  neverShownIn,
  proseIn,
} from "../../../scripts/words.js";

describe("the words gate's rules", () => {
  it.each([
    ["Workspace north does not exist", ["workspace"]],
    ["Ask your team to sign in", ["team"]],
    // The edition's name is a name (0.4.45); "teams" around it still counts.
    ["Den Hub for Teams: a shared Hub", []],
    ["Den Hub for Teams, for teams", ["team"]],
    ["the org's repos", ["org"]],
    ["This user can't approve", ["user"]],
    ["Link your account", ["account"]],
    ["Start a session", ["session"]],
    ["the server restarted", ["server"]],
    ["the bot answered", ["bot"]],
    ["each tenant's data", ["tenant"]],
    ["El espacio de trabajo no existe", ["espacio de trabajo"]],
    ["Abre una sesión con tu cuenta", ["cuenta", "sesión"]],
    ["ワークスペースがありません", ["ワークスペース"]],
    ["ユーザーのセッション", ["ユーザー", "セッション"]],
  ])("%j says %j", (text, words) => {
    expect(neverShownIn(text).sort()).toEqual([...words].sort());
  });

  it.each([
    "Project north does not exist",
    "Run `den workspace use north` first",
    "use -w/--workspace <ws> for one project",
    "Usage: den org list [--org <id>]",
    "attach with <cli> sessions attach <id>",
    "it is set in config/local/workspaces.yml",
    "the agent's MCP server serves this project",
    "DEN_SESSION_ID is set by Den",
    "a person signs in to the install",
    "agents.<id>.grants names projects",
  ])("%j is clean", (text) => {
    expect(neverShownIn(text)).toEqual([]);
  });

  it("es: signing in says sesión, and botón is no bot (0.4.45)", () => {
    for (const text of [
      "Sesión iniciada como",
      "Cerrar sesión",
      "Inicia sesión allí y aprueba esta instalación",
      "No es un inicio de sesión: nada más lo necesita.",
      "Los navegadores con la sesión iniciada en este Den.",
      "El botón propio de la barra lateral hace lo mismo.",
    ])
      expect([text, neverShownIn(text, "es")]).toEqual([text, []]);
    expect(neverShownIn("La sesión del agente sigue abierta", "es")).toEqual([
      "sesión",
    ]);
    expect(neverShownIn("Un bot de la empresa", "es")).toEqual(["bot"]);
  });

  // 2026-11-17 (issue 339): a vendor's own account is the vendor's word,
  // as "MCP server" is the protocol's: allowed only right after a vendor's
  // name or a {placeholder}. A bare account is still never shown.
  it.each([
    "Add {vendor} account",
    "{vendor} account A",
    "Claude account",
    "Codex account 2",
    "added ${name} account 2",
    "Cuenta de {vendor} A",
    "Añadir cuenta de {vendor}",
    "{vendor} アカウント A",
    "{vendor} アカウントを追加",
  ])("a vendor's account: %j is clean", (text) => {
    expect(neverShownIn(text)).toEqual([]);
  });

  it.each([
    ["Link your account", ["account"]],
    ["Add account", ["account"]],
    ["the account of {vendor}", ["account"]],
    ["Añadir cuenta", ["cuenta"]],
    ["アカウントを追加", ["アカウント"]],
  ])("a bare account: %j says %j", (text, words) => {
    expect(neverShownIn(text)).toEqual(words);
  });

  it("a template's ${…} reads as a {placeholder} before a vendor's account", () => {
    const [s] = proseIn("  d.out(`✓ added ${rt.name} account ${a.id}`);");
    expect(neverShownIn(s!)).toEqual([]);
    const [bare] = proseIn("  d.out(`✓ added the account ${a.id} here`);");
    expect(neverShownIn(bare!)).toEqual(["account"]);
  });

  it("the vendor names cover every built-in runtime's vendor, name and accountName", async () => {
    const { VENDOR_NAMES } = await import("../../../scripts/words.js");
    const { BUILTIN_CATALOG } =
      await import("../../../src/shared/agents/catalog.js");
    for (const e of BUILTIN_CATALOG)
      expect([
        e.id,
        VENDOR_NAMES.includes(e.vendor),
        VENDOR_NAMES.includes(e.name),
        // Issue 339: what the vendor calls the account (every built-in has one).
        VENDOR_NAMES.includes(e.accountName),
      ]).toEqual([e.id, true, true, true]);
  });

  it("tells the language by its script and words", () => {
    expect(languageOf("プロジェクト")).toBe("ja");
    expect(languageOf("El proyecto no existe")).toBe("es");
    expect(languageOf("The project")).toBe("en");
  });

  it("reads only strings with two words in a row, never comments or keys", () => {
    expect(proseIn('  throw new Error(`no session "${id}" here`);')).toEqual([
      'no session "{}" here',
    ]);
    expect(proseIn("  // the workspace is gone")).toEqual([]);
    expect(proseIn('  const k = "workspace";')).toEqual([]);
  });
});

describe("a tag's attributes (dev.6)", () => {
  it("href, data-* and class values are code; title, aria-label, placeholder and alt are read", () => {
    expect(
      neverShownIn(
        '<a class="x" href="/settings?ws=north#workspace" data-for="workspace persona-workspace">Hub</a>',
      ),
    ).toEqual([]);
    expect(
      neverShownIn('<button title="More for this workspace">⋯</button>'),
    ).toEqual(["workspace"]);
    expect(
      neverShownIn('<input placeholder="Type to find a workspace">'),
    ).toEqual(["workspace"]);
    expect(neverShownIn('<i aria-label="workspace menu"></i>')).toEqual([
      "workspace",
    ]);
  });
});

/**
 * The words-ok ratchet (0.4.45): each exemption under src/ is counted, so a
 * new one is a one-line change here that review sees. Lower it when you
 * remove one; raise it only with the exemption it pays for.
 */
// 68: 1257 (Refs #989) names the CLI's "workspace seed" command in SeedVia.
// 69: ja "サーバー" for the approved mock's Server tag (issue 773).
const WORDS_OK_MAX = 69;

describe("lines only moved or re-indented (0.4.48)", () => {
  // A diff where one string moved in a file (re-indented under a new
  // block) and another is new. Only the new one is read.
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,2 +10,4 @@",
    "-        hints: [`Attach: ${cli} sessions attach ${n}`],",
    "+          hints: [`Attach: ${cli} sessions attach ${n}`],",
    '+          note: "a new string with the session word",',
    "diff --git a/src/b.ts b/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1,0 +1,1 @@",
    "+        hints: [`Attach: ${cli} sessions attach ${n}`],",
  ].join("\n");

  it("a line removed and added again in the same file (whitespace aside) is not new", () => {
    const moved = movedLines(diff);
    expect(
      moved.has("src/a.ts\0hints: [`Attach: ${cli} sessions attach ${n}`],"),
    ).toBe(true);
  });

  it("a changed line, or the same text in another file, is new", () => {
    const moved = movedLines(diff);
    expect(
      moved.has('src/a.ts\0note: "a new string with the session word",'),
    ).toBe(false);
    expect(
      moved.has("src/b.ts\0hints: [`Attach: ${cli} sessions attach ${n}`],"),
    ).toBe(false);
  });
});

describe("the words-ok ratchet", () => {
  it(`src/ has at most ${WORDS_OK_MAX} words-ok markers`, () => {
    const out = execFileSync("git", ["grep", "-c", "words-ok:", "--", "src"], {
      encoding: "utf-8",
    });
    const total = out
      .split("\n")
      .filter(Boolean)
      .reduce((n, l) => n + Number(l.slice(l.lastIndexOf(":") + 1)), 0);
    expect(total).toBeLessThanOrEqual(WORDS_OK_MAX);
  });
});
