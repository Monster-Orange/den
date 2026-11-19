/**
 * SRV-1a: the server agent restarts its own Den and carries on. The
 * held den_restart (its check; its run hands over who asked), the marker
 * the next server takes once, the line it types, and when it types it.
 * The setting, server_agent.self_update. A temp state dir; fakes for the
 * session and the clock.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readServerAgentConfig } from "../../../src/shared/den-config.js";
import {
  heldActions,
  RESTART_REASON_MAX,
  type HeldActionDeps,
} from "../../../src/ui/server/held-actions.js";
import {
  backAudit,
  backMessage,
  finishRestartMarker,
  MARKER_MAX_AGE_MS,
  pinReminder,
  restartMarkerPath,
  takeRestartMarker,
  tellBack,
  tellBackDetail,
  writeRestartMarker,
  type RestartMarker,
} from "../../../src/ui/server/server-restart.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-srv1a-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const marker = (over: Partial<RestartMarker> = {}): RestartMarker => ({
  id: "req-1",
  reason: "new pin",
  agent: "server",
  allowed: "auto",
  fromVersion: "0.4.41",
  fromPid: 111,
  at: new Date().toISOString(),
  ...over,
});

describe("den_restart, the held action", () => {
  const deps = (restarted: unknown[]): HeldActionDeps =>
    ({
      restartDen: async (reason: string, asked: unknown) => {
        restarted.push({ reason, asked });
        return { ok: true, restarting: true };
      },
    }) as unknown as HeldActionDeps;

  it("a one-line reason is required, and bounded; the Review says sessions stay", async () => {
    const a = heldActions(deps([])).den_restart;
    expect(await a.check({})).toMatchObject({ ok: false });
    expect(
      await a.check({ reason: "x".repeat(RESTART_REASON_MAX + 1) }),
    ).toMatchObject({ ok: false });
    const c = await a.check({ reason: "  new\n  pin " });
    expect(c).toMatchObject({
      ok: true,
      args: { reason: "new pin" },
      summary: "restart Den (new pin)",
      params: { reason: "new pin" },
    });
    expect(c.ok && c.details.join(" ")).toMatch(/carry on where they were/);
  });

  it("its run hands the request (who asked) to the restart", async () => {
    const restarted: unknown[] = [];
    const a = heldActions(deps(restarted)).den_restart;
    expect(
      await a.run({ reason: "new pin" }, { id: "r1", agent: "server" }),
    ).toEqual({ ok: true, restarting: true });
    expect(restarted).toEqual([
      { reason: "new pin", asked: { id: "r1", agent: "server" } },
    ]);
  });

  it("a server that can't restart itself refuses before anything waits", async () => {
    const a = heldActions({} as HeldActionDeps).den_restart;
    expect(await a.check({ reason: "x" })).toMatchObject({ ok: false });
  });
});

describe("SRV-1b: den_update, the held action", () => {
  const deps = (asked: unknown[]): HeldActionDeps =>
    ({
      updateDen: async (version: string, reason: string, who: unknown) => {
        asked.push({ version, reason, who });
        return { ok: true, from: "1.0.0", to: "1.1.0", restarting: true };
      },
    }) as unknown as HeldActionDeps;

  it("a version (latest by default) and a one-line reason; the Review says it rolls back by itself", async () => {
    const a = heldActions(deps([])).den_update;
    expect(await a.check({ version: "latest" })).toMatchObject({ ok: false });
    expect(await a.check({ version: "1.0", reason: "x" })).toMatchObject({
      ok: false,
      error: "version: latest, or one like 0.4.44",
    });
    const c = await a.check({ reason: " new\n release " });
    expect(c).toMatchObject({
      ok: true,
      args: { version: "latest", reason: "new release" },
      summary: "update Den to latest (new release)",
      params: { version: "latest", reason: "new release" },
    });
    expect(c.ok && c.details.join(" ")).toMatch(/rolls back by itself/);
    expect(
      await a.check({ version: "0.4.44-dev.1", reason: "try it" }),
    ).toMatchObject({ ok: true, args: { version: "0.4.44-dev.1" } });
  });

  it("its run hands version, reason and who asked to the update", async () => {
    const asked: unknown[] = [];
    const a = heldActions(deps(asked)).den_update;
    expect(
      await a.run(
        { version: "latest", reason: "r" },
        { id: "r1", agent: "server" },
      ),
    ).toMatchObject({ ok: true, restarting: true });
    expect(asked).toEqual([
      { version: "latest", reason: "r", who: { id: "r1", agent: "server" } },
    ]);
  });

  it("a server that can't update itself refuses before anything waits", async () => {
    const a = heldActions({} as HeldActionDeps).den_update;
    expect(await a.check({ reason: "x" })).toMatchObject({ ok: false });
  });
});

describe("the restart marker", () => {
  it("written 0600, in a 0700 folder", () => {
    writeRestartMarker(dir, marker());
    expect(fs.statSync(restartMarkerPath(dir)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(restartMarkerPath(dir))).mode & 0o777).toBe(
      0o700,
    );
  });

  it("told once: once its note is typed (finished), the next start finds nothing", () => {
    const m = marker();
    writeRestartMarker(dir, m);
    expect(takeRestartMarker(dir)).toEqual(m);
    finishRestartMarker(dir);
    expect(takeRestartMarker(dir)).toBeNull();
    expect(fs.existsSync(restartMarkerPath(dir))).toBe(false);
  });

  it("a stale or broken one is dropped, never told", () => {
    const now = Date.now();
    writeRestartMarker(
      dir,
      marker({ at: new Date(now - MARKER_MAX_AGE_MS - 1).toISOString() }),
    );
    expect(takeRestartMarker(dir, now)).toBeNull();
    fs.writeFileSync(restartMarkerPath(dir), "{not json");
    expect(takeRestartMarker(dir, now)).toBeNull();
    expect(fs.existsSync(restartMarkerPath(dir))).toBe(false);
  });

  it("the line says the version and pid, and what it was", () => {
    expect(backMessage(marker(), "0.4.42", 222)).toBe(
      "Server is back on 0.4.42 (pid 222) (it was 0.4.41). You restarted it: new pin. Carry on from where you were.",
    );
    expect(backMessage(marker(), "0.4.41", 222)).toMatch(
      /^Server is back on 0.4.41 \(pid 222\)\. /,
    );
  });

  it("SRV-1b: a rollback's marker keeps rolledBack through the take", () => {
    writeRestartMarker(dir, marker({ rolledBack: true }));
    expect(takeRestartMarker(dir)).toMatchObject({ rolledBack: true });
    writeRestartMarker(dir, marker());
    expect(takeRestartMarker(dir)).not.toHaveProperty("rolledBack");
  });

  it("SRV-1b: after a rollback it says so, and why, and to commit nothing", () => {
    expect(
      backMessage(
        marker({
          rolledBack: true,
          fromVersion: "0.4.42",
          reason:
            "Den 0.4.42 wasn't up within 180 s (it never answered), so Den rolled back to 0.4.41",
        }),
        "0.4.41",
        222,
      ),
    ).toBe(
      "Server is back on 0.4.41 (pid 222), rolled back: Den 0.4.42 wasn't up within 180 s (it never answered), so Den rolled back to 0.4.41. Your update didn't take: commit no pin change, and tell your person why. No doctor results were kept for this update.",
    );
  });

  it("SRV-P6: Den's own update (no agent asked) tells the server agent Den commits the pin, or nothing", () => {
    writeRestartMarker(dir, marker({ by: "den" }));
    expect(takeRestartMarker(dir)).toMatchObject({ by: "den" });
    expect(
      backMessage(
        marker({ by: "den", reason: "Den 0.4.42 is out" }),
        "0.4.42",
        222,
      ),
    ).toBe(
      "Den is back on 0.4.42 (pid 222) (it was 0.4.41). Den updated itself: Den 0.4.42 is out. Den commits and pushes the new pin itself (server_agent.pin_commit); commit it yourself only when that is off. No doctor results were kept for this update. Your Den tools keep running the Den they started on until the person restarts you from Den (Restart keeps this conversation).",
    );
    expect(
      backMessage(
        marker({
          by: "den",
          rolledBack: true,
          fromVersion: "0.4.42",
          reason: "0.4.42 never answered, so Den rolled back to 0.4.41",
        }),
        "0.4.41",
        222,
      ),
    ).toBe(
      "Den is back on 0.4.41 (pid 222), rolled back: 0.4.42 never answered, so Den rolled back to 0.4.41. Den's own update didn't take: commit no pin change. The person has it in the bell. No doctor results were kept for this update.",
    );
  });
});

describe("telling the agent", () => {
  const run = async (states: string[], waitMs = 10_000) => {
    let clock = 0;
    const typed: string[] = [];
    const told = await tellBack("back", {
      state: async () => (states.shift() ?? "busy") as never,
      type: async (t) => {
        typed.push(t);
        return true;
      },
      waitMs,
      pollMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    return { told, typed, clock };
  };

  it("mid-turn: waits for its prompt, then types", async () => {
    expect(await run(["busy", "busy", "idle"])).toEqual({
      told: "told",
      typed: ["back"],
      clock: 2000,
    });
  });

  it("still busy at ui.restart_wait_seconds: types anyway (the runtime queues it)", async () => {
    const r = await run([], 3000);
    expect([r.told, r.typed, r.clock]).toEqual(["told", ["back"], 3000]);
  });

  it("gone or stopped: nothing typed", async () => {
    expect((await run(["missing"])).typed).toEqual([]);
    expect((await run(["stopped"])).told).toBe("stopped");
  });
});

describe("server_agent.self_update", () => {
  it("ask by default; auto only when the person's user.yml says (review M4); the team file can't; anything else names its key", () => {
    expect(readServerAgentConfig({} as never, undefined, {}).selfUpdate).toBe(
      "ask",
    );
    expect(
      readServerAgentConfig({} as never, undefined, {
        server_agent: { self_update: "auto" },
      }).selfUpdate,
    ).toBe("auto");
    // 0.4.48: before the first start copies it, the team file's choice
    // holds (never a silent ask); once user.yml has one, the team file's
    // does nothing.
    const pending = readServerAgentConfig(
      { server_agent: { self_update: "auto" } } as never,
      undefined,
      {},
    );
    expect([
      pending.selfUpdate,
      pending.teamSelfUpdateIgnored,
      pending.selfUpdateFrom,
    ]).toEqual(["auto", false, "org"]);
    const team = readServerAgentConfig(
      { server_agent: { self_update: "auto" } } as never,
      undefined,
      { server_agent: { self_update: "ask" } },
    );
    expect([team.selfUpdate, team.teamSelfUpdateIgnored]).toEqual([
      "ask",
      true,
    ]);
    expect(() =>
      readServerAgentConfig({} as never, undefined, {
        server_agent: { self_update: "yes" },
      }),
    ).toThrow(/server_agent\.self_update/);
  });
});

/**
 * Issue 251: on one install the pin note was lost to a second restart.
 * The first new server took the self-update marker (removing it), the
 * server agent was mid-turn, and the server restarted again before the
 * note was typed: the second start found only "carry on", or nothing.
 */
describe("issue 251: a second restart during a self-update", () => {
  const den = () =>
    marker({
      id: "",
      by: "den",
      reason: "update Den 0.4.41 → 0.4.42",
      fromVersion: "0.4.41",
    });

  it("a start that ends before the note is typed leaves it for the next start", () => {
    writeRestartMarker(dir, den());
    expect(takeRestartMarker(dir)).toMatchObject({ by: "den" });
    // No finish: this server went before it typed the note.
    const again = takeRestartMarker(dir);
    expect(again).toMatchObject({
      by: "den",
      fromVersion: "0.4.41",
      again: true,
    });
    expect(backMessage(again!, "0.4.42", 333)).toMatch(
      /Den updated itself: update Den 0\.4\.41 → 0\.4\.42\. Den commits and pushes the new pin itself/,
    );
  });

  it("the server agent's own restart in between keeps the pin note, and says the restart too", () => {
    writeRestartMarker(dir, den());
    takeRestartMarker(dir);
    // The second restart: asked from 0.4.42, by the server agent.
    writeRestartMarker(
      dir,
      marker({ id: "r2", reason: "reload my tools", fromVersion: "0.4.42" }),
    );
    const m = takeRestartMarker(dir)!;
    expect(m).toMatchObject({
      agent: "server",
      update: { fromVersion: "0.4.41", reason: "update Den 0.4.41 → 0.4.42" },
    });
    const line = backMessage(m, "0.4.42", 333);
    expect(line).toMatch(
      /^Den is back on 0\.4\.42 \(pid 333\) \(it was 0\.4\.41\)\./,
    );
    expect(line).toMatch(/Den commits and pushes the new pin itself/);
    expect(line).toMatch(
      /It restarted again since: reload my tools\. Carry on from where you were\.$/,
    );
    finishRestartMarker(dir);
    expect(takeRestartMarker(dir)).toBeNull();
  });

  it("a restart with no marker of its own (the page's) keeps it too", () => {
    writeRestartMarker(dir, den());
    takeRestartMarker(dir);
    takeRestartMarker(dir);
    expect(takeRestartMarker(dir)).toMatchObject({ by: "den" });
  });

  it("a rollback replaces it: there is no pin to commit", () => {
    writeRestartMarker(dir, den());
    takeRestartMarker(dir);
    writeRestartMarker(
      dir,
      marker({ by: "den", rolledBack: true, fromVersion: "0.4.42" }),
    );
    const m = takeRestartMarker(dir)!;
    expect(m.rolledBack).toBe(true);
    expect(m).not.toHaveProperty("update");
  });

  it("a told note isn't carried", () => {
    writeRestartMarker(dir, den());
    takeRestartMarker(dir);
    finishRestartMarker(dir);
    writeRestartMarker(dir, marker({ fromVersion: "0.4.42" }));
    expect(takeRestartMarker(dir)).not.toHaveProperty("update");
  });
});

describe("issue 251: the audit row says what was typed, and the agent's state", () => {
  it("the input state at the moment it typed: idle, or busy when the wait ran out", async () => {
    let clock = 0;
    const deps = (states: string[]) => ({
      state: async () => (states.shift() ?? "busy") as never,
      type: async () => true,
      waitMs: 3000,
      pollMs: 1000,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    });
    expect(await tellBackDetail("x", deps(["busy", "idle"]))).toEqual({
      told: "told",
      state: "idle",
    });
    clock = 0;
    expect(await tellBackDetail("x", deps([]))).toEqual({
      told: "told",
      state: "busy",
    });
    expect(await tellBackDetail("x", deps(["stopped"]))).toEqual({
      told: "stopped",
      state: "stopped",
    });
  });

  it("the row has the exact note and the state, in full beside the short detail", () => {
    const text = backMessage(marker({ by: "den" }), "0.4.42", 222);
    const row = backAudit(marker({ by: "den" }), "0.4.42", 222, text, {
      told: "told",
      state: "busy",
    });
    expect(row.detail).toMatch(
      /^on 0\.4\.42 \(pid 222\), was 0\.4\.41 \(pid 111\): new pin \[req-1\]; agent:server told \(typed while busy\)/,
    );
    expect(row.agents).toEqual({
      server: { told: "told", state: "busy", typed: text },
    });
    const kept = backAudit(
      { ...marker({ by: "den" }), again: true },
      "0.4.42",
      222,
      text,
      { told: "told", state: "idle" },
    );
    expect(kept.detail).toMatch(/kept from an earlier start/);
  });

  it("the pin reminder names the version, the folder and the wait", () => {
    expect(pinReminder("0.4.42", "/srv/dist", 60)).toBe(
      "Den 0.4.42 runs here, but its new pin (package.json, package-lock.json) in /srv/dist is still not committed 60 min after the update. Commit and push it now, or tell your person why you can't.",
    );
  });
});
