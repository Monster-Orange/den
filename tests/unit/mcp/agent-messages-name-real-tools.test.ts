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
 *
 * #384: a named tool must also give what the text says it gives, to that
 * caller. FIELD_PROMISES finds "<tool> has <field>" in the text; each one
 * is called the way the server agent calls it (its MCP server, with its
 * real scope: --workspace den-server --actor agent:server) after a recorded
 * update, and its answer must hold the field. A line Den types when it is
 * back is read by tools that started before the update (the agent's MCP
 * server outlives it), so such a line promises no tool field at all: what
 * it says of the update, it says itself.
 */
import { describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as fs from "fs";
import * as path from "path";
import type { ZodTypeAny } from "zod";
import { toolsFor } from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import * as mcpServer from "../../../src/ui/mcp/server.js";
import {
  backMessage,
  type RestartMarker,
} from "../../../src/ui/server/server-restart.js";
import type { LastUpdate } from "../../../src/ui/server/den-update.js";
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
  // A parameter of gate_slot_request (a browser slot's container browser).
  browser_endpoint: "gate_slot_request's parameter",
  // Issue 642: a parameter of gate_runner_entry_set (the repo variable).
  routing_variable: "gate_runner_entry_set's parameter",
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

/** The update Den recorded (state.json and doctor.json), as the route reads it. */
const UPDATE: LastUpdate = {
  state: "good",
  from: "0.4.41",
  to: "0.4.42",
  at: "2026-11-17T12:00:05.000Z",
  doctor: {
    at: "2026-11-17T12:00:03.000Z",
    lines: ["warn hub: not connected", "fail pin: package.json has no pin"],
  },
};
const ROLLED: LastUpdate = {
  state: "rolled_back",
  from: "0.4.41",
  to: "0.4.42",
  at: "2026-11-17T12:00:05.000Z",
  why: "0.4.42 never answered",
  doctor: UPDATE.doctor!,
};

/** backMessage's every branch (with the update it is back from, if any). */
const BACK_LINES: Record<string, string> = {
  "Den updated itself": backMessage(
    marker({ by: "den" }),
    "0.4.42",
    222,
    UPDATE,
  ),
  "Den updated itself, no doctor results kept": backMessage(
    marker({ by: "den" }),
    "0.4.42",
    222,
    { ...UPDATE, doctor: undefined },
  ),
  "Den's own update rolled back": backMessage(
    marker({ by: "den", rolledBack: true, fromVersion: "0.4.42" }),
    "0.4.41",
    222,
    ROLLED,
  ),
  "the agent's update rolled back": backMessage(
    marker({ rolledBack: true, fromVersion: "0.4.42" }),
    "0.4.41",
    222,
    ROLLED,
  ),
  "the agent's update, a new version": backMessage(
    marker({ reason: "update Den 0.4.41 → 0.4.42" }),
    "0.4.42",
    222,
    UPDATE,
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

/**
 * #384: "<tool> has <field>": the field path an answer must hold. A text
 * names release_status for Den's last update (`denUpdate`) or for the new
 * Den's doctor results (`denUpdate.doctor`).
 */
const FIELD_PROMISES: { re: RegExp; tool: string; field: string[] }[] = [
  {
    re: /\brelease_status\b[^.]*?(?:\bdoctor results\b)/gi,
    tool: "release_status",
    field: ["denUpdate", "doctor"],
  },
  {
    re: /\brelease_status\b[^.]*?(?:`?denUpdate`?|\blast update\b|\bthe update\b)/gi,
    tool: "release_status",
    field: ["denUpdate"],
  },
];

/** What `text` promises a tool's answer holds. */
function promisesIn(text: string): { tool: string; field: string[] }[] {
  const out = new Map<string, { tool: string; field: string[] }>();
  for (const p of FIELD_PROMISES)
    for (const _ of text.matchAll(p.re))
      out.set(`${p.tool}:${p.field.join(".")}`, {
        tool: p.tool,
        field: p.field,
      });
  return [...out.values()];
}

/** The web server's answers after a recorded update (UPDATE). */
function updatedApi(): DenApi {
  return {
    baseUrl: "http://localhost:1",
    async get(p) {
      if (p === "/api/server-agent/update") return { update: UPDATE };
      if (p === "/api/release/runs") return { runs: [] };
      // A project's agent's scope is checked against the projects.
      if (p === "/api/workspaces")
        return {
          active: ["north"],
          focus: "north",
          workspaces: { north: { services: {} } },
        };
      return {};
    },
    async stream() {
      return { events: [], lines: [], ended: "done", exitCode: 0 };
    },
  };
}

/**
 * Call `tool` as an agent calls it: through the MCP server Den starts for
 * it (`--workspace <ws> --actor <actor>`), over the protocol.
 */
async function callAs(
  scope: { workspace: string; actor: string },
  tool: string,
): Promise<Record<string, unknown>> {
  const server = mcpServer.createDenMcpServer({
    cfg: cfg(),
    baseUrl: "http://localhost:1",
    cli: "acme",
    api: updatedApi(),
    scope,
    log: () => {},
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "acme-test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const r = (await client.callTool({ name: tool, arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    if (r.isError) throw new Error(`${tool}: ${r.content[0]?.text}`);
    return JSON.parse(r.content[0].text) as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

/** Whether `body` holds the field path. */
function holds(body: unknown, field: string[]): boolean {
  let v: unknown = body;
  for (const k of field) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, k))
      return false;
    v = (v as Record<string, unknown>)[k];
  }
  return v !== null && v !== undefined;
}

const SERVER_AGENT = { workspace: SERVER_SCOPE, actor: "agent:server" };

describe("#384: a named tool gives what the text says, as the server agent calls it", () => {
  it("the finder sees the promises, and the check sees one broken (a project's agent has no denUpdate)", async () => {
    expect(
      promisesIn(
        "Then call release_status: it has the new Den's doctor results.",
      ),
    ).toEqual([{ tool: "release_status", field: ["denUpdate", "doctor"] }]);
    expect(
      promisesIn("release_status has Den's last update of itself."),
    ).toEqual([{ tool: "release_status", field: ["denUpdate"] }]);
    expect(promisesIn("Call onboard_status, then status.")).toEqual([]);
    // A project's agent's release_status leaves Den's update out (by design):
    // the check would catch a text promising it to that caller.
    const project = await callAs(
      { workspace: "north", actor: "agent:planner" },
      "release_status",
    );
    expect(holds(project, ["denUpdate"])).toBe(false);
  });

  it("the server agent's release_status, after a recorded update, has denUpdate and its doctor results", async () => {
    const body = await callAs(SERVER_AGENT, "release_status");
    expect(body.denUpdate).toEqual(UPDATE);
  });

  it("every promise in the pack, the tool texts and the server agent's instructions holds", async () => {
    const texts: Record<string, string> = {};
    for (const f of fs.readdirSync(PACK).filter((x) => x.endsWith(".md")))
      texts[`pack ${f}`] = fs.readFileSync(path.join(PACK, f), "utf8");
    for (const t of TOOLS) texts[`tool ${t.name}`] = t.description;
    texts["instructions, the server agent"] =
      instructions()["the server agent"];
    const found: string[] = [];
    const broken: string[] = [];
    for (const [where, text] of Object.entries(texts))
      for (const p of promisesIn(text)) {
        found.push(`${where}: ${p.tool} ${p.field.join(".")}`);
        if (!holds(await callAs(SERVER_AGENT, p.tool), p.field))
          broken.push(`${where}: ${p.tool} has no ${p.field.join(".")}`);
      }
    // Not vacuous: the pack and the instructions do promise them.
    expect(found.length).toBeGreaterThan(0);
    expect(broken).toEqual([]);
  });

  it("a line Den types when it is back promises no tool field (its reader's tools predate the update)", () => {
    const bad: Record<string, string[]> = {};
    for (const [k, text] of Object.entries(BACK_LINES)) {
      const p = promisesIn(text);
      if (p.length) bad[k] = p.map((x) => `${x.tool} ${x.field.join(".")}`);
    }
    expect(bad).toEqual({});
  });

  it("the line says the update's doctor results itself, or that none were kept", () => {
    const up = BACK_LINES["Den updated itself"];
    expect(up).toContain("warn hub: not connected");
    expect(up).toContain("fail pin: package.json has no pin");
    expect(BACK_LINES["the agent's update, a new version"]).toContain(
      "warn hub: not connected",
    );
    expect(BACK_LINES["Den's own update rolled back"]).toContain(
      "warn hub: not connected",
    );
    expect(BACK_LINES["Den updated itself, no doctor results kept"]).toMatch(
      /no doctor results/i,
    );
  });
});
