/**
 * /api/service/exec lifecycle commands go through the service runner, so the
 * web UI and MCP get the CLI's semantics (B1, B2).
 */
import { describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import {
  streamLifecycleExec,
  type LifecycleExecDeps,
} from "../../../src/ui/server/lifecycle-exec.js";
import type { RunCommandOptions } from "../../../src/shared/environment-manager/service-runner.js";
import type { ResolvedService } from "../../../src/shared/types/index.js";

const resolved: ResolvedService = {
  address: "shop/web",
  repoName: "shop",
  subsystem: "web",
  repoPath: "/repos/shop",
  branch: null,
  mode: "dev-managed",
};

function harness(
  health: "ok" | "error",
  runImpl: (o: RunCommandOptions) => {
    detachable?: boolean;
    interactive?: boolean;
  } = (o) => {
    setImmediate(() => o.onClose(0));
    return {};
  },
) {
  const events: Record<string, unknown>[] = [];
  const runs: RunCommandOptions[] = [];
  let ended = 0;
  const deps: LifecycleExecDeps = {
    health: async () => ({
      address: resolved.address,
      repoName: "shop",
      subsystem: "web",
      repoPath: resolved.repoPath,
      mode: resolved.mode,
      branch: null,
      health,
    }),
    run: (o) => {
      runs.push(o);
      const r = runImpl(o);
      return {
        proc: new EventEmitter() as unknown as ChildProcess,
        detachable: r.detachable ?? false,
        interactive: r.interactive ?? false,
      };
    },
  };
  const go = (cmd: "up" | "down" | "restart") =>
    new Promise<void>((done) => {
      void streamLifecycleExec(
        {
          resolved,
          cmd,
          env: {},
          emit: (e) => events.push(e),
          end: () => {
            ended++;
            done();
          },
          onClientClose: () => {},
        },
        deps,
      );
    });
  return { events, runs, go, ended: () => ended, deps };
}

const depsOf = (h: { deps: LifecycleExecDeps }): LifecycleExecDeps => h.deps;

describe("streamLifecycleExec", () => {
  it("restart goes to the runner as restart (its down+up fallback), not a manifest lookup (B1)", async () => {
    const h = harness("ok");
    await h.go("restart");
    expect(h.runs.map((r) => r.command)).toEqual(["restart"]);
    expect(h.runs[0].runtime).toBe("daemon");
    expect(h.events.at(-1)).toMatchObject({ type: "done", exitCode: 0 });
  });

  it("up on a healthy service starts nothing (B2)", async () => {
    const h = harness("ok");
    await h.go("up");
    expect(h.runs).toEqual([]);
    expect(h.events).toEqual([
      expect.objectContaining({
        type: "line",
        text: expect.stringMatching(/already up/),
      }),
      expect.objectContaining({ type: "done", exitCode: 0 }),
    ]);
  });

  it("up on a down service runs it, announcing the detach", async () => {
    const h = harness("error", (o) => {
      setImmediate(() => {
        o.onServiceExit?.(0);
        o.onClose(0);
      });
      return { detachable: true };
    });
    await h.go("up");
    expect(h.runs.map((r) => r.command)).toEqual(["up"]);
    expect(h.events.map((e) => e.type)).toEqual([
      "started",
      "service-exited",
      "done",
    ]);
  });

  it("a non-zero close is an error event then done with that code", async () => {
    const h = harness("error", (o) => {
      setImmediate(() => {
        o.onLine("Error: port 5173 in use");
        o.onClose(1);
      });
      return {};
    });
    await h.go("down");
    expect(h.events.map((e) => e.type)).toEqual(["line", "error", "done"]);
    expect(h.events.at(-1)).toMatchObject({ exitCode: 1 });
    expect(h.ended()).toBe(1);
  });

  it("an interactive command is refused, once", async () => {
    const run = jest.fn();
    const h = harness("error", (o) => {
      run();
      setImmediate(() => o.onClose(0));
      return { interactive: true };
    });
    await h.go("up");
    await new Promise((r) => setImmediate(r));
    expect(h.events.map((e) => e.type)).toEqual(["error", "done"]);
    expect(h.events.at(-1)).toMatchObject({ exitCode: 1 });
    expect(h.ended()).toBe(1);
  });
});

describe("ready after a detached start (B1 follow-up)", () => {
  const timing = {
    pollMs: 5,
    readyTimeoutMs: 400,
    settleMs: 30,
    restartMinMs: 40,
  };

  function detached(
    healthSeq: ("ok" | "error" | "unknown")[],
    opts: { exit?: number } = {},
  ) {
    const events: Record<string, unknown>[] = [];
    let i = 0;
    const deps: LifecycleExecDeps = {
      ...timing,
      health: async () => {
        const h = healthSeq[Math.min(i++, healthSeq.length - 1)];
        return {
          address: resolved.address,
          repoName: "shop",
          subsystem: "web",
          repoPath: resolved.repoPath,
          mode: resolved.mode,
          branch: null,
          health: h,
        };
      },
      run: (o) => {
        if (opts.exit !== undefined)
          setTimeout(() => o.onServiceExit?.(opts.exit!), 10);
        return {
          proc: new EventEmitter() as unknown as ChildProcess,
          detachable: true,
          interactive: false,
        };
      },
    };
    return { events, deps };
  }

  const go = (cmd: "up" | "restart", h: ReturnType<typeof detached>) =>
    streamLifecycleExec(
      {
        resolved,
        cmd,
        env: {},
        emit: (e) => h.events.push(e),
        end: () => {},
        onClientClose: () => {},
      },
      h.deps,
    );
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const types = (h: ReturnType<typeof detached>) => h.events.map((e) => e.type);

  it("up: ready once health turns green", async () => {
    // First reading is the pre-start check (not healthy), then the polls.
    const h = detached(["error", "error", "error", "ok"]);
    await go("up", h);
    await wait(100);
    expect(types(h)).toEqual(["started", "ready"]);
    expect(h.events.at(-1)).toMatchObject({ checked: true });
  });

  it("restart: the old instance's green does not count", async () => {
    // ok (old) … error (down) … ok (new).
    const h = detached(["ok", "ok", "error", "ok"]);
    await go("restart", h);
    await wait(100);
    expect(types(h)).toEqual(["started", "ready"]);
  });

  it("restart: green throughout counts once the restart has had time to bounce", async () => {
    const h = detached(["ok"]);
    await go("restart", h);
    await wait(15);
    expect(types(h)).toEqual(["started"]);
    await wait(100);
    expect(types(h)).toEqual(["started", "ready"]);
  });

  it("no health check: ready, unchecked, after the settle window", async () => {
    const h = detached(["unknown"]);
    await go("up", h);
    await wait(100);
    expect(h.events.at(-1)).toMatchObject({ type: "ready", checked: false });
  });

  it("a launcher that dies first is not ready", async () => {
    const h = detached(["error"], { exit: 1 });
    await go("up", h);
    await wait(100);
    expect(types(h)).toEqual(["started", "service-exited"]);
  });
});

describe("secret_env (R16)", () => {
  const FAKE = "sk-test-123";

  it("passes the resolved secret_env to the runner, and emits no value", async () => {
    const h = harness("error");
    const secretEnv = jest.fn(async () => ({
      ok: true as const,
      secretEnv: { SOME_KEY: FAKE },
    }));
    await new Promise<void>((done) => {
      void streamLifecycleExec(
        {
          resolved,
          cmd: "restart",
          env: {},
          emit: (e) => h.events.push(e),
          end: done,
          onClientClose: () => {},
        },
        {
          ...depsOf(h),
          secretEnv,
        },
      );
    });
    expect(secretEnv).toHaveBeenCalledWith("shop/web", "restart", undefined);
    expect(h.runs[0].secretEnv).toEqual({ SOME_KEY: FAKE });
    expect(JSON.stringify(h.events)).not.toContain(FAKE);
  });

  it("a missing key fails the command before the runner is called", async () => {
    const h = harness("error");
    const message =
      "shop/web: 1 secret_env key(s) could not be resolved; not starting it:\n  SOME_KEY (ref proj/dev/SOME_KEY, provider env): not resolved";
    await new Promise<void>((done) => {
      void streamLifecycleExec(
        {
          resolved,
          cmd: "up",
          env: {},
          emit: (e) => h.events.push(e),
          end: done,
          onClientClose: () => {},
        },
        {
          ...depsOf(h),
          secretEnv: async () => ({ ok: false as const, message }),
        },
      );
    });
    expect(h.runs).toEqual([]);
    expect(h.events).toEqual([
      { type: "error", text: message },
      expect.objectContaining({ type: "done", exitCode: 1 }),
    ]);
  });
});
