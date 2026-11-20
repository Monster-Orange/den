/**
 * Issue 660: Claude Code covers file writes under Edit(path) rules and
 * warns at every start that a Write(path) rule "never matches". Every
 * permission rule Den writes into an agent's settings is collected here,
 * from every runtime's launch with every rule source on, and none may be
 * a path-scoped Write rule. A bare `Write` tool rule (no path) is fine.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  personConfigDenyRules,
  stateDirDenyRules,
} from "../../../src/shared/agents/den-claude.js";
import {
  getRuntime,
  runtimeIds,
  type LaunchInput,
} from "../../../src/shared/agents/runtimes.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-660-")));
  tmps.push(d);
  return d;
}

/** Every string under a `permissions` object, at any depth. */
function permissionRules(v: unknown, inPerms = false): string[] {
  if (typeof v === "string") return inPerms ? [v] : [];
  if (Array.isArray(v)) return v.flatMap((x) => permissionRules(x, inPerms));
  if (v && typeof v === "object")
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
      permissionRules(x, inPerms || k === "permissions"),
    );
  return [];
}

function fullInput(root: string): LaunchInput {
  // A stand-in binary that never does anything (no real vendor CLI runs).
  const bin = path.join(root, "bin", "agent-cli");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return {
    bin,
    persona: {
      id: "planner",
      role: "Writes stories.",
      prompt: "You plan the work.",
      standing: true,
      tools: [],
      context: [],
      source: "/pack/planner.md",
      argv: ["{bin}"],
    },
    workspace: { name: "north", dir: path.join(root, "w") },
    agentId: "planner",
    worktree: path.join(root, "w"),
    mcp: {
      name: "acme",
      command: ["/dist/bin/acme", "mcp"],
      env: { PATH: "/usr/bin:/bin" },
      scope: "north",
      hub: {
        name: "acme-hub",
        url: "https://hub.example.test/mcp",
        headersHelper: "true",
        allowTools: true,
      },
    },
    filesDir: path.join(root, "agent-files", "planner"),
    stateDir: path.join(root, "home", ".acme"),
    personConfigDir: path.join(root, "proj", "config", "local"),
    allow: ["npm test", "git status"],
    denToolsAllowed: true,
    env: { HOME: path.join(root, "home"), PATH: "/usr/bin:/bin" },
  } as LaunchInput;
}

const WRITE_PATH = /^Write\(.+\)$/;

describe("issue 660: no Write(path) permission rules", () => {
  it("the deny-rule builders emit none", () => {
    const root = tmp();
    const rules = [
      ...personConfigDenyRules(path.join(root, "config", "local")),
      ...stateDirDenyRules(path.join(root, ".acme"), root),
    ];
    expect(rules.filter((r) => WRITE_PATH.test(r))).toEqual([]);
  });

  it("the person's config folder keeps its Edit(path) deny rule", () => {
    const dir = path.join(tmp(), "config", "local");
    expect(personConfigDenyRules(dir)).toEqual([`Edit(/${dir}/**)`]);
  });

  it.each(runtimeIds())(
    "runtime %s writes no Write(path) rule in any settings file",
    (id) => {
      const out = getRuntime(id)!.launch(fullInput(tmp()));
      const rules = Object.values(out.files ?? {}).flatMap((body) => {
        try {
          return permissionRules(JSON.parse(body));
        } catch {
          return [];
        }
      });
      if (id === "den-claude") {
        // The collector sees the real rules: the deny list is in there.
        expect(rules.some((r) => r.startsWith("Edit("))).toBe(true);
      }
      expect(rules.filter((r) => WRITE_PATH.test(r))).toEqual([]);
    },
  );
});
