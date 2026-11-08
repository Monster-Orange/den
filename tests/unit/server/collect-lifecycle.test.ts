/**
 * ON-3's service_try runs `up` as /api/service/exec does
 * (streamLifecycleExec), collected instead of streamed
 * (collectLifecycleExec): it ends at the launcher's exit, at `done`, or
 * once a detached start is ready, and then lets go of the log tail only.
 */
import { describe, expect, it } from "@jest/globals";
import { EventEmitter } from "events";
import type { ChildProcess } from "child_process";
import {
  collectLifecycleExec,
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

function deps(
  health: "ok" | "error" | "unknown",
  run: (o: RunCommandOptions) => { detachable?: boolean },
): { deps: LifecycleExecDeps; killed: () => number } {
  let killed = 0;
  return {
    killed: () => killed,
    deps: {
      health: async () => ({
        address: resolved.address,
        repoName: "shop",
        subsystem: "web",
        repoPath: resolved.repoPath,
        mode: resolved.mode,
        branch: null,
        health: health as "ok",
      }),
      run: (o) => {
        const r = run(o);
        const proc = new EventEmitter() as unknown as ChildProcess & {
          kill: () => boolean;
        };
        proc.kill = () => {
          killed++;
          return true;
        };
        return { proc, detachable: r.detachable ?? false, interactive: false };
      },
      pollMs: 1,
      settleMs: 5,
    },
  };
}

describe("collectLifecycleExec", () => {
  it("a start that fails: not ok, its exit code and the end of its output", async () => {
    const d = deps("error", (o) => {
      setImmediate(() => {
        for (let i = 1; i <= 40; i++) o.onLine(`line ${i}`);
        o.onClose(3);
      });
      return {};
    });
    const r = await collectLifecycleExec(
      { resolved, cmd: "up", env: {} },
      d.deps,
      5,
    );
    expect(r).toMatchObject({ ok: false, exitCode: 3, ready: false });
    expect(r.lines).toEqual([
      "line 36",
      "line 37",
      "line 38",
      "line 39",
      "line 40",
    ]);
  });

  it("a detached start that stays up: ready, and only the log tail is let go", async () => {
    const d = deps("unknown", (o) => {
      setImmediate(() => o.onLine("listening on 3000"));
      return { detachable: true };
    });
    const r = await collectLifecycleExec(
      { resolved, cmd: "up", env: {} },
      d.deps,
    );
    expect(r).toMatchObject({ ok: true, exitCode: null, ready: true });
    expect(r.lines).toContain("listening on 3000");
    expect(d.killed()).toBe(1);
  });

  it("a detached launcher that exits non-zero: not ok, with that code", async () => {
    const d = deps("error", (o) => {
      setImmediate(() => o.onServiceExit?.(2));
      return { detachable: true };
    });
    const r = await collectLifecycleExec(
      { resolved, cmd: "up", env: {} },
      d.deps,
    );
    expect(r).toMatchObject({ ok: false, exitCode: 2, ready: false });
  });

  it("already healthy: ok, nothing started", async () => {
    let runs = 0;
    const d = deps("ok", () => {
      runs++;
      return {};
    });
    const r = await collectLifecycleExec(
      { resolved, cmd: "up", env: {} },
      d.deps,
    );
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
    expect(r.lines.join("\n")).toMatch(/already up/);
    expect(runs).toBe(0);
  });
});
