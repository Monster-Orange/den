/**
 * LOGICAL-ERD.md "Words people see": the words gate's rules
 * (scripts/words.js). A string people read never says the "never shown"
 * words; code a person may see (flags, `code`, command names, paths, keys)
 * and the protocol's name ("MCP server") stay.
 */
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
    ["Inicia sesión con tu cuenta", ["cuenta", "sesión"]],
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
