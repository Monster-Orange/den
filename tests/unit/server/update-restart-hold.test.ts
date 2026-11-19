/**
 * Issue 562, review: the wait is read before the install, and the install
 * takes a minute or more. A person who answers the server agent's question
 * meanwhile starts a turn, and the restart would cut it. So the auto
 * update reads the wait again once the install and doctor are done, just
 * before the watch starts and Den restarts:
 *
 *   - a security release: waitPast (still on its person, or idle: now;
 *     working or an Allow pending: it waits);
 *   - any other: the plain check;
 *   - re-read every few seconds, at most
 *     server_agent.update_restart_wait_seconds (default 900); then it
 *     restarts anyway (the new version is installed, the old one runs),
 *     says why in the log, and leaves one bell line.
 *
 * Fakes only: a fake clock, fake commands, temp dirs.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  holdRestart,
  restartedWhileWorkingNote,
  updateCheck,
  type UpdateCheckDeps,
  type UpdateWait,
} from "../../../src/ui/server/update-check.js";
import { updateDen } from "../../../src/ui/server/den-update.js";
import { readServerAgentConfig } from "../../../src/shared/den-config.js";

function clock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

function seq(...ws: (UpdateWait | null)[]) {
  let i = 0;
  return async () => ws[Math.min(i++, ws.length - 1)];
}

describe("the restart after the install reads the wait again", () => {
  it("security path: the person answered during the install; the restart waits for the turn to end", async () => {
    const c = clock();
    const notes: string[] = [];
    const r = await holdRestart({
      waitWhy: seq("busy", "busy", null),
      maxMs: 900_000,
      everyMs: 5_000,
      now: c.now,
      sleep: c.sleep,
      timedOut: (why) => notes.push(why),
    });
    expect(r).toEqual({ heldMs: 10_000, timedOut: null });
    expect(c.slept).toEqual([5_000, 5_000]);
    expect(notes).toEqual([]);
  });

  it("a pending Allow holds it too", async () => {
    const c = clock();
    const r = await holdRestart({
      waitWhy: seq("approval", null),
      maxMs: 900_000,
      everyMs: 5_000,
      now: c.now,
      sleep: c.sleep,
    });
    expect(r).toEqual({ heldMs: 5_000, timedOut: null });
  });

  it("the wait times out: it restarts anyway, says why in the log, and leaves the bell line", async () => {
    const c = clock();
    const notes: string[] = [];
    const logs: string[] = [];
    const r = await holdRestart({
      waitWhy: seq("busy"),
      maxMs: 12_000,
      everyMs: 5_000,
      now: c.now,
      sleep: c.sleep,
      log: (l) => logs.push(l),
      timedOut: (why) => notes.push(why),
    });
    expect(r).toEqual({ heldMs: 12_000, timedOut: "busy" });
    expect(c.slept).toEqual([5_000, 5_000, 2_000]);
    expect(notes).toEqual(["busy"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/restarts anyway after 12 s/);
    expect(logs[0]).toMatch(/in the middle of a turn/);
  });

  it("a read that throws counts as working (it waits, never guesses idle)", async () => {
    const c = clock();
    let n = 0;
    const r = await holdRestart({
      waitWhy: async () => {
        if (n++ === 0) throw new Error("no answer");
        return null;
      },
      maxMs: 900_000,
      everyMs: 5_000,
      now: c.now,
      sleep: c.sleep,
    });
    expect(r).toEqual({ heldMs: 5_000, timedOut: null });
  });

  it("normal path, idle: restarts at once, no sleep, no note", async () => {
    const c = clock();
    const notes: string[] = [];
    const r = await holdRestart({
      waitWhy: seq(null),
      maxMs: 900_000,
      now: c.now,
      sleep: c.sleep,
      timedOut: (why) => notes.push(why),
    });
    expect(r).toEqual({ heldMs: 0, timedOut: null });
    expect(c.slept).toEqual([]);
    expect(notes).toEqual([]);
  });
});

describe("the update check tells the update which path it is on", () => {
  function fake(wait: UpdateWait | null, over: Partial<UpdateCheckDeps> = {}) {
    const calls: { v: string; security: boolean }[] = [];
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
      waitPast: async () => null,
      security: async () => true,
      update: async (v, _reason, o) => {
        calls.push({ v, security: !!o?.security });
        return { ok: true };
      },
      ask: () => true,
      notice: () => undefined,
      ...over,
    };
    return { d, calls };
  }

  it("past the agent's question: the security path", async () => {
    const f = fake("asked");
    await updateCheck(f.d).tick();
    expect(f.calls).toEqual([{ v: "1.3.0", security: true }]);
  });

  it("idle: the normal path", async () => {
    const f = fake(null);
    await updateCheck(f.d).tick();
    expect(f.calls).toEqual([{ v: "1.3.0", security: false }]);
  });
});

describe("den_update holds the restart after the install, before the watch", () => {
  let tmp: string;
  let root: string;
  let engine: string;
  let stateDir: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-562h-"));
    root = path.join(tmp, "dist");
    engine = path.join(root, "node_modules", "@example", "den");
    stateDir = path.join(tmp, "state");
    fs.mkdirSync(path.join(engine, "src/ui/server"), { recursive: true });
    fs.writeFileSync(
      path.join(engine, "src/ui/server/update-watch.mjs"),
      "// the watch\n",
    );
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { "@example/den": "1.0.0" } }),
    );
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("install, doctor, then the hold, then the watch and the restart", async () => {
    const order: string[] = [];
    const res = await updateDen("1.1.0", {
      root,
      engine,
      stateDir,
      pkg: { name: "@example/den", version: "1.0.0" },
      npmView: async (spec) => spec.split("@").pop()!,
      npm: ["npm"],
      cli: ["den"],
      run: async (argv) => {
        order.push(argv[1] === "install" ? "install" : "doctor");
        return { code: 0, out: JSON.stringify({ checks: [] }) };
      },
      beforeRestart: async () => void order.push("hold"),
      watch: () => {
        order.push("watch");
        return 1;
      },
      note: (reason) => ({
        path: path.join(stateDir, "r.json"),
        marker: { reason },
      }),
      restart: () => void order.push("restart"),
      port: 7000,
      pid: 1,
      waitMs: 180_000,
    });
    expect(res).toMatchObject({ ok: true, to: "1.1.0" });
    expect(order).toEqual(["install", "doctor", "hold", "watch", "restart"]);
  });
});

describe("the bell line and the setting", () => {
  it("says Den restarted while the agent was working, with its key", () => {
    const added: Record<string, unknown>[] = [];
    restartedWhileWorkingNote(
      { add: (n: Record<string, unknown>) => void added.push(n) } as never,
      "Den",
      "Den agent",
      "1.3.0",
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      text: "Den restarted to finish an update while Den agent was working",
      msg: {
        key: "bell.m.restartedWhileWorking",
        vars: { agent: "Den agent", v: "1.3.0" },
      },
    });
  });

  it("its words are in en, es and ja", () => {
    const pub = path.join(process.cwd(), "src", "ui", "server", "public");
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"])
      expect(fs.readFileSync(path.join(pub, f), "utf8")).toMatch(
        /"bell\.m\.restartedWhileWorking":/,
      );
  });

  it("server_agent.update_restart_wait_seconds: 900 by default; a bad one names the key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-562s-"));
    try {
      expect(readServerAgentConfig({}, dir, {}).updateRestartWaitMs).toBe(
        900_000,
      );
      expect(
        readServerAgentConfig(
          { server_agent: { update_restart_wait_seconds: 60 } },
          dir,
          {},
        ).updateRestartWaitMs,
      ).toBe(60_000);
      for (const bad of [-1, "60", Number.NaN])
        expect(() =>
          readServerAgentConfig(
            { server_agent: { update_restart_wait_seconds: bad as never } },
            dir,
            {},
          ),
        ).toThrow(/server_agent\.update_restart_wait_seconds/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
