/**
 * Issue 476: a review leg reads untrusted PR content (a fork's, after a
 * person's "Review this"), so its launch is narrower than any agent's:
 *
 * - It runs Claude Code's --restricted mode: no Bash or other code-running
 *   tools, no WebFetch, no user, project or local settings (so neither the
 *   head's .claude/settings.json nor the person's own allow rules or
 *   default mode apply; only Den's --settings), file tools confined to its
 *   folder. A Claude Code without --restricted can't run a leg.
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

/** A stand-in Claude Code whose --help says what it takes. */
function fakeClaude(name: string, help: string): string {
  const bin = path.join(root, name);
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${help}\nEOF\n`, {
    mode: 0o755,
  });
  return bin;
}
const HELP =
  '  --permission-mode <mode>  Permission mode (choices: "acceptEdits", "auto", "manual", "plan")\n' +
  "  --restricted              Restricted mode: removes the built-in tools that run commands\n" +
  "  --setting-sources <s>     Comma-separated list of setting sources\n" +
  '  --tools <tools...>        Built-in tools to make available: "" for none';
const withRestricted = fakeClaude("claude-new", HELP);
const withoutRestricted = fakeClaude(
  "claude-old",
  HELP.split("\n")
    .filter((l) => !l.includes("--restricted"))
    .join("\n"),
);

const persona: Persona = serverPersona();

function input(review: boolean, bin = withRestricted): LaunchInput {
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
    bin,
    ...(review ? { review: { tools: ["review_submit"] } } : {}),
  } as LaunchInput;
}

function launch(review: boolean, bin = withRestricted) {
  const out = getRuntime("den-claude")!.launch(input(review, bin));
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
  it("runs restricted: no shell, no user, project or local settings, file tools in its folder", () => {
    const l = launch(true);
    expect(l.argv).toContain("--restricted");
    // Only the built-ins a review needs: no Agent, Write, Edit, SendMessage
    // or ListAgents (a leg must never message other sessions). ToolSearch
    // loads review_submit, which Claude Code defers.
    const t = l.argv.indexOf("--tools");
    expect(t).toBeGreaterThan(0);
    expect(l.argv[t + 1]).toBe("Read,Grep,Glob,ToolSearch");
    // Restricted ignores every settings file: no user-only fallback.
    expect(l.argv).not.toContain("--setting-sources");
    expect(launch(false).argv).not.toContain("--restricted");
  });

  it("a Claude Code without --restricted can't run a leg; an ordinary agent still starts", () => {
    expect(() => launch(true, withoutRestricted)).toThrow(/restricted/i);
    expect(launch(false, withoutRestricted).argv).not.toContain("--restricted");
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
