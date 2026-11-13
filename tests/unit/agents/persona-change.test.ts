/**
 * AG-18, change a running agent's persona: Den stops its session and
 * resumes the same conversation (`--resume <token>`) with the new
 * persona's role prompt and permissions. The id, name, workspace, folder
 * and model stay. Mid-turn it never stops a turn unasked: refused, or
 * after this turn, or stop now. A person's only: an agent's token is
 * refused, in the CLI and the API. A runtime that can't resume can't.
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
import { verifyActorToken } from "../../../src/shared/actor-token.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  cancelStalePersonaChanges,
  changePersona,
  resolveAgentsDeps,
} from "../../../src/ui/cli/agent-ops.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
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

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

/**
 * Stop waits for the session to end (as it does for real), and each
 * scripted session ends on TERM.
 */
function endOnTerm(r: Rig): void {
  r.deps.stopWaitMs = 3_000;
  const made = r.made;
  const push = made.push.bind(made);
  made.push = (...ps) => {
    for (const p of ps) {
      const kill = p.kill.bind(p);
      p.kill = (sig: string) => {
        kill(sig);
        setTimeout(() => p.exit(143), 5);
      };
    }
    return push(...ps);
  };
}

/** Its conversation's transcript: a prompt, then `last` (one record). */
function transcript(r: Rig, token: string, last: unknown): void {
  const claude = path.join(r.dir, "claude-config");
  const dir = path.join(claude, "projects", "-work");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${token}.jsonl`);
  fs.writeFileSync(
    file,
    [
      { type: "user", cwd: r.wsDir("north"), message: { content: "Plan it" } },
      last,
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(file, t, t);
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
}

const ENDED = {
  type: "assistant",
  message: {
    model: "opus",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "Planned." }],
  },
};
const WORKING = {
  type: "assistant",
  message: {
    model: "opus",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t1", name: "Bash" }],
  },
};

/** A planner on opus, named, prompted: its conversation is `last`. */
async function planner(r: Rig, last: unknown): Promise<string> {
  endOnTerm(r);
  expect(
    await agents(
      r,
      "start",
      "-w",
      "north",
      "--persona",
      "planner",
      "--model",
      "opus",
      "--name",
      "Release plan",
    ),
  ).toBe(0);
  const token = readRecord(r.stateDir, "release-plan")!.resumeToken!;
  transcript(r, token, last);
  return token;
}

/** The planner never prompted: no transcript, nothing to resume yet. */
async function unprompted(r: Rig): Promise<void> {
  endOnTerm(r);
  const claude = path.join(r.dir, "claude-config");
  fs.mkdirSync(path.join(claude, "projects"), { recursive: true });
  r.deps.env = { ...r.deps.env, CLAUDE_CONFIG_DIR: claude };
  expect(
    await agents(
      r,
      "start",
      "-w",
      "north",
      "--persona",
      "planner",
      "--name",
      "Release plan",
    ),
  ).toBe(0);
}

const FRESH_NOTE =
  "nothing to resume yet; started fresh (same conversation id, folder and scope)";

describe("agents persona (CLI)", () => {
  it('never prompted: says it started fresh, not "same conversation"', async () => {
    const r = await rig();
    await unprompted(r);
    expect(
      await agents(r, "persona", "release-plan", "reviewer", "--now"),
    ).toBe(0);
    const out = r.out.join("\n");
    expect(out).toContain(
      `agent release-plan is now reviewer (was planner); ${FRESH_NOTE}`,
    );
    expect(out).not.toContain("same conversation,");
    expect(readRecord(r.stateDir, "release-plan")!.persona).toBe("reviewer");
  });

  it("idle: the same conversation resumes as the new persona; id, name, folder and model stay", async () => {
    const r = await rig();
    const token = await planner(r, ENDED);
    const before = readRecord(r.stateDir, "release-plan")!;
    expect(
      await agents(r, "persona", "release-plan", "reviewer", "-w", "north"),
    ).toBe(0);
    expect(r.made).toHaveLength(2);
    expect(r.made[0].signals).toContain("SIGTERM");
    const p = r.made[1];
    // The same conversation: what it said before is still its history.
    expect(p.args.slice(0, 2)).toEqual(["--resume", token]);
    expect(p.opts.cwd).toBe(before.cwd);
    expect(argAfter(p.args, "--model")).toBe("opus");
    expect(argAfter(p.args, "--append-system-prompt")).toContain(
      "with the reviewer persona",
    );
    const rec = readRecord(r.stateDir, "release-plan")!;
    expect(rec).toMatchObject({
      id: "release-plan",
      persona: "reviewer",
      displayName: "Release plan",
      workspace: "north",
      cwd: before.cwd,
      model: "opus",
      resumeToken: token,
    });
    expect(rec.personaChanges).toEqual([
      expect.objectContaining({ from: "planner", to: "reviewer", by: "cli" }),
    ]);
    expect(r.out.join("\n")).toContain(
      "agent release-plan is now reviewer (was planner)",
    );
    expect(fs.existsSync(r.ran)).toBe(false);
  });

  it("the new persona's permissions apply: the old one's mode and commands go", async () => {
    const r = await rig();
    endOnTerm(r);
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "planner",
        "--id",
        "p1",
      ),
    ).toBe(0);
    // As if it had been started with its own mode and commands.
    const f = path.join(r.stateDir, "agents", "p1.json");
    const rec = JSON.parse(fs.readFileSync(f, "utf-8")) as Record<
      string,
      unknown
    >;
    fs.writeFileSync(
      f,
      JSON.stringify({
        ...rec,
        permission: "all",
        allow: ["make deploy"],
        overrides: ["permission", "allow"],
      }),
    );
    transcript(r, rec.resumeToken as string, ENDED);
    expect(await agents(r, "persona", "p1", "reviewer")).toBe(0);
    const after = readRecord(r.stateDir, "p1")!;
    // den#48: the record says the mode it runs with now, never the old one.
    expect(after.permission).not.toBe("all");
    expect(after.allow).toBeUndefined();
    expect(after.overrides).toBeUndefined();
    expect(argAfter(r.made[1].args, "--permission-mode")).not.toBe(
      "bypassPermissions",
    );
  });

  it("mid-turn: refused with the choice, nothing stopped; --now stops it and changes", async () => {
    const r = await rig();
    await planner(r, WORKING);
    expect(await agents(r, "persona", "release-plan", "reviewer")).toBe(1);
    expect(r.err.join("\n")).toContain(
      "is working. Change after this turn, or stop it now?",
    );
    expect(r.err.join("\n")).toContain("--after-turn");
    expect(r.made).toHaveLength(1);
    expect(r.made[0].signals).toEqual([]);
    expect(readRecord(r.stateDir, "release-plan")!.persona).toBe("planner");

    expect(
      await agents(r, "persona", "release-plan", "reviewer", "--now"),
    ).toBe(0);
    expect(r.made).toHaveLength(2);
    expect(readRecord(r.stateDir, "release-plan")!.persona).toBe("reviewer");
  });

  it("after this turn: waits while it works, then changes once the turn ends", async () => {
    const r = await rig();
    const token = await planner(r, WORKING);
    const d = resolveAgentsDeps(r.deps);
    let done = false;
    const change = changePersona(
      d,
      "release-plan",
      "north",
      { persona: "reviewer", when: "after-turn" },
      { pollMs: 20 },
    ).then((x) => {
      done = true;
      return x;
    });
    await new Promise((res) => setTimeout(res, 150));
    expect(done).toBe(false);
    expect(r.made[0].signals).toEqual([]);
    transcript(r, token, ENDED);
    const out = await change;
    expect(out.from).toBe("planner");
    expect(out.rec.persona).toBe("reviewer");
    expect(r.made[1].args.slice(0, 2)).toEqual(["--resume", token]);
  });

  it("while it waits, the record says so; done, the mark goes", async () => {
    const r = await rig();
    const token = await planner(r, WORKING);
    const d = resolveAgentsDeps(r.deps);
    const change = changePersona(
      d,
      "release-plan",
      "north",
      { persona: "reviewer", when: "after-turn", by: "@owner" },
      { pollMs: 20 },
    );
    await new Promise((res) => setTimeout(res, 100));
    expect(readRecord(r.stateDir, "release-plan")!.pendingPersona).toEqual(
      expect.objectContaining({ to: "reviewer", by: "@owner" }),
    );
    transcript(r, token, ENDED);
    await change;
    expect(readRecord(r.stateDir, "release-plan")!.pendingPersona).toBe(
      undefined,
    );
  });

  it("a wait that runs out clears the mark; nothing changed", async () => {
    const r = await rig();
    await planner(r, WORKING);
    const d = resolveAgentsDeps(r.deps);
    await expect(
      changePersona(
        d,
        "release-plan",
        "north",
        { persona: "reviewer", when: "after-turn" },
        { pollMs: 10, maxMs: 60 },
      ),
    ).rejects.toThrow(/still working/);
    const rec = readRecord(r.stateDir, "release-plan")!;
    expect([rec.persona, rec.pendingPersona]).toEqual(["planner", undefined]);
  });

  it("a restart drops a waiting change: at start the mark is cleared and returned for the audit, once", async () => {
    const r = await rig();
    await planner(r, WORKING);
    const d = resolveAgentsDeps(r.deps);
    // What a server that stopped mid-wait leaves behind.
    const { writeRecord } =
      await import("../../../src/shared/agents/records.js");
    writeRecord(r.stateDir, {
      ...readRecord(r.stateDir, "release-plan")!,
      pendingPersona: {
        to: "reviewer",
        since: new Date().toISOString(),
        by: "@owner",
      },
    });
    expect(cancelStalePersonaChanges(d)).toEqual([
      {
        id: "release-plan",
        workspace: "north",
        from: "planner",
        to: "reviewer",
        by: "@owner",
      },
    ]);
    const rec = readRecord(r.stateDir, "release-plan")!;
    expect([rec.persona, rec.pendingPersona]).toEqual(["planner", undefined]);
    expect(cancelStalePersonaChanges(d)).toEqual([]);
  });

  it("an agent can't change its own persona (or another's) from its session", async () => {
    const r = await rig();
    await planner(r, ENDED);
    r.deps.env = { ...r.deps.env, DEN_ACTOR_TOKEN: "den_at_x" };
    expect(await agents(r, "persona", "release-plan", "reviewer")).toBe(1);
    expect(r.err.join("\n")).toContain(
      "only a person can change an agent's persona",
    );
    expect(r.made).toHaveLength(1);
  });

  it("a runtime that can't resume can't; its row doesn't offer it", async () => {
    const r = await rig();
    const packs = path.join(r.dir, "personas");
    fs.mkdirSync(packs);
    fs.writeFileSync(
      path.join(packs, "shell.md"),
      '---\nname: shell\nruntime: generic\nargv: ["sh", "-c", "true"]\n---\nA shell.\n',
    );
    r.config.personaPacks = ["personas"];
    expect(
      await agents(
        r,
        "start",
        "-w",
        "north",
        "--persona",
        "shell",
        "--id",
        "sh",
      ),
    ).toBe(0);
    expect(await agents(r, "persona", "sh", "planner")).toBe(1);
    expect(r.err.join("\n")).toContain("can't change persona");
    r.out.length = 0;
    expect(await agents(r, "list", "-w", "north", "--json")).toBe(0);
    const rows = JSON.parse(r.out.join("\n")) as Array<Record<string, unknown>>;
    expect(rows.find((x) => x.agent === "sh")?.personaChange).toBeUndefined();
  });

  it("a den-claude agent's row offers it", async () => {
    const r = await rig();
    await planner(r, ENDED);
    r.out.length = 0;
    expect(await agents(r, "list", "-w", "north", "--json")).toBe(0);
    const rows = JSON.parse(r.out.join("\n")) as Array<Record<string, unknown>>;
    expect(rows.find((x) => x.agent === "release-plan")?.personaChange).toBe(
      true,
    );
  });
});

describe("POST …/agents/<id>/persona", () => {
  it("never prompted: fresh, with the note that says so", async () => {
    const r = await rig();
    await unprompted(r);
    const post = await api(r);
    const res = await post({ persona: "reviewer", when: "now" });
    expect([res.status, res.json.fresh, res.json.note]).toEqual([
      200,
      true,
      FRESH_NOTE,
    ]);
  });

  async function api(r: Rig) {
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
      void handleAgentRoutes(req, res, p, {
        agents: r.deps,
        personaWait: { pollMs: 20 },
      }).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end("{}");
        }
      });
    });
    servers.push(server);
    await new Promise<void>((res) => server.listen(0, "localhost", res));
    const port = (server.address() as AddressInfo).port;
    return async (body: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(
        `http://localhost:${port}/api/workspaces/north/agents/release-plan/persona`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        },
      );
      return {
        status: res.status,
        json: (await res.json()) as Record<string, unknown>,
      };
    };
  }

  it("a person's: 200 and the same conversation; busy is 409 busy; after-turn is 202 pending", async () => {
    const r = await rig();
    const token = await planner(r, WORKING);
    const post = await api(r);
    const busy = await post({ persona: "reviewer" });
    expect([busy.status, busy.json.code]).toEqual([409, "busy"]);
    expect(r.made).toHaveLength(1);

    const later = await post({ persona: "reviewer", when: "after-turn" });
    expect([later.status, later.json.pending]).toEqual([202, true]);
    await new Promise((res) => setTimeout(res, 100));
    expect(r.made).toHaveLength(1);
    transcript(r, token, ENDED);
    for (let i = 0; i < 100 && r.made.length < 2; i++) await settle();
    for (let i = 0; i < 50 && r.made.length < 2; i++)
      await new Promise((res) => setTimeout(res, 20));
    expect(r.made).toHaveLength(2);
    expect(readRecord(r.stateDir, "release-plan")!.persona).toBe("reviewer");

    const bad = await post({ persona: "planner", nope: 1 });
    expect(bad.status).toBe(400);
  });

  it("an agent's token is refused (403), nothing stopped", async () => {
    const r = await rig();
    await planner(r, ENDED);
    const post = await api(r);
    const env = r.made[0].opts.env as Record<string, string>;
    const res = await post(
      { persona: "reviewer", when: "now" },
      { authorization: `Bearer ${actorTokenOf(env) ?? ""}` },
    );
    expect(res.status).toBe(403);
    expect(r.made[0].signals).toEqual([]);
    expect(readRecord(r.stateDir, "release-plan")!.persona).toBe("planner");
  });
});
