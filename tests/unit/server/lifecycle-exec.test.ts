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
  return { events, runs, go, ended: () => ended };
}

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
