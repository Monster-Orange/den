/**
 * Issue 658: Resume never fails on a conversation that was never written.
 *
 * What happened: an agent rotated and Den relaunched it from its handoff.
 * The relaunch stopped at the runtime's "trust this folder?" question,
 * the answer was No, and it exited, so the new conversation was never
 * written. Den had already recorded its id and put the handoff aside.
 * Every Resume then passed `--resume <id>` and failed (502 resume_failed),
 * relaunch refused ("has not rotated"), and only Start fresh was left,
 * without the handoff.
 *
 *   1. Resume of a conversation the runtime never wrote starts fresh,
 *      never `--resume`; with a handoff on file (handoff.md, or the newest
 *      kept one that passes the check) its first prompt is that handoff.
 *      Never a 502 for it.
 *   2. Whether there is a conversation to resume is the runtime's own
 *      record (its transcript), not Den's: a relaunched record, or a
 *      session someone typed into (a No to the trust question), is not one.
 *   3. A relaunch that ends before its conversation exists, at once or
 *      later, leaves the agent relaunchable: handoff.md back, rotation due.
 *   4. `agents relaunch <id> --from-handoff [<file>]` relaunches from the
 *      newest handoff when no rotation is due; the record says why.
 *   5. A relaunch keeps the folder the agent ran in (the folder Claude Code
 *      knows and trusts), never moving it to a repo folder.
 *
 * A real host on a temp socket and a scripted PTY: nothing runs. Claude
 * Code's projects folder is a temp dir. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import {
  noteCompaction,
  readRotation,
} from "../../../src/shared/agents/rotation.js";
import { setRotateValue } from "../../../src/shared/agents/rotate-settings.js";
import * as ops from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { handleAgentRoutes } from "../../../src/ui/server/agent-routes.js";
import {
  jsonApiErrors,
  newRequestId,
} from "../../../src/ui/server/http-errors.js";
import { GOOD_HANDOFF } from "./helpers/handoff.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((res) => s.close(() => res()));
  await cleanupRigs();
});

const ID = "be-dev";
const agents = (r: Rig, ...a: string[]) => cmdAgents(a, r.deps);
const rec = (r: Rig) => readRecord(r.stateDir, ID)!;
const files = (r: Rig) => path.join(r.stateDir, "agent-files", ID);
const handoffMd = (r: Rig) => path.join(files(r), "handoff.md");
const kept = (r: Rig) => path.join(files(r), "handoffs");
const last = (r: Rig) => r.made[r.made.length - 1];
const lastArg = (r: Rig) => last(r).args[last(r).args.length - 1];

/** What Claude Code shows before it starts in a folder it doesn't know. */
const TRUST =
  "Do you trust the files in this folder?\r\n\r\n" +
  "  /work/north\r\n\r\n" +
  "❯ 1. Yes, proceed\r\n  2. No, exit\r\n\r\nEnter to confirm · Esc to cancel\r\n";

/** Claude Code's transcript for `token`: the conversation exists. */
function transcript(r: Rig, token: string): void {
  const dir = path.join(r.dir, "claude-config", "projects", "-work-north");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${token}.jsonl`), "{}\n");
}

/** Every PTY ends on TERM, as a real runtime does. */
function endOnTerm(r: Rig): void {
  const push = r.made.push.bind(r.made);
  r.made.push = (...ps) => {
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

async function base(o: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = await rig(o);
  r.deps.env = {
    ...r.deps.env,
    CLAUDE_CONFIG_DIR: path.join(r.dir, "claude-config"),
  };
  r.deps.stopWaitMs = 3_000;
  endOnTerm(r);
  return r;
}

/** Started, typed into, its conversation written by the runtime. */
async function started(r: Rig): Promise<string> {
  expect(await agents(r, "start", "-w", "north", "--persona", ID)).toBe(0);
  await typeInto(r, "build the export\r");
  const t = rec(r).resumeToken!;
  transcript(r, t);
  return t;
}

async function typeInto(r: Rig, text: string): Promise<void> {
  const c = await connectHost(sessionPaths(r.stateDir).socket);
  c.write(rec(r).session.id, Buffer.from(text));
  await settle();
  c.close();
}

async function stop(r: Rig): Promise<void> {
  expect(await agents(r, "stop", ID)).toBe(0);
  await settle(50);
}

/** 3 compactions and a handoff that passes: the rotation is ready. */
function rotated(r: Rig): void {
  const token = rec(r).resumeToken!;
  const after = readRotation(files(r))!.after;
  for (let i = 0; i < 3; i++)
    noteCompaction(files(r), { session_id: token, trigger: "auto" }, after);
  fs.writeFileSync(handoffMd(r), GOOD_HANDOFF);
}

/**
 * The relaunch stops at the trust question; its person answers No and it
 * exits (1), after Den's at-once watch: nothing written.
 */
async function relaunchAnsweredNo(r: Rig): Promise<string> {
  expect(await agents(r, "relaunch", ID)).toBe(0);
  const p = last(r);
  p.emit(TRUST);
  await typeInto(r, "2");
  p.emit("\r\n");
  p.exit(1);
  await settle(50);
  return rec(r).resumeToken!;
}

/**
 * A runtime that keeps its own record of conversations: `--resume <id>`
 * of one it never wrote says so and exits; `--session-id <id>` of an id
 * listed in `inUse` is refused. Any other launch runs.
 */
function claudeAnswers(r: Rig, inUse: string[] = []): () => void {
  let seen = r.made.length;
  let on = true;
  void (async () => {
    while (on) {
      for (; seen < r.made.length; seen++) {
        const p = r.made[seen];
        const [flag, id] = p.args;
        const written = fs.existsSync(
          path.join(
            r.dir,
            "claude-config",
            "projects",
            "-work-north",
            `${id}.jsonl`,
          ),
        );
        if (flag === "--resume" && !written) {
          p.emit(`No conversation found with session ID: ${id}\r\n`);
          p.exit(1);
        } else if (flag === "--session-id" && inUse.includes(id)) {
          p.emit(`Error: Session ID ${id} is already in use.\r\n`);
          p.exit(1);
        }
      }
      await settle(10);
    }
  })();
  return () => {
    on = false;
  };
}

async function route(r: Rig) {
  const server = http.createServer((req, res) => {
    jsonApiErrors(res, newRequestId());
    const p = new URL(req.url ?? "/", "http://localhost").pathname;
    void handleAgentRoutes(req, res, p, { agents: r.deps });
  });
  servers.push(server);
  await new Promise<void>((res) => server.listen(0, "localhost", res));
  const port = (server.address() as AddressInfo).port;
  return async (p: string, body?: unknown) => {
    const res = await fetch(`http://localhost:${port}${p}`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          }),
    });
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
    };
  };
}

describe("issue 658, clause 1: a relaunch that never began, then Resume", () => {
  it("Resume starts it with the handoff as its first prompt: never --resume of the unwritten conversation", async () => {
    const r = await base();
    r.deps.exitWatchMs = 300;
    await started(r);
    rotated(r);
    await stop(r);
    const t2 = await relaunchAnsweredNo(r);
    const n = r.made.length;
    r.out.length = 0;
    expect(await agents(r, "resume", ID)).toBe(0);
    expect(r.made.length).toBeGreaterThan(n);
    expect(last(r).args).not.toEqual(expect.arrayContaining(["--resume", t2]));
    expect(r.made.slice(n).some((p) => p.args[0] === "--resume")).toBe(false);
    expect(lastArg(r)).toContain(GOOD_HANDOFF);
    expect(r.out.join("\n")).toMatch(/handoff/);
  }, 30_000);

  it("through the resume route: 200 with the handoff, never 502 resume_failed (the runtime refuses both ways)", async () => {
    const r = await base();
    r.deps.exitWatchMs = 300;
    await started(r);
    rotated(r);
    await stop(r);
    const t2 = await relaunchAnsweredNo(r);
    const done = claudeAnswers(r, [t2]);
    const post = await route(r);
    const res = await post(`/api/workspaces/north/agents/${ID}/resume`);
    done();
    expect(res.json.code).not.toBe("resume_failed");
    expect(res.status).toBe(200);
    expect(lastArg(r)).toContain(GOOD_HANDOFF);
  }, 30_000);

  it("typing that was the answer to the folder-trust question (Den saw it) is no conversation: fresh at once", async () => {
    const r = await base();
    const t1 = await started(r);
    // Typed into, but its runtime never wrote it: the typing was a No.
    fs.rmSync(path.join(r.dir, "claude-config"), { recursive: true });
    await stop(r);
    writeRecord(r.stateDir, {
      ...rec(r),
      trustDeclined: new Date().toISOString(),
    });
    const n = r.made.length;
    expect(await agents(r, "resume", ID)).toBe(0);
    expect(r.made[n].args.slice(0, 2)).toEqual(["--session-id", t1]);
  }, 30_000);

  it("typed into, never written, and Den didn't see why: the runtime's own answer starts it fresh, exit 0", async () => {
    const r = await base();
    r.deps.exitWatchMs = 300;
    const t1 = await started(r);
    fs.rmSync(path.join(r.dir, "claude-config"), { recursive: true });
    await stop(r);
    const done = claudeAnswers(r);
    const code = await agents(r, "resume", ID);
    done();
    expect(code).toBe(0);
    expect(last(r).args.slice(0, 2)).toEqual(["--session-id", t1]);
  }, 30_000);
});

describe("issue 658, clause 3: nothing on file", () => {
  it("a relaunched conversation never written and no handoff kept: fresh under the same id, saying it had nothing to continue", async () => {
    const r = await base();
    r.deps.exitWatchMs = 300;
    await started(r);
    rotated(r);
    await stop(r);
    const t2 = await relaunchAnsweredNo(r);
    // Den's look saw the trust question declined (its server's tick).
    expect(
      (await ops.trustTick(ops.resolveAgentsDeps(r.deps))).map((e) => e.kind),
    ).toEqual(["declined"]);
    fs.rmSync(kept(r), { recursive: true, force: true });
    r.out.length = 0;
    expect(await agents(r, "resume", ID)).toBe(0);
    expect(last(r).args.slice(0, 2)).toEqual(["--session-id", t2]);
    expect(r.out.join("\n")).toMatch(/nothing to resume yet; started fresh/);
  }, 30_000);

  it("both ways refused and no conversation on disk: a new conversation, never exit 1", async () => {
    const r = await base();
    r.deps.exitWatchMs = 300;
    const t1 = await started(r);
    await stop(r);
    // Typed into (prompted), launched, but nothing written; its id is held.
    fs.rmSync(path.join(r.dir, "claude-config"), { recursive: true });
    const done = claudeAnswers(r, [t1]);
    r.err.length = 0;
    const code = await agents(r, "resume", ID);
    done();
    expect(r.err.join("\n")).not.toMatch(/could not be continued/);
    expect(code).toBe(0);
    expect(last(r).args[0]).toBe("--session-id");
    expect(last(r).args[1]).not.toBe(t1);
    expect(rec(r).resumeToken).toBe(last(r).args[1]);
  }, 30_000);
});

describe("issue 658, clause 2: a relaunch that ends before its conversation exists stays relaunchable", () => {
  it("at once: handoff.md is back and the rotation is due", async () => {
    const r = await base();
    r.deps.exitWatchMs = 400;
    await started(r);
    rotated(r);
    await stop(r);
    const n = r.made.length;
    const said = (async () => {
      for (let i = 0; i < 200 && r.made.length <= n; i++) await settle(10);
      r.made[n].emit(TRUST);
      r.made[n].exit(1);
    })();
    await agents(r, "relaunch", ID);
    await said;
    expect(fs.existsSync(handoffMd(r))).toBe(true);
    expect(readRotation(files(r))?.due).toBe("compactions");
  }, 30_000);

  it("later (the trust question answered No): relaunch works again, from the same handoff", async () => {
    const r = await base();
    r.deps.exitWatchMs = 300;
    await started(r);
    rotated(r);
    await stop(r);
    await relaunchAnsweredNo(r);
    r.err.length = 0;
    expect(await agents(r, "relaunch", ID)).toBe(0);
    expect(r.err.join("\n")).not.toMatch(/has not rotated/);
    expect(lastArg(r)).toContain(GOOD_HANDOFF);
  }, 30_000);

  it("later: Den's own look puts handoff.md back and the row says ready to relaunch", async () => {
    const r = await base();
    r.deps.exitWatchMs = 300;
    await started(r);
    rotated(r);
    await stop(r);
    await relaunchAnsweredNo(r);
    const d = ops.resolveAgentsDeps(r.deps);
    expect(await ops.undoUnbegunRelaunches(d)).toEqual([ID]);
    expect(fs.existsSync(handoffMd(r))).toBe(true);
    r.out.length = 0;
    expect(await agents(r, "list", "-w", "north", "--json")).toBe(0);
    const [row] = JSON.parse(r.out.join("\n")) as Array<
      Record<string, { ready?: boolean }>
    >;
    expect(row.rotation?.ready).toBe(true);
    // Only once.
    expect(await ops.undoUnbegunRelaunches(d)).toEqual([]);
  }, 30_000);
});

describe("issue 658, point 4: relaunch from the newest handoff when no rotation is due", () => {
  it("agents relaunch <id> --from-handoff: the newest kept handoff, recorded as manual", async () => {
    const r = await base();
    await started(r);
    rotated(r);
    await stop(r);
    expect(await agents(r, "relaunch", ID)).toBe(0);
    transcript(r, rec(r).resumeToken!);
    await stop(r);
    expect(fs.existsSync(handoffMd(r))).toBe(false);
    r.err.length = 0;
    expect(await agents(r, "relaunch", ID)).toBe(1);
    expect(await agents(r, "relaunch", ID, "--from-handoff")).toBe(0);
    expect(lastArg(r)).toContain(GOOD_HANDOFF);
    const rots = rec(r).rotations!;
    expect(rots[rots.length - 1].reason).toBe("manual");
  }, 30_000);

  it("--from-handoff <file>: that file, when it passes the check", async () => {
    const r = await base();
    await started(r);
    await stop(r);
    const f = path.join(r.dir, "mine.md");
    fs.writeFileSync(f, GOOD_HANDOFF.replace("Next step", "Next step"));
    expect(await agents(r, "relaunch", ID, "--from-handoff", f)).toBe(0);
    expect(lastArg(r)).toContain(GOOD_HANDOFF);
    fs.writeFileSync(f, "not a handoff");
    await stop(r);
    r.err.length = 0;
    expect(await agents(r, "relaunch", ID, "--from-handoff", f)).toBe(1);
  }, 30_000);

  it("the relaunch route takes { fromHandoff: true }", async () => {
    const r = await base();
    await started(r);
    rotated(r);
    await stop(r);
    expect(await agents(r, "relaunch", ID)).toBe(0);
    transcript(r, rec(r).resumeToken!);
    await stop(r);
    const post = await route(r);
    const res = await post(`/api/workspaces/north/agents/${ID}/relaunch`, {
      fromHandoff: true,
    });
    expect(res.status).toBe(200);
    expect(lastArg(r)).toContain(GOOD_HANDOFF);
  }, 30_000);

  it("the row offers it: handoffOnFile while no rotation is ready", async () => {
    const r = await base();
    await started(r);
    rotated(r);
    await stop(r);
    expect(await agents(r, "relaunch", ID)).toBe(0);
    await stop(r);
    r.out.length = 0;
    expect(await agents(r, "list", "-w", "north", "--json")).toBe(0);
    const [row] = JSON.parse(r.out.join("\n")) as Array<
      Record<string, unknown>
    >;
    expect(row.handoffOnFile).toBe(true);
  }, 30_000);
});

describe("issue 658, point 5: a relaunch keeps the folder the agent ran in", () => {
  it("an agent in its project's top folder (from before 0.4.48) relaunches there, not in a repo", async () => {
    let wsDir: (ws: string) => string = () => "";
    const r = await base({
      workspaceServices: (ws) =>
        ws === "north"
          ? [{ address: "notes", path: path.join(wsDir("north"), "notes") }]
          : [],
    });
    wsDir = r.wsDir;
    fs.mkdirSync(path.join(r.wsDir("north"), "notes"), { recursive: true });
    await started(r);
    // Its record from before 0.4.48: the project's top folder.
    writeRecord(r.stateDir, { ...rec(r), cwd: r.wsDir("north") });
    rotated(r);
    await stop(r);
    expect(await agents(r, "relaunch", ID)).toBe(0);
    expect(rec(r).cwd).toBe(r.wsDir("north"));
    expect(last(r).opts.cwd).toBe(r.wsDir("north"));
  }, 30_000);

  it("on_due ask: a Resume of a relaunch that never began relaunches (it was asked for), never 409", async () => {
    const r = await base();
    r.deps.exitWatchMs = 300;
    await started(r);
    rotated(r);
    await stop(r);
    setRotateValue(r.stateDir, "install", undefined, "on_due", "ask");
    await relaunchAnsweredNo(r);
    expect(await agents(r, "resume", ID)).toBe(0);
    expect(lastArg(r)).toContain(GOOD_HANDOFF);
  }, 30_000);
});
