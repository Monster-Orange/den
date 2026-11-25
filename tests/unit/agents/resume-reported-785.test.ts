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

function codexOnPath(r: Rig): string {
  const bin = path.join(r.dir, "bin", "codex");
  fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return bin;
}

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
    expect(await row(r)).toMatchObject({ resumable: true });
    expect(await agents(r, "resume", "coder")).toBe(0);
    const p = r.made[r.made.length - 1];
    expect(p.file).toBe(bin);
    expect(p.args).toEqual(["resume", "019a-77"]);
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
    expect(await agents(r, "resume", "coder")).toBe(0);
    const p = r.made[r.made.length - 1];
    expect([p.file, ...p.args]).toEqual([bin, "resume", "019a-77"]);
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
    expect(runs).toContainEqual([bin, ["resume", "019a-77"]]);
    expect(
      runs.filter(([f, a]) => f === bin && (a as string[])[0] !== "resume"),
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
