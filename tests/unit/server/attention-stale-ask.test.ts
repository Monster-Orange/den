/**
 * A "waits for you" question never outlives its answer. An agent's turn
 * ended on a question (its hand-back's decision); the question was
 * answered somewhere else, and the bell went on listing it:
 *
 * - its next turn ended with no question (its hand-back says
 *   "Decisions: none"): it no longer waits, so the mark and its row go;
 * - an ask_human question stays until it is answered (the agent ends its
 *   turn to wait for that answer);
 * - the row goes when the wait ends even when the person already opened
 *   the bell (a read row), since "Needs you" lists read rows too;
 * - a turn-end question kept across a server restart is still one: the
 *   next turn ending with no question clears it.
 * A temp store; invented names.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  NotificationStore,
  bellPrefs,
  bellView,
} from "../../../src/shared/notifications";
import { Attention } from "../../../src/ui/server/attention";

let dir = "";
let clock = Date.parse("2026-01-02T03:04:05.000Z");

function mk(store = new NotificationStore(dir, () => new Date(clock))) {
  const a = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: () => "Builder",
    now: () => clock,
    hooked: () => true,
    ended: async () => new Map(),
  });
  return { store, a };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-stale-ask-"));
  clock = Date.parse("2026-01-02T03:04:05.000Z");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const waitingRows = (store: NotificationStore, agent: string) =>
  store
    .list()
    .filter((n) => n.subject === `agent:${agent}` && n.kind === "waiting");

const needsYouRows = (store: NotificationStore, agent: string) =>
  bellView(store.list(), bellPrefs(null), clock).recent.filter(
    (n) => n.subject === `agent:${agent}`,
  );

describe("a turn-end question clears when the agent no longer asks", () => {
  it("the next turn ending with no question clears the mark and its row", async () => {
    const { store, a } = mk();
    await a.event("ag-1", "web", {
      event: "finished",
      question: "1. Do you allow the sign-off at the link above?",
    });
    expect(a.waitingNow().get("ag-1")).toBe("asked");
    clock += 60_000;
    await a.event("ag-1", "web", { event: "finished" });
    expect(a.waitingNow().has("ag-1")).toBe(false);
    expect(waitingRows(store, "ag-1")).toHaveLength(0);
  });

  it("a new question at the next turn's end replaces the old one", async () => {
    const { store, a } = mk();
    await a.event("ag-1", "web", {
      event: "finished",
      question: "1. Do you allow the first sign-off?",
    });
    clock += 60_000;
    await a.event("ag-1", "web", {
      event: "finished",
      question: "1. Do you allow the second sign-off?",
    });
    expect(a.waitingNow().get("ag-1")).toBe("asked");
    const rows = waitingRows(store, "ag-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toContain("second sign-off");
  });

  it("an ask_human question stays when its turn ends", async () => {
    const { a } = mk();
    await a.event("ag-1", "web", {
      event: "waiting",
      why: "asked",
      text: "Ship it to beta now?",
    });
    clock += 5_000;
    await a.event("ag-1", "web", { event: "finished" });
    expect(a.waitingNow().get("ag-1")).toBe("asked");
  });

  it("a question kept across a restart clears at the next turn without one", async () => {
    const first = mk();
    await first.a.event("ag-1", "web", {
      event: "finished",
      question: "1. Do you allow the sign-off at the link above?",
    });
    // A new server: the row is kept, the wait is adopted from it.
    const second = mk(first.store);
    await second.a.reconcile();
    expect(second.a.waitingNow().get("ag-1")).toBe("asked");
    clock += 60_000;
    await second.a.event("ag-1", "web", { event: "finished" });
    expect(second.a.waitingNow().has("ag-1")).toBe(false);
    expect(waitingRows(first.store, "ag-1")).toHaveLength(0);
  });
});

describe("a wait's row goes with the wait, read or not", () => {
  it("an answered question leaves Needs you after the person opened the bell", async () => {
    const { store, a } = mk();
    await a.event("ag-1", "web", {
      event: "finished",
      question: "1. Do you allow the sign-off at the link above?",
    });
    store.markRead({ subject: "agent:ag-1" });
    expect(needsYouRows(store, "ag-1")).toHaveLength(1);
    a.answered("ag-1");
    expect(a.waitingNow().has("ag-1")).toBe(false);
    expect(needsYouRows(store, "ag-1")).toHaveLength(0);
  });

  it("a prompt answers it the same way", async () => {
    const { store, a } = mk();
    await a.event("ag-1", "web", {
      event: "finished",
      question: "1. Do you allow the sign-off at the link above?",
    });
    store.markRead({ all: true });
    clock += 60_000;
    await a.event("ag-1", "web", { event: "resumed", from: "prompt" });
    expect(needsYouRows(store, "ag-1")).toHaveLength(0);
  });
});

describe("the same question at the next turn's end", () => {
  it("stays one wait and one row", async () => {
    const { store, a } = mk();
    const question = "1. Do you allow the sign-off at the link above?";
    await a.event("ag-1", "web", { event: "finished", question });
    const before = waitingRows(store, "ag-1").map((n) => n.id);
    clock += 60_000;
    await a.event("ag-1", "web", { event: "finished", question });
    expect(a.waitingNow().get("ag-1")).toBe("asked");
    expect(waitingRows(store, "ag-1").map((n) => n.id)).toEqual(before);
  });
});
