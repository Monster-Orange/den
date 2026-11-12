/**
 * D55: the run registry (src/ui/server/exec-jobs.ts). A run's streams
 * attach and detach; only Stop ends it early.
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import { EventEmitter } from "events";
import type { ServerResponse } from "http";
import {
  attachJob,
  getJob,
  listJobs,
  MAX_FINISHED_JOBS,
  MAX_JOB_EVENTS,
  resetJobsForTests,
  startJob,
  stopJob,
  STOPPED_EXIT,
} from "../../../src/ui/server/exec-jobs.js";

/** A stream: what was written to it, and whether it ended. */
function stream() {
  const e = new EventEmitter() as EventEmitter & {
    frames: Record<string, unknown>[];
    writableEnded: boolean;
    destroyed: boolean;
    write(c: string): boolean;
    end(): void;
    close(): void;
  };
  e.frames = [];
  e.writableEnded = false;
  e.destroyed = false;
  e.write = (c: string) => {
    for (const f of c.split("\n\n"))
      if (f.startsWith("data: ")) e.frames.push(JSON.parse(f.slice(6)));
    return true;
  };
  e.end = () => {
    e.writableEnded = true;
  };
  e.close = () => {
    e.destroyed = true;
    e.emit("close");
  };
  return e;
}
const res = (s: ReturnType<typeof stream>) => s as unknown as ServerResponse;
const params = new URLSearchParams({ cmd: "restart", workspace: "north" });

beforeEach(() => resetJobsForTests());

describe("exec jobs (D55)", () => {
  it("says its id first, then every event, to the stream that started it", () => {
    const a = stream();
    const job = startJob("/api/workspace/exec", params, res(a));
    job.write({ type: "line", text: "one" });
    expect(a.frames).toEqual([
      { type: "job", id: job.id },
      { type: "line", text: "one" },
    ]);
    expect(getJob(job.id)).toMatchObject({
      path: "/api/workspace/exec",
      params: { cmd: "restart", workspace: "north" },
      status: "running",
    });
  });

  it("a stream that closes only stops watching: the run goes on, and a new stream gets it all", () => {
    const a = stream();
    const job = startJob("/api/workspace/exec", params, res(a));
    job.write({ type: "line", text: "down" });
    a.close();
    expect(job.watchers()).toBe(0);
    job.write({ type: "line", text: "up" });
    expect(a.frames).toHaveLength(2);
    const b = stream();
    expect(attachJob(job.id, res(b))).toBe(true);
    job.write({ type: "done", exitCode: 0 });
    job.end();
    expect(b.frames.map((f) => f.text ?? f.type)).toEqual([
      "job",
      "down",
      "up",
      "done",
    ]);
    expect(b.writableEnded).toBe(true);
    expect(getJob(job.id)).toMatchObject({ status: "done", exitCode: 0 });
  });

  it("an ended run replays whole and ends the stream at once", () => {
    const job = startJob("/api/service/exec", params, res(stream()));
    job.write({ type: "done", exitCode: 2 });
    job.end();
    job.write({ type: "line", text: "after the end" });
    const b = stream();
    attachJob(job.id, res(b));
    expect(b.frames.map((f) => f.type)).toEqual(["job", "done"]);
    expect(b.writableEnded).toBe(true);
  });

  it("the last stream leaving runs the unwatched hooks; one leaving of two doesn't", () => {
    const a = stream();
    const job = startJob("/api/service/exec", params, res(a));
    let n = 0;
    job.onUnwatched(() => n++);
    const b = stream();
    attachJob(job.id, res(b));
    a.close();
    expect(n).toBe(0);
    b.close();
    expect(n).toBe(1);
  });

  it("Stop runs the stop hooks, says stopped, and ends it; a second Stop says ended", () => {
    const a = stream();
    const job = startJob("/api/workspace/exec", params, res(a));
    let killed = 0;
    job.onStop(() => killed++);
    expect(stopJob(job.id)).toBe("stopped");
    expect(killed).toBe(1);
    expect(a.frames.at(-1)).toMatchObject({
      type: "done",
      exitCode: STOPPED_EXIT,
      stopped: true,
    });
    expect(a.writableEnded).toBe(true);
    expect(job.ended).toBe(true);
    expect(getJob(job.id)).toMatchObject({ stopped: true, exitCode: 130 });
    expect(stopJob(job.id)).toBe("ended");
    expect(stopJob("run_none")).toBe("missing");
    expect(attachJob("run_none", res(stream()))).toBe(false);
  });

  it("keeps the last events of a long run, and a bounded number of ended runs; never drops a running one", () => {
    const job = startJob("/api/workspace/exec", params, res(stream()));
    for (let i = 0; i < MAX_JOB_EVENTS + 10; i++)
      job.write({ type: "line", text: String(i) });
    const b = stream();
    attachJob(job.id, res(b));
    expect(b.frames).toHaveLength(MAX_JOB_EVENTS);
    expect(b.frames.at(-1)).toMatchObject({ text: String(MAX_JOB_EVENTS + 9) });
    for (let i = 0; i < MAX_FINISHED_JOBS + 5; i++) {
      const j = startJob("/api/service/exec", params, res(stream()));
      j.end();
    }
    const kept = listJobs();
    expect(kept.filter((j) => j.status === "done")).toHaveLength(
      MAX_FINISHED_JOBS,
    );
    expect(kept.some((j) => j.id === job.id)).toBe(true);
  });
});
