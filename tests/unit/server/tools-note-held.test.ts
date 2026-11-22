/**
 * Issue 629: the bell item while Den's reconnected-tools note waits for
 * the agent's person: in the agent's project, one per agent, its words
 * keyed for en/es/ja.
 */
import { describe, expect, it } from "@jest/globals";
import {
  TOOLS_LIST_FAILED_SUBJECT,
  TOOLS_NOTE_HELD_SUBJECT,
  clearToolsNotesHeld,
  toolsListFailedNote,
  toolsNoteHeldNote,
} from "../../../src/ui/server/update-check.js";

describe("the tools note waits: the bell", () => {
  it("names the agent, in its project, keyed for every language", () => {
    const added: Record<string, unknown>[] = [];
    toolsNoteHeldNote(
      { add: (n) => void added.push(n as Record<string, unknown>) } as never,
      "Acme",
      "planner",
      "north",
    );
    expect(added).toEqual([
      expect.objectContaining({
        subject: `${TOOLS_NOTE_HELD_SUBJECT}:planner`,
        scope: "workspace/north",
        msg: { key: "bell.m.toolsNoteHeld", vars: { agent: "planner" } },
      }),
    ]);
    expect(String(added[0].text)).toMatch(/waits until you answer planner/);
  });
});

describe("the tools note waits: after Den restarts", () => {
  it("every waiting-note bell item is cleared (the loop that kept it is gone); others stay", () => {
    let items = [
      { subject: `${TOOLS_NOTE_HELD_SUBJECT}:planner` },
      { subject: `${TOOLS_NOTE_HELD_SUBJECT}:builder` },
      { subject: "record:something-else" },
    ];
    const store = {
      remove: (pred: (n: { subject: string }) => boolean) => {
        const before = items.length;
        items = items.filter((n) => !pred(n));
        return before - items.length;
      },
    };
    expect(clearToolsNotesHeld(store as never)).toBe(2);
    expect(items.map((n) => n.subject)).toEqual(["record:something-else"]);
  });
});

describe("issue 749: Hub's tools still didn't load after Den's one restart", () => {
  it("one bell item per agent, in its project, with the error, keyed for every language", () => {
    const added: Record<string, unknown>[] = [];
    toolsListFailedNote(
      {
        add: (n: unknown) => void added.push(n as Record<string, unknown>),
      } as never,
      "planner",
      "north",
      "listing Hub's tools failed (hub (500): Internal Server Error)",
    );
    expect(added).toEqual([
      expect.objectContaining({
        subject: `${TOOLS_LIST_FAILED_SUBJECT}:planner`,
        scope: "workspace/north",
        link: "/agents",
        msg: { key: "bell.m.toolsListFailed", vars: { agent: "planner" } },
      }),
    ]);
    expect(String(added[0].text)).toBe(
      "planner can't use Hub's tools: listing Hub's tools failed (hub (500): Internal Server Error). Den restarted it once; restart it from Agents once Hub is fixed",
    );
  });
});
