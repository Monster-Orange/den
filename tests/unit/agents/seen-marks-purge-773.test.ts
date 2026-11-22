/**
 * Issue 773: a removed agent's seen marks go when its record is purged
 * for good (marks.json never keeps every agent ever removed). Within the
 * undo window they stay, so Undo brings it back as it was.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  purgeRemoved,
  removeRecord,
  restoreRecord,
  writeRecord,
  type AgentRecord,
} from "../../../src/shared/agents/records.js";
import { SeenMarks, agentSeenSubject } from "../../../src/shared/seen-mark.js";

let st = "";
beforeEach(() => {
  st = fs.mkdtempSync(path.join(os.tmpdir(), "seen-purge-"));
});
afterEach(() => {
  fs.rmSync(st, { recursive: true, force: true });
});

const rec = (id: string): AgentRecord =>
  ({
    id,
    workspace: "shop",
    persona: "builder",
    runtime: "den-claude",
    session: { host: "local", id: `s-${id}` },
    sessionName: `shop-${id}`,
    startedAt: "2026-11-20T10:00:00.000Z",
  }) as AgentRecord;

function finishedAndSeen(id: string): SeenMarks {
  const m = new SeenMarks(st);
  const subject = agentSeenSubject(id);
  m.noteVersion(subject, "1", "2026-11-20T10:05:00.000Z");
  m.markSeen({ subject, person: "person:a" });
  return m;
}

describe("issue 773: seen marks of a removed agent", () => {
  it("stay within the undo window: Undo brings the agent back as it was", () => {
    writeRecord(st, rec("builder"));
    finishedAndSeen("builder");
    expect(removeRecord(st, "builder")).toBe(true);
    purgeRemoved(st); // inside the window: nothing purged
    expect(
      new SeenMarks(st).latest(agentSeenSubject("builder")),
    ).not.toBeNull();
    expect(restoreRecord(st, "builder")).toBe(true);
  });

  it("go when the record is purged for good; other agents keep theirs", () => {
    writeRecord(st, rec("builder"));
    writeRecord(st, rec("scribe"));
    finishedAndSeen("builder");
    finishedAndSeen("scribe");
    removeRecord(st, "builder");
    purgeRemoved(st, 0, Date.now() + 1000);
    const m = new SeenMarks(st);
    expect(m.latest(agentSeenSubject("builder"))).toBeNull();
    expect(m.seenVersion(agentSeenSubject("builder"), "person:a")).toBeNull();
    expect(m.latest(agentSeenSubject("scribe"))).not.toBeNull();
  });
});
