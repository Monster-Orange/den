/**
 * Issue 142, the 11-18 repro: a real agent on a test install, its prompt
 * typed through the agents page, failed three clauses.
 *   1. Its turn ended on a question: the agent was marked waiting
 *      ("asked") but no bell item was kept, so the badge never counted it.
 *   2. A plain turn end, with "finished" on: no item at all (Updates 0).
 *   3. Opening the agent had no Updates item to remove.
 * The page had said it showed the agent (NT-2, kept 10 s), so at the
 * turn's end Den kept nothing, and nothing came after the person left.
 * Also: the turn-end hook read the transcript only on the server; Claude
 * Code's Stop hook already carries the turn's last answer
 * (`last_assistant_message`, as Den's own Stop guardrail reads it), so the
 * hook now says the question itself.
 * The hook input below is the shape Claude Code sends at a turn's end.
 * A temp store, fake clock. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "@jest/globals";
import {
  bellView,
  NotificationStore,
} from "../../../src/shared/notifications.js";
import { Attention } from "../../../src/ui/server/attention.js";
import { attentionOf } from "../../../src/shared/agents/guardrails/attention-hook.js";
import { terminalReportOnly } from "../../../src/shared/sessions/terminal-reports.js";

/** Claude Code's Stop hook input at the end of a turn. */
const stopInput = (last: string) => ({
  session_id: "0b7c2c3e-1111-4222-8333-944445555666",
  transcript_path: "/nonexistent/den-142/t.jsonl",
  cwd: "/nonexistent/den-142",
  permission_mode: "default",
  hook_event_name: "Stop",
  stop_hook_active: false,
  last_assistant_message: last,
});

let dir = "";
let clock = 1_000_000;
beforeEach(() => {
  clock = 1_000_000;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-142t-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function mk(
  endedAsking: (id: string) => Promise<string | null> = async () => null,
) {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: (id) => id,
    now: () => clock,
    hooked: () => true,
    endedAsking,
  });
  const view = () => bellView(store.list(), { off: [], foldDays: 7 }, clock);
  return { store, a, view };
}

/** What the route hands Attention for the hook's event. */
function finishedOf(input: unknown) {
  const ev = attentionOf(input);
  if (!ev || ev.event !== "finished") throw new Error("not a turn end");
  return {
    event: "finished" as const,
    text: ev.text,
    ...("question" in ev && ev.question ? { question: ev.question } : {}),
  };
}

describe("issue 142: the turn-end hook says the question it ended on", () => {
  it("a turn ending on a question carries it; a plain one doesn't", () => {
    expect(
      attentionOf(stopInput("Built it.\n\nShall I merge the branch now?")),
    ).toMatchObject({
      event: "finished",
      question: "Shall I merge the branch now?",
    });
    const plain = attentionOf(stopInput("Noted."));
    expect(plain).toMatchObject({ event: "finished" });
    expect(plain && "question" in plain ? plain.question : undefined).toBe(
      undefined,
    );
  });

  it("the question from the hook needs the person, with no transcript to read", async () => {
    const { a, view } = mk();
    await a.event(
      "q1",
      "w",
      finishedOf(stopInput("Built it.\nShall I merge the branch now?")),
    );
    expect([...a.waitingNow()]).toEqual([["q1", "asked"]]);
    expect(view().unread).toBe(1);
  });
});

describe("issue 142: the page showed the agent when its turn ended", () => {
  it("clause 1: ended on a question → a counted needs item", async () => {
    const { a, view } = mk(async () => "Shall I merge the branch now?");
    a.lookingAt(["q1"]);
    await a.event("q1", "w", { event: "finished" });
    expect([...a.waitingNow()]).toEqual([["q1", "asked"]]);
    // The person left the page: the question still waits for them.
    clock += 11_000;
    expect(view().recent.map((n) => n.kind)).toEqual(["waiting"]);
    expect(view().unread).toBe(1);
  });

  it("clause 2: a plain turn end → a finished item under Updates, not counted", async () => {
    const { a, view } = mk();
    a.lookingAt(["i1"]);
    await a.event("i1", "w", finishedOf(stopInput("Noted.")));
    // Claude Code's idle notice, 60 s on: adds nothing, undoes nothing.
    clock += 60_000;
    await a.event("i1", "w", {
      event: "waiting",
      why: "input",
      text: "Claude is waiting for your input",
      idle: true,
      hooked: true,
    });
    expect(view().updates.map((n) => n.kind)).toEqual(["finished"]);
    expect(view().unread).toBe(0);
    expect([...a.waitingNow()]).toEqual([]);
  });

  it("a permission prompt while shown still counts (no alert pops)", async () => {
    const alerts: unknown[] = [];
    const store = new NotificationStore(dir, () => new Date(clock));
    const a = new Attention({
      store,
      outputMark: async () => "m",
      nameOf: (id) => id,
      now: () => clock,
      hooked: () => true,
      alert: (n) => alerts.push(n),
    });
    a.lookingAt(["p1"]);
    await a.event("p1", "w", {
      event: "waiting",
      why: "permission",
      what: "Bash",
      hooked: true,
    });
    expect(bellView(store.list(), { off: [], foldDays: 7 }, clock).unread).toBe(
      1,
    );
    expect(alerts).toEqual([]);
  });
});

describe("issue 142: opening a pane is not the person answering", () => {
  it("xterm's own answers (focus, cursor place, its kind) are reports", () => {
    for (const s of [
      "\x1b[I",
      "\x1b[O",
      "\x1b[I\x1b[O",
      "\x1b[12;40R",
      "\x1b[?1;2c",
      "\x1b[>0;276;0c",
      "\x1b[?2004;1$y",
      "\x1b]11;rgb:0000/0000/0000\x1b\\",
      "\x1b]10;rgb:ffff/ffff/ffff\x07",
    ])
      expect(terminalReportOnly(Buffer.from(s))).toBe(true);
    for (const s of ["y", "\r", "yes\r", "\x1b[A", "\x03", "\x1b[I1\r", ""])
      expect(terminalReportOnly(Buffer.from(s))).toBe(false);
  });
});
