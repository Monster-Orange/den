/**
 * #142: the bell's badge counts only what needs the person. Live, idle
 * agents (Claude Code's "waiting for your input", sent after a turn) were
 * counted; Den's own "Allow the update" ask was filed as an update; and
 * opening an agent left its updates listed. Now:
 *   permission prompt → needs you;  ask_human → needs you;
 *   a turn ending on a question to the person → needs you;
 *   plain idle → nothing new (its turn's end is already an update);
 *   Den's update ask → needs you, one at a time, gone once running;
 *   opening an agent removes its updates.
 * A temp store; fake transcripts and clock. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bellView, NotificationStore } from "../../../src/shared/notifications";
import { Attention } from "../../../src/ui/server/attention";
import * as conv from "../../../src/shared/agents/conversations";
import * as uc from "../../../src/ui/server/update-check";

let dir = "";
let clock = 1_000_000;
const asked: Record<string, string | null> = {};

function mk() {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: (id) => id,
    now: () => clock,
    hooked: () => true,
    endedAsking: async (id) => asked[id] ?? null,
  } as ConstructorParameters<typeof Attention>[0]);
  const badge = () =>
    bellView(store.list(), { off: [], foldDays: 3 }, clock).unread;
  return { store, a, badge };
}

beforeEach(() => {
  clock = 1_000_000;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-142-"));
  for (const k of Object.keys(asked)) delete asked[k];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("#142: the badge counts only what needs the person", () => {
  it("plain idle (hooked): not waiting, nothing counted", async () => {
    const { a, badge } = mk();
    await a.event("idle", "w", { event: "finished" });
    await a.event("idle", "w", {
      event: "waiting",
      why: "input",
      text: "Claude is waiting for your input",
      hooked: true,
    });
    expect([...a.waitingNow()]).toEqual([]);
    expect(badge()).toBe(0);
  });

  it("a permission prompt and an ask_human question count", async () => {
    const { a, badge } = mk();
    await a.event("p", "w", {
      event: "waiting",
      why: "permission",
      hooked: true,
    });
    await a.event("q", "w", {
      event: "waiting",
      why: "asked",
      text: "Which one?",
      hooked: true,
    });
    expect(badge()).toBe(2);
  });

  it("a turn that ended on a question to the person counts, and its idle notice doesn't undo it", async () => {
    const { a, badge } = mk();
    asked["t"] = "Shall I merge it?";
    await a.event("t", "w", { event: "finished" });
    await a.event("t", "w", { event: "waiting", why: "input", hooked: true });
    expect([...a.waitingNow()]).toEqual([["t", "asked"]]);
    expect(badge()).toBe(1);
    // The person answers: a prompt clears it.
    clock += 2_000;
    await a.event("t", "w", { event: "resumed", from: "prompt" });
    expect(badge()).toBe(0);
  });

  it("without hooks, a bell is an update, not a need", async () => {
    const store = new NotificationStore(dir, () => new Date(clock));
    const a = new Attention({
      store,
      outputMark: async () => "m",
      nameOf: (id) => id,
      now: () => clock,
      hooked: () => false,
    });
    await a.event("b", "w", { event: "waiting", why: "input" });
    expect(store.list().map((n) => n.kind)).toEqual(["finished"]);
    expect(bellView(store.list(), { off: [], foldDays: 3 }, clock).unread).toBe(
      0,
    );
  });
});

describe("#142: opening an agent removes its updates", () => {
  it("store.remove takes read and unread items out; needs-you stays", () => {
    const store = new NotificationStore(dir, () => new Date(clock));
    store.add({
      kind: "finished",
      subject: "agent:x",
      scope: "workspace/w",
      text: "x finished its turn",
    });
    store.add({
      kind: "waiting",
      subject: "agent:x",
      scope: "workspace/w",
      text: "x needs your permission",
    });
    store.markRead({ all: true } as never);
    const removed = (
      store as {
        remove?: (
          m: (n: { kind: string; subject: string }) => boolean,
        ) => number;
      }
    ).remove?.((n) => n.subject === "agent:x" && n.kind === "finished");
    expect(removed).toBe(1);
    expect(store.list().map((n) => n.kind)).toEqual(["waiting"]);
  });
});

describe("#142: Den's update ask", () => {
  const ask = (v: string) => ({
    subject: `record:den-update-${v}`,
    msg: { key: "bell.m.updateOut", vars: { v, have: "1.0.0" } },
  });
  it("is recognised, and is stale once this Den runs that version or newer", () => {
    const f = uc as {
      isUpdateAsk?: (n: unknown) => boolean;
      staleUpdateAsk?: (n: unknown, have: string) => boolean;
    };
    expect(f.isUpdateAsk?.(ask("1.2.0"))).toBe(true);
    expect(
      f.isUpdateAsk?.({
        subject: "record:den-update-1.2.0",
        msg: { key: "bell.m.updateFailed", vars: {} },
      }),
    ).toBe(false);
    expect(f.staleUpdateAsk?.(ask("1.2.0"), "1.2.0")).toBe(true);
    expect(f.staleUpdateAsk?.(ask("1.3.0"), "1.2.0")).toBe(false);
  });
});

describe("#142: lastAnswerQuestion", () => {
  const write = (lines: object[]) => {
    const f = path.join(dir, "t.jsonl");
    fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return f;
  };
  const answer = (text: string, stop = "end_turn") => ({
    type: "assistant",
    message: { stop_reason: stop, content: [{ type: "text", text }] },
  });
  const q = (f: string) =>
    (
      conv as { lastAnswerQuestion?: (f: string) => string | null }
    ).lastAnswerQuestion?.(f);
  it("the last answer's last line, when it is a question", () => {
    expect(
      q(write([answer("Done the build.\n\nShould I push it to **main**?")])),
    ).toBe("Should I push it to **main**?");
    expect(q(write([answer("Done. Pushed it.")]))).toBe(null);
    expect(q(write([answer("Which file?", "tool_use")]))).toBe(null);
    expect(
      q(
        write([
          answer("Should I?"),
          { type: "user", message: { content: "yes" } },
        ]),
      ),
    ).toBe(null);
  });
});
