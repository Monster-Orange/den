/**
 * Issue 97: agents run on the Antigravity runtime (Google's Antigravity
 * CLI, `agy`), as a catalog entry beside Codex CLI, Gemini CLI and Grok
 * Build (AG-8a). From Google's docs:
 *
 *   - the binary is `agy`, put at ~/.local/bin/agy by the installer;
 *   - `agy --version` checks it;
 *   - plain `agy` starts the interactive CLI in the current directory;
 *   - Ctrl+J inserts a newline (Shift+Enter in a pane sends it);
 *   - sign-in is a Google account.
 *
 * Its screen is read with herdr's agy rules: a dialog is Blocked, a turn
 * is Working. herdr has no idle rule for it, so an idle screen is left to
 * Den's other signals (unknown, never a guess).
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  BUILTIN_CATALOG,
  accountNameOf,
  builtinEntry,
  entryDirs,
  softNewlineSeq,
  validateCatalogEntry,
} from "../../../src/shared/agents/catalog.js";
import {
  RULE_SETS,
  detectScreen,
  ruleSetProblems,
} from "../../../src/shared/agents/detect/index.js";
import {
  clearVersionCache,
  resetInteractivePath,
} from "../../../src/shared/agents/runtime-search.js";
import {
  listRuntimes,
  resolveAgentsDeps,
  startAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(async () => {
  resetInteractivePath();
  clearVersionCache();
  await cleanupRigs();
});

function write(file: string, content: string, mode = 0o755): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  return file;
}
const fakeCli = (ran: string, version: string) =>
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\necho "$@" >> "${ran}"\nexit 1\n`;

describe("the Antigravity entry", () => {
  const e = builtinEntry("antigravity")!;

  it("is in the catalog, valid by its own validator", () => {
    expect(e).toBeDefined();
    expect(validateCatalogEntry(e, e.id)).toEqual(e);
    expect(e).toMatchObject({
      vendor: "Google",
      name: "Antigravity CLI",
      bins: ["agy"],
      version: { args: ["--version"] },
      launch: { argv: ["{bin}"] },
      screenRules: "antigravity",
    });
    // After the others: the catalog's order is the lists' order.
    expect(BUILTIN_CATALOG.at(-1)!.id).toBe("antigravity");
  });

  it("is looked for where the installer puts it, then the system's dirs", () => {
    const dirs = entryDirs(e, "/home/a", {}, () => ["/usr/bin"]);
    expect(dirs[0]).toBe("/home/a/.local/bin");
    expect(dirs).toContain("/usr/bin");
  });

  it("Shift+Enter sends Ctrl+J; its account is a Google account", () => {
    expect(softNewlineSeq(e)).toBe("\n");
    expect(accountNameOf(e)).toBe("Google");
  });
});

describe("an agent on Antigravity", () => {
  it("is listed as installed, and runs as `agy` in the project's directory", async () => {
    const r = await rig();
    const agy = write(
      path.join(path.dirname(r.claude), "agy"),
      fakeCli(r.ran, "1.2.17"),
    );
    const d = resolveAgentsDeps(r.deps);
    const row = (await listRuntimes(d)).find((x) => x.id === "antigravity");
    expect(row).toMatchObject({
      label: "Antigravity CLI",
      vendor: "Google",
      available: true,
      version: "1.2.17",
      denTools: false,
    });
    const s = await startAgent(d, {
      workspace: "north",
      persona: "planner",
      runtime: "antigravity",
    });
    const pty = r.made.at(-1)!;
    expect([pty.file, ...pty.args]).toEqual([agy]);
    expect(pty.opts.cwd).toBe(r.wsDir("north"));
    expect(s.rec.runtime).toBe("antigravity");
  });

  it("not installed: listed as missing, and a start says so", async () => {
    const r = await rig();
    const d = resolveAgentsDeps(r.deps);
    expect(
      (await listRuntimes(d)).find((x) => x.id === "antigravity"),
    ).toMatchObject({ available: false });
    await expect(
      startAgent(d, {
        workspace: "north",
        persona: "planner",
        runtime: "antigravity",
      }),
    ).rejects.toThrow(/antigravity is unavailable: agy not found/);
  });
});

describe("its screen (herdr's agy rules)", () => {
  const scr = (rows: string[]) => ({ text: `${rows.join("\n")}\n` });

  it("ships the rule set, with no problems", () => {
    expect(RULE_SETS.antigravity).toBeDefined();
    expect(ruleSetProblems(RULE_SETS.antigravity)).toEqual([]);
  });

  it("a permission dialog is Blocked", () => {
    const d = detectScreen(
      "antigravity",
      scr([
        " Run command: npm test",
        " ❯ Allow once",
        "   Deny",
        " ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command",
        " esc to cancel",
      ]),
    )!;
    expect([d.state, d.fallback, d.visibleBlocker]).toEqual([
      "blocked",
      false,
      true,
    ]);
  });

  it("a turn with its spinner is Working", () => {
    const d = detectScreen(
      "antigravity",
      scr([
        " ⠹ Reading the parser tests",
        " ╭──────────────────────────╮",
        " │ >                        │",
        " ╰──────────────────────────╯",
        " esc to cancel",
      ]),
    )!;
    expect([d.state, d.fallback]).toEqual(["working", false]);
  });

  it("an idle prompt is left to Den's other signals: unknown, no rule", () => {
    const d = detectScreen(
      "antigravity",
      scr([
        " Done: the parser test passes.",
        " ╭──────────────────────────╮",
        " │ >                        │",
        " ╰──────────────────────────╯",
        " ? for shortcuts",
      ]),
    )!;
    expect([d.state, d.fallback]).toEqual(["unknown", true]);
  });
});
