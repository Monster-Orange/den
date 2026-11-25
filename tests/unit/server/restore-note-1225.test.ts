/**
 * Issue 1225: after a restart, the bell says how many services came back,
 * and names each one that didn't with its reason, in the person's language
 * (a key and its values; `text` is the English). Nothing to say: no item.
 * Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  RESTORE_NOTE_SUBJECT,
  restoreNote,
} from "../../../src/ui/server/restore-note.js";

type Added = Parameters<Parameters<typeof restoreNote>[0]["add"]>[0];

function store() {
  const added: Added[] = [];
  return { added, add: (n: Added) => (added.push(n), null) };
}

describe("issue 1225: the bell after a restart", () => {
  it("two came back: one service item, in the person's language", () => {
    const s = store();
    restoreNote(s, {
      brought: ["kiosk/web", "ledger/api"],
      failedServices: [],
    });
    expect(s.added).toEqual([
      {
        kind: "service",
        subject: RESTORE_NOTE_SUBJECT,
        scope: "workspace/den-server",
        text: "Brought back 2 services after the restart.",
        msg: { key: "bell.m.servicesBack", vars: { n: "2" } },
        link: "/services",
      },
    ]);
  });

  it("one came back and one didn't: the failure is named with its reason", () => {
    const s = store();
    restoreNote(s, {
      brought: ["ledger/api"],
      failedServices: [{ address: "kiosk/web", why: "exit 1" }],
    });
    expect(s.added[0]!.msg).toEqual({
      key: "bell.m.serviceBackFailed",
      vars: { n: "1", failed: "kiosk/web (exit 1)" },
    });
    expect(s.added[0]!.text).toContain("kiosk/web (exit 1)");
  });

  it("nothing to bring back: no item", () => {
    const s = store();
    restoreNote(s, { brought: [], failedServices: [] });
    expect(s.added).toEqual([]);
  });
});
