/**
 * Issue 701: the agent asked its person a question and ended its turn;
 * the person answered with a Hub comment. Once that comment is typed in,
 * the question is answered: the agent's "asked" mark and its bell row
 * go. A permission dialog isn't answered by a comment. A temp store;
 * invented names.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NotificationStore } from "../../../src/shared/notifications";
import { Attention } from "../../../src/ui/server/attention";

let dir = "";
const clock = Date.parse("2026-01-02T03:04:05.000Z");

function mk() {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: () => "Designer",
    now: () => clock,
    hooked: () => true,
  });
  return { store, a };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-701-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const rows = (store: NotificationStore, agent: string) =>
  store
    .list()
    .filter((n) => n.subject === `agent:${agent}` && n.kind === "waiting");

describe("issue 701: a typed Hub comment answers the question", () => {
  it("an asked mark and its bell row go", async () => {
    const { store, a } = mk();
    await a.event("ag-1", "web", {
      event: "finished",
      question: "Do you want option D?",
    });
    expect(a.waitingNow().get("ag-1")).toBe("asked");
    expect(rows(store, "ag-1")).toHaveLength(1);
    (a as unknown as { answered: (x: string) => void }).answered("ag-1");
    expect(a.waitingNow().has("ag-1")).toBe(false);
    expect(rows(store, "ag-1")).toHaveLength(0);
  });

  it("a permission dialog stays", async () => {
    const { a } = mk();
    await a.event("ag-1", "web", {
      event: "waiting",
      why: "permission",
      what: "Bash",
      hooked: true,
    });
    (a as unknown as { answered?: (x: string) => void }).answered?.("ag-1");
    expect(a.waitingNow().get("ag-1")).toBe("permission");
  });
});
