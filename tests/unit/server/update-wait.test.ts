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
import * as fs from "fs";
import * as path from "path";
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
  it("uncommitted past server_agent.pin_commit_wait_minutes: the note again once, then one log line and one bell item, naming the person's wait", async () => {
    let clock = Date.parse("2026-11-19T10:00:00Z");
    const MIN = 60_000;
    const resent: string[] = [];
    const pins: string[] = [];
    const f = fake({
      latest: async () => "1.2.0",
      now: () => clock,
      pinWaitMs: () => 60 * MIN,
      // Came back on 1.2.0 (verified) at 10:00.
      last: () => ({
        state: "good",
        from: "1.1.0",
        to: "1.2.0",
        at: "2026-11-19T10:00:00Z",
      }),
      pinResend: async (v, min) => void resent.push(`${v} ${min}`),
      pinNote: (v, why, info) =>
        void pins.push(`pin ${v} ${why} ${info?.minutes}`),
      pinDone: () => void pins.push("pin done"),
    });
    f.setPin("uncommitted");
    const c = updateCheck(f.d);
    await c.tick();
    clock += 30 * MIN;
    await c.tick();
    expect(resent).toEqual([]);
    expect(c.pinStatus()).toMatchObject({
      version: "1.2.0",
      since: "2026-11-19T10:00:00.000Z",
    });
    clock += 30 * MIN; // 60 min: the note again, once
    await c.tick();
    await c.tick();
    expect(resent).toEqual(["1.2.0 60"]);
    expect(pins).toEqual([]);
    expect(f.logs).toEqual([
      "update check: Den 1.2.0 runs, but its pin isn't committed 60 min after the update: the Den agent is told again",
    ]);
    clock += 60 * MIN; // 60 min after the note again: the bell
    await c.tick();
    await c.tick();
    expect(f.logs[1]).toBe(
      "update check: Den 1.2.0 runs, but its pin isn't committed in the distribution's folder 120 min after the update, after the Den agent was told twice (the Den agent is waiting on its person's Allow)",
    );
    expect(pins).toEqual(["pin 1.2.0 permission 120"]);
    expect(c.pinStatus()).toMatchObject({
      version: "1.2.0",
      resent: expect.any(String),
      flagged: expect.any(String),
      minutes: 120,
    });
    f.setPin("committed");
    await c.tick();
    expect(pins).toEqual(["pin 1.2.0 permission 120", "pin done"]);
    expect(f.logs[2]).toBe("update check: the pin of 1.2.0 is committed");
    expect(c.pinStatus()).toBeNull();
  });

  it("a restart in between doesn't send the note again (the state carries over)", async () => {
    const MIN = 60_000;
    let clock = Date.parse("2026-11-19T12:00:00Z");
    const resent: string[] = [];
    const f = fake({
      latest: async () => "1.2.0",
      now: () => clock,
      pinWaitMs: () => 60 * MIN,
      pinBefore: () => ({
        version: "1.2.0",
        since: "2026-11-19T10:00:00.000Z",
        resent: "2026-11-19T11:30:00.000Z",
      }),
      pinResend: async (v) => void resent.push(v),
    });
    f.setPin("uncommitted");
    const c = updateCheck(f.d);
    await c.tick();
    expect(resent).toEqual([]);
    clock += 30 * MIN;
    await c.tick();
    expect(f.notes).toContain("pin 1.2.0 permission");
  });

  it("no git (can't tell): says nothing", async () => {
    const f = fake({ latest: async () => "1.2.0" });
    f.setPin(null);
    const c = updateCheck(f.d);
    await c.tick();
    await c.tick();
    expect(f.notes).toEqual(["wait done"]);
    expect(f.logs).toEqual([]);
  });
});

describe("issue 251: the late pin's bell item is in en, es and ja", () => {
  const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
  it.each(["shell.js", "i18n/es.js", "i18n/ja.js"])(
    "%s has both lines, with the version, the folder and the minutes",
    (file) => {
      const src = fs.readFileSync(path.join(PUBLIC, file), "utf8");
      for (const key of [
        "bell.m.pinNotCommittedLate",
        "bell.m.pinNotCommittedLateAllow",
      ]) {
        const m = new RegExp(
          `"${key.replace(/\./g, "\\.")}":\\s*"([^"]+)"`,
        ).exec(src);
        expect(m?.[1]).toBeTruthy();
        for (const v of ["{v}", "{folder}", "{min}"])
          expect(m![1]).toContain(v);
      }
    },
  );
});
