/**
 * Issue 785: a runtime other than Claude (Codex here) resumes the
 * conversation its agent reported, with the command Den builds from the
 * runtime's own template; a missing or refused one says why, Resume is
 * refused, and after a restart it starts fresh. Nothing in a report but
 * the conversation id reaches the command.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { readRecord, writeRecord } from "../../../src/shared/agents/records.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import {
  markInterrupted,
  resolveAgentsDeps,
  resumeInterrupted,
} from "../../../src/ui/cli/agent-ops.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const agents = (r: Rig, ...args: string[]) => cmdAgents(args, r.deps);

/** A `codex` on the rig's PATH (its first folder). */
function codexOnPath(r: Rig): string {
  const bin = path.join(r.dir, "bin", "codex");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bin;
}

/**
 * Codex's own session file for thread `id` (its first line, session_meta),
 * under the rig's $CODEX_HOME: a main thread, unless `meta` says otherwise.
 */
function codexSession(
  r: Rig,
  id: string,
  cwd: string,
  meta: Record<string, unknown> = {},
): void {
  const home = path.join(r.dir, "codex-home");
  r.deps.env = { ...r.deps.env, CODEX_HOME: home };
  const day = path.join(home, "sessions", "2026", "11", "22");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(
    path.join(day, `rollout-2026-11-22T10-00-00-${id}.jsonl`),
    JSON.stringify({
      timestamp: "2026-11-22T10:00:00.000Z",
      type: "session_meta",
      payload: {
        session_id: id,
        id,
        timestamp: "2026-11-22T10:00:00.000Z",
        cwd,
        originator: "codex_cli_rs",
        cli_version: "0.171.0",
        source: "cli",
        ...meta,
      },
    }) + "\n",
  );
}

/** A Codex agent in north: stopped, or (`interrupted`) gone with its host. */
function coder(
  r: Rig,
  report?: Record<string, unknown>,
  o: { id?: string; interrupted?: boolean } = {},
): void {
  const id = o.id ?? "coder";
  writeRecord(r.stateDir, {
    id,
    persona: "planner",
    runtime: "codex",
    workspace: "north",
    cwd: r.wsDir("north"),
    session: { backend: "den-pty", id: `gone-${id}` },
    sessionName: `acme-north:${id}`,
    startedAt: "2026-11-06T09:30:00.000Z",
    launched: true,
    ...(o.interrupted ? {} : { stoppedAt: "2026-11-06T10:30:00.000Z" }),
    ...(report ? { resumeReport: report } : {}),
  } as never);
}

async function row(r: Rig) {
  r.out.length = 0;
  expect(await agents(r, "list", "-w", "north", "--json")).toBe(0);
  return (JSON.parse(r.out.join("\n")) as Record<string, unknown>[]).find(
    (x) => x.agent === "coder",
  );
}

describe("issue 785: a Codex agent resumes the conversation it reported", () => {
  it("resumable; Resume runs Codex's own template with its binary and the id", async () => {
    const r = await rig();
    const bin = codexOnPath(r);
    coder(r, { conversation: "019a-77", cwd: r.wsDir("north"), seq: 3 });
    codexSession(r, "019a-77", r.wsDir("north"));
    expect(await row(r)).toMatchObject({ resumable: true });
    expect(await agents(r, "resume", "coder")).toBe(0);
    const p = r.made[r.made.length - 1];
    expect(p.file).toBe(bin);
    expect(p.args).toEqual([
      "-c",
      'notify=["/dist/bin/acme","agents","report-resume","--notify-json"]',
      "resume",
      "019a-77",
    ]);
  });

  it("a record that carries words beside the id: only the id is used", async () => {
    const r = await rig();
    const bin = codexOnPath(r);
    coder(r, {
      conversation: "019a-77",
      argv: ["bash", "-c", "id"],
      cwd: r.wsDir("north"),
      seq: 1,
    });
    codexSession(r, "019a-77", r.wsDir("north"));
    expect(await agents(r, "resume", "coder")).toBe(0);
    const p = r.made[r.made.length - 1];
    expect([p.file, ...p.args]).toEqual([
      bin,
      "-c",
      'notify=["/dist/bin/acme","agents","report-resume","--notify-json"]',
      "resume",
      "019a-77",
    ]);
  });

  it("an id that would read as a flag: refused; its startup command never changes", async () => {
    const r = await rig();
    codexOnPath(r);
    coder(r, {
      conversation: "--dangerously-bypass-approvals-and-sandbox",
      cwd: r.wsDir("north"),
      seq: 1,
    });
    const got = await row(r);
    expect(got?.resumable).toBe(false);
    expect(got?.noResume).toMatch(
      /^codex can't resume coder: its conversation id must be/,
    );
    expect(await agents(r, "resume", "coder")).toBe(1);
    expect(r.made).toHaveLength(0);
  });

  it("none reported: says so, and Resume is refused", async () => {
    const r = await rig();
    codexOnPath(r);
    coder(r);
    expect(await row(r)).toMatchObject({
      resumable: false,
      noResume:
        "codex can't resume coder: it reported no conversation to resume",
    });
    expect(await agents(r, "resume", "coder")).toBe(1);
    expect(r.err.join("\n")).toMatch(/it reported no conversation to resume/);
    expect(r.made).toHaveLength(0);
  });

  it("reported for another folder: refused, naming both", async () => {
    const r = await rig();
    codexOnPath(r);
    coder(r, { conversation: "019a-77", cwd: r.wsDir("south"), seq: 1 });
    const got = await row(r);
    expect(got?.resumable).toBe(false);
    expect(got?.noResume).toMatch(
      /codex can't resume coder: its conversation was reported for .*south, not .*north/,
    );
  });
});

describe("issue 785: after a restart or crash", () => {
  it("one with a good report resumes with it; one with none starts fresh, saying why", async () => {
    const r = await rig();
    const bin = codexOnPath(r);
    coder(
      r,
      { conversation: "019a-77", cwd: r.wsDir("north"), seq: 1 },
      { interrupted: true },
    );
    codexSession(r, "019a-77", r.wsDir("north"));
    coder(r, undefined, { id: "tester", interrupted: true });
    const found = await markInterrupted(resolveAgentsDeps(r.deps), {
      restoreAll: true,
    });
    expect(found.interrupted.sort()).toEqual(["coder", "tester"]);
    expect(found.resumed).toEqual(["coder"]);
    expect(found.startedFresh).toEqual([
      {
        agent: "tester",
        why: "codex can't resume tester: it reported no conversation to resume",
      },
    ]);
    expect(found.failed).toEqual([]);
    const runs = r.made.map((p) => [p.file, p.args]);
    expect(runs).toContainEqual([
      bin,
      [
        "-c",
        'notify=["/dist/bin/acme","agents","report-resume","--notify-json"]',
        "resume",
        "019a-77",
      ],
    ]);
    // The fresh one: Codex's own launch, not a resume.
    expect(
      runs.filter(([f, a]) => f === bin && !(a as string[]).includes("resume")),
    ).toHaveLength(1);
  });
});

describe("issue 785: the bell says who started fresh", () => {
  it("one note: how many, with the Agents page; none, no note", async () => {
    const { noteStartedFresh } =
      await import("../../../src/ui/server/agent-routes.js");
    const added: Record<string, unknown>[] = [];
    const store = { add: (n: unknown) => (added.push(n as never), null) };
    noteStartedFresh(store, ["tester", "lookout"]);
    expect(added).toEqual([
      expect.objectContaining({
        kind: "service",
        subject: "record:agents-started-fresh",
        text: "2 agents started fresh: no conversation Den could resume",
        msg: { key: "bell.m.fresh", vars: { n: 2 } },
        link: "/agents",
      }),
    ]);
    noteStartedFresh(store, ["tester"]);
    // The page picks the .one form itself when n is 1.
    expect(added[1]).toMatchObject({
      text: "1 agent started fresh: no conversation Den could resume",
      msg: { key: "bell.m.fresh", vars: { n: 1 } },
    });
    noteStartedFresh(store, []);
    expect(added).toHaveLength(2);
  });
});

describe("issue 785: a conversation is this agent's own (security review)", () => {
  it("one another agent's record also holds: Resume refused; after a restart it starts fresh", async () => {
    const r = await rig();
    codexOnPath(r);
    const report = { conversation: "019a-77", cwd: r.wsDir("north"), seq: 1 };
    coder(r, report);
    coder(r, { ...report, seq: 9 }, { id: "other" });
    const got = await row(r);
    expect(got?.resumable).toBe(false);
    expect(got?.noResume).toBe(
      "codex can't resume coder: its conversation is also another agent's",
    );
    expect(await agents(r, "resume", "coder")).toBe(1);
    expect(r.made).toHaveLength(0);
  });

  it("Resume all: a conversation a running agent holds is refused; the coder is not resumed", async () => {
    const r = await rig();
    codexOnPath(r);
    const report = { conversation: "019a-77", cwd: r.wsDir("north"), seq: 1 };
    coder(r, report, { interrupted: true });
    expect(
      await agents(r, "start", "-w", "north", "--persona", "planner"),
    ).toBe(0);
    const holder = readRecord(r.stateDir, "planner")!;
    expect(holder.stoppedAt).toBeUndefined();
    writeRecord(r.stateDir, {
      ...holder,
      resumeReport: { ...report, seq: 9 },
    } as never);
    r.made.length = 0;
    const got = await resumeInterrupted(resolveAgentsDeps(r.deps), ["north"]);
    expect(got.resumed).toEqual([]);
    expect(got.failed).toEqual([
      {
        agent: "coder",
        why: "codex can't resume coder: its conversation is also another agent's",
      },
    ]);
    expect(r.made).toHaveLength(0);
  });

  it("Resume all in one workspace: a conversation an agent in another workspace holds is refused", async () => {
    const r = await rig();
    codexOnPath(r);
    const report = { conversation: "019a-77", cwd: r.wsDir("north"), seq: 1 };
    coder(r, report, { interrupted: true });
    coder(r, { ...report, seq: 9 }, { id: "other" });
    const other = readRecord(r.stateDir, "other")!;
    writeRecord(r.stateDir, { ...other, workspace: "south" } as never);
    const got = await resumeInterrupted(resolveAgentsDeps(r.deps), ["north"]);
    expect(got.resumed).toEqual([]);
    expect(got.failed.map((f) => f.agent)).toEqual(["coder"]);
    expect(r.made).toHaveLength(0);
  });
});

describe("issue 785: a Codex sub-agent's thread never resumes", () => {
  const CHILD = "019a7f2c-9999-7e3f-9a8b-0c1d2e3f4a5b";
  const ROOT = "019a7f2c-1b2d-7e3f-9a8b-0c1d2e3f4a5b";

  it("Resume: refused, nothing launched", async () => {
    const r = await rig();
    codexOnPath(r);
    coder(r, { conversation: CHILD, cwd: r.wsDir("north"), seq: 1 });
    codexSession(r, CHILD, r.wsDir("north"), {
      session_id: ROOT,
      parent_thread_id: ROOT,
    });
    expect(await agents(r, "resume", "coder")).toBe(1);
    expect(r.err.join("\n")).toMatch(
      /codex can't resume coder: its conversation is not a main thread of codex that began in .*north after the agent was created/,
    );
    expect(r.made).toHaveLength(0);
  });

  it("after a restart: it starts fresh with the note, never resuming the sub-agent's thread", async () => {
    const r = await rig();
    const bin = codexOnPath(r);
    coder(
      r,
      { conversation: CHILD, cwd: r.wsDir("north"), seq: 1 },
      { interrupted: true },
    );
    codexSession(r, CHILD, r.wsDir("north"), {
      session_id: ROOT,
      parent_thread_id: ROOT,
    });
    const found = await markInterrupted(resolveAgentsDeps(r.deps), {
      restoreAll: true,
    });
    expect(found.resumed).toEqual([]);
    expect(found.startedFresh).toEqual([
      {
        agent: "coder",
        why: `codex can't resume coder: its conversation is not a main thread of codex that began in ${r.wsDir("north")} after the agent was created`,
      },
    ]);
    const runs = r.made.map((p) => [p.file, p.args]);
    expect(runs.some(([, a]) => (a as string[]).includes(CHILD))).toBe(false);
    expect(runs.filter(([f]) => f === bin)).toHaveLength(1);
  });
});

/** A `gemini` on the rig's PATH. */
function geminiOnPath(r: Rig): string {
  const bin = path.join(r.dir, "bin", "gemini");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bin;
}

const SESSION = "6f1c2a9e-0b3d-4c5e-8f7a-1b2c3d4e5f60";

/** A Gemini agent in north under Den's id, gone with its host. */
function geminiAgent(r: Rig, o: { interrupted?: boolean } = {}): void {
  writeRecord(r.stateDir, {
    id: "g1",
    persona: "planner",
    runtime: "gemini",
    workspace: "north",
    cwd: r.wsDir("north"),
    session: { backend: "den-pty", id: "gone-g1" },
    sessionName: "acme-north:g1",
    startedAt: "2026-11-06T09:30:00.000Z",
    launched: true,
    resumeToken: SESSION,
    ...(o.interrupted ? {} : { stoppedAt: "2026-11-06T10:30:00.000Z" }),
  } as never);
}

/** Gemini's own session file for SESSION, with `lines` after its startup line. */
function geminiSession(r: Rig, lines: unknown[]): void {
  const home = path.join(r.dir, "gemini-home");
  r.deps.env = { ...r.deps.env, GEMINI_CLI_HOME: home };
  const chats = path.join(home, ".gemini", "tmp", "north", "chats");
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(
    path.join(chats, `session-2026-11-22T10-00-${SESSION.slice(0, 8)}.jsonl`),
    [{ sessionId: SESSION, projectHash: "h", kind: "main" }, ...lines]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );
}

describe("issue 785: a Gemini agent resumes under Den's id", () => {
  it("with a reply on file: after a restart it resumes by its id", async () => {
    const r = await rig();
    const bin = geminiOnPath(r);
    geminiAgent(r, { interrupted: true });
    geminiSession(r, [{ id: "m2", type: "gemini", content: "Planned." }]);
    const found = await markInterrupted(resolveAgentsDeps(r.deps), {
      restoreAll: true,
    });
    expect(found.resumed).toEqual(["g1"]);
    expect(r.made.map((p) => [p.file, p.args])).toContainEqual([
      bin,
      ["--resume", SESSION],
    ]);
  });

  it("stopped before its first turn: after a restart it starts fresh under a new id, with the note", async () => {
    const r = await rig();
    const bin = geminiOnPath(r);
    geminiAgent(r, { interrupted: true });
    geminiSession(r, []);
    const found = await markInterrupted(resolveAgentsDeps(r.deps), {
      restoreAll: true,
    });
    expect(found.resumed).toEqual([]);
    expect(found.failed).toEqual([]);
    expect(found.startedFresh).toEqual([
      {
        agent: "g1",
        why: "gemini can't resume g1: its conversation was never written (it stopped before its first turn)",
      },
    ]);
    const runs = r.made.filter((p) => p.file === bin);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args[0]).toBe("--session-id");
    expect(runs[0]!.args[1]).not.toBe(SESSION);
    expect(readRecord(r.stateDir, "g1")?.resumeToken).toBe(runs[0]!.args[1]);
  });

  it("Resume with nothing written: a fresh start under a new id, not an error", async () => {
    const r = await rig();
    const bin = geminiOnPath(r);
    geminiAgent(r);
    expect(await agents(r, "resume", "g1")).toBe(0);
    const runs = r.made.filter((p) => p.file === bin);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args[0]).toBe("--session-id");
    expect(runs[0]!.args[1]).not.toBe(SESSION);
  });
});

describe("issue 785 with 988: an agent's own login, only from a record Den trusts", () => {
  it("runAs on a record another login could write: never honoured; Resume starts fresh under a new id", async () => {
    const r = await rig();
    const bin = geminiOnPath(r);
    geminiAgent(r);
    // The store runAs names holds a reply; Den's own env has none.
    geminiSession(r, [{ id: "m2", type: "gemini", content: "Planned." }]);
    r.deps.env = { ...r.deps.env, GEMINI_CLI_HOME: path.join(r.dir, "none") };
    const rec = readRecord(r.stateDir, "g1")!;
    writeRecord(r.stateDir, {
      ...rec,
      runAs: {
        login: "den-agents-p",
        uid: process.getuid!(),
        home: "/nowhere",
        env: { GEMINI_CLI_HOME: path.join(r.dir, "gemini-home") },
      },
    } as never);
    // Den writes records 0600; another login made this one group-writable.
    fs.chmodSync(path.join(r.stateDir, "agents", "g1.json"), 0o664);
    expect(await agents(r, "resume", "g1")).toBe(0);
    const runs = r.made.filter((p) => p.file === bin);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args[0]).toBe("--session-id");
    expect(runs[0]!.args[1]).not.toBe(SESSION);
  });

  it("runAs on Den's own record: its home's store is read", async () => {
    const r = await rig();
    const bin = geminiOnPath(r);
    geminiAgent(r, { interrupted: true });
    geminiSession(r, [{ id: "m2", type: "gemini", content: "Planned." }]);
    const rec = readRecord(r.stateDir, "g1")!;
    // Den's env points elsewhere: only runAs finds the store.
    r.deps.env = { ...r.deps.env, GEMINI_CLI_HOME: path.join(r.dir, "none") };
    writeRecord(r.stateDir, {
      ...rec,
      runAs: {
        login: "den-agents-p",
        uid: process.getuid!(),
        home: "/nowhere",
        env: { GEMINI_CLI_HOME: path.join(r.dir, "gemini-home") },
      },
    } as never);
    fs.chmodSync(path.join(r.stateDir, "agents", "g1.json"), 0o600);
    const found = await markInterrupted(resolveAgentsDeps(r.deps), {
      restoreAll: true,
    });
    expect(found.resumed).toEqual(["g1"]);
    expect(r.made.map((p) => [p.file, p.args])).toContainEqual([
      bin,
      ["--resume", SESSION],
    ]);
  });

  it("a resume keeps when the agent was created", async () => {
    const r = await rig();
    codexOnPath(r);
    coder(r, { conversation: "019a-77", cwd: r.wsDir("north"), seq: 3 });
    codexSession(r, "019a-77", r.wsDir("north"));
    expect(await agents(r, "resume", "coder")).toBe(0);
    const rec = readRecord(r.stateDir, "coder")!;
    expect(rec.createdAt).toBe("2026-11-06T09:30:00.000Z");
    expect(rec.startedAt).not.toBe("2026-11-06T09:30:00.000Z");
  });
});
