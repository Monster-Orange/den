/**
 * Issue 828: a notice that needs the person is read by its type, not its
 * wording; a pending AskUserQuestion shows as the question it asks.
 *
 *  1. A Notification is classified by notification_type: permission_prompt
 *     → permission; elicitation_dialog, elicitation_url_dialog,
 *     agent_needs_input → needs you (a question on screen, "asked");
 *     idle_prompt → input. The wording only when the type is missing.
 *  2. A pending AskUserQuestion (its PermissionRequest) shows as its
 *     question, not as a permission for a tool named AskUserQuestion; the
 *     permission_prompt notice that comes with it doesn't replace it. A
 *     question on screen isn't sent to the lead, and its answer (the tool
 *     run, or the person's prompt) ends it.
 *  3. After a Den restart, a question on screen keeps its row, and is
 *     still ended by its answer.
 * A temp store; invented names.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NotificationStore } from "../../../src/shared/notifications";
import { attentionOf } from "../../../src/shared/agents/guardrails/attention-hook";
import { Attention, RESUME_AFTER_MS } from "../../../src/ui/server/attention";

let dir = "";
let clock = Date.parse("2026-01-02T03:04:05.000Z");
const told: string[] = [];

function mk(store = new NotificationStore(dir, () => new Date(clock))) {
  const a = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: () => "Builder",
    now: () => clock,
    hooked: () => true,
    ended: async () => new Map(),
    leadOf: async () => "lead-1",
    tellLead: async (lead: string, text: string) => {
      told.push(`${lead}: ${text}`);
      return true;
    },
  } as ConstructorParameters<typeof Attention>[0]);
  return { store, a };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-828-"));
  clock = Date.parse("2026-01-02T03:04:05.000Z");
  told.length = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const note = (notification_type: string | undefined, message: string) => ({
  hook_event_name: "Notification",
  ...(notification_type ? { notification_type } : {}),
  message,
});
const askTool = {
  hook_event_name: "PermissionRequest",
  tool_name: "AskUserQuestion",
  tool_input: {
    questions: [
      {
        question: "Ship it today?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ],
  },
};

/** The hook's event, sent as the hook sends it (JSON). */
async function send(a: Attention, input: unknown) {
  const ev = attentionOf(input);
  if (!ev) throw new Error("no event");
  return a.event("ag-1", "web", JSON.parse(JSON.stringify(ev)));
}

const waitingRows = (store: NotificationStore) =>
  store
    .list()
    .filter((n) => n.subject === "agent:ag-1" && n.kind === "waiting");

describe("issue 828, clause 1: by notification_type", () => {
  it("each type, whatever its wording", () => {
    const why = (t: string | undefined, m: string) => {
      const e = attentionOf(note(t, m));
      return e && e.event === "waiting" ? e.why : null;
    };
    expect(why("permission_prompt", "Claude needs your input")).toBe(
      "permission",
    );
    for (const t of [
      "elicitation_dialog",
      "elicitation_url_dialog",
      "agent_needs_input",
    ])
      expect([t, why(t, "Claude Code needs your input")]).toEqual([t, "asked"]);
    expect(why("idle_prompt", "Claude needs your permission")).toBe("input");
    // No type: the wording, as before.
    expect(why(undefined, "Claude needs your permission to use Bash")).toBe(
      "permission",
    );
    expect(why(undefined, "Claude is waiting for your input")).toBe("input");
  });

  it("an elicitation for an agent with hooks: it waits on its person, and the bell says so", async () => {
    const { store, a } = mk();
    await send(a, note("elicitation_dialog", "Claude Code needs your input"));
    expect(a.waitingNow().get("ag-1")).toBe("asked");
    const rows = waitingRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0].msg?.key).toBe("bell.m.asked");
    expect(rows[0].text).toContain("Claude Code needs your input");
  });
});

describe("issue 828, clause 2: AskUserQuestion is its question", () => {
  it("the PermissionRequest for AskUserQuestion reads as the question", () => {
    const e = attentionOf(askTool);
    expect(e).toMatchObject({
      event: "waiting",
      why: "asked",
      text: "Ship it today?",
    });
  });

  it("the bell shows the question; the permission notice after it doesn't replace it; no lead", async () => {
    const { store, a } = mk();
    await send(a, askTool);
    await send(
      a,
      note(
        "permission_prompt",
        "Claude needs your permission to use AskUserQuestion",
      ),
    );
    expect(a.waitingNow().get("ag-1")).toBe("asked");
    const rows = waitingRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("Builder asked: Ship it today?");
    expect(rows[0].text).not.toMatch(/permission/i);
    expect(told).toEqual([]);
  });

  it("its answer ends it: the tool's run, or the person's prompt", async () => {
    const { a } = mk();
    await send(a, askTool);
    clock += RESUME_AFTER_MS + 500;
    await send(a, {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_input: askTool.tool_input,
    });
    expect(a.waitingNow().has("ag-1")).toBe(false);

    await send(a, note("elicitation_dialog", "Claude Code needs your input"));
    clock += RESUME_AFTER_MS + 500;
    await send(a, { hook_event_name: "UserPromptSubmit" });
    expect(a.waitingNow().has("ag-1")).toBe(false);
  });

  it("an ended turn ends a question on screen (the dialog is gone)", async () => {
    const { a } = mk();
    await send(a, askTool);
    clock += 60_000;
    await a.event("ag-1", "web", { event: "finished" });
    expect(a.waitingNow().has("ag-1")).toBe(false);
  });
});

describe("issue 828, clause 3: after a restart", () => {
  it("the question's row is kept as a wait, and its answer still ends it", async () => {
    const store = new NotificationStore(dir, () => new Date(clock));
    const first = mk(store);
    await send(first.a, askTool);
    // A new server over the same store.
    clock += 60_000;
    const { a } = mk(store);
    await a.reconcile();
    expect(a.waitingNow().get("ag-1")).toBe("asked");
    expect(waitingRows(store)).toHaveLength(1);
    clock += RESUME_AFTER_MS + 500;
    await send(a, {
      hook_event_name: "PostToolUse",
      tool_name: "AskUserQuestion",
      tool_input: askTool.tool_input,
    });
    expect(a.waitingNow().has("ag-1")).toBe(false);
  });
});
