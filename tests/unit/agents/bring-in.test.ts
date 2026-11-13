/**
 * AG-17.1, bring in a conversation: `agents import` and its routes list
 * Claude Code's own conversations for a workspace's folder, and bring one
 * in as a Den agent with the runtime's resume (`--resume <id>`), in the
 * folder it ran in, under Den's token. One writer only: a conversation
 * written in the last minute is refused. An agent's token can't bring one
 * in unless mcp.actions lists agent_import.
 *
 * A real host on a temp socket with a scripted PTY: nothing runs, and the
 * `claude` shim must never run. A temp CLAUDE_CONFIG_DIR, never ~/.claude.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { readRecord } from "../../../src/shared/agents/records.js";
import { claudeSlug } from "../../../src/shared/agents/conversations.js";
import { repoFolders } from "../../../src/shared/environment-manager/workspaces.js";
import { verifyActorToken } from "../../../src/shared/actor-token.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  agentImportRefusal,
  AGENT_IMPORT_ACTION,
} from "../../../src/ui/server/agent-resume-grant.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const TOKEN = "0f1e2d3c-aaaa-bbbb-cccc-000000000001";

/** A Claude Code transcript that ran in `cwd`, last written `ageMs` ago. */
function conversation(
  r: Rig,
  cwd: string,
  id = TOKEN,
  ageMs = 10 * 60_000,
): void {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", claudeSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "user", cwd, message: { content: "Tidy the docs" } })}\n`,
  );
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);

describe("agents import (CLI)", () => {
  it("lists the workspace's conversations, then brings one in with --resume in its folder", async () => {
    const r = await rig();
    const sub = path.join(r.wsDir("north"), "docs");
    fs.mkdirSync(sub);
    conversation(r, sub);
    expect(await agents(r, "import", "-w", "north")).toBe(0);
    expect(r.out.join("\n")).toContain(TOKEN);
    expect(r.out.join("\n")).toContain("Tidy the docs");

    expect(
      await agents(
        r,
        "import",
        "-w",
        "north",
        "--session",
        TOKEN,
        "--persona",
        "planner",
      ),
    ).toBe(0);
    expect(r.made).toHaveLength(1);
    expect(r.made[0].args.slice(0, 2)).toEqual(["--resume", TOKEN]);
    expect(r.made[0].args).not.toContain("--session-id");
    expect(r.made[0].opts.cwd).toBe(sub);
    // Den's own token and MCP, as any agent it starts.
    expect(String(actorTokenOf(r.made[0].opts.env))).toMatch(/^den_at_/);
    expect(r.made[0].args).toContain("--mcp-config");
    const rec = readRecord(r.stateDir, "planner")!;
    expect(rec).toMatchObject({
      resumeToken: TOKEN,
      launched: true,
      cwd: sub,
      workspace: "north",
    });
    expect(typeof rec.broughtInAt).toBe("string");
    expect(fs.existsSync(r.ran)).toBe(false);

    // A normal agent afterwards: stop, resume continues the same one.
    expect(await agents(r, "stop", "planner")).toBe(0);
    r.made[0].exit(143);
    await settle();
    expect(await agents(r, "resume", "planner")).toBe(0);
    expect(r.made[1].args.slice(0, 2)).toEqual(["--resume", TOKEN]);
    expect(r.made[1].opts.cwd).toBe(sub);

    // Its list row says which agent continues it; a second import refuses.
    r.out.length = 0;
    expect(await agents(r, "import", "-w", "north")).toBe(0);
    expect(r.out.join("\n")).toContain("agent planner");
    expect(
      await agents(
        r,
        "import",
        "-w",
        "north",
        "--session",
        TOKEN,
        "--persona",
        "reviewer",
      ),
    ).toBe(1);
    expect(r.err.join("\n")).toContain("already continues");
  });

  it("one writer only: written in the last minute is refused, nothing launched", async () => {
    const r = await rig();
    conversation(r, r.wsDir("north"), TOKEN, 5_000);
    expect(
      await agents(
        r,
        "import",
        "-w",
        "north",
        "--session",
        TOKEN,
        "--persona",
        "planner",
      ),
    ).toBe(1);
    expect(r.err.join("\n")).toContain(
      "Still open in another terminal. Close it there first",
    );
    expect(r.made).toHaveLength(0);
    expect(readRecord(r.stateDir, "planner")).toBeNull();
  });

  it("a repo added by path outside the workspace's folder: its conversations are this workspace's (0.4.14-dev.0 gate)", async () => {
    const r = await rig();
    const hello = path.join(r.dir, "elsewhere", "hello");
    fs.mkdirSync(hello, { recursive: true });
    conversation(r, hello);
    // What the workspaces file gives: north's folder, and its by-path repo.
    r.deps.workspaceFolders = (ws) =>
      ws === "north"
        ? {
            under: [
              r.wsDir("north"),
              ...repoFolders({
                services: { hello: { mode: "dev-managed", path: hello } },
              } as never),
            ],
          }
        : { under: [r.wsDir(ws)] };
    expect(await agents(r, "import", "-w", "north")).toBe(0);
    expect(r.out.join("\n")).toContain(TOKEN);
    expect(
      await agents(
        r,
        "import",
        "-w",
        "north",
        "--session",
        TOKEN,
        "--persona",
        "planner",
      ),
    ).toBe(0);
    expect(r.made[0].opts.cwd).toBe(hello);
    // Not another workspace's.
    r.out.length = 0;
    expect(await agents(r, "import", "-w", "south")).toBe(0);
    expect(r.out.join("\n")).not.toContain(TOKEN);
  });

  it("repoFolders: each by-path repo's folder; managed clones are not", () => {
    expect(
      repoFolders({
        services: {
          hello: { mode: "dev-managed", path: "/w/hello" },
          "hello/api": { mode: "dev-managed", path: "/w/hello" },
          shop: { mode: "managed", branch: "main" },
          odd: { mode: "dev-managed", path: "relative/x" },
        },
      } as never),
    ).toEqual(["/w/hello", "/w/hello"]);
    expect(repoFolders(undefined)).toEqual([]);
  });

  it("another workspace's conversation is not one of this workspace's", async () => {
    const r = await rig();
    conversation(r, r.wsDir("south"));
    expect(
      await agents(
        r,
        "import",
        "-w",
        "north",
        "--session",
        TOKEN,
        "--persona",
        "planner",
      ),
    ).toBe(1);
    // AG-17.1: whose it is, by its folder (spec, dogfood on 0.4.14).
    expect(r.err.join("\n")).toContain(
      `This conversation belongs to ${r.wsDir("south")}, not to project north`,
    );
    expect(r.made).toHaveLength(0);
  });

  it("a runtime that can't bring one in says so", async () => {
    const r = await rig();
    conversation(r, r.wsDir("north"));
    expect(
      await agents(
        r,
        "import",
        "-w",
        "north",
        "--runtime",
        "generic",
        "--session",
        TOKEN,
        "--persona",
        "planner",
      ),
    ).toBe(1);
    expect(r.err.join("\n")).toContain("can't bring in a conversation yet");
  });

  it("never clobbers an existing agent: the persona's id is taken, so -2", async () => {
    const r = await rig();
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    conversation(r, r.wsDir("north"));
    expect(
      await agents(
        r,
        "import",
        "-w",
        "north",
        "--session",
        TOKEN,
        "--persona",
        "planner",
      ),
    ).toBe(0);
    expect(readRecord(r.stateDir, "planner-2")?.resumeToken).toBe(TOKEN);
    expect(readRecord(r.stateDir, "planner")?.resumeToken).not.toBe(TOKEN);
  });
});

interface Api {
  r: Rig;
  call(
    method: string,
    p: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; json: Record<string, unknown> }>;
}

async function api(): Promise<Api> {
  const r = await rig();
  const server = http.createServer((req, res) => {
    jsonApiErrors(res, newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    const bearer = /^Bearer (den_at_\S+)$/.exec(
      String(req.headers.authorization ?? ""),
    );
    const t = bearer ? verifyActorToken(r.stateDir, bearer[1]) : null;
    if (t)
      setPrincipal(req, {
        kind: "agent",
        actor: t.actor,
        workspace: t.workspace,
        grants: t.grants,
        session: t.session,
      });
    handleAgentRoutes(req, res, p, { agents: r.deps })
      .then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end("{}");
        }
      })
      .catch((e: Error) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const port = (server.address() as AddressInfo).port;
  return {
    r,
    async call(method, p, body, headers = {}) {
      const res = await fetch(`http://localhost:${port}${p}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    },
  };
}

describe("the routes", () => {
  it("GET lists them with runtimes; POST …/import brings one in; open is 409 open_elsewhere", async () => {
    const a = await api();
    conversation(a.r, a.r.wsDir("north"));
    conversation(a.r, a.r.wsDir("north"), "fresh-one", 2_000);
    const list = await a.call("GET", "/api/workspaces/north/conversations");
    expect(list.status).toBe(200);
    const convs = list.json.conversations as Array<Record<string, unknown>>;
    expect(convs.map((c) => [c.id, c.open, c.runtime])).toEqual([
      ["fresh-one", true, "den-claude"],
      [TOKEN, false, "den-claude"],
    ]);
    const rts = list.json.runtimes as Array<Record<string, unknown>>;
    expect(rts.find((x) => x.id === "den-claude")?.bringIn).toBe(true);
    expect(rts.find((x) => x.id === "generic")?.bringIn).toBe(false);

    const open = await a.call(
      "POST",
      "/api/workspaces/north/conversations/fresh-one/import",
      { persona: "planner" },
    );
    expect(open.status).toBe(409);
    expect(open.json).toMatchObject({
      code: "open_elsewhere",
      error: "Still open in another terminal. Close it there first",
    });

    const ok = await a.call(
      "POST",
      `/api/workspaces/north/conversations/${TOKEN}/import`,
      { persona: "planner" },
    );
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true });
    expect(a.r.made[0].args.slice(0, 2)).toEqual(["--resume", TOKEN]);

    const bad = await a.call(
      "POST",
      `/api/workspaces/north/conversations/${TOKEN}/import`,
      { persona: "planner", extra: 1 },
    );
    expect(bad.status).toBe(400);
  });

  it("an agent's token can't list or bring one in without mcp.actions' agent_import", async () => {
    const a = await api();
    expect(
      (
        await a.call("POST", "/api/workspaces/north/agents", {
          persona: "orchestrator",
        })
      ).status,
    ).toBe(200);
    conversation(a.r, a.r.wsDir("north"));
    const env = a.r.made[0].opts.env as Record<string, string>;
    const auth = { authorization: `Bearer ${actorTokenOf(env) ?? ""}` };
    expect(
      (
        await a.call(
          "GET",
          "/api/workspaces/north/conversations",
          undefined,
          auth,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await a.call(
          "POST",
          `/api/workspaces/north/conversations/${TOKEN}/import`,
          { persona: "planner" },
          auth,
        )
      ).status,
    ).toBe(403);
    expect(a.r.made).toHaveLength(1);
  });

  it("the rule: opted in, its own workspace or a granted one", () => {
    const p = { actor: "agent:o", workspace: "north", grants: ["south"] };
    expect(agentImportRefusal(p, "north", [])).toContain(AGENT_IMPORT_ACTION);
    expect(agentImportRefusal(p, "north", [AGENT_IMPORT_ACTION])).toBeNull();
    expect(agentImportRefusal(p, "south", [AGENT_IMPORT_ACTION])).toBeNull();
    expect(agentImportRefusal(p, "east", [AGENT_IMPORT_ACTION])).toContain(
      "not east",
    );
  });
});

/** A transcript with a prompt and answers (AG-17.1c): `model`, MCP tools. */
function answered(
  r: Rig,
  cwd: string,
  model: string,
  tools: string[] = [],
  id = TOKEN,
): void {
  conversation(r, cwd, id);
  const claude = path.join(r.dir, "claude-config");
  const file = path.join(claude, "projects", claudeSlug(cwd), `${id}.jsonl`);
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      type: "assistant",
      message: {
        model,
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "Done." },
          ...tools.map((name) => ({ type: "tool_use", id: name, name })),
        ],
      },
    })}\n`,
  );
  const t = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(file, t, t);
}

/** A persona of its own pack, with `extra` front matter. */
function ownPersona(r: Rig, name: string, extra: string): void {
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, `${name}.md`),
    `---\nname: ${name}\n${extra}---\nYou work.\n`,
  );
  r.config.personaPacks = ["personas"];
}

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("AG-17.1c: Bring in keeps the conversation's model, and says what changes", () => {
  it("a conversation on one model, brought in as a persona on another, stays on its own", async () => {
    const r = await rig();
    ownPersona(r, "fast-dev", "model: sonnet\n");
    answered(r, r.wsDir("north"), "claude-opus-4-5");
    expect(
      await agents(
        r,
        "import",
        "-w",
        "north",
        "--session",
        TOKEN,
        "--persona",
        "fast-dev",
      ),
    ).toBe(0);
    expect(argAfter(r.made[0].args, "--model")).toBe("claude-opus-4-5");
    expect(readRecord(r.stateDir, "fast-dev")?.model).toBe("claude-opus-4-5");
  });

  it("a model the catalog knows is stored as its alias, pinned (Relaunch takes it)", async () => {
    const r = await rig();
    ownPersona(r, "fast-dev", "model: sonnet\n");
    answered(r, r.wsDir("north"), "claude-opus-5-5");
    expect(
      await agents(
        r,
        "import",
        "-w",
        "north",
        "--session",
        TOKEN,
        "--persona",
        "fast-dev",
      ),
    ).toBe(0);
    expect(argAfter(r.made[0].args, "--model")).toBe("claude-opus-5-5");
    expect(readRecord(r.stateDir, "fast-dev")).toMatchObject({
      model: "opus",
      version: "claude-opus-5-5",
    });
  });

  it("--model (Advanced) changes it", async () => {
    const r = await rig();
    ownPersona(r, "fast-dev", "model: sonnet\n");
    answered(r, r.wsDir("north"), "claude-opus-4-5");
    expect(
      await agents(
        r,
        "import",
        "-w",
        "north",
        "--session",
        TOKEN,
        "--persona",
        "fast-dev",
        "--model",
        "haiku",
      ),
    ).toBe(0);
    expect(readRecord(r.stateDir, "fast-dev")?.model).toBe("haiku");
    expect(r.made[0].args).not.toContain("claude-opus-4-5");
  });

  it("the list: its model, the servers it won't have (not Den's own), and a suggested persona", async () => {
    const r = await rig();
    // The latest agent that worked in north's folder was a reviewer.
    expect(
      await agents(r, "start", "-w", "north", "--persona", "reviewer"),
    ).toBe(0);
    const sub = path.join(r.wsDir("north"), "docs");
    fs.mkdirSync(sub);
    answered(r, sub, "claude-opus-4-5", [
      "mcp__linear__get_issue",
      "mcp__acme__run_tests",
    ]);
    r.out.length = 0;
    expect(await agents(r, "import", "-w", "north", "--json")).toBe(0);
    const { conversations } = JSON.parse(r.out.join("\n")) as {
      conversations: Array<Record<string, unknown>>;
    };
    expect(conversations[0]).toMatchObject({
      id: TOKEN,
      model: "claude-opus-4-5",
      lost: ["linear"],
      suggest: "reviewer",
    });
    // Suggested, never submitted: nothing was brought in.
    expect(r.made).toHaveLength(1);
  });

  it("no agent in the workspace yet: no suggestion (the page keeps its first)", async () => {
    const r = await rig();
    answered(r, r.wsDir("north"), "claude-opus-4-5");
    r.out.length = 0;
    expect(await agents(r, "import", "-w", "north", "--json")).toBe(0);
    const { conversations } = JSON.parse(r.out.join("\n")) as {
      conversations: Array<Record<string, unknown>>;
    };
    expect(conversations[0].suggest).toBeUndefined();
    expect(conversations[0].lost).toBeUndefined();
  });
});
