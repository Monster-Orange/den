/**
 * P0-D4: Den logs every Hub delivery it types or passes over: the time,
 * the delivery, the agent, its kind, the doc's link or held id, and the
 * outcome. Never a body, a name or a token. The file is JSON lines,
 * 0600, capped; doctor sums the last 24 h of it.
 *
 * The loop's own events (received, typed, done, held, refused, repeat,
 * passed over, failed) come through its `journal` hook. A fake Hub and
 * fake agents. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SeenDeliveries,
  LOCAL_PREFIX,
} from "../../../src/shared/hub/hub-delivery";
import {
  DeliveryLoop,
  type AgentState,
  type DeliveryHub,
} from "../../../src/shared/hub/hub-delivery-loop";
import {
  appendJournal,
  journalSummary,
  type JournalEntry,
} from "../../../src/shared/hub/hub-delivery-journal";
import { hubDeliveryLines } from "../../../src/ui/cli/doctor-command";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-d4-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const HELD = "0a1b2c3d-1111-4222-8333-944455556666";
const SECRET = "hubi_TESTONLY_never_logged";
const raw = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  agent: "ag-1",
  project: "web",
  thread: {
    kind: "comment",
    id: `th_${id}`,
    url: "https://hub.example.test/a/doc",
    artifact: "Pricing page",
  },
  author: {
    id: "u_me",
    login: "pat",
    name: "Pat Example",
    kind: "person",
    verified: "hub_session",
  },
  body: `Make it shorter. ${SECRET} held ${HELD}`,
  created_at: "2026-11-12T18:00:00Z",
  ...o,
});

function setup(state: { s: AgentState }) {
  const events: JournalEntry[] = [];
  const hub: DeliveryHub = {
    stream: () => {
      throw Object.assign(new Error("no stream"), { kind: "refused" });
    },
    list: async () => [],
    ack: async () => undefined,
  };
  const loop = new DeliveryLoop({
    hub,
    agents: {
      state: async (a: string) => (a === "ag-1" ? state.s : "missing"),
      why: async () => null,
      type: async () => true,
    },
    owner: () => ({ ownerId: "u_me", company: "Acme" }),
    seen: new SeenDeliveries(path.join(dir, "seen.json")),
    journal: (e: JournalEntry) => events.push(e),
  } as ConstructorParameters<typeof DeliveryLoop>[0]);
  return { loop, events };
}
const outcomes = (ev: JournalEntry[], id: string) =>
  ev.filter((e) => e.id === id).map((e) => e.outcome);

describe("P0-D4: the loop says what happened to each delivery", () => {
  it("received, held while busy (once per reason), typed, then done", async () => {
    const st = { s: "busy" as AgentState };
    const { loop, events } = setup(st);
    await loop.take(raw("d1", { kind: "approve", version: 3 }));
    await loop.pump();
    await loop.pump();
    st.s = "idle";
    await loop.pump();
    st.s = "busy";
    await loop.pump();
    st.s = "idle";
    await loop.pump();
    expect(outcomes(events, "d1")).toEqual([
      "received",
      "held",
      "typed",
      "done",
    ]);
    const r = events.find((e) => e.outcome === "received")!;
    expect(r).toMatchObject({
      agent: "ag-1",
      kind: "approve",
      version: 3,
      thread: "th_d1",
      url: "https://hub.example.test/a/doc",
      held: [HELD],
    });
    expect(Date.parse(r.at)).not.toBeNaN();
    expect(events.find((e) => e.outcome === "held")?.why).toBe("busy");
  });

  it("a repeat, an agent that isn't here, and an inbox item passed over", async () => {
    const { loop, events } = setup({ s: "busy" });
    await loop.take(raw("d2"));
    await loop.take(raw("d2"));
    await loop.take(raw("d3", { agent: "gone" }));
    loop.passLocal(`${LOCAL_PREFIX}x1`);
    expect(outcomes(events, "d2")).toEqual(["received", "held", "repeat"]);
    expect(outcomes(events, "d3")).toEqual(["received", "refused"]);
    expect(outcomes(events, `${LOCAL_PREFIX}x1`)).toEqual(["passed"]);
  });

  it("a typed one whose agent stops: failed", async () => {
    const st = { s: "idle" as AgentState };
    const { loop, events } = setup(st);
    await loop.take(raw("d4"));
    await loop.pump();
    st.s = "stopped";
    await loop.pump();
    expect(outcomes(events, "d4")).toEqual(["received", "typed", "failed"]);
  });

  it("never a body, a name or a token", async () => {
    const st = { s: "idle" as AgentState };
    const { loop, events } = setup(st);
    await loop.take(raw("d5"));
    await loop.pump();
    const all = JSON.stringify(events);
    for (const x of [
      SECRET,
      "Make it shorter",
      "Pat Example",
      "pat",
      "Pricing page",
    ])
      expect([x, all.includes(x)]).toEqual([x, false]);
  });
});

describe("P0-D4: the file", () => {
  const e = (
    id: string,
    outcome: JournalEntry["outcome"],
    at: string,
  ): JournalEntry => ({
    at,
    id,
    agent: "ag-1",
    outcome,
  });

  it("JSON lines, 0600, one per entry", () => {
    const f = path.join(dir, "hub", "deliveries.jsonl");
    appendJournal(f, e("d1", "typed", "2026-11-12T18:00:00.000Z"));
    appendJournal(f, e("d2", "held", "2026-11-12T18:01:00.000Z"));
    const lines = fs.readFileSync(f, "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).id)).toEqual(["d1", "d2"]);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it("capped: past its size it keeps the newer half", () => {
    const f = path.join(dir, "deliveries.jsonl");
    for (let i = 0; i < 300; i++)
      appendJournal(f, e(`d${i}`, "typed", "2026-11-12T18:00:00.000Z"), 10_000);
    const ids = fs
      .readFileSync(f, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).id);
    expect(fs.statSync(f).size).toBeLessThanOrEqual(10_000);
    expect(ids.at(-1)).toBe("d299");
    expect(ids[0]).not.toBe("d0");
  });

  it("the cap counts bytes, not characters", () => {
    const f = path.join(dir, "wide.jsonl");
    const wide = (id: string): JournalEntry => ({
      ...e(id, "typed", "2026-11-12T18:00:00.000Z"),
      agent: "エージェント".repeat(100),
    });
    let most = 0;
    for (let i = 0; i < 200; i++) {
      appendJournal(f, wide(`w${i}`), 9_000);
      most = Math.max(most, fs.statSync(f).size);
    }
    expect(most).toBeLessThanOrEqual(9_000);
  });

  it("doctor: the last 24 h by outcome, the last typed, and where the file is", () => {
    const f = path.join(dir, "deliveries.jsonl");
    const now = Date.parse("2026-11-13T12:00:00.000Z");
    appendJournal(f, e("old", "typed", "2026-11-11T12:00:00.000Z"));
    appendJournal(f, e("d1", "typed", "2026-11-13T11:00:00.000Z"));
    appendJournal(f, e("d2", "held", "2026-11-13T11:10:00.000Z"));
    appendJournal(f, e("d3", "passed", "2026-11-13T11:20:00.000Z"));
    appendJournal(f, e("d1", "done", "2026-11-13T11:30:00.000Z"));
    fs.appendFileSync(f, "not json\n");
    const s = journalSummary(f, now);
    expect(s).toMatchObject({
      counts: { typed: 1, held: 1, passed: 1, done: 1 },
      lastTypedAt: Date.parse("2026-11-13T11:00:00.000Z"),
      file: f,
    });
    const row = hubDeliveryLines(
      {
        url: null,
        streamOpen: true,
        lastOkAt: now,
        lastDeliveryAt: now,
      } as never,
      now,
      15,
      s,
    );
    expect(row.lines[0]).toContain(
      "last 24 h: 1 typed, 1 done, 1 held, 1 passed over",
    );
    expect(row.lines[0]).toContain(f);
    expect(journalSummary(path.join(dir, "none.jsonl"), now)).toBeNull();
  });
});
