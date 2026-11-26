import { describe, expect, it } from "@jest/globals";
import { RestartQueue } from "../../../src/shared/agents/restart-queue.js";
import {
  capRefusal,
  stillWanted,
} from "../../../src/ui/server/restart-queue-service.js";
import { AgentError } from "../../../src/ui/cli/agent-ops.js";

class CapError extends Error {
  readonly code = "cap";
}

function world(o: { maxWaitMs?: number; stopped?: Set<string> } = {}) {
  const logs: string[] = [];
  const sleeps: Array<{ ms: number; go: () => void }> = [];
  let clock = 1_000_000;
  let room = 0;
  const started: string[] = [];
  const q = new RestartQueue({
    now: () => clock,
    config: () => ({
      batch: 4,
      gapMs: 30_000,
      loadCeiling: 0,
      maxWaitMs: o.maxWaitMs ?? 600_000,
    }),
    load: () => 0,
    log: (l) => logs.push(l),
    sleep: (ms) => new Promise<void>((go) => sleeps.push({ ms, go })),
    stillWanted: (id) => !o.stopped?.has(id),
    heldBy: (e) =>
      (e as { code?: string }).code === "cap" ? (e as Error).message : null,
  });
  const capped = (id: string) =>
    q.add({
      id,
      why: "resume",
      run: async () => {
        if (room <= 0)
          throw new CapError(
            "1 agent is running and agents.max_concurrent is 1",
          );
        room -= 1;
        started.push(id);
        return id;
      },
    });
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const pass = async () => {
    await flush();
    sleeps.shift()?.go();
    await flush();
  };
  return {
    q,
    capped,
    started,
    sleeps,
    logs,
    flush,
    pass,
    free: () => (room += 1),
    tick: (ms: number) => (clock += ms),
  };
}

describe("issue 1694: a resume a cap refused waits in the restart queue", () => {
  it("its caller hears the refusal, and once a place frees it starts without a click", async () => {
    const w = world();
    await expect(w.capped("b")).rejects.toThrow(/agents\.max_concurrent is 1/);
    await w.flush();
    expect(w.q.held()).toEqual([
      { id: "b", why: "1 agent is running and agents.max_concurrent is 1" },
    ]);
    w.tick(30_000);
    await w.pass();
    expect(w.started).toEqual([]);
    expect(w.q.held().map((h) => h.id)).toEqual(["b"]);
    w.free();
    w.tick(30_000);
    await w.pass();
    await w.pass();
    expect(w.started).toEqual(["b"]);
    expect(w.q.held()).toEqual([]);
  });

  it("a refusal that isn't a cap is not tried again", async () => {
    const w = world();
    await expect(
      w.q.add({
        id: "c",
        why: "resume",
        run: async () => {
          throw new Error("no such folder");
        },
      }),
    ).rejects.toThrow(/no such folder/);
    await w.flush();
    expect(w.q.held()).toEqual([]);
    expect(w.sleeps).toEqual([]);
  });

  it("stops trying once it has waited agents.resume.max_wait_seconds, and says so", async () => {
    const w = world({ maxWaitMs: 60_000 });
    await expect(w.capped("d")).rejects.toThrow(/cap|max_concurrent/);
    for (let i = 0; i < 3; i++) {
      w.tick(30_000);
      await w.pass();
    }
    expect(w.q.held()).toEqual([]);
    expect(w.logs.join("\n")).toMatch(/d.*agents\.resume\.max_wait_seconds/);
    w.free();
    w.tick(30_000);
    await w.pass();
    expect(w.started).toEqual([]);
  });

  it("a person's own Resume takes it out of the wait", async () => {
    const w = world();
    await expect(w.capped("e")).rejects.toThrow(/max_concurrent/);
    await w.flush();
    w.q.forget("e");
    expect(w.q.held()).toEqual([]);
  });

  it("the server's queue holds a start refused by a cap, and nothing else", () => {
    const why =
      "2 agents are running in project north and its cap is 2 (agents.max_per_project)";
    expect(capRefusal(new AgentError(why, { status: 429, code: "cap" }))).toBe(
      why,
    );
    expect(
      capRefusal(new AgentError("no such folder", { status: 400 })),
    ).toBeNull();
    expect(capRefusal("cap")).toBeNull();
  });

  it("an agent the person stops while it waits is not started when a place frees", async () => {
    const stopped = new Set<string>();
    const w = world({ stopped });
    await expect(w.capped("f")).rejects.toThrow(/max_concurrent/);
    await w.flush();
    stopped.add("f");
    w.free();
    w.tick(30_000);
    await w.pass();
    await w.pass();
    expect(w.started).toEqual([]);
    expect(w.q.held()).toEqual([]);
  });

  it("the server's queue wants an agent back only while its record is there and not stopped since its hold", async () => {
    const fs = await import("fs");
    const os = await import("os");
    const path = await import("path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1694-"));
    fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
    const put = (id: string, stoppedAt?: string) =>
      fs.writeFileSync(
        path.join(dir, "agents", `${id}.json`),
        JSON.stringify({
          id,
          workspace: "north",
          ...(stoppedAt ? { stoppedAt } : {}),
        }),
      );
    const heldAt = Date.parse("2026-11-20T10:00:00Z");
    put("waits");
    put("stopped-before", "2026-11-20T09:00:00Z");
    put("stopped-after", "2026-11-20T10:05:00Z");
    expect(stillWanted(dir, "waits", heldAt)).toBe(true);
    expect(stillWanted(dir, "stopped-before", heldAt)).toBe(true);
    expect(stillWanted(dir, "stopped-after", heldAt)).toBe(false);
    expect(stillWanted(dir, "removed", heldAt)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
