/**
 * Issue 52, Coach slice T-a (TUNE-1): every conversation an agent has had
 * is on its record, `conversations: [{ id, from, to?, why }]`, appended
 * whenever its conversation id (resumeToken) changes. Before, only a
 * rotation kept the old id, so a Start fresh or a relaunch lost it. A
 * record from before this is backfilled from its resumeToken and its
 * rotations.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  backfillConversations,
  conversationIds,
  withConversations,
} from "../../../src/shared/agents/conversation-history.js";
import {
  readRecord,
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
    sessionName: "shop-builder",
    startedAt: T0,
    ...over,
  } as AgentRecord;
}

describe("withConversations: a new conversation id is appended", () => {
  it("a first start records its conversation as `start`", () => {
    const r = withConversations(null, rec({ resumeToken: "c1" }), T0);
    expect(r.conversations).toEqual([{ id: "c1", from: T0, why: "start" }]);
  });

  it("the same id again changes nothing", () => {
    const a = withConversations(null, rec({ resumeToken: "c1" }), T0);
    const b = withConversations(a, { ...a, stoppedAt: T1 }, T1);
    expect(b.conversations).toEqual(a.conversations);
  });

  it("a Start fresh (a new id, no rotation) ends the old one and adds `fresh`", () => {
    const a = withConversations(null, rec({ resumeToken: "c1" }), T0);
    const b = withConversations(a, { ...a, resumeToken: "c2" }, T1);
    expect(b.conversations).toEqual([
      { id: "c1", from: T0, to: T1, why: "start" },
      { id: "c2", from: T1, why: "fresh" },
    ]);
  });

  it("a relaunch from its handoff is a `rotation`", () => {
    const a = withConversations(null, rec({ resumeToken: "c1" }), T0);
    const b = withConversations(
      a,
      {
        ...a,
        resumeToken: "c2",
        rotations: [
          {
            at: T1,
            reason: "manual",
            compactions: 3,
            conversation: "c1",
            next: "c2",
          },
        ],
      },
      T1,
    );
    expect(b.conversations?.[1]).toEqual({
      id: "c2",
      from: T1,
      why: "rotation",
    });
  });

  it("a conversation brought in is a `bring-in`", () => {
    const r = withConversations(
      null,
      rec({ resumeToken: "c9", broughtInAt: T0 }),
      T0,
    );
    expect(r.conversations).toEqual([{ id: "c9", from: T0, why: "bring-in" }]);
  });

  it("a record with no conversation id yet records none", () => {
    expect(withConversations(null, rec(), T0).conversations).toEqual([]);
  });

  it("never drops an id: c1 → c2 → c1 keeps all three entries", () => {
    let r = withConversations(null, rec({ resumeToken: "c1" }), T0);
    r = withConversations(r, { ...r, resumeToken: "c2" }, T1);
    r = withConversations(r, { ...r, resumeToken: "c1" }, T2);
    expect(r.conversations?.map((c) => c.id)).toEqual(["c1", "c2", "c1"]);
    expect(conversationIds(r)).toEqual(["c1", "c2"]);
  });

  it("a caller's own conversations list is kept, not rebuilt", () => {
    const prev = withConversations(null, rec({ resumeToken: "c1" }), T0);
    // A caller that built the next record from an old copy, without the list.
    const { conversations: _dropped, ...stale } = prev;
    const next = withConversations(prev, { ...stale, resumeToken: "c2" }, T1);
    expect(next.conversations?.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("backfillConversations: a record from before this", () => {
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

  it("a brought-in record starts as `bring-in`, from when it was brought in", () => {
    const old = rec({ resumeToken: "c1", broughtInAt: T3 });
    expect(backfillConversations(old)).toEqual([
      { id: "c1", from: T3, why: "bring-in", backfilled: true },
    ]);
  });

  it("conversationIds reads an un-backfilled record the same way", () => {
    const old = rec({
      resumeToken: "c2",
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
    expect(conversationIds(old)).toEqual(["c1", "c2"]);
  });
});

describe("writeRecord keeps the list", () => {
  const tmp: string[] = [];
  afterEach(() => {
    for (const d of tmp.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });

  it("every write that changes the id appends to it, and an old record is backfilled on its first write", () => {
    const st = fs.mkdtempSync(path.join(os.tmpdir(), "den-conv-"));
    tmp.push(st);
    // An old record, written before the list existed.
    const dir = path.join(st, "agents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "builder.json"),
      JSON.stringify(rec({ resumeToken: "c1" })),
    );
    writeRecord(st, { ...readRecord(st, "builder")!, resumeToken: "c2" });
    const got = readRecord(st, "builder")!;
    expect(got.conversations?.map((c) => [c.id, c.why, !!c.to])).toEqual([
      ["c1", "start", true],
      ["c2", "fresh", false],
    ]);
  });
});
