/**
 * Issue 479: an agent whose runtime is a copy macOS has quarantined
 * (com.apple.quarantine) is never started, so macOS never shows its
 * warning at launch.
 *
 *   1. Start, resume and restart stop before anything is spawned (the
 *      scripted PTY records every spawn; the `claude` shim writes a marker
 *      when run). The refusal says why, the path, and the choices: the
 *      other copies found, or clear this one yourself. Den never removes
 *      the attribute itself.
 *   2. An agent's start (the CLI, or MCP through the routes) gets the same
 *      refusal as a clear error, with no retry.
 *   3. The Start dialog says so before Start: the path (selectable, and
 *      Copy path, for a browser on another machine), "Use this" for each
 *      other copy that can run. Nothing opens a folder on the Den machine.
 *   4. A row's resume that is refused offers one way on: Settings ›
 *      Agents › Runtimes, at that runtime's row.
 *
 * The quarantine is read by a fake reader (setQuarantineReader): no test
 * runs this machine's xattr or a vendor's CLI.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import {
  clearVersionCache,
  resetInteractivePath,
  setQuarantineReader,
} from "../../../src/shared/agents/runtime-search.js";
import {
  AgentError,
  resolveAgentsDeps,
  restartAgent,
  resumeAgent,
  startAgent,
  stopAgent,
} from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import { callTool } from "../../../src/ui/mcp/tools.js";
import { DenHttpError, type DenApi } from "../../../src/ui/mcp/api.js";
import {
  quarantinedHtml,
  quarantineNext,
  readiness,
  runtimeSettingsUrl,
  wireQuarantine,
} from "../../../src/ui/server/public/agent-start.js";
import { runtimeFocusFrom } from "../../../src/ui/server/public/settings-registry.js";
import {
  CLAUDE_SHIM,
  cleanupRigs,
  rig,
  settle,
  type Rig,
} from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  resetInteractivePath();
  clearVersionCache();
  setQuarantineReader(undefined);
  await cleanupRigs();
});

interface Two {
  r: Rig;
  /** The second claude, later on PATH: never quarantined. */
  other: string;
  otherRan: string;
  /** A third, quarantined too: never offered. */
  third: string;
}

/**
 * The rig's `claude` (first on PATH) and two more copies later on PATH:
 * `other` runs, `third` is quarantined too. The rig's own is the one
 * chosen; `quarantine(true)` marks it (and `third`) quarantined.
 */
async function copies(): Promise<Two & { quarantine(on: boolean): void }> {
  const r = await rig();
  const otherRan = path.join(r.dir, "other-ran");
  const other = path.join(r.dir, "bin2", "claude");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, CLAUDE_SHIM(otherRan), { mode: 0o755 });
  const third = path.join(r.dir, "bin3", "claude");
  fs.mkdirSync(path.dirname(third), { recursive: true });
  fs.writeFileSync(third, CLAUDE_SHIM(otherRan), { mode: 0o755 });
  r.deps.env = {
    ...r.deps.env,
    PATH: `${path.dirname(r.claude)}:${path.dirname(other)}:${path.dirname(third)}:/usr/bin:/bin`,
  };
  let on = false;
  setQuarantineReader((f) => on && (f === r.claude || f === third));
  return {
    r,
    other,
    otherRan,
    third,
    quarantine(v: boolean) {
      on = v;
      // The reader's answers are kept per file identity: ask again.
      setQuarantineReader((f) => on && (f === r.claude || f === third));
    },
  };
}

const recordFile = (r: Rig, id: string) =>
  path.join(r.stateDir, "agents", `${id}.json`);

async function refusalOf(p: Promise<unknown>): Promise<AgentError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw e;
  }
  throw new Error("not refused");
}

describe("issue 479 (1): a quarantined runtime copy is never started", () => {
  it("start stops before spawning: why, the path, and the other copy to use", async () => {
    const c = await copies();
    c.quarantine(true);
    const d = resolveAgentsDeps(c.r.deps);
    const e = await refusalOf(
      startAgent(d, { workspace: "north", persona: "planner" }),
    );
    expect(e.code).toBe("runtime_quarantined");
    expect(e.status).toBe(409);
    expect(e.message).toContain(c.r.claude);
    expect(e.message).toMatch(/macOS has quarantined/);
    expect(e.message).toMatch(/did not run it/);
    // The choices: the other copy that runs (never the quarantined third),
    // or clear it yourself; Den never clears it.
    expect(e.message).toContain(c.other);
    expect(e.message).not.toContain(c.third);
    expect(e.hints.join("\n")).toContain(
      `set agents.runtimes.den-claude.bin to ${c.other}`,
    );
    expect(e.hints.join("\n")).toMatch(/clear it yourself/);
    expect(e.quarantined).toEqual({
      runtime: "den-claude",
      name: "Claude Code",
      path: c.r.claude,
      dir: path.dirname(c.r.claude),
      scope: "global",
      setting: "agents.runtimes.den-claude.bin",
      others: [expect.objectContaining({ path: c.other, source: "PATH" })],
    });
    // Nothing spawned, nothing ran, nothing recorded.
    expect(c.r.made).toHaveLength(0);
    expect(fs.existsSync(c.r.ran)).toBe(false);
    expect(fs.existsSync(c.otherRan)).toBe(false);
    expect(fs.existsSync(recordFile(c.r, "planner"))).toBe(false);
  });

  it("pinned to a quarantined copy in the project's setting: refused, and its pin is the project's", async () => {
    const c = await copies();
    c.quarantine(true);
    c.r.wsBins.north = { "den-claude": c.r.claude };
    const d = resolveAgentsDeps(c.r.deps);
    const e = await refusalOf(
      startAgent(d, { workspace: "north", persona: "planner" }),
    );
    expect(e.code).toBe("runtime_quarantined");
    expect(e.quarantined?.scope).toBe("workspace");
    expect(c.r.made).toHaveLength(0);
  });

  it("resume stops before spawning", async () => {
    const c = await copies();
    const d = resolveAgentsDeps(c.r.deps);
    await startAgent(d, { workspace: "north", persona: "planner" });
    expect(c.r.made).toHaveLength(1);
    await stopAgent(d, "planner", "north");
    c.r.made[0].exit(0);
    await settle();
    c.quarantine(true);
    const e = await refusalOf(resumeAgent(d, "planner", "north"));
    expect(e.code).toBe("runtime_quarantined");
    expect(e.message).toContain(c.r.claude);
    expect(c.r.made).toHaveLength(1);
  });

  it("restart refuses before stopping: the agent keeps running", async () => {
    const c = await copies();
    const d = resolveAgentsDeps(c.r.deps);
    await startAgent(d, { workspace: "north", persona: "planner" });
    c.quarantine(true);
    const e = await refusalOf(restartAgent(d, "planner", "north", "now"));
    expect(e.code).toBe("runtime_quarantined");
    // Never stopped (no signal sent), and nothing new spawned.
    expect(c.r.made).toHaveLength(1);
    expect(c.r.made[0].signals).toEqual([]);
  });

  it("cleared by the person: the next start runs (asked again, not remembered)", async () => {
    const c = await copies();
    c.quarantine(true);
    const d = resolveAgentsDeps(c.r.deps);
    await refusalOf(startAgent(d, { workspace: "north", persona: "planner" }));
    c.quarantine(false);
    await startAgent(d, { workspace: "north", persona: "planner" });
    expect(c.r.made).toHaveLength(1);
  });

  it("Den never removes the attribute: no source runs xattr -d or -c", () => {
    const root = path.join(__dirname, "..", "..", "..", "src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(ts|js|mjs)$/.test(f.name)) {
          const src = fs.readFileSync(p, "utf-8");
          if (/xattr["'`]?\s*,?\s*\[?\s*["'`]-[dcr]/.test(src)) hits.push(p);
          if (/xattr -[dcr]\b/.test(src)) hits.push(p);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

describe("issue 479 (2): another agent's start gets the same refusal, no retry", () => {
  it("`agents start` (the CLI an agent runs): exit 1, the message and the choices, nothing spawned", async () => {
    const c = await copies();
    c.quarantine(true);
    const rc = await cmdAgents(
      ["start", "-w", "north", "--persona", "planner"],
      c.r.deps,
    );
    expect(rc).toBe(1);
    const err = c.r.err.join("\n");
    expect(err).toContain(c.r.claude);
    expect(err).toMatch(/macOS has quarantined/);
    expect(err).toContain(`set agents.runtimes.den-claude.bin to ${c.other}`);
    expect(c.r.made).toHaveLength(0);
    expect(fs.existsSync(c.r.ran)).toBe(false);
  });

  it("the start route: 409 runtime_quarantined with the path and the copies, nothing spawned", async () => {
    const c = await copies();
    c.quarantine(true);
    const server = http.createServer((req, res) => {
      jsonApiErrors(res, newRequestId());
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleAgentRoutes(req, res, p, { agents: c.r.deps });
    });
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, "localhost", res));
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(
      `http://localhost:${port}/api/workspaces/north/agents`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona: "planner" }),
      },
    );
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(409);
    expect(json.code).toBe("runtime_quarantined");
    expect(String(json.error)).toContain(c.r.claude);
    expect(json.quarantined).toMatchObject({
      runtime: "den-claude",
      path: c.r.claude,
      others: [expect.objectContaining({ path: c.other })],
    });
    expect(c.r.made).toHaveLength(0);
  });

  it("MCP agent_resume: one call, the refusal as the tool's error, never retried", async () => {
    const msg =
      "den-claude can't start: macOS has quarantined /x/claude (com.apple.quarantine)";
    let calls = 0;
    const api: DenApi = {
      baseUrl: "http://localhost:4100",
      async get(p, _q, method) {
        if (method === "POST") {
          calls++;
          throw new DenHttpError("POST", p, 409, msg);
        }
        if (p === "/api/workspaces")
          return {
            active: ["north"],
            focus: "north",
            workspaces: { north: {} },
          };
        return {};
      },
      async stream() {
        throw new Error("no stream here");
      },
    };
    const r = await callTool(
      "agent_resume",
      { agent: "sde-1", workspace: "north" },
      {
        api,
        cfg: {
          actions: ["agent_resume"],
          runTestsEnvs: ["local"],
          logsRemote: false,
          approvals: true,
        },
        cli: "acme",
        scope: { workspace: "north", actor: "agent:orchestrator" },
      },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain("quarantined /x/claude");
    expect(calls).toBe(1);
  });
});

/** Echoes the key and its values: what was said, not how. */
const t = (key: string, vars?: Record<string, unknown>) =>
  [key, ...Object.values(vars ?? {}).map(String)].join(" ");

describe("issue 479 (1): the Start dialog says so before Start", () => {
  const q = {
    runtime: "den-claude",
    name: "Claude Code",
    path: "/opt/a/claude",
    dir: "/opt/a",
    scope: "global",
    setting: "agents.runtimes.den-claude.bin",
    others: [
      { path: "/opt/b/claude", source: "PATH", version: "2.1.0" },
      { path: "/opt/c/claude", source: "well-known", quarantined: true },
    ],
  };
  it("quarantinedHtml: why, the path (selectable, Copy path), Use this for a copy that runs; no Open its folder", () => {
    const html = quarantinedHtml(q, t);
    expect(html).toContain("ag.rt.quarantined Claude Code");
    expect(html).toContain("/opt/a/claude");
    expect(html).toContain('data-q-pin="den-claude"');
    expect(html).toContain('data-bin="/opt/b/claude"');
    expect(html).toContain('data-q-scope="global"');
    expect(html).not.toContain('data-bin="/opt/c/claude"');
    expect(html).toContain("set.ui.rt.useThis");
    // A browser on another machine: the path to copy, never a folder
    // opened on the Den machine.
    expect(html).toContain('data-q-copy="/opt/a/claude"');
    expect(html).toContain("ag.rt.copyPath");
    expect(html).toMatch(/class="[^"]*ag-q-path[^"]*"[^>]*>\/opt\/a\/claude</);
    expect(html).toContain("user-select:all");
    expect(html).not.toContain("data-q-open");
    expect(html).not.toContain("ag.rt.openFolder");
    expect(html).toContain("ag.rt.clearSelf");
    expect(html).toContain("data-q-again");
  });

  it("readiness: Start is off for a quarantined runtime, with the same choices", () => {
    const data = {
      personas: [{ id: "planner", role: "Plans." }],
      runtimes: [
        {
          id: "den-claude",
          label: "Claude Code",
          default: true,
          available: true,
          quarantined: true,
          path: "/opt/a/claude",
          source: "PATH",
          setting: "agents.runtimes.den-claude.bin",
          others: q.others,
        },
      ],
    };
    const r = readiness(data, "planner", "", t);
    expect(r.ok).toBe(false);
    expect(r.tone).toBe("warn");
    expect(r.html).toContain("/opt/a/claude");
    expect(r.html).toContain('data-bin="/opt/b/claude"');
    expect(r.html).toContain('data-q-copy="/opt/a/claude"');
    expect(r.html).not.toContain("data-q-open");
  });
});

describe("issue 479 (1): a refused resume is not a dead end", () => {
  const q = {
    runtime: "den-claude",
    name: "Claude Code",
    path: "/opt/a/claude",
    dir: "/opt/a",
    scope: "global",
    setting: "agents.runtimes.den-claude.bin",
    others: [],
  };
  it("runtimeSettingsUrl: Settings › Agents › Runtimes at that runtime's row (and its project, for a project's pin)", () => {
    expect(runtimeSettingsUrl(q)).toBe(
      "/settings?runtime=den-claude#agents.runtimes",
    );
    expect(runtimeSettingsUrl({ ...q, scope: "workspace" }, "north")).toBe(
      "/settings?runtime=den-claude&project=north#agents.runtimes",
    );
  });

  it("quarantineNext: the one action a refused row resume offers; none for another refusal", () => {
    const err = Object.assign(new Error("den-claude can't start"), {
      code: "runtime_quarantined",
      data: { code: "runtime_quarantined", quarantined: q },
    });
    expect(quarantineNext(err, t)).toEqual({
      label: "ag.rt.openRuntimes",
      href: "/settings?runtime=den-claude#agents.runtimes",
    });
    expect(quarantineNext(new Error("other"), t)).toBeNull();
  });

  it("runtimeFocusFrom: Settings reads the row (and the project, when it is one) from its URL", () => {
    expect(runtimeFocusFrom("?runtime=den-claude", ["north"])).toEqual({
      runtime: "den-claude",
      ws: "",
    });
    expect(runtimeFocusFrom("?runtime=codex&project=north", ["north"])).toEqual(
      { runtime: "codex", ws: "north" },
    );
    // A project that isn't one: every project.
    expect(runtimeFocusFrom("?runtime=codex&project=gone", ["north"])).toEqual({
      runtime: "codex",
      ws: "",
    });
    expect(runtimeFocusFrom("", ["north"])).toEqual({ runtime: "", ws: "" });
  });
});

describe("issue 479 (1): Open a terminal there, in Den's own terminal", () => {
  const q = {
    runtime: "den-claude",
    name: "Claude Code",
    path: "/opt/a/claude",
    dir: "/opt/a",
    scope: "global",
    setting: "agents.runtimes.den-claude.bin",
    others: [],
  };

  async function serve(r: Rig): Promise<number> {
    const server = http.createServer((req, res) => {
      jsonApiErrors(res, newRequestId());
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleAgentRoutes(req, res, p, { agents: r.deps });
    });
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, "localhost", res));
    return (server.address() as AddressInfo).port;
  }

  const post = (port: number, body?: unknown) =>
    fetch(`http://localhost:${port}/api/workspaces/north/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("quarantinedHtml offers it, with the copy's folder", () => {
    const html = quarantinedHtml(q, t);
    expect(html).toContain('data-q-term="/opt/a"');
    expect(html).toContain("ag.rt.openTerminal");
  });

  it("the terminal-start route takes a cwd: the shell starts in that folder", async () => {
    const c = await copies();
    c.r.deps.env = { ...c.r.deps.env, SHELL: "/bin/sh" };
    const dir = path.dirname(c.r.claude);
    const port = await serve(c.r);
    const res = await post(port, { cwd: dir });
    expect(res.status).toBe(200);
    expect(c.r.made).toHaveLength(1);
    expect(c.r.made[0].opts.cwd).toBe(dir);
    // No cwd: the project's folder, as before.
    const again = await post(port);
    expect(again.status).toBe(200);
    expect(c.r.made[1].opts.cwd).toBe(c.r.wsDir("north"));
  });

  it("a cwd that isn't an absolute path to a folder is refused; nothing starts", async () => {
    const c = await copies();
    c.r.deps.env = { ...c.r.deps.env, SHELL: "/bin/sh" };
    const port = await serve(c.r);
    for (const cwd of ["relative/dir", c.r.claude, "/no/such/folder", 7]) {
      const res = await post(port, { cwd });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect(c.r.made).toHaveLength(0);
  });

  it("the button starts that terminal in the project shown and opens its pane", async () => {
    let onClick: ((e: unknown) => Promise<void>) | undefined;
    const host = {
      dataset: {} as Record<string, string>,
      addEventListener: (_: string, fn: (e: unknown) => Promise<void>) => {
        onClick = fn;
      },
      contains: () => true,
    };
    const b = {
      dataset: { qTerm: "/opt/a" } as Record<string, string>,
      disabled: false,
      closest(sel: string) {
        return sel.includes("data-quarantined") ? null : b;
      },
    };
    const calls: unknown[][] = [];
    const opened: string[] = [];
    wireQuarantine(host, {
      api: async (...a: unknown[]) => {
        calls.push(a);
        return { ok: true, session: { id: "s-1", workspace: "north" } };
      },
      reload: async () => {},
      ws: () => "north",
      t,
      open: (u: string) => opened.push(u),
    });
    await onClick!({ target: b, preventDefault() {} });
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 3)).toEqual([
      "POST",
      "/api/workspaces/north/sessions",
      { cwd: "/opt/a" },
    ]);
    // Issue 482: a terminal opens on the Terminals page.
    expect(opened).toEqual(["/terminals?project=north&open=s-1"]);
  });
});
