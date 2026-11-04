import { describe, it, expect, jest, beforeEach } from "@jest/globals";

// Keep telemetry inert (no JSONL writes / Sentry) during the test.
jest.mock("../../../src/shared/dev-metrics/emit.js", () => ({
  recordInvocation: jest.fn(),
  recordFailure: jest.fn(),
}));

// Control the deploy: capture its emit + resolve it on demand so we can drive
// the session lifecycle deterministically.
const deploy =
  jest.fn<
    (
      env: string,
      plan: unknown[],
      emit: (ev: unknown) => void,
      aborted: () => boolean,
    ) => Promise<boolean>
  >();
jest.mock("../../../src/ui/server/release-service.js", () => ({
  releaseService: { deploy },
}));

import { deploySessions } from "../../../src/ui/server/release-deploy-session.js";

type Ev = { type: string; [k: string]: unknown };

/** Flush pending microtasks so promise .then/.finally on the mock resolve. */
const flush = () => new Promise((r) => setImmediate(r));

describe("deploySessions — decoupled, replayable deploy sessions", () => {
  let capturedEmit: (ev: Ev) => void = () => {};
  let capturedAborted: () => boolean = () => false;
  let resolveDeploy: (ok: boolean) => void = () => {};

  beforeEach(() => {
    // The manager is a module singleton and now holds MANY sessions — clear
    // every leftover, or one test's running deploys leak into the next.
    for (const s of deploySessions.active()) deploySessions.dismiss(s.id);

    deploy.mockReset();
    deploy.mockImplementation((_env, _plan, emit, aborted) => {
      capturedEmit = emit as (ev: Ev) => void;
      capturedAborted = aborted;
      return new Promise<boolean>((resolve) => {
        resolveDeploy = resolve;
      });
    });
  });

  const plan = (repo: string) => [
    { repo, workflow: "cd.yml", ref: "main", wave: 0 },
  ];

  const start = (repo = "jobs-runtime", env = "sandbox") =>
    deploySessions.start({
      env,
      mode: "single",
      label: `${repo} → ${env}`,
      plan: plan(repo),
      notices: [{ type: "log", text: "▶ deploy single → sandbox · 1 repo(s)" }],
    });

  it("starts a running session that is restorable via active()", () => {
    const s = start();
    expect(s).not.toBeNull();
    expect(s!.status).toBe("running");
    expect(s!.repos).toEqual(["jobs-runtime"]);
    expect(deploySessions.active().map((a) => a.id)).toContain(s!.id);
    expect(deploySessions.busy()).toBe(true);
  });

  it("replays the buffered log to a late attacher, then streams live events", () => {
    const s = start()!;
    capturedEmit({ type: "log", text: "line-1" });

    const seen: Ev[] = [];
    const unsub = deploySessions.attach(s.id, (ev) => seen.push(ev as Ev));
    expect(unsub).not.toBeNull();
    // Replay = the notice + the one live line emitted before attaching.
    expect(seen.map((e) => e.text)).toEqual([
      "▶ deploy single → sandbox · 1 repo(s)",
      "line-1",
    ]);

    // A subsequent live event streams to the attached subscriber.
    capturedEmit({ type: "log", text: "line-2" });
    expect(seen[seen.length - 1].text).toBe("line-2");

    unsub!();
    capturedEmit({ type: "log", text: "after-unsub" });
    expect(seen.find((e) => e.text === "after-unsub")).toBeUndefined();
  });

  it("runs deploys of different systems concurrently", () => {
    // Different repos dispatch to different GitHub repos, each with its own
    // concurrency group — a global lock only blocked work that never collided.
    const a = start("jobs-runtime");
    const b = start("files-api");
    const c = start("shop");
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    const running = deploySessions
      .active()
      .filter((s) => s.status === "running");
    expect(running).toHaveLength(3);
  });

  it("reports a conflict only for the same repo in the same env", () => {
    start("jobs-runtime", "sandbox");

    // Same repo + same env would race two runs against one concurrency group.
    expect(deploySessions.conflicts("sandbox", plan("jobs-runtime"))).toEqual([
      "jobs-runtime",
    ]);

    // A different repo is unaffected…
    expect(deploySessions.conflicts("sandbox", plan("files-api"))).toEqual([]);
    // …as is the same repo targeting a different environment.
    expect(deploySessions.conflicts("dev", plan("jobs-runtime"))).toEqual([]);
  });

  it("reports the conflicting subset of a multi-repo plan", () => {
    start("jobs-runtime", "sandbox");
    start("shop", "sandbox");
    expect(
      deploySessions.conflicts("sandbox", [
        ...plan("jobs-runtime"),
        ...plan("files-api"),
        ...plan("shop"),
      ]),
    ).toEqual(["jobs-runtime", "shop"]);
  });

  it("frees a repo for redeploy once its session finishes", async () => {
    start("jobs-runtime", "sandbox");
    expect(deploySessions.conflicts("sandbox", plan("jobs-runtime"))).toEqual([
      "jobs-runtime",
    ]);
    resolveDeploy(true);
    await flush();
    expect(deploySessions.conflicts("sandbox", plan("jobs-runtime"))).toEqual(
      [],
    );
  });

  it("marks the session done on completion and keeps it restorable until dismissed", async () => {
    const s = start()!;
    capturedEmit({ type: "done", ok: true, summary: "ok" });
    resolveDeploy(true);
    await flush();

    const active = deploySessions.active().find((a) => a.id === s.id);
    expect(active?.status).toBe("done");
    expect(deploySessions.busy()).toBe(false);

    // A fresh attach still replays the full log including the terminal done.
    const seen: Ev[] = [];
    deploySessions.attach(s.id, (ev) => seen.push(ev as Ev));
    expect(seen.some((e) => e.type === "done")).toBe(true);

    // A new deploy is allowed once the prior finished.
    expect(start()).not.toBeNull();
  });

  it("dismiss() signals the deploy to abort and removes it from restore", async () => {
    const s = start()!;
    expect(capturedAborted()).toBe(false);
    expect(deploySessions.dismiss(s.id)).toBe(true);
    expect(capturedAborted()).toBe(true); // deploy's aborted() now trips
    expect(deploySessions.active().map((a) => a.id)).not.toContain(s.id);

    // Once the aborted deploy loop resolves the session is gone for good, and
    // its repo is no longer treated as in-flight.
    resolveDeploy(false);
    await flush();
    expect(deploySessions.active().map((a) => a.id)).not.toContain(s.id);
    expect(deploySessions.attach(s.id, () => {})).toBeNull();
    expect(deploySessions.conflicts("sandbox", plan("jobs-runtime"))).toEqual(
      [],
    );
  });

  it("attach() returns null for an unknown/closed session", () => {
    expect(deploySessions.attach("nope", () => {})).toBeNull();
  });
});
