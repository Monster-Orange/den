/**
 * AG-0.3: `<cli> agents doctor` lists each runtime: its status, the CLI it
 * runs and where it came from, its version, the directories searched
 * (names only, never an env value), and the fix when it's missing. It exits
 * 1 when the default runtime is unavailable. A rig with a fake `claude`
 * (helpers/rig.ts): its --version answers, nothing else of it runs.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { cmdAgents, AGENTS_HELP } from "../../../src/ui/cli/agents-command.js";
import { clearVersionCache } from "../../../src/shared/agents/runtime-search.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(async () => {
  clearVersionCache();
  await cleanupRigs();
});

const doctor = (r: Rig, ...args: string[]) =>
  cmdAgents(["doctor", ...args], { ...r.deps, loginPath: async () => {} });

describe("agents doctor", () => {
  it("prints each runtime's status, path and source, version and the directories searched; exit 0", async () => {
    const r = await rig();
    const bin = path.dirname(r.claude);
    expect(await doctor(r)).toBe(0);
    const user = path.join(r.dir, "config", "local", "user.yml");
    const missing = (id: string, label: string, b: string) => [
      `${id} (${label})  [Den tools: coming]`,
      `  status    ✗ unavailable: ${b} not found (searched 3 directories)`,
      "  searched  the same 3 directories as above",
      `  fix       install ${label.split(",")[0]}, or set agents.runtimes.${id}.bin to its absolute path in ${user}`,
      "            then run `acme agents doctor` again",
      "",
    ];
    expect(r.out).toEqual([
      "den-claude (Claude Code, Anthropic)  [default]",
      "  status    ✓ available",
      `  path      ${r.claude} (PATH)`,
      "  version   9.9.9",
      `  searched  ${bin}`,
      "            /usr/bin",
      "            /bin",
      "",
      ...missing("codex", "Codex CLI, OpenAI", "codex"),
      ...missing("gemini", "Gemini CLI, Google", "gemini"),
      ...missing("grok", "Grok Build, xAI", "grok"),
      "generic (Generic command)",
      "  status    ✓ available",
      "  path      none to find (the persona's argv)",
      "",
      "`acme doctor --probe` checks the env each runtime's session gets.",
    ]);
    // Never an env value (the rig's env holds a token-shaped one).
    expect(r.out.join("\n")).not.toContain("secret-value-123");
    expect(fs.existsSync(r.ran)).toBe(false);
  });

  it("the default runtime missing: the fix (install, or the user.yml key and file), exit 1", async () => {
    const r = await rig();
    r.deps.env = { PATH: "/usr/bin:/bin", HOME: "/home/someone" };
    expect(await doctor(r)).toBe(1);
    const user = path.join(r.dir, "config", "local", "user.yml");
    expect(r.out.slice(0, 7)).toEqual([
      "den-claude (Claude Code, Anthropic)  [default]",
      "  status    ✗ unavailable: claude not found (searched 2 directories)",
      "  searched  /usr/bin",
      "            /bin",
      `  fix       install Claude Code, or set agents.runtimes.den-claude.bin to its absolute path in ${user}`,
      "            then run `acme agents doctor` again",
      "",
    ]);
  });

  it("a configured bin: its source, or why it is refused (exit 1)", async () => {
    const r = await rig();
    r.runtimeBins["den-claude"] = r.claude;
    r.deps.env = { PATH: "/usr/bin:/bin" };
    expect(await doctor(r)).toBe(0);
    expect(r.out.slice(0, 4)).toEqual([
      "den-claude (Claude Code, Anthropic)  [default]",
      "  status    ✓ available",
      `  path      ${r.claude} (agents.runtimes setting)`,
      "  version   9.9.9",
    ]);
    r.out.length = 0;
    r.runtimeBins["den-claude"] = "claude";
    expect(await doctor(r)).toBe(1);
    expect(r.out[1]).toBe(
      '  status    ✗ unavailable: agents.runtimes.den-claude.bin: "claude" is not an absolute path',
    );
  });

  it("--json: the runtimes as the Start dialog gets them, and the user.yml", async () => {
    const r = await rig();
    expect(await doctor(r, "--json")).toBe(0);
    const j = JSON.parse(r.out.join("\n")) as {
      runtimes: Record<string, unknown>[];
      userConfig: string;
    };
    expect(j.userConfig).toBe(path.join(r.dir, "config", "local", "user.yml"));
    expect(j.runtimes[0]).toMatchObject({
      id: "den-claude",
      available: true,
      version: "9.9.9",
      path: r.claude,
      source: "PATH",
      setting: "agents.runtimes.den-claude.bin",
      default: true,
    });
  });

  it("is in the help, and takes no other argument", async () => {
    expect(AGENTS_HELP.usage).toMatch(/doctor/);
    expect(AGENTS_HELP.lines.join("\n")).toMatch(
      /agents doctor \[-w <ws>\] \[--json\]/,
    );
    const r = await rig();
    expect(await doctor(r, "extra")).toBe(2);
  });
});
