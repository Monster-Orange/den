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
  backMessage,
  MARKER_MAX_AGE_MS,
  restartMarkerPath,
  takeRestartMarker,
  tellBack,
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

describe("the restart marker", () => {
  it("written 0600, in a 0700 folder", () => {
    writeRestartMarker(dir, marker());
    expect(fs.statSync(restartMarkerPath(dir)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(restartMarkerPath(dir))).mode & 0o777).toBe(
      0o700,
    );
  });

  it("taken once: the second start finds nothing", () => {
    const m = marker();
    writeRestartMarker(dir, m);
    expect(takeRestartMarker(dir)).toEqual(m);
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
  it("ask by default; auto when the distribution says; anything else names its key", () => {
    expect(readServerAgentConfig({} as never).selfUpdate).toBe("ask");
    expect(
      readServerAgentConfig({ server_agent: { self_update: "auto" } } as never)
        .selfUpdate,
    ).toBe("auto");
    expect(() =>
      readServerAgentConfig({ server_agent: { self_update: "yes" } } as never),
    ).toThrow(/server_agent\.self_update/);
  });
});
