import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { NotificationStore } from "../../../src/shared/notifications";
import { Attention } from "../../../src/ui/server/attention";

let dir = "";
let clock = Date.parse("2026-01-02T03:04:05.000Z");

const start = () => {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async () => "m",
    nameOf: (id) => id,
    now: () => clock,
    hooked: () => true,
    ended: async () => new Map(),
    dialogOpen: async () => true,
  });
  return { store, a };
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1699-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const QUESTION = "Which colour, red or blue?";

describe("a wait keeps its text across a Den restart", () => {
  it("an ask: the adopted wait has the question it had before", async () => {
    const before = start();
    await before.a.event("ask", "north", {
      event: "waiting",
      why: "asked",
      text: QUESTION,
      what: QUESTION,
      dialog: true,
      hooked: true,
    });
    const was = before.a.waitingDetail("ask")?.what;
    expect(was).toBe(QUESTION);
    const after = start();
    await after.a.reconcile();
    expect(after.a.waitingDetail("ask")?.what).toBe(was);
  });

  it("a permission dialog: the adopted wait names its tool, as before", async () => {
    const before = start();
    await before.a.event("perm", "north", {
      event: "waiting",
      why: "permission",
      text: "Claude needs your permission to use Bash",
      what: "Bash",
      hooked: true,
    });
    const after = start();
    await after.a.reconcile();
    expect(after.a.waitingDetail("perm")?.what).toBe("Bash");
  });
});

describe("each kept row's own text, adopted", () => {
  const keep = (
    store: NotificationStore,
    id: string,
    text: string,
    msg?: { key: string; vars: Record<string, string | number> },
  ) =>
    store.add({
      kind: "waiting",
      subject: `agent:${id}`,
      scope: "workspace/north",
      text,
      ...(msg ? { msg } : {}),
    });

  it.each([
    [
      "bell.m.asked: the question, in text",
      `q asked: ${QUESTION}`,
      { key: "bell.m.asked", vars: { name: "q", text: QUESTION, dialog: 1 } },
      QUESTION,
    ],
    [
      "bell.m.permissionWhat: the tool, in what",
      "q needs your permission: Bash",
      { key: "bell.m.permissionWhat", vars: { name: "q", what: "Bash" } },
      "Bash",
    ],
    [
      "bell.m.permission: no text to keep",
      "q needs your permission",
      { key: "bell.m.permission", vars: { name: "q" } },
      "",
    ],
    [
      "an ask from before keys: the question, from its words",
      `q asked: ${QUESTION}`,
      undefined,
      QUESTION,
    ],
    [
      "a permission row from before keys: the tool, from its words",
      "q needs your permission: Bash",
      undefined,
      "Bash",
    ],
  ])("%s", async (_name, text, msg, what) => {
    const { store, a } = start();
    keep(store, "q", text, msg);
    await a.reconcile();
    expect(a.waitingDetail("q")?.what).toBe(what);
  });
});
