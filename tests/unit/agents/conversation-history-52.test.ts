/**
 * Issue 52, Coach slice T-a (TUNE-1): every conversation an agent has had
 * is kept, `[{ id, from, to?, why }]`, appended whenever its conversation
 * id (resumeToken) changes. Before, only a rotation kept the old id, so a
 * Start fresh or a relaunch lost it. An agent from before this is
 * backfilled from its resumeToken and its rotations. The list lives
 * beside the record, never in it.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  backfillConversations,
  conversationIds,
  nextConversations,
  type ConversationEntry,
} from "../../../src/shared/agents/conversation-history.js";
import {
  conversationsFile,
  readConversations,
  readRecord,
  removeRecord,
  writeRecord,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";

const T0 = "2026-11-01T10:00:00.000Z";
const T1 = "2026-11-02T10:00:00.000Z";
const T2 = "2026-11-03T10:00:00.000Z";
const T3 = "2026-11-04T10:00:00.000Z";

function rec(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "builder",
    workspace: "shop",
    persona: "builder",
    runtime: "den-claude",
    session: { host: "local", id: "s1" },
    sessionName: "shop-builder",
    startedAt: T0,
    ...over,
  } as AgentRecord;
}

/** Write `next` over `prev`, carrying the list along as writeRecord does. */
function step(
  list: ConversationEntry[] | null,
  prev: AgentRecord | null,
  next: AgentRecord,
  now: string,
): ConversationEntry[] {
  return nextConversations(list, prev, next, now) ?? list ?? [];
}

describe("nextConversations: a new conversation id is appended", () => {
  it("a first start records its conversation as `start`", () => {
    expect(step(null, null, rec({ resumeToken: "c1" }), T0)).toEqual([
      { id: "c1", from: T0, why: "start" },
    ]);
  });

  it("the same id again changes nothing", () => {
    const a = rec({ resumeToken: "c1" });
    const l = step(null, null, a, T0);
    expect(nextConversations(l, a, { ...a, stoppedAt: T1 }, T1)).toBeNull();
  });

  it("a Start fresh (a new id, no rotation) ends the old one and adds `fresh`", () => {
    const a = rec({ resumeToken: "c1" });
    const l = step(step(null, null, a, T0), a, { ...a, resumeToken: "c2" }, T1);
    expect(l).toEqual([
      { id: "c1", from: T0, to: T1, why: "start" },
      { id: "c2", from: T1, why: "fresh" },
    ]);
  });

  it("a relaunch from its handoff is a `rotation`", () => {
    const a = rec({ resumeToken: "c1" });
    const b = {
      ...a,
      resumeToken: "c2",
      rotations: [
        {
          at: T1,
          reason: "manual" as const,
          compactions: 3,
          conversation: "c1",
          next: "c2",
        },
      ],
    };
    expect(step(step(null, null, a, T0), a, b, T1)[1]).toEqual({
      id: "c2",
      from: T1,
      why: "rotation",
    });
  });

  it("a conversation brought in is a `bring-in`", () => {
    expect(
      step(null, null, rec({ resumeToken: "c9", broughtInAt: T0 }), T0),
    ).toEqual([{ id: "c9", from: T0, why: "bring-in" }]);
  });

  it("an agent with no conversation id yet has none", () => {
    expect(step(null, null, rec(), T0)).toEqual([]);
  });

  it("never drops an id: c1 → c2 → c1 keeps all three entries", () => {
    const a = rec({ resumeToken: "c1" });
    const b = { ...a, resumeToken: "c2" };
    let l = step(null, null, a, T0);
    l = step(l, a, b, T1);
    l = step(l, b, a, T2);
    expect(l.map((c) => c.id)).toEqual(["c1", "c2", "c1"]);
    expect(conversationIds(l)).toEqual(["c1", "c2"]);
  });
});

describe("backfillConversations: an agent from before this", () => {
  it("is rebuilt from its rotations and its resumeToken, marked backfilled", () => {
    const old = rec({
      resumeToken: "c3",
      rotations: [
        {
          at: T1,
          reason: "manual",
          compactions: 3,
          conversation: "c1",
          next: "c2",
        },
        {
          at: T2,
          reason: "manual",
          compactions: 4,
          conversation: "c2",
          next: "c3",
        },
      ],
    });
    expect(backfillConversations(old)).toEqual([
      { id: "c1", from: T0, to: T1, why: "start", backfilled: true },
      { id: "c2", from: T1, to: T2, why: "rotation", backfilled: true },
      { id: "c3", from: T2, why: "rotation", backfilled: true },
    ]);
  });

  it("a current id that no rotation started is `fresh`", () => {
    const old = rec({
      resumeToken: "c4",
      rotations: [
        {
          at: T1,
          reason: "manual",
          compactions: 3,
          conversation: "c1",
          next: "c2",
        },
      ],
    });
    expect(backfillConversations(old).map((c) => [c.id, c.why])).toEqual([
      ["c1", "start"],
      ["c2", "rotation"],
      ["c4", "fresh"],
    ]);
  });

  it("a brought-in agent starts as `bring-in`, from when it was brought in", () => {
    expect(
      backfillConversations(rec({ resumeToken: "c1", broughtInAt: T3 })),
    ).toEqual([{ id: "c1", from: T3, why: "bring-in", backfilled: true }]);
  });
});

describe("writeRecord keeps the list beside the record", () => {
  const tmp: string[] = [];
  afterEach(() => {
    for (const d of tmp.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });
  const state = () => {
    const st = fs.mkdtempSync(path.join(os.tmpdir(), "den-conv-"));
    tmp.push(st);
    return st;
  };
  const ids = (st: string) =>
    readConversations(st, readRecord(st, "builder")!).map((c) => [c.id, c.why]);

  it("the record itself never carries the list", () => {
    const st = state();
    writeRecord(st, rec({ resumeToken: "c1" }));
    writeRecord(st, rec({ resumeToken: "c2" }));
    const raw = JSON.parse(
      fs.readFileSync(path.join(st, "agents", "builder.json"), "utf-8"),
    );
    expect(raw).not.toHaveProperty("conversations");
    expect(fs.statSync(conversationsFile(st, "builder")).mode & 0o777).toBe(
      0o600,
    );
    expect(ids(st)).toEqual([
      ["c1", "start"],
      ["c2", "fresh"],
    ]);
  });

  it("an old agent is backfilled on its first write, then appended to", () => {
    const st = state();
    fs.mkdirSync(path.join(st, "agents"), { recursive: true });
    fs.writeFileSync(
      path.join(st, "agents", "builder.json"),
      JSON.stringify(rec({ resumeToken: "c1" })),
    );
    // Read before any write: backfilled, nothing written.
    expect(ids(st)).toEqual([["c1", "start"]]);
    expect(fs.existsSync(conversationsFile(st, "builder"))).toBe(false);
    writeRecord(st, { ...readRecord(st, "builder")!, resumeToken: "c2" });
    const got = readConversations(st, readRecord(st, "builder")!);
    expect(got.map((c) => [c.id, c.why, !!c.to, !!c.backfilled])).toEqual([
      ["c1", "start", true, true],
      ["c2", "fresh", false, false],
    ]);
  });

  it("a write from a caller's copy keeps the stored list", () => {
    const st = state();
    writeRecord(st, rec({ resumeToken: "c1" }));
    const copy = readRecord(st, "builder")!;
    writeRecord(st, { ...copy, resumeToken: "c2" });
    // The caller's older copy, saved for another reason (a rename).
    writeRecord(st, { ...readRecord(st, "builder")!, displayName: "Night" });
    expect(ids(st)).toEqual([
      ["c1", "start"],
      ["c2", "fresh"],
    ]);
  });

  it("an ordinary save that doesn't change the id doesn't rewrite the list", () => {
    const st = state();
    writeRecord(st, rec({ resumeToken: "c1" }));
    const f = conversationsFile(st, "builder");
    const before = fs.readFileSync(f, "utf-8");
    fs.utimesSync(f, new Date(0), new Date(0));
    writeRecord(st, { ...readRecord(st, "builder")!, stoppedAt: T1 });
    expect(fs.readFileSync(f, "utf-8")).toBe(before);
    expect(fs.statSync(f).mtimeMs).toBe(0);
  });

  it("a new agent with an earlier agent's id starts its own list", () => {
    const st = state();
    writeRecord(st, rec({ resumeToken: "old1" }));
    removeRecord(st, "builder");
    fs.rmSync(path.join(st, "removed-agents"), { recursive: true });
    writeRecord(st, rec());
    writeRecord(st, rec({ resumeToken: "new1" }));
    expect(ids(st)).toEqual([["new1", "start"]]);
  });

  it("an entry whose id isn't a conversation id (a path) is dropped; the rest stay", () => {
    const st = state();
    writeRecord(st, rec({ resumeToken: "c1" }));
    fs.writeFileSync(
      conversationsFile(st, "builder"),
      JSON.stringify([
        { id: "../../etc/passwd", from: T0, why: "start" },
        { id: "c0", from: T0, to: T1, why: "start" },
        { id: "a/b", from: T1, why: "fresh" },
        { id: "", from: T1, why: "fresh" },
        { id: "c1", from: T1, why: "nope" },
        { id: "c1", from: T1, why: "fresh" },
      ]),
    );
    expect(ids(st)).toEqual([
      ["c0", "start"],
      ["c1", "fresh"],
    ]);
  });

  it("a conversation id that isn't one is never recorded", () => {
    expect(step(null, null, rec({ resumeToken: "../x" }), T0)).toEqual([]);
  });

  it("a list file that isn't one is ignored, and the record backfills", () => {
    const st = state();
    writeRecord(st, rec({ resumeToken: "c1" }));
    fs.writeFileSync(conversationsFile(st, "builder"), '{"id": 5}');
    expect(ids(st)).toEqual([["c1", "start"]]);
  });
});
