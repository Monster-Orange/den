/**
 * NT-1 / NT-2 / NT-3b: attention events, the waiting mark, and the
 * notifications they make. A temp store; fake output marks and clock.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NotificationStore } from "../../../src/shared/notifications";
import { Attention } from "../../../src/ui/server/attention";

let dir = "";
let clock = 1_000_000;
const marks: Record<string, string | null> = {};

function mk() {
  const store = new NotificationStore(dir, () => new Date(clock));
  const a = new Attention({
    store,
    outputMark: async (id) => marks[id] ?? null,
    nameOf: (id) => (id === "ag-1" ? "Planner" : id),
    now: () => clock,
    lookingMs: 10_000,
  });
  return { store, a };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-att-"));
  clock = 1_000_000;
  for (const k of Object.keys(marks)) delete marks[k];
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("attention", () => {
  it("waiting: marked, and a notification that links to the agent", async () => {
    const { store, a } = mk();
    marks["ag-1"] = "m1";
    await a.event("ag-1", "web", { event: "waiting", why: "permission" });
    expect([...a.waitingNow()]).toEqual([["ag-1", "permission"]]);
    const [n] = store.list();
    expect(n).toMatchObject({
      kind: "waiting",
      subject: "agent:ag-1",
      scope: "workspace/web",
      text: "Planner needs your permission",
      link: "/agents?ws=web&agent=ag-1",
      read: false,
    });
  });

  it("its output moves (answered, or it went on): no longer waiting, notification withdrawn", async () => {
    const { store, a } = mk();
    marks["ag-1"] = "m1";
    await a.event("ag-1", "web", { event: "waiting", why: "input" });
    await a.check();
    expect(a.waitingNow().size).toBe(1);
    marks["ag-1"] = "m2";
    await a.check();
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("finished: a finished notification; any waiting mark goes", async () => {
    const { store, a } = mk();
    await a.event("ag-1", "web", { event: "waiting", why: "input" });
    await a.event("ag-1", "web", { event: "finished" });
    expect(a.waitingNow().size).toBe(0);
    expect(store.list().map((n) => [n.kind, n.text])).toEqual([
      ["finished", "Planner finished its turn"],
    ]);
  });

  it("NT-2: on screen, no notification (still marked); off screen after 10 s, one", async () => {
    const { store, a } = mk();
    a.lookingAt(["ag-1"]);
    await a.event("ag-1", "web", { event: "waiting", why: "input" });
    expect(a.waitingNow().size).toBe(1);
    expect(store.list()).toEqual([]);
    clock += 11_000;
    await a.event("ag-1", "web", { event: "finished" });
    expect(store.list().map((n) => n.kind)).toEqual(["finished"]);
  });

  it("asked (den_notify): its question in the text; gone() clears", async () => {
    const { store, a } = mk();
    await a.event("ag-1", "web", {
      event: "waiting",
      why: "asked",
      text: "Which branch?",
    });
    expect(store.list()[0].text).toBe("Planner asked: Which branch?");
    a.gone("ag-1");
    expect(a.waitingNow().size).toBe(0);
    expect(store.list()).toEqual([]);
  });
});
