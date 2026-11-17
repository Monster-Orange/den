/**
 * #176: every tool Den names to its own server agent is one it has. The
 * server agent once read "Then check with doctor." after Den updated
 * itself, but it has no doctor tool, so it fell back to onboard_status.
 *
 * The text read here: the server agent's persona and pack
 * (src/shared/agents/server-pack/*.md), every line Den types into its
 * conversation when Den is back (backMessage, each branch), and the MCP
 * tool descriptions (and their parameters') and instructions. Each tool
 * name found must be in the server agent's MCP tool list: toolsFor() with
 * every action on and the held writes on, unpinned (ON-6).
 *
 * A tool name, as text names one:
 *   - a lowercase snake_case word (`onboard_status`, den_update), not part
 *     of a dotted setting key or a path (server_agent.pin_commit, a/b_c);
 *   - "doctor" where it is called as a tool: `doctor` in backticks, or
 *     after "with", "call", "use" or "run" ("check with doctor").
 * NOT_TOOLS lists the snake_case words in that text that aren't tools,
 * each with what it is. Add one only for a word that is not a tool.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { ZodTypeAny } from "zod";
import { toolsFor } from "../../../src/ui/mcp/tools.js";
import * as mcpServer from "../../../src/ui/mcp/server.js";
import {
  backMessage,
  type RestartMarker,
} from "../../../src/ui/server/server-restart.js";
import {
  MCP_ACTIONS,
  type ResolvedMcpConfig,
} from "../../../src/shared/den-config.js";
import { SERVER_SCOPE } from "../../../src/shared/agents/server-agent.js";

const ROOT = path.resolve(__dirname, "../../..");
const PACK = path.join(ROOT, "src/shared/agents/server-pack");

/** snake_case words in this text that are not tools. */
const NOT_TOOLS: Readonly<Record<string, string>> = {
  // server.md's frontmatter keys.
  permission_mode: "a persona's frontmatter key",
  resume_on_restart: "a persona's frontmatter key",
  // Settings named without their block (server_agent.self_update).
  self_update: "the server_agent.self_update setting",
  pin_commit: "the server_agent.pin_commit setting",
  // A parameter of repo_add and manifest_draft, and a folder.
  no_run: "repo_add's and manifest_draft's parameter",
  node_modules: "npm's folder",
  // A value of Den's update state (release_status's denUpdate.state).
  rolled_back: "an update's state",
};

const cfg = (): ResolvedMcpConfig => ({
  actions: [...MCP_ACTIONS],
  runTestsEnvs: ["local"],
  logsRemote: false,
  approvals: true,
});

/** The server agent's tools: the whole Den's, unpinned (ON-6). */
const TOOLS = toolsFor(cfg());
const NAMES = new Set(TOOLS.map((t) => t.name));

const SNAKE = /(?<![\w./-])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w/-]|\.\w)/g;
const DOCTOR = /`doctor`|\b(?:with|call|use|run)\s+`?doctor\b/gi;

/** The tool names `text` mentions. */
function toolNamesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SNAKE))
    if (!Object.hasOwn(NOT_TOOLS, m[1])) out.add(m[1]);
  if (DOCTOR.test(text)) out.add("doctor");
  DOCTOR.lastIndex = 0;
  return [...out];
}

/** Each name `text` gives that the server agent has no tool for. */
function missing(text: string): string[] {
  return toolNamesIn(text).filter((n) => !NAMES.has(n));
}

const marker = (over: Partial<RestartMarker> = {}): RestartMarker => ({
  id: "abc",
  reason: "Den 0.4.42 is out",
  agent: "server",
  fromVersion: "0.4.41",
  fromPid: 111,
  at: "2026-11-17T12:00:00.000Z",
  ...over,
});

/** backMessage's every branch. */
const BACK_LINES: Record<string, string> = {
  "Den updated itself": backMessage(marker({ by: "den" }), "0.4.42", 222),
  "Den's own update rolled back": backMessage(
    marker({ by: "den", rolledBack: true }),
    "0.4.41",
    222,
  ),
  "the agent's update rolled back": backMessage(
    marker({ rolledBack: true }),
    "0.4.41",
    222,
  ),
  "the agent's restart, a new version": backMessage(marker(), "0.4.42", 222),
  "the agent's restart, the same version": backMessage(marker(), "0.4.41", 222),
};

/** What the MCP instructions say, as each kind of caller gets them. */
function instructions(): Record<string, string> {
  const fn = (mcpServer as Record<string, unknown>).mcpInstructions as
    | ((o: {
        cfg: ResolvedMcpConfig;
        cli: string;
        scope?: { workspace: string; actor: string };
      }) => string)
    | undefined;
  expect(typeof fn).toBe("function");
  if (!fn) return {};
  return {
    unscoped: fn({ cfg: cfg(), cli: "acme" }),
    "the server agent": fn({
      cfg: cfg(),
      cli: "acme",
      scope: { workspace: SERVER_SCOPE, actor: "agent:server" },
    }),
    "a project's agent": fn({
      cfg: cfg(),
      cli: "acme",
      scope: { workspace: "north", actor: "agent:planner" },
    }),
  };
}

/** A zod type's description, and its wrapped types' (optional, default). */
function describedIn(z: ZodTypeAny | undefined, out: string[] = []): string[] {
  let t: ZodTypeAny | undefined = z;
  for (let i = 0; t && i < 6; i++) {
    if (t.description) out.push(t.description);
    t = (t._def as { innerType?: ZodTypeAny }).innerType;
  }
  return out;
}

describe("#176: what Den tells its server agent names only tools it has", () => {
  it("the finder sees today's slip: 'check with doctor' names a tool there is none of", () => {
    expect(missing("Then check with doctor.")).toEqual(["doctor"]);
    expect(missing("Then call `doctor`.")).toEqual(["doctor"]);
    expect(missing("Call onboard_status, then release_status.")).toEqual([]);
    expect(missing("call made_up_tool now")).toEqual(["made_up_tool"]);
    // Setting keys and paths are not tool names.
    expect(
      missing("server_agent.pin_commit and config/local/user_x.yml"),
    ).toEqual([]);
    // Den's doctor, said as what Den runs, is not a call.
    expect(missing("the new Den's doctor results")).toEqual([]);
  });

  it("the server agent's persona and pack", () => {
    const files = fs.readdirSync(PACK).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThan(0);
    const bad: Record<string, string[]> = {};
    for (const f of files) {
      const m = missing(fs.readFileSync(path.join(PACK, f), "utf8"));
      if (m.length) bad[f] = m;
    }
    expect(bad).toEqual({});
  });

  it("each line Den types into its conversation when Den is back", () => {
    const bad: Record<string, string[]> = {};
    for (const [k, text] of Object.entries(BACK_LINES)) {
      const m = missing(text);
      if (m.length) bad[k] = m;
    }
    expect(bad).toEqual({});
  });

  it("the MCP tool descriptions and their parameters'", () => {
    const bad: Record<string, string[]> = {};
    for (const t of TOOLS) {
      const text = [
        t.title ?? "",
        t.description,
        ...Object.values(t.shape as Record<string, ZodTypeAny>).flatMap((z) =>
          describedIn(z),
        ),
      ].join("\n");
      const m = missing(text);
      if (m.length) bad[t.name] = m;
    }
    expect(bad).toEqual({});
  });

  it("the MCP instructions, for each kind of caller", () => {
    const bad: Record<string, string[]> = {};
    for (const [k, text] of Object.entries(instructions())) {
      const m = missing(text);
      if (m.length) bad[k] = m;
    }
    expect(bad).toEqual({});
  });

  it("NOT_TOOLS holds no real tool", () => {
    expect(Object.keys(NOT_TOOLS).filter((n) => NAMES.has(n))).toEqual([]);
  });
});
