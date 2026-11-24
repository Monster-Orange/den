/**
 * Issue 1369: the audit file has one writer, the web server. A process
 * outside it (the CLI, a script, an agent's `den` command) queues its
 * entry in <state>/audit/cli-queue, the one state folder an agent's
 * sandbox may write; the server takes the queue in at its start and while
 * it runs. Readers outside the server see queued entries too.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { auditConfig } from "../../../src/shared/config-audit.js";
import {
  AUDIT_QUEUE_DIR,
  readAuditRows,
  startAuditQueueIntake,
  takeQueuedAuditRows,
  type QueuedAuditRow,
} from "../../../src/shared/audit-queue.js";
import {
  recordQueuedAuditRow,
  setAuditFile,
} from "../../../src/ui/server/audit.js";

let state = "";
beforeEach(() => {
  state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-aq-")));
});
afterEach(() => {
  try {
    fs.chmodSync(state, 0o700);
  } catch {
    /* gone */
  }
  fs.rmSync(state, { recursive: true, force: true });
});

const queue = () => path.join(state, AUDIT_QUEUE_DIR);
const queued = () => {
  try {
    return fs.readdirSync(queue()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
};
const take = () => {
  const got: QueuedAuditRow[] = [];
  const r = takeQueuedAuditRows(state, (row) => got.push(row));
  return { got, ...r };
};

describe("issue 1369: a CLI audit entry is queued, never appended", () => {
  it("auditConfig outside the server: one 0600 queue entry, and no audit.jsonl written", () => {
    auditConfig({ verb: "config-write", detail: "workspaces.yml by x" }, state);
    expect(fs.existsSync(path.join(state, "audit.jsonl"))).toBe(false);
    const names = queued();
    expect(names).toHaveLength(1);
    expect(fs.statSync(path.join(queue(), names[0])).mode & 0o777).toBe(0o600);
    expect(fs.statSync(queue()).mode & 0o777).toBe(0o700);
  });

  it("inside an agent's sandbox (the state folder read-only, audit/ writable): the entry is still recorded", () => {
    fs.mkdirSync(path.join(state, "audit"), { mode: 0o700 });
    fs.chmodSync(state, 0o500);
    auditConfig(
      { verb: "agents", detail: "restart planner in north: ok" },
      state,
    );
    fs.chmodSync(state, 0o700);
    const { got } = take();
    expect(got.map((r) => r.detail)).toEqual(["restart planner in north: ok"]);
  });
});

describe("issue 1369: the server takes the queue in", () => {
  it("in the order written, with each entry's own time and who; the queue is emptied", () => {
    auditConfig({ verb: "hub-link", detail: "first" }, state);
    auditConfig(
      { verb: "agents", detail: "second", outcome: "refused", reason: "busy" },
      state,
    );
    const { got, dropped } = take();
    expect(dropped).toBe(0);
    expect(got.map((r) => [r.verb, r.detail])).toEqual([
      ["hub-link", "first"],
      ["agents", "second"],
    ]);
    expect(got[1]).toMatchObject({ outcome: "refused", reason: "busy" });
    expect(Date.parse(got[0].ts)).not.toBeNaN();
    expect(got[0].principal).toMatch(/pid \d+/);
    expect(queued()).toEqual([]);
    expect(take().got).toEqual([]);
  });

  it("an entry that isn't one is dropped, never recorded: bad JSON, an unknown verb, too big, a link, a write in progress", () => {
    fs.mkdirSync(queue(), { recursive: true, mode: 0o700 });
    const put = (n: string, body: string) =>
      fs.writeFileSync(path.join(queue(), n), body, { mode: 0o600 });
    put("1.json", "{not json");
    put(
      "2.json",
      JSON.stringify({
        ts: new Date().toISOString(),
        verb: "web-login",
        detail: "x",
      }),
    );
    put(
      "3.json",
      JSON.stringify({
        ts: new Date().toISOString(),
        verb: "agents",
        detail: "y".repeat(20000),
      }),
    );
    const outside = path.join(state, "outside.json");
    fs.writeFileSync(
      outside,
      JSON.stringify({
        ts: new Date().toISOString(),
        verb: "agents",
        detail: "z",
      }),
    );
    fs.symlinkSync(outside, path.join(queue(), "4.json"));
    put("5.json.123.abcd.tmp", "partial");
    const { got, dropped } = take();
    expect(got).toEqual([]);
    expect(dropped).toBe(4);
    // A write in progress is left for its writer to finish.
    expect(fs.readdirSync(queue())).toEqual(["5.json.123.abcd.tmp"]);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("a record that throws keeps its entry for the next pass", () => {
    auditConfig({ verb: "agents", detail: "kept" }, state);
    expect(() =>
      takeQueuedAuditRows(state, () => {
        throw new Error("disk full");
      }),
    ).not.toThrow();
    expect(queued()).toHaveLength(1);
    expect(take().got.map((r) => r.detail)).toEqual(["kept"]);
  });
});

describe("issue 1369: readers outside the server see queued entries too", () => {
  it("readAuditRows: audit.jsonl's rows, then the queue's not taken in yet", () => {
    fs.writeFileSync(
      path.join(state, "audit.jsonl"),
      JSON.stringify({
        ts: "2026-11-23T08:00:00.000Z",
        actor: "user",
        verb: "agents",
        detail: "old",
      }) + "\n",
      { mode: 0o600 },
    );
    auditConfig({ verb: "agents", detail: "new" }, state);
    expect(readAuditRows(state).map((r) => r.detail)).toEqual(["old", "new"]);
  });
});

describe("issue 1369: the running server takes in what is queued after its start", () => {
  it("at its start, then on each sweep while it runs; stop ends it", () => {
    jest.useFakeTimers();
    try {
      auditConfig({ verb: "agents", detail: "before start" }, state);
      const got: string[] = [];
      const stop = startAuditQueueIntake(state, (r) => got.push(r.detail), {
        intervalMs: 1000,
        watch: false,
      });
      expect(got).toEqual(["before start"]);
      auditConfig({ verb: "agents", detail: "while it runs" }, state);
      jest.advanceTimersByTime(1000);
      expect(got).toEqual(["before start", "while it runs"]);
      stop();
      auditConfig({ verb: "agents", detail: "after stop" }, state);
      jest.advanceTimersByTime(5000);
      expect(got).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("issue 1369: the server records a queued entry as written", () => {
  it("its own time, who and test-person path, marked as queued, in audit.jsonl", () => {
    const f = path.join(state, "audit.jsonl");
    setAuditFile(f);
    try {
      const e = recordQueuedAuditRow({
        ts: "2026-11-23T08:00:00.000Z",
        verb: "agents",
        detail: "restart planner in north: ok",
        principal: "person:p (den agents restart, pid 9)",
        via: "test-person",
      });
      expect(e).toMatchObject({
        ts: "2026-11-23T08:00:00.000Z",
        actor: "user",
        principal: "person:p (den agents restart, pid 9)",
        via: "test-person",
        queued: true,
      });
      const rows = fs
        .readFileSync(f, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(rows.at(-1)).toMatchObject({
        detail: "restart planner in north: ok",
        queued: true,
      });
    } finally {
      setAuditFile(null);
    }
  });
});
