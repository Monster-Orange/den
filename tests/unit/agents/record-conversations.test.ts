/**
 * Issue 52 (Coach, slice T-a): every conversation an agent has had is
 * recorded on its record, `conversations: [{ id, from, to?, why }]`, appended
 * whenever it is written with a new resume token; a record from before is
 * backfilled from its resume token and its rotations. The usage report then
 * counts all of them, each call once.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  agentsDir,
  conversationsOf,
  readRecord,
  withConversations,
  writeRecord,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";
import { agentUsage } from "../../../src/shared/usage/report.js";
import { claudeCodeSource } from "../../../src/shared/usage/sources.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const T0 = "2026-11-01T10:00:00.000Z";
const T1 = "2026-11-02T10:00:00.000Z";
const T2 = "2026-11-03T10:00:00.000Z";

function rec(more: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "agent-1",
    persona: "builder",
    runtime: "den-claude",
    workspace: "notes",
    sessionName: "notes-agent-1",
    startedAt: T0,
    ...more,
  } as AgentRecord;
}

const rotation = (at: string, conversation: string, next?: string) => ({
  at,
  reason: "compactions" as never,
  compactions: 3,
  conversation,
  ...(next ? { next } : {}),
});

describe("withConversations: why each conversation began", () => {
  it("the first token is a start, from now", () => {
    const out = withConversations(null, rec({ resumeToken: A }), T0);
    expect(out.conversations).toEqual([{ id: A, from: T0, why: "start" }]);
  });

  it("a record with no token yet keeps no list", () => {
    expect(withConversations(null, rec(), T0).conversations).toBeUndefined();
  });

  it("brought in: the first conversation is a bring-in", () => {
    const out = withConversations(
      null,
      rec({ resumeToken: A, broughtInAt: T0 }),
      T0,
    );
    expect(out.conversations?.[0]).toMatchObject({ id: A, why: "bring-in" });
  });

  it("a new token with a new rotation is a rotation; the old one ends then", () => {
    const prev = withConversations(null, rec({ resumeToken: A }), T0);
    const out = withConversations(
      prev,
      rec({ resumeToken: B, rotations: [rotation(T1, A)] as never }),
      T1,
    );
    expect(out.conversations).toEqual([
      { id: A, from: T0, to: T1, why: "start" },
      { id: B, from: T1, why: "rotation" },
    ]);
  });

  it("a new token with no new rotation is a Start fresh", () => {
    const prev = withConversations(null, rec({ resumeToken: A }), T0);
    const out = withConversations(prev, rec({ resumeToken: B }), T1);
    expect(out.conversations?.map((c) => c.why)).toEqual(["start", "fresh"]);
  });

  it("the same token written again adds nothing", () => {
    const prev = withConversations(null, rec({ resumeToken: A }), T0);
    const out = withConversations(
      prev,
      rec({ resumeToken: A, stoppedAt: T1 }),
      T1,
    );
    expect(out.conversations).toEqual([{ id: A, from: T0, why: "start" }]);
  });

  it("a write that dropped the list (an older writer) keeps the stored one", () => {
    const prev = withConversations(null, rec({ resumeToken: A }), T0);
    const out = withConversations(prev, rec({ resumeToken: B }), T1);
    expect(out.conversations).toHaveLength(2);
  });
});

describe("conversationsOf: a record from before is backfilled", () => {
  it("from its rotations and its resume token, oldest first", () => {
    const old = rec({
      resumeToken: C,
      rotations: [rotation(T1, A, B), rotation(T2, B, C)] as never,
    });
    expect(conversationsOf(old)).toEqual([
      { id: A, from: T0, to: T1, why: "start", backfilled: true },
      { id: B, from: T1, to: T2, why: "rotation", backfilled: true },
      { id: C, from: T2, why: "rotation", backfilled: true },
    ]);
  });

  it("a brought-in record with no rotations: one bring-in", () => {
    expect(conversationsOf(rec({ resumeToken: A, broughtInAt: T1 }))).toEqual([
      { id: A, from: T1, why: "bring-in", backfilled: true },
    ]);
  });

  it("no token and no rotations: none", () => {
    expect(conversationsOf(rec())).toEqual([]);
  });
});

describe("writeRecord keeps the list on disk", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-convs-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a relaunch on a new token appends, and the first one ends", () => {
    writeRecord(dir, rec({ resumeToken: A }));
    writeRecord(dir, rec({ resumeToken: B }));
    const got = readRecord(dir, "agent-1")?.conversations ?? [];
    expect(got.map((c) => [c.id, c.why])).toEqual([
      [A, "start"],
      [B, "fresh"],
    ]);
    expect(got[0].to).toBeDefined();
    expect(got[1].to).toBeUndefined();
  });

  it("on upgrade: a stored record without a list is backfilled at its next write", () => {
    fs.mkdirSync(agentsDir(dir), { recursive: true });
    const old = rec({
      resumeToken: B,
      rotations: [rotation(T1, A, B)] as never,
    });
    fs.writeFileSync(
      path.join(agentsDir(dir), "agent-1.json"),
      JSON.stringify(old),
    );
    writeRecord(dir, { ...old, stoppedAt: T2 });
    expect(readRecord(dir, "agent-1")?.conversations?.map((c) => c.id)).toEqual(
      [A, B],
    );
  });
});

describe("the usage report counts every conversation, each call once", () => {
  let home = "";
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "den-convs-usage-"));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const call = (id: string) =>
    JSON.stringify({
      type: "assistant",
      timestamp: T1,
      message: {
        id,
        model: "claude-sonnet",
        usage: {
          input_tokens: 1,
          output_tokens: 10,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: "text", text: "x" }],
      },
    }) + "\n";

  it("both conversations' calls, and a call copied into the second counted once", async () => {
    const proj = path.join(home, ".claude", "projects", "-work-notes");
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, `${A}.jsonl`), call("m1") + call("m2"));
    // A resumed conversation can carry the earlier messages with it.
    fs.writeFileSync(path.join(proj, `${B}.jsonl`), call("m2") + call("m3"));
    const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") };
    const r = rec({
      resumeToken: B,
      conversations: [
        { id: A, from: T0, to: T1, why: "start" },
        { id: B, from: T1, why: "fresh" },
      ],
    });
    expect(claudeCodeSource.agentFiles(A, env)).toHaveLength(1);
    const [row] = await agentUsage([r], { env });
    expect(row.transcripts).toBe(2);
    expect(row.usage?.calls).toBe(3);
    expect(row.usage?.output).toBe(30);
  });
});
