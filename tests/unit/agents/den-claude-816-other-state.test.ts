/**
 * Issue 816: an agent launched while test installs are announced on this
 * computer is denied their state folders as it is its own Den's (SEC-1
 * §6c.1): their web.secret mints the setup grant, so an agent must not
 * read it. Binds a cooperating agent only, like the rules for its own.
 */
import { describe, expect, it } from "@jest/globals";
import * as os from "os";
import * as path from "path";
import type { Persona } from "../../../src/shared/agents/personas.js";
import {
  getRuntime,
  type LaunchInput,
} from "../../../src/shared/agents/runtimes.js";
import { stateDirDenyRules } from "../../../src/shared/agents/den-claude.js";

const persona: Persona = {
  id: "planner",
  role: "Writes stories.",
  description: "Writes stories.",
  category: "engineering",
  allowedCommands: [],
  origin: "builtin",
  prompt: "You plan the work.",
  standing: true,
  tools: [],
  context: [],
  source: "/pack/planner.md",
};

function input(over: Partial<LaunchInput> = {}): LaunchInput {
  return {
    persona,
    workspace: { name: "north", dir: "/w/north" },
    agentId: "planner",
    worktree: "/w/north",
    mcp: {
      name: "acme",
      command: ["/dist/bin/acme", "mcp"],
      env: { PATH: "/usr/bin:/bin" },
      scope: "north",
    },
    filesDir: path.join(os.tmpdir(), "den-816-files"),
    stateDir: "/home/someone/.acme",
    // The binary is never run; launch only builds its argv and files.
    bin: "/bin/echo",
    env: {},
    ...over,
  };
}

function deny(inp: LaunchInput): string[] {
  const out = getRuntime("den-claude")!.launch(inp);
  const settings = Object.entries(out.files ?? {}).find(
    ([k]) => k.endsWith(".json") && k.includes("settings"),
  );
  const v = JSON.parse(settings![1]) as { permissions?: { deny?: string[] } };
  return v.permissions?.deny ?? [];
}

describe("issue 816: announced test installs' state folders", () => {
  const other = "/home/someone/tests/bed-a/state";

  it("are denied like the agent's own Den's", () => {
    const rules = deny(input({ otherStateDirs: [other] }));
    for (const r of stateDirDenyRules(other)) expect(rules).toContain(r);
    expect(rules).toContain(`Read(/${other}/web.secret)`);
  });

  it("the agent's own rules stay", () => {
    const rules = deny(input({ otherStateDirs: [other] }));
    for (const r of stateDirDenyRules("/home/someone/.acme"))
      expect(rules).toContain(r);
  });

  it("none announced: the rules are the agent's own only", () => {
    expect(deny(input())).toEqual(stateDirDenyRules("/home/someone/.acme"));
  });
});

describe("issue 816: the announce folder itself", () => {
  const dir = "/home/someone/.acme/test-installs";

  it("is denied, so an agent can't find a test install announced after it started", () => {
    const rules = deny(input({ testAnnounceDir: dir }));
    expect(rules).toContain(`Read(/${dir}/**)`);
    expect(rules.some((r) => r.startsWith("Bash(") && r.includes(dir))).toBe(
      true,
    );
  });
});
