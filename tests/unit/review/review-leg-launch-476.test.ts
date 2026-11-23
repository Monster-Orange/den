/**
 * Issue 476: a review leg reads untrusted PR content (a fork's, after a
 * person's "Review this"), so its launch is narrower than any agent's:
 *
 * - It never loads project or local settings (--setting-sources user): the
 *   head's .claude/settings.json hooks and allow rules can't take effect.
 * - Only Den's own MCP server, limited to review_submit (--only), with
 *   strict MCP config: no Hub, no project servers, no .mcp.json, no
 *   claude.ai connectors.
 * - Deny rules for gh, git push, curl, wget and the rest that reach out,
 *   on top of Den's state-folder and person-config denies. gh keeps its
 *   login outside the environment, so the deny (and the "ask" intent
 *   under it) is the real guard, not the env allowlist.
 * - No Den-tools allow, and no allow rules from the request.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getRuntime,
  type LaunchInput,
} from "../../../src/shared/agents/runtimes.js";
import { REVIEW_LEG_DENY } from "../../../src/shared/agents/den-claude.js";
import {
  serverPersona,
  type Persona,
} from "../../../src/shared/agents/personas.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-leg-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const persona: Persona = serverPersona();

function input(review: boolean): LaunchInput {
  return {
    persona,
    workspace: { name: "north", dir: root },
    agentId: "rev-leg-1",
    worktree: root,
    mcp: {
      name: "acme",
      command: [
        "/x/acme",
        "mcp",
        "--workspace",
        "north",
        "--actor",
        "agent:rev-leg-1",
      ],
      env: {},
      scope: "north",
      hub: {
        name: "acme-hub",
        url: "https://hub.example.test/mcp",
        headersHelper: "true",
        allowTools: true,
      },
      extra: [{ name: "proj", url: "https://mcp.example.test" }],
    },
    filesDir: path.join(root, "files", "rev-leg-1"),
    stateDir: path.join(root, "home", ".acme"),
    personConfigDir: path.join(root, "proj", "config", "local"),
    allow: ["npm test"],
    denToolsAllowed: true,
    claudeAiConnectors: true,
    permission: "ask",
    env: { HOME: path.join(root, "home") },
    bin: "/nowhere/claude",
    ...(review ? { review: { tools: ["review_submit"] } } : {}),
  } as LaunchInput;
}

function launch(review: boolean) {
  const out = getRuntime("den-claude")!.launch(input(review));
  const files = out.files ?? {};
  const mcpFile = Object.keys(files).find(
    (f) => f.endsWith(".json") && files[f].includes("mcpServers"),
  )!;
  const settingsFile = Object.keys(files).find((f) =>
    f.endsWith("settings.json"),
  )!;
  return {
    argv: out.argv,
    mcp: JSON.parse(files[mcpFile]) as {
      mcpServers: Record<string, { args?: string[] }>;
    },
    settings: JSON.parse(files[settingsFile]) as {
      permissions?: { allow?: string[]; deny?: string[] };
    },
  };
}

describe("a review leg's launch", () => {
  it("loads only the person's own settings, never the head's project settings", () => {
    const l = launch(true);
    const i = l.argv.indexOf("--setting-sources");
    expect(i).toBeGreaterThan(0);
    expect(l.argv[i + 1]).toBe("user");
    expect(launch(false).argv).not.toContain("--setting-sources");
  });

  it("has only Den's server, limited to review_submit, with strict MCP config", () => {
    const l = launch(true);
    expect(Object.keys(l.mcp.mcpServers)).toEqual(["acme"]);
    const args = l.mcp.mcpServers.acme.args!;
    expect(args.slice(-2)).toEqual(["--only", "review_submit"]);
    expect(l.argv).toContain("--strict-mcp-config");
    // An ordinary agent keeps Hub and the project's servers.
    expect(Object.keys(launch(false).mcp.mcpServers).sort()).toEqual([
      "acme",
      "acme-hub",
      "proj",
    ]);
  });

  it("denies gh, git push, curl and wget, plus Den's state and person-config denies", () => {
    const deny = launch(true).settings.permissions?.deny ?? [];
    for (const r of [
      "Bash(gh:*)",
      "Bash(git push:*)",
      "Bash(curl:*)",
      "Bash(wget:*)",
    ]) {
      expect(REVIEW_LEG_DENY).toContain(r);
      expect(deny).toContain(r);
    }
    expect(deny.some((r) => r.includes(path.join(root, "home", ".acme")))).toBe(
      true,
    );
    expect(
      deny.some((r) => r.includes(path.join(root, "proj", "config", "local"))),
    ).toBe(true);
  });

  it("allows nothing on its own: no Den-tools allow, no request allow rules, no Hub allow", () => {
    const allow = launch(true).settings.permissions?.allow ?? [];
    expect(allow).toEqual([]);
  });
});
