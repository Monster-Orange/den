/**
 * Issue 1369: the audit file has one writer, the web server. A process
 * outside it sends each entry over its own authenticated call, and the
 * server records who the credential says sent it, at its own time. Each
 * entry is first queued in <state>/audit/cli-queue (the one state folder
 * an agent's sandbox may write) and removed once sent; what is left, the
 * server takes in later as a report: unverified, never anyone's word.
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
import {
  auditConfig,
  flushAuditSends,
  setAuditSender,
  type AuditSender,
} from "../../../src/shared/config-audit.js";
import {
  AUDIT_PERSON_QUEUE_DIR,
  AUDIT_QUEUE_DIR,
  cleanLine,
  MAX_PER_PASS,
  queueAuditRow,
  readAuditRows,
  rememberSentAuditId,
  sentAuditBudget,
  startAuditQueueIntake,
  takeQueuedAuditRows,
  type CliAuditRow,
  wasSentAuditId,
  type QueuedAuditRow,
} from "../../../src/shared/audit-queue.js";
import {
  recordQueuedAuditRow,
  recordSentAuditRow,
  setAuditFile,
} from "../../../src/ui/server/audit.js";

let state = "";
beforeEach(() => {
  state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-aq-")));
  setAuditSender(null);
});
afterEach(() => {
  setAuditSender(null);
  setAuditFile(null);
  try {
    fs.chmodSync(state, 0o700);
  } catch {
    /* gone */
  }
  fs.rmSync(state, { recursive: true, force: true });
});

const queue = () => path.join(state, AUDIT_QUEUE_DIR);
const personQueue = () => path.join(state, AUDIT_PERSON_QUEUE_DIR);
const list = (d: string) => {
  try {
    return fs.readdirSync(d).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
};
/** Both queues: the person's CLI's own, and the one agents may write. */
const queued = () => [...list(personQueue()), ...list(queue())];
/** Where a queued file is, in either queue. */
const queuedPath = (n: string) =>
  fs.existsSync(path.join(personQueue(), n))
    ? path.join(personQueue(), n)
    : path.join(queue(), n);
const take = (max?: number) => {
  const got: QueuedAuditRow[] = [];
  const c = takeQueuedAuditRows(state, (row) => got.push(row), max);
  return { got, ...c };
};
const put = (name: string, body: unknown) => {
  fs.mkdirSync(queue(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(queue(), name),
    typeof body === "string" ? body : JSON.stringify(body),
    { mode: 0o600 },
  );
};
const trail = () =>
  fs
    .readFileSync(path.join(state, "audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("issue 1369: a CLI entry is sent, with a queued copy until it is", () => {
  it("no server: one 0600 queue entry, and no audit.jsonl written", () => {
    auditConfig({ verb: "config-write", detail: "workspaces.yml by x" }, state);
    expect(fs.existsSync(path.join(state, "audit.jsonl"))).toBe(false);
    expect(queued()).toHaveLength(1);
    expect(fs.statSync(queuedPath(queued()[0])).mode & 0o777).toBe(0o600);
    expect(fs.statSync(personQueue()).mode & 0o777).toBe(0o700);
  });

  it("the server up: the entry is sent (its words only, no who, no when) and the queued copy removed", async () => {
    const sent: CliAuditRow[] = [];
    setAuditSender(async (r) => {
      sent.push(r);
      return true;
    });
    auditConfig(
      {
        verb: "agents",
        detail: "stop a1 in north: stopped",
        outcome: "refused",
        reason: "busy",
      },
      state,
    );
    await flushAuditSends();
    expect(sent).toEqual([
      {
        verb: "agents",
        detail: "stop a1 in north: stopped",
        outcome: "refused",
        reason: "busy",
        id: expect.stringMatching(/^\d{15}-\d+-\d{9}-[0-9a-f]{8}$/),
      },
    ]);
    expect(queued()).toEqual([]);
  });

  it("a send no server took (down, refused, or failed): the queued copy stays", async () => {
    for (const s of [
      async () => false,
      async () => {
        throw new Error("ECONNRESET");
      },
    ] as AuditSender[]) {
      setAuditSender(s);
      auditConfig({ verb: "agents", detail: "kept" }, state);
    }
    await flushAuditSends();
    expect(queued()).toHaveLength(2);
  });

  it("inside an agent's sandbox (the state folder read-only, audit/ writable): the entry is still kept", () => {
    fs.mkdirSync(path.join(state, "audit"), { mode: 0o700 });
    fs.chmodSync(state, 0o500);
    auditConfig({ verb: "agents", detail: "restart a1 in north: ok" }, state);
    fs.chmodSync(state, 0o700);
    expect(take().got.map((r) => r.detail)).toEqual([
      "restart a1 in north: ok",
    ]);
  });
});

describe("issue 1369: a sent entry is recorded as its credential says", () => {
  it("the token's principal and the server's time; a who or a when in the body is never read", () => {
    setAuditFile(path.join(state, "audit.jsonl"));
    const body = {
      verb: "agents",
      detail: "restart a1 in north: ok",
      principal: "person:someone",
      actor: "user",
      ts: "1999-01-01T00:00:00.000Z",
    };
    const before = Date.now();
    const e = recordSentAuditRow(null, body as CliAuditRow, "agent:a1");
    expect(e.principal).toBe("agent:a1");
    expect(Date.parse(e.ts)).toBeGreaterThanOrEqual(before);
    expect(e).not.toHaveProperty("queued");
    expect(JSON.stringify(trail())).not.toContain("person:someone");
    expect(JSON.stringify(trail())).not.toContain("1999");
  });
});

describe("issue 1369: a queued entry comes in as a report, never anyone's word", () => {
  it("one claiming the person, written by an agent while the server is up: unverified, no principal, the server's time", () => {
    setAuditFile(path.join(state, "audit.jsonl"));
    put("000000000000001-1-000000000-00000000.json", {
      verb: "agents",
      detail: "restart a1 in north: ok",
      principal: "person:someone",
      actor: "user",
      at: "1999-01-01T00:00:00.000Z",
    });
    const before = Date.now();
    const { got } = take();
    const e = recordQueuedAuditRow(got[0]);
    expect(e).toMatchObject({ queued: true, unverified: true });
    expect(e.principal).toBeUndefined();
    expect(Date.parse(e.ts)).toBeGreaterThanOrEqual(before);
    expect(e.reported).toMatchObject({
      principal: "person:someone",
      at: "1999-01-01T00:00:00.000Z",
    });
    expect(typeof e.reported?.uid).toBe("number");
    expect(Date.parse(String(e.reported?.written))).not.toBeNaN();
    expect(trail().at(-1)).toMatchObject({ unverified: true, queued: true });
    expect(trail().at(-1)).not.toHaveProperty("principal");
  });

  it("control characters are stripped from what it reports and says", () => {
    put("000000000000001-1-000000000-00000000.json", {
      verb: "agents",
      detail: "ok\u001b[31m red",
      reason: "line\u0007 one\nline two",
      principal: "person:x\u001b]0;title\u0007",
    });
    const [r] = take().got;
    expect(r.detail).toBe("ok[31m red");
    expect(r.reason).toBe("line one");
    expect(r.reported.principal).toBe("person:x]0;title");
  });

  it("in the order written; the queue is emptied", () => {
    auditConfig({ verb: "hub-link", detail: "first" }, state);
    auditConfig({ verb: "agents", detail: "second" }, state);
    const { got, dropped } = take();
    expect(dropped).toBe(0);
    expect(got.map((r) => r.detail)).toEqual(["first", "second"]);
    expect(queued()).toEqual([]);
    expect(take().got).toEqual([]);
  });

  it("an entry that isn't one is dropped and counted: bad JSON, another verb, too big, a link", () => {
    put("1.json", "{not json");
    put("2.json", { verb: "web-login", detail: "x" });
    put("3.json", { verb: "agents", detail: "y".repeat(20000) });
    const outside = path.join(state, "outside.json");
    fs.writeFileSync(outside, JSON.stringify({ verb: "agents", detail: "z" }));
    fs.symlinkSync(outside, path.join(queue(), "4.json"));
    const { got, dropped } = take();
    expect(got).toEqual([]);
    expect(dropped).toBe(4);
    expect(fs.existsSync(outside)).toBe(true);
  });
});

describe("issue 1369: the intake reads and removes nothing outside the queue", () => {
  it("a link put in the queue folder's place: the link removed, the folder it named untouched", () => {
    const elsewhere = path.join(state, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(
      path.join(elsewhere, "x.json"),
      JSON.stringify({ verb: "agents", detail: "not the queue's" }),
    );
    fs.mkdirSync(path.join(state, "audit"), { mode: 0o700 });
    fs.symlinkSync(elsewhere, queue());
    const r = take();
    expect(r.got).toEqual([]);
    expect(r.refused).toBe(1);
    expect(fs.existsSync(path.join(elsewhere, "x.json"))).toBe(true);
    expect(fs.existsSync(queue())).toBe(false);
  });
});

describe("issue 1369: the intake is capped, and says what it dropped", () => {
  it("a pass takes at most its cap; the rest wait pending for the next", () => {
    for (let i = 0; i < MAX_PER_PASS + 5; i++)
      put(`${String(i).padStart(15, "0")}-1-000000000-00000000.json`, {
        verb: "agents",
        detail: `n${i}`,
      });
    const r = take();
    expect(r.taken).toBe(MAX_PER_PASS);
    expect(r.deferred).toBe(5);
    expect(take().taken).toBe(5);
  });

  it("an hour's cap across passes: the rest wait, none dropped", () => {
    jest.useFakeTimers();
    try {
      const got: string[] = [];
      const told: number[] = [];
      for (let i = 0; i < 3; i++)
        auditConfig({ verb: "agents", detail: `a${i}` }, state);
      const stop = startAuditQueueIntake(state, (r) => got.push(r.detail), {
        intervalMs: 1000,
        settleMs: 0,
        windowMs: 0,
        perHour: 2,
        onDropped: (c) => told.push(c.dropped),
      });
      // Past the hour's cap the rest wait pending; none is dropped.
      expect(got).toEqual(["a0", "a1"]);
      auditConfig({ verb: "agents", detail: "b" }, state);
      jest.advanceTimersByTime(1000);
      expect(got).toHaveLength(2);
      expect(told).toEqual([]);
      stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("the running server takes in what is queued after its start, until stopped", () => {
    jest.useFakeTimers();
    try {
      auditConfig({ verb: "agents", detail: "before start" }, state);
      const got: string[] = [];
      const stop = startAuditQueueIntake(state, (r) => got.push(r.detail), {
        intervalMs: 1000,
        settleMs: 0,
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

describe("issue 1369: readers outside the server see queued entries, as reports", () => {
  it("readAuditRows: audit.jsonl's rows, then the queue's, unverified with no principal", () => {
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
    const rows = readAuditRows(state);
    expect(rows.map((r) => r.detail)).toEqual(["old", "new"]);
    expect(rows[1]).toMatchObject({ unverified: true, queued: true });
    expect(rows[1]).not.toHaveProperty("principal");
  });
});

describe("issue 1369: a queued copy of an entry the server already took is dropped", () => {
  it("the sender sends the entry's id; a copy left behind (the CLI ended first) never comes in twice", async () => {
    const ids: string[] = [];
    // The server took it, but this process ends before removing its copy.
    setAuditSender(async (r) => {
      ids.push(String(r.id));
      rememberSentAuditId(String(r.id));
      return false;
    });
    auditConfig({ verb: "agents", detail: "once" }, state);
    await flushAuditSends();
    expect(ids).toHaveLength(1);
    expect(queued()).toEqual([`${ids[0]}.json`]);
    const got: QueuedAuditRow[] = [];
    const c = takeQueuedAuditRows(state, (row) => got.push(row), undefined, {
      seen: wasSentAuditId,
    });
    expect(got).toEqual([]);
    expect(c).toMatchObject({ taken: 0, duplicate: 1, dropped: 0 });
    expect(queued()).toEqual([]);
  });

  it("the server remembers only recent ids, and only well-formed ones", () => {
    rememberSentAuditId("not an id");
    expect(wasSentAuditId("not an id")).toBe(false);
    const first = "000000000000001-1-000000000-00000000";
    rememberSentAuditId(first);
    expect(wasSentAuditId(first)).toBe(true);
    for (let i = 0; i < 5000; i++)
      rememberSentAuditId(
        `000000000000002-1-${String(i).padStart(9, "0")}-00000000`,
      );
    expect(wasSentAuditId(first)).toBe(false);
  });
});

describe("issue 1369: a queued copy is left to settle before it's taken in", () => {
  const later = () => Date.now() + 20_000;

  it("a copy younger than the settle time waits in the server's own folder, never the queue; an older one comes in", () => {
    put("000000000000001-1-000000001-00000000.json", {
      verb: "agents",
      detail: "young",
    });
    put("000000000000001-1-000000002-00000000.json", {
      verb: "agents",
      detail: "old",
    });
    const t = new Date(Date.now() - 20_000);
    fs.utimesSync(
      path.join(queue(), "000000000000001-1-000000002-00000000.json"),
      t,
      t,
    );
    const got: QueuedAuditRow[] = [];
    const c = takeQueuedAuditRows(state, (r) => got.push(r), undefined, {
      settleMs: 15_000,
    });
    expect(got.map((r) => r.detail)).toEqual(["old"]);
    expect(c.waiting).toBe(1);
    // Nothing is put back where an agent may write.
    expect(queued()).toEqual([]);
    const next: QueuedAuditRow[] = [];
    takeQueuedAuditRows(state, (r) => next.push(r), undefined, {
      settleMs: 15_000,
      now: later(),
    });
    expect(next.map((r) => r.detail)).toEqual(["young"]);
  });

  it("the server up and the send taken: one entry; the send failed: the report, after the settle", async () => {
    setAuditSender(async () => true);
    auditConfig({ verb: "agents", detail: "sent" }, state);
    await flushAuditSends();
    setAuditSender(async () => false);
    auditConfig({ verb: "agents", detail: "not sent" }, state);
    await flushAuditSends();
    const first: string[] = [];
    takeQueuedAuditRows(state, (r) => first.push(r.detail), undefined, {
      settleMs: 15_000,
    });
    expect(first).toEqual([]);
    const next: string[] = [];
    takeQueuedAuditRows(state, (r) => next.push(r.detail), undefined, {
      settleMs: 15_000,
      now: later(),
    });
    expect(next).toEqual(["not sent"]);
  });

  it("a copy taken in while its send is on the way: dropped as the duplicate it is, once settled", () => {
    const id = queueAuditRow(state, { verb: "agents", detail: "racing" });
    takeQueuedAuditRows(state, () => undefined, undefined, {
      settleMs: 15_000,
    });
    // The send lands after the intake moved the copy.
    rememberSentAuditId(id);
    const got: string[] = [];
    const c = takeQueuedAuditRows(state, (r) => got.push(r.detail), undefined, {
      settleMs: 15_000,
      now: later(),
      seen: wasSentAuditId,
    });
    expect(got).toEqual([]);
    expect(c.duplicate).toBe(1);
  });

  it("a copy whose writer set its time in the future is settled at once, never left to wait", () => {
    put("000000000000001-1-000000001-00000000.json", {
      verb: "agents",
      detail: "future",
    });
    const t = new Date(Date.now() + 10 * 365 * 86_400_000);
    fs.utimesSync(
      path.join(queue(), "000000000000001-1-000000001-00000000.json"),
      t,
      t,
    );
    const got: string[] = [];
    const c = takeQueuedAuditRows(state, (r) => got.push(r.detail), undefined, {
      settleMs: 15_000,
    });
    expect(got).toEqual(["future"]);
    expect(c.waiting).toBe(0);
  });

  it("a folder named like an entry is dropped, and the entries after it still come in", () => {
    fs.mkdirSync(
      path.join(queue(), "000000000000001-1-000000001-00000000.json"),
      {
        recursive: true,
      },
    );
    put("000000000000001-1-000000002-00000000.json", {
      verb: "agents",
      detail: "after",
    });
    const got: string[] = [];
    const c = takeQueuedAuditRows(state, (r) => got.push(r.detail));
    expect(got).toEqual(["after"]);
    expect(c.dropped).toBe(1);
  });

  it("the queue folder swapped for a link while entries wait: nothing is ever written through it", () => {
    const outside = path.join(state, "outside");
    fs.mkdirSync(outside);
    put("000000000000001-1-000000001-00000000.json", {
      verb: "agents",
      detail: "young",
    });
    put("000000000000001-1-000000002-00000000.json", {
      verb: "agents",
      detail: "old",
    });
    const t = new Date(Date.now() - 20_000);
    fs.utimesSync(
      path.join(queue(), "000000000000001-1-000000002-00000000.json"),
      t,
      t,
    );
    // An agent swaps the queue for a link mid-pass (as an entry is recorded).
    const swap = () => {
      fs.rmSync(queue(), { recursive: true, force: true });
      fs.symlinkSync(outside, queue());
    };
    takeQueuedAuditRows(state, swap, undefined, { settleMs: 15_000 });
    // After its move, the pass never goes back to the queue's path: the
    // link is as the agent left it, and nothing went through it.
    expect(fs.lstatSync(queue()).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    swap();
    takeQueuedAuditRows(state, () => undefined, undefined, {
      settleMs: 15_000,
      now: later(),
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe("issue 1369: what the intake drops is told once a window, summed", () => {
  it("50 passes each dropping one bad file: one note, with 50", () => {
    jest.useFakeTimers();
    try {
      const told: number[] = [];
      let t = 1_000_000;
      const stop = startAuditQueueIntake(state, () => undefined, {
        intervalMs: 1000,
        settleMs: 0,
        windowMs: 600_000,
        now: () => t,
        onDropped: (c) => told.push(c.dropped),
      });
      for (let i = 0; i < 50; i++) {
        put(`${String(i).padStart(15, "0")}-1-000000000-00000000.json`, "{bad");
        t += 1000;
        jest.advanceTimersByTime(1000);
      }
      expect(told).toEqual([]);
      t += 600_000;
      jest.advanceTimersByTime(1000);
      expect(told).toEqual([50]);
      stop();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("issue 1369: one sender's entries are capped an hour", () => {
  it("past the cap, the server takes no more from that principal this hour; another's still come in", () => {
    const budget = sentAuditBudget(3);
    const t0 = 5_000_000;
    expect([1, 2, 3, 4].map(() => budget("agent:a1", t0))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(budget("agent:a2", t0)).toBe(true);
    expect(budget("agent:a1", t0 + 3_600_000)).toBe(true);
  });
});

describe("issue 1369: the person's CLI queues where agents can't write", () => {
  it("outside a sandbox: the person's own queue, and nothing in the one agents may write", () => {
    auditConfig({ verb: "agents", detail: "person" }, state);
    expect(list(personQueue())).toHaveLength(1);
    expect(list(queue())).toEqual([]);
  });

  it("inside an agent's sandbox (state read-only, audit/ writable): the agents' queue", () => {
    fs.mkdirSync(path.join(state, "audit"), { mode: 0o700 });
    fs.chmodSync(state, 0o500);
    try {
      auditConfig({ verb: "agents", detail: "agent" }, state);
    } finally {
      fs.chmodSync(state, 0o700);
    }
    expect(list(personQueue())).toEqual([]);
    expect(list(queue())).toHaveLength(1);
  });
});

describe("issue 1369: nothing is removed unread, and the server's arrival orders the take", () => {
  const big = (i: number) =>
    put(`000000000000000-1-${String(i).padStart(9, "0")}-00000000.json`, {
      verb: "agents",
      detail: "x".repeat(3900),
      reason: "y".repeat(290),
    });

  it("an agent filling a pass with large entries erases nothing: every entry comes in over later passes, the person's too", () => {
    for (let i = 0; i < 80; i++) big(i);
    auditConfig({ verb: "agents", detail: "the person's" }, state);
    const got: string[] = [];
    let dropped = 0;
    for (let p = 0; p < 10; p++) {
      const c = takeQueuedAuditRows(state, (r) => got.push(r.detail));
      dropped += c.dropped;
    }
    expect(dropped).toBe(0);
    expect(got).toHaveLength(81);
    expect(got).toContain("the person's");
  });

  it("an entry that arrived first is taken first, whatever name a later one has", () => {
    auditConfig({ verb: "agents", detail: "first" }, state);
    // Moved in, none taken (the hour's cap reached).
    takeQueuedAuditRows(state, () => undefined, 0);
    put("000000000000000-1-000000000-00000000.json", {
      verb: "agents",
      detail: "later, named to sort first",
    });
    const got: string[] = [];
    takeQueuedAuditRows(state, (r) => got.push(r.detail), 10);
    takeQueuedAuditRows(state, (r) => got.push(r.detail), 10);
    expect(got).toEqual(["first", "later, named to sort first"]);
  });

  it("a name that isn't an entry's id is dropped, counted, never taken", () => {
    put("evil.json", { verb: "agents", detail: "no id" });
    const got: string[] = [];
    const c = takeQueuedAuditRows(state, (r) => got.push(r.detail));
    expect(got).toEqual([]);
    expect(c.dropped).toBe(1);
  });

  it("pending full: the queue is left where it is, not dropped", () => {
    for (let i = 0; i < 3; i++) big(i);
    takeQueuedAuditRows(state, () => undefined, 0, { maxPending: 2 });
    big(10);
    const c = takeQueuedAuditRows(state, () => undefined, 0, {
      maxPending: 2,
    });
    expect(c.full).toBe(1);
    expect(list(queue())).toEqual([
      "000000000000000-1-000000010-00000000.json",
    ]);
    // Room again: all four come in, none lost.
    const got: string[] = [];
    for (let p = 0; p < 6; p++)
      takeQueuedAuditRows(state, (r) => got.push(r.detail), 200, {
        maxPending: 2,
      });
    expect(got).toHaveLength(4);
  });

  it("a pass reads a bounded number of names; the rest wait in the server's folder for later passes", () => {
    for (let i = 0; i < 120; i++)
      put(`000000000000000-1-${String(i).padStart(9, "0")}-00000000.json`, {
        verb: "agents",
        detail: String(i),
      });
    const got: string[] = [];
    const c = takeQueuedAuditRows(state, (r) => got.push(r.detail), 200, {
      scanPerPass: 50,
    });
    expect(c.taken).toBeLessThanOrEqual(50);
    for (let p = 0; p < 4; p++)
      takeQueuedAuditRows(state, (r) => got.push(r.detail), 200, {
        scanPerPass: 50,
      });
    expect(got).toHaveLength(120);
  });
});

describe("issue 1369: what an entry says is one plain line", () => {
  it("line and paragraph separators, C1, format and bidi controls are stripped", () => {
    expect(cleanLine("a\u2028b", 100)).toBe("a");
    expect(cleanLine("ok\u202e\u200bfine\u0085x", 100)).toBe("okfine");
    expect(cleanLine("tab\there", 100)).toBe("tabhere");
  });
});
