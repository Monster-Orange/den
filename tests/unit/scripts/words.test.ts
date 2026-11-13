/**
 * LOGICAL-ERD.md "Words people see": the words gate's rules
 * (scripts/words.js). A string people read never says the "never shown"
 * words; code a person may see (flags, `code`, command names, paths, keys)
 * and the protocol's name ("MCP server") stay.
 */
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "@jest/globals";
import { languageOf, neverShownIn, proseIn } from "../../../scripts/words.js";

describe("the words gate's rules", () => {
  it.each([
    ["Workspace north does not exist", ["workspace"]],
    ["Ask your team to sign in", ["team"]],
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

  it("tells the language by its script and words", () => {
    expect(languageOf("プロジェクト")).toBe("ja");
    expect(languageOf("El proyecto no existe")).toBe("es");
    expect(languageOf("The project")).toBe("en");
  });

  it("reads only strings with two words in a row, never comments or keys", () => {
    expect(proseIn('  throw new Error(`no session "${id}" here`);')).toEqual([
      'no session " " here',
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
const WORDS_OK_MAX = 67;

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
