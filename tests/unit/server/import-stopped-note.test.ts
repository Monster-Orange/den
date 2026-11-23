/**
 * Issue 159: a hand-over that stops (no hand-off in time, a terminal that
 * won't close, a bring-in that fails) reaches the person in the bell, one
 * key per case so each language says it as a sentence.
 */
import { describe, expect, it } from "@jest/globals";
import { noteImportStopped } from "../../../src/ui/server/agent-routes.js";
import type { HandoverFailCode } from "../../../src/shared/agents/import-handover.js";

function store() {
  const items: Record<string, unknown>[] = [];
  return { items, add: (n: Record<string, unknown>) => (items.push(n), null) };
}

describe("issue 159: the bell's note when a hand-over stops", () => {
  const codes: HandoverFailCode[] = [
    "noHandoff",
    "unknownHolder",
    "wontClose",
    "importFailed",
  ];

  it.each(codes)(
    "%s: one note on the project, its own key, its words",
    (code) => {
      const s = store();
      noteImportStopped(
        s as never,
        {
          code,
          text: `Bringing in conversation c1 as agent planner stopped (${code}).`,
          vars: { session: "c1", agent: "planner", file: "/f/handoff.md" },
        },
        "north",
      );
      expect(s.items).toEqual([
        expect.objectContaining({
          kind: "service",
          scope: "workspace/north",
          subject: "record:import-c1",
          text: `Bringing in conversation c1 as agent planner stopped (${code}).`,
          msg: {
            key: `bell.m.import${code[0].toUpperCase()}${code.slice(1)}`,
            vars: { session: "c1", agent: "planner", file: "/f/handoff.md" },
          },
          link: "/agents",
        }),
      ]);
    },
  );
});
