/**
 * 0.4.8: a resume never loses the conversation.
 *
 *   - Every launch on a token marks the record `launched`; every resume
 *     after it is the runtime's own (`--resume <token>`), however many
 *     times it was stopped without typing. Never `--session-id` again,
 *     which Claude Code refuses once the conversation exists.
 *   - The runtime's transcript (<token>.jsonl under its projects dir) is a
 *     fast path for a record without the flag.
 *   - Only a record from before 0.4.8 (no flag, no transcript) whose
 *     session nobody prompted starts fresh under the same id.
 *   - A resume told "no conversation found" falls back once to a fresh
 *     start (same token, folder and scope) and says so; a fresh start told
 *     "already in use" retries once with --resume; both failing is a clear
 *     error naming Start fresh (CLI exit 1; the route 502 resume_failed).
 *
 * A real host on a temp socket and a scripted PTY: a test plays what the
 * runtime prints. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import { plainLines } from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const rec = (r: Rig) => readRecord(r.stateDir, "planner")!;
const head = (r: Rig, i: number) => r.made[i].args.slice(0, 2);

/** Stop planner without typing; its program ends on TERM. */
async function stopIt(r: Rig): Promise<void> {
  expect(await agents(r, "stop", "planner")).toBe(0);
  r.made[r.made.length - 1].exit(143);
  await settle();
}

/** When launch number `i` appears, it prints `text` and exits 1. */
function answers(r: Rig, i: number, text: string): Promise<void> {
  return (async () => {
    for (let n = 0; n < 200 && r.made.length <= i; n++) await settle(10);
    r.made[i].emit(`${text}\r\n`);
    r.made[i].exit(1);
  })();
}

/** The MCP server's argv in the agent's own config (its scope). */
function mcpArgs(r: Rig): string[] {
  const cfg = JSON.parse(
    fs.readFileSync(
      path.join(r.stateDir, "agent-files", "planner", "mcp.json"),
      "utf-8",
    ),
  ) as { mcpServers: Record<string, { args: string[] }> };
  return Object.values(cfg.mcpServers)[0].args;
}

/** Claude Code's transcript for `token`, as it writes it once prompted. */
function transcript(r: Rig, token: string): void {
  const claude = path.join(r.dir, "claude-config");
  fs.mkdirSync(path.join(claude, "projects", "-work-north"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(claude, "projects", "-work-north", `${token}.jsonl`),
    "{}\n",
  );
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

/** What Claude Code 2.1.319 prints on a resume with nothing to continue. */
const NO_CONVERSATION =
  "\x1b[2mNo conversation found with session ID: x\x1b[0m\r\n\x1b(B\x1b7\x1b8\x1b(B\x1b7\x1b8";

async function started(r: Rig): Promise<string> {
  r.config.agents = { planner: { grants: ["south"] } };
  expect(await agents(r, "start", "-w", "north", "--persona", "planner")).toBe(
    0,
  );
  return rec(r).resumeToken!;
}

describe("the conversation survives stop and resume without typing", () => {
  it("prompted once, then stopped and resumed three times, never typing: every resume is --resume <token>", async () => {
    const r = await rig();
    const token = await started(r);
    expect(rec(r).launched).toBe(true);
    expect(head(r, 0)).toEqual(["--session-id", token]);
    // The first session was prompted: Claude Code wrote its transcript.
    transcript(r, token);
    for (let i = 1; i <= 3; i++) {
      await stopIt(r);
      expect(await agents(r, "resume", "planner")).toBe(0);
      expect(head(r, i)).toEqual(["--resume", token]);
    }
    expect(r.made.slice(1).some((p) => p.args.includes("--session-id"))).toBe(
      false,
    );
    expect(rec(r).resumeToken).toBe(token);
  });

  it("a brand-new agent stopped before anyone typed: no transcript, so it starts fresh at once and says so", async () => {
    const r = await rig();
    const token = await started(r);
    await stopIt(r);
    expect(rec(r).launched).toBe(true);
    expect(await agents(r, "resume", "planner")).toBe(0);
    expect(head(r, 1)).toEqual(["--session-id", token]);
    expect(r.made).toHaveLength(2);
    expect(r.made[1].opts.cwd).toBe(r.made[0].opts.cwd);
    expect(r.out.join("\n")).toMatch(/nothing to resume yet; started fresh/);
  });

  it("the backstop reads past Claude Code's trailing escape codes: no conversation → fresh once", async () => {
    const r = await rig();
    r.deps.exitWatchMs = 300;
    const token = await started(r);
    // A transcript Den sees, but the runtime still finds nothing.
    transcript(r, token);
    await stopIt(r);
    const said = answers(r, 1, NO_CONVERSATION);
    expect(await agents(r, "resume", "planner")).toBe(0);
    await said;
    expect(head(r, 1)).toEqual(["--resume", token]);
    expect(head(r, 2)).toEqual(["--session-id", token]);
    expect(r.out.join("\n")).toMatch(/nothing to resume yet; started fresh/);
  }, 20_000);

  it("no flag, but the runtime's transcript is there: --resume", async () => {
    const r = await rig();
    const token = await started(r);
    await stopIt(r);
    const { launched: _l, ...old } = rec(r);
    writeRecord(r.stateDir, old);
    const claude = path.join(r.dir, "claude-config");
    fs.mkdirSync(path.join(claude, "projects", "-work-north"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(claude, "projects", "-work-north", `${token}.jsonl`),
      "{}\n",
    );
    r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
    expect(await agents(r, "resume", "planner")).toBe(0);
    expect(head(r, 1)).toEqual(["--resume", token]);
  });

  it("a record from before 0.4.8 (no flag, no transcript), never prompted: fresh under the same id", async () => {
    const r = await rig();
    const token = await started(r);
    await stopIt(r);
    const { launched: _l, ...old } = rec(r);
    writeRecord(r.stateDir, old);
    expect(await agents(r, "resume", "planner")).toBe(0);
    expect(head(r, 1)).toEqual(["--session-id", token]);
    expect(r.out.join("\n")).toMatch(/nothing to resume yet; started fresh/);
  });
});

describe("one try the other way, then a clear error", () => {
  it("a resume told no conversation starts fresh with the same token, folder and scope", async () => {
    const r = await rig();
    r.deps.exitWatchMs = 300;
    const token = await started(r);
    transcript(r, token);
    await stopIt(r);
    const scope = mcpArgs(r);
    const said = answers(r, 1, "No conversation found with session ID: x");
    expect(await agents(r, "resume", "planner")).toBe(0);
    await said;
    expect(head(r, 1)).toEqual(["--resume", token]);
    expect(head(r, 2)).toEqual(["--session-id", token]);
    expect(r.made[2].opts.cwd).toBe(r.made[0].opts.cwd);
    expect(mcpArgs(r)).toEqual(scope);
    expect(scope).toEqual(expect.arrayContaining(["--grant", "south"]));
    expect(rec(r)).toMatchObject({
      resumeToken: token,
      workspace: "north",
      grants: ["south"],
      launched: true,
    });
    expect(r.out.join("\n")).toMatch(/nothing to resume yet; started fresh/);
  }, 20_000);

  it("a fresh start told the id is already in use retries once with --resume", async () => {
    const r = await rig();
    r.deps.exitWatchMs = 300;
    const token = await started(r);
    await stopIt(r);
    const { launched: _l, ...old } = rec(r);
    writeRecord(r.stateDir, old);
    const said = answers(r, 1, `Error: Session ID ${token} is already in use.`);
    expect(await agents(r, "resume", "planner")).toBe(0);
    await said;
    expect(head(r, 1)).toEqual(["--session-id", token]);
    expect(head(r, 2)).toEqual(["--resume", token]);
    expect(r.made).toHaveLength(3);
  }, 20_000);

  it("both ways failing: a clear error naming the token and Start fresh (CLI exit 1)", async () => {
    const r = await rig();
    r.deps.exitWatchMs = 300;
    const token = await started(r);
    transcript(r, token);
    await stopIt(r);
    const said = Promise.all([
      answers(r, 1, "No conversation found with session ID: x"),
      answers(r, 2, `Error: Session ID ${token} is already in use.`),
    ]);
    expect(await agents(r, "resume", "planner")).toBe(1);
    await said;
    const err = r.err.join("\n");
    expect(err).toContain(token);
    expect(err).toMatch(/could not be continued or started/);
    expect(err).toMatch(
      /Start fresh: acme agents start -w north --persona planner --id planner/,
    );
    expect(r.made).toHaveLength(3);
  }, 20_000);

  it('through the resume route: 502 resume_failed with the message, never just "exited"', async () => {
    const r = await rig();
    r.deps.exitWatchMs = 300;
    const token = await started(r);
    transcript(r, token);
    await stopIt(r);
    const server = http.createServer((req, res) => {
      jsonApiErrors(res, newRequestId());
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleAgentRoutes(req, res, p, { agents: r.deps });
    });
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, "localhost", res));
    const port = (server.address() as AddressInfo).port;
    const said = Promise.all([
      answers(r, 1, "No conversation found with session ID: x"),
      answers(r, 2, `Error: Session ID ${token} is already in use.`),
    ]);
    const res = await fetch(
      `http://localhost:${port}/api/workspaces/north/agents/planner/resume`,
      { method: "POST" },
    );
    await said;
    const json = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(502);
    expect(json.code).toBe("resume_failed");
    expect(String(json.error)).toContain(token);
    expect(JSON.stringify(json)).toMatch(/Start fresh/);
  }, 20_000);
});

describe("plainLines", () => {
  it("drops charset, save and restore escapes, so only the text is left", () => {
    expect(plainLines(NO_CONVERSATION)).toEqual([
      "No conversation found with session ID: x",
    ]);
    expect(plainLines("a\x1b)0b\x1b=c\x1b>d")).toEqual(["abcd"]);
  });
});
