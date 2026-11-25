/**
 * Hardening (issue 362): a Claude Code agent is denied editing the files
 * Den launches it with: its settings file (hooks, deny and allow rules)
 * and its MCP config. Edit by path, and any shell command naming them.
 * Its files folder stays writable otherwise (its handoff goes there). A
 * cooperating agent's boundary only, as the state-dir rules are.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadPersonas } from "../../../src/shared/agents/personas.js";
import { getRuntime } from "../../../src/shared/agents/runtimes.js";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "os362-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const planner = loadPersonas([]).get("planner")!;
const filesDir = path.join(root, "files", "planner");

function deny(stateDir?: string): string[] {
  const out = getRuntime("den-claude")!.launch({
    persona: planner,
    workspace: { name: "north", dir: root },
    agentId: "planner",
    worktree: root,
    mcp: { name: "acme", command: ["/x/acme", "mcp"], env: {}, scope: "north" },
    filesDir,
    ...(stateDir ? { stateDir } : {}),
    env: { HOME: root },
    bin: "/nowhere/claude",
  });
  const s = JSON.parse(out.files![path.join(filesDir, "settings.json")]!) as {
    permissions?: { deny?: string[] };
  };
  return s.permissions?.deny ?? [];
}

describe("hardening: an agent can't edit the files it was launched with", () => {
  const settings = path.join(filesDir, "settings.json");
  const mcp = path.join(filesDir, "mcp.json");

  it.each([[undefined], [path.join(root, "state")]])(
    "Edit and Bash rules for its settings and MCP config (state dir: %s)",
    (stateDir) => {
      const rules = deny(stateDir);
      expect(rules).toContain(`Edit(/${settings})`);
      expect(rules).toContain(`Edit(/${mcp})`);
      expect(rules).toContain(`Bash(*${settings}*)`);
      expect(rules).toContain(`Bash(*${mcp}*)`);
      // The same files as a shell writes them from HOME.
      const rel = path.relative(root, settings);
      expect(rules).toContain(`Bash(*~/${rel}*)`);
    },
  );

  it("its files folder is not denied as a whole (its handoff goes there)", () => {
    const rules = deny();
    expect(rules.some((r) => r.includes(`${filesDir}/**`))).toBe(false);
  });
});
