/**
 * #251: the self-update waited silently. Its server agent sat at a
 * permission prompt, so each pass recorded "waiting" and nothing told the
 * person. Now a wait says why (the log and the audit, once per reason);
 * while the server agent waits on its person the bell has one item, which
 * needs them after server_agent.update_wait_checks passes; it never goes
 * past a pending Allow. And after a self-update, a pin left uncommitted
 * for two passes is said too. Fakes only; invented versions.
 */
import { describe, expect, it } from "@jest/globals";
import {
  updateCheck,
  type UpdateCheckDeps,
  type UpdateWait,
} from "../../../src/ui/server/update-check.js";

function fake(over: Partial<UpdateCheckDeps> = {}) {
  const logs: string[] = [];
  const notes: string[] = [];
  let wait: UpdateWait | null = "permission";
  let pin: "committed" | "uncommitted" | null = "committed";
  let updates = 0;
  const d: UpdateCheckDeps = {
    running: () => "1.2.0",
    latest: async () => "1.3.0",
    pinned: () => "1.2.0",
    role: () => "lead",
    mode: () => "auto",
    cantUpdate: () => null,
    last: () => null,
    idle: async () => wait === null,
    waitWhy: async () => wait,
    waitChecks: () => 2,
    update: async () => {
      updates += 1;
      return { ok: true };
    },
    ask: () => true,
    notice: () => undefined,
    log: (l) => logs.push(l),
    waitNote: (v, why, needs) => notes.push(`wait ${v} ${why} ${needs}`),
    waitDone: () => notes.push("wait done"),
    pinState: async () => pin,
    pinNote: (v, why) => notes.push(`pin ${v} ${why}`),
    pinDone: () => notes.push("pin done"),
    ...over,
  };
  return {
    d,
    logs,
    notes,
    set: (w: UpdateWait | null) => (wait = w),
    setPin: (p: typeof pin) => (pin = p),
    updates: () => updates,
  };
}

describe("an update waiting on the server agent's person", () => {
  it("says why once, keeps one bell item that needs the person after N passes, and never updates", async () => {
    const f = fake();
    const c = updateCheck(f.d);
    const t = await c.tick();
    expect(t).toMatchObject({ did: "waiting", wait: "permission" });
    await c.tick();
    await c.tick();
    expect(f.logs).toEqual([
      "update check: Den 1.3.0 waits: the Den agent is waiting on its person's Allow",
    ]);
    expect(f.notes).toEqual([
      "wait 1.3.0 permission false",
      "wait 1.3.0 permission true",
      "wait 1.3.0 permission true",
    ]);
    expect(f.updates()).toBe(0);
  });

  it("a new reason is a new line; a mid-turn wait has no bell item", async () => {
    const f = fake();
    const c = updateCheck(f.d);
    await c.tick();
    f.set("busy");
    await c.tick();
    await c.tick();
    expect(f.logs).toEqual([
      expect.stringContaining("waiting on its person's Allow"),
      "update check: Den 1.3.0 waits: the Den agent is in the middle of a turn",
    ]);
    expect(f.notes).toEqual(["wait 1.3.0 permission false", "wait done"]);
  });

  it("a question and a held Allow wait on the person too", async () => {
    for (const w of ["asked", "approval"] as const) {
      const f = fake();
      f.set(w);
      await updateCheck(f.d).tick();
      expect(f.notes).toEqual([`wait 1.3.0 ${w} false`]);
    }
  });

  it("once the wait ends, the item goes and the update runs", async () => {
    const f = fake();
    const c = updateCheck(f.d);
    await c.tick();
    f.set(null);
    expect(await c.tick()).toEqual({ did: "updating", version: "1.3.0" });
    expect(f.notes).toEqual(["wait 1.3.0 permission false", "wait done"]);
    expect(f.updates()).toBe(1);
  });
});

describe("the pin after a self-update", () => {
  it("uncommitted two passes in a row: one log line and one bell item, naming the person's wait", async () => {
    const f = fake({ latest: async () => "1.2.0" });
    f.setPin("uncommitted");
    const c = updateCheck(f.d);
    await c.tick();
    expect(f.notes).toEqual([]);
    await c.tick();
    await c.tick();
    expect(f.logs).toEqual([
      "update check: Den 1.2.0 runs, but its pin isn't committed in the distribution's folder (the Den agent is waiting on its person's Allow)",
    ]);
    expect(f.notes).toEqual(["pin 1.2.0 permission"]);
    f.setPin("committed");
    await c.tick();
    expect(f.notes).toEqual(["pin 1.2.0 permission", "pin done"]);
    expect(f.logs[1]).toBe("update check: the pin of 1.2.0 is committed");
  });

  it("no git (can't tell): says nothing", async () => {
    const f = fake({ latest: async () => "1.2.0" });
    f.setPin(null);
    const c = updateCheck(f.d);
    await c.tick();
    await c.tick();
    expect(f.notes).toEqual([]);
    expect(f.logs).toEqual([]);
  });
});
