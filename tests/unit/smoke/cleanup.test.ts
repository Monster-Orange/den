import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { EventEmitter } from "events";

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

import { spawn } from "child_process";
import * as fs from "fs";
import {
  acquireFixture,
  fixtureInstanceId,
  releaseFixturesForConsumer,
  resetFixtureManagerForTests,
} from "../../../src/pillars/smoke/cleanup.js";
import {
  registerSmokeFixtureReleaseHandles,
  releaseSmokeFixturesFromHandoff,
  resetSmokeFixtureBridgeForTests,
  smokeFixtureConsumerKey,
  SMOKE_FIXTURE_HANDOFF_PATH,
  writeSmokeFixtureHandoff,
} from "../../../src/pillars/smoke/global-teardown.js";

const mockSpawn = spawn as jest.Mock;

function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout?: EventEmitter;
    stderr?: EventEmitter;
  };
  return proc;
}

/** Spawn waits for `close`; schedule success so `await acquireFixture` does not deadlock. */
function mockSpawnAutoClose() {
  mockSpawn.mockImplementation(() => {
    const proc = fakeProc();
    queueMicrotask(() => {
      proc.emit("close", 0);
    });
    return proc;
  });
}

describe("fixture manager", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    resetFixtureManagerForTests();
    resetSmokeFixtureBridgeForTests();
  });

  it("uses stable identity for fixtureKey + resolvedPayload (key order independent)", () => {
    const a = fixtureInstanceId("api:storage:local", {
      bucket: "b",
      endpoint: "e",
    });
    const b = fixtureInstanceId("api:storage:local", {
      endpoint: "e",
      bucket: "b",
    });
    expect(a).toBe(b);
  });

  it("treats explicit undefined values as part of fixture identity", () => {
    const a = fixtureInstanceId("api:storage:local", {});
    const b = fixtureInstanceId("api:storage:local", { optional: undefined });
    expect(a).not.toBe(b);
  });

  it("runs setup once for repeated consumers of the same fixture identity", async () => {
    mockSpawnAutoClose();

    const spec = {
      fixtureKey: "api:storage:local",
      resolvedPayload: { bucket: "artifacts-smoke" },
      cwd: "/repos/files-api",
      env: { ...process.env, FOO: "1" },
      setup: "node scripts/setup.mjs",
      teardown: "node scripts/teardown.mjs",
    };

    const releaseA = await acquireFixture(spec);
    const releaseB = await acquireFixture(spec);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      "node scripts/setup.mjs",
      [],
      expect.objectContaining({
        cwd: "/repos/files-api",
        shell: true,
        stdio: "inherit",
        env: expect.objectContaining({ FOO: "1" }),
      }),
    );

    await releaseA();
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    await releaseB();
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn).toHaveBeenLastCalledWith(
      "node scripts/teardown.mjs",
      [],
      expect.objectContaining({
        cwd: "/repos/files-api",
        shell: true,
        stdio: "inherit",
      }),
    );
  });

  it("does not share an instance for the same fixture key with different resolved payloads", async () => {
    mockSpawnAutoClose();

    const base = {
      fixtureKey: "api:storage:local",
      cwd: "/repos/files-api",
      env: process.env,
      setup: "node scripts/setup.mjs",
      teardown: "node scripts/teardown.mjs",
    };

    const r1 = await acquireFixture({
      ...base,
      resolvedPayload: { bucket: "bucket-a" },
    });
    const r2 = await acquireFixture({
      ...base,
      resolvedPayload: { bucket: "bucket-b" },
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "node scripts/setup.mjs",
      [],
      expect.anything(),
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      "node scripts/setup.mjs",
      [],
      expect.anything(),
    );

    await r1();
    await r2();
    expect(mockSpawn).toHaveBeenCalledTimes(4);
    expect(mockSpawn).toHaveBeenNthCalledWith(
      3,
      "node scripts/teardown.mjs",
      [],
      expect.anything(),
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(
      4,
      "node scripts/teardown.mjs",
      [],
      expect.anything(),
    );
  });

  it("runs teardown only after the last consumer releases", async () => {
    mockSpawnAutoClose();

    const spec = {
      fixtureKey: "svc:storage:dev",
      resolvedPayload: { bucket: "x" },
      cwd: "/r",
      env: process.env,
      setup: "setup-cmd",
      teardown: "teardown-cmd",
    };

    const rel1 = await acquireFixture(spec);
    const rel2 = await acquireFixture(spec);

    mockSpawn.mockClear();
    mockSpawnAutoClose();

    await rel1();
    expect(mockSpawn).not.toHaveBeenCalled();

    await rel2();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      "teardown-cmd",
      [],
      expect.anything(),
    );
  });

  it("still runs teardown when work fails if release is called from finally", async () => {
    mockSpawnAutoClose();

    const spec = {
      fixtureKey: "svc:storage:dev",
      resolvedPayload: { bucket: "x" },
      cwd: "/r",
      env: process.env,
      setup: "setup-cmd",
      teardown: "teardown-cmd",
    };

    const release = await acquireFixture(spec);

    let err: unknown;
    try {
      mockSpawn.mockClear();
      mockSpawnAutoClose();
      throw new Error("test failure");
    } catch (e) {
      err = e;
    } finally {
      await release();
    }

    expect(err).toBeInstanceOf(Error);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      "teardown-cmd",
      [],
      expect.anything(),
    );
  });

  it("duplicate acquire from one logical flow does not duplicate setup; both releases teardown once", async () => {
    mockSpawnAutoClose();

    const spec = {
      fixtureKey: "k",
      resolvedPayload: { v: 1 },
      cwd: "/c",
      env: process.env,
      setup: "s",
      teardown: "t",
    };

    const relA = await acquireFixture(spec);
    const relB = await acquireFixture(spec);

    expect(mockSpawn).toHaveBeenCalledTimes(1);

    mockSpawn.mockClear();
    mockSpawnAutoClose();

    await releaseFixturesForConsumer([relA, relB]);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith("t", [], expect.anything());
  });

  it("releases every handle in LIFO order even when an earlier teardown fails", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = fakeProc();
      queueMicrotask(() => {
        proc.emit("close", 0);
      });
      return proc;
    });

    const relA = await acquireFixture({
      fixtureKey: "fa",
      resolvedPayload: { id: "a" },
      cwd: "/a",
      env: process.env,
      setup: "setup-a",
      teardown: "teardown-a",
    });
    const relB = await acquireFixture({
      fixtureKey: "fb",
      resolvedPayload: { id: "b" },
      cwd: "/b",
      env: process.env,
      setup: "setup-b",
      teardown: "teardown-b",
    });

    mockSpawn.mockClear();
    mockSpawn.mockImplementation((...args: unknown[]) => {
      const proc = fakeProc();
      const command = String(args[0] ?? "");
      queueMicrotask(() => {
        if (command === "teardown-b") {
          proc.emit("close", 1);
        } else {
          proc.emit("close", 0);
        }
      });
      return proc;
    });

    await expect(releaseFixturesForConsumer([relA, relB])).rejects.toThrow(
      /Fixture teardown failed/u,
    );

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "teardown-b",
      [],
      expect.anything(),
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      "teardown-a",
      [],
      expect.anything(),
    );
  });

  it("release is idempotent (second call does not double-decrement)", async () => {
    mockSpawnAutoClose();

    const spec = {
      fixtureKey: "k2",
      resolvedPayload: {},
      cwd: "/c",
      env: process.env,
      setup: "s",
      teardown: "t",
    };

    const rel = await acquireFixture(spec);

    mockSpawn.mockClear();
    mockSpawnAutoClose();

    await rel();
    await rel();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting specs for the same shared fixture identity", async () => {
    mockSpawnAutoClose();

    const release = await acquireFixture({
      fixtureKey: "shared-storage",
      resolvedPayload: { bucket: "artifacts-smoke" },
      cwd: "/repos/files-api",
      env: { ...process.env, MODE: "a" },
      setup: "node scripts/setup-a.mjs",
      teardown: "node scripts/teardown-a.mjs",
    });

    await expect(
      acquireFixture({
        fixtureKey: "shared-storage",
        resolvedPayload: { bucket: "artifacts-smoke" },
        cwd: "/repos/other-path",
        env: { ...process.env, MODE: "b" },
        setup: "node scripts/setup-b.mjs",
        teardown: "node scripts/teardown-b.mjs",
      }),
    ).rejects.toThrow(/Conflicting fixture specs/);

    mockSpawn.mockClear();
    mockSpawnAutoClose();
    await release();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

describe("smoke fixture setup/teardown bridge", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    resetFixtureManagerForTests();
    resetSmokeFixtureBridgeForTests();
  });

  it("single consumer: handoff-driven release runs teardown once", async () => {
    mockSpawnAutoClose();

    const spec = {
      fixtureKey: "api:storage:local",
      resolvedPayload: { bucket: "artifacts-smoke" },
      cwd: "/repos/files-api",
      env: { ...process.env, FOO: "1" },
      setup: "node scripts/setup.mjs",
      teardown: "node scripts/teardown.mjs",
    };

    const release = await acquireFixture(spec);
    const consumerKey = smokeFixtureConsumerKey("sample-repo", "api");
    registerSmokeFixtureReleaseHandles(consumerKey, [release]);
    writeSmokeFixtureHandoff({
      consumersInAcquireOrder: [consumerKey],
      bindings: [
        {
          consumerKey,
          fixtureInstanceId: fixtureInstanceId(
            spec.fixtureKey,
            spec.resolvedPayload,
          ),
        },
      ],
    });

    mockSpawn.mockClear();
    mockSpawnAutoClose();
    await releaseSmokeFixturesFromHandoff();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      "node scripts/teardown.mjs",
      [],
      expect.objectContaining({
        cwd: "/repos/files-api",
        shell: true,
        stdio: "inherit",
      }),
    );
    expect(fs.existsSync(SMOKE_FIXTURE_HANDOFF_PATH)).toBe(false);
  });

  it("multi-service consumers with matching identity share setup; teardown after last consumer only", async () => {
    mockSpawnAutoClose();

    const base = {
      fixtureKey: "api:storage:local",
      resolvedPayload: { bucket: "shared-bucket" },
      cwd: "/repos/files-api",
      env: process.env,
      setup: "node scripts/setup.mjs",
      teardown: "node scripts/teardown.mjs",
    };

    const relA = await acquireFixture(base);
    const relB = await acquireFixture(base);
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    const keyA = smokeFixtureConsumerKey("files-api", "api");
    const keyB = smokeFixtureConsumerKey("files-api", "ingest");
    registerSmokeFixtureReleaseHandles(keyA, [relA]);
    registerSmokeFixtureReleaseHandles(keyB, [relB]);
    const iid = fixtureInstanceId(base.fixtureKey, base.resolvedPayload);
    writeSmokeFixtureHandoff({
      consumersInAcquireOrder: [keyA, keyB],
      bindings: [
        { consumerKey: keyA, fixtureInstanceId: iid },
        { consumerKey: keyB, fixtureInstanceId: iid },
      ],
    });

    mockSpawn.mockClear();
    mockSpawnAutoClose();
    await releaseSmokeFixturesFromHandoff();

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      "node scripts/teardown.mjs",
      [],
      expect.anything(),
    );
  });

  it("handoff release order is LIFO across consumers (release-driven)", async () => {
    mockSpawnAutoClose();

    const specA = {
      fixtureKey: "fa",
      resolvedPayload: { id: "a" },
      cwd: "/a",
      env: process.env,
      setup: "setup-a",
      teardown: "teardown-a",
    };
    const specB = {
      fixtureKey: "fb",
      resolvedPayload: { id: "b" },
      cwd: "/b",
      env: process.env,
      setup: "setup-b",
      teardown: "teardown-b",
    };

    const relA = await acquireFixture(specA);
    const relB = await acquireFixture(specB);

    const keyA = smokeFixtureConsumerKey("r", "a");
    const keyB = smokeFixtureConsumerKey("r", "b");
    registerSmokeFixtureReleaseHandles(keyA, [relA]);
    registerSmokeFixtureReleaseHandles(keyB, [relB]);
    writeSmokeFixtureHandoff({
      consumersInAcquireOrder: [keyA, keyB],
      bindings: [
        {
          consumerKey: keyA,
          fixtureInstanceId: fixtureInstanceId(
            specA.fixtureKey,
            specA.resolvedPayload,
          ),
        },
        {
          consumerKey: keyB,
          fixtureInstanceId: fixtureInstanceId(
            specB.fixtureKey,
            specB.resolvedPayload,
          ),
        },
      ],
    });

    mockSpawn.mockClear();
    mockSpawnAutoClose();
    await releaseSmokeFixturesFromHandoff();

    expect(mockSpawn).toHaveBeenNthCalledWith(
      1,
      "teardown-b",
      [],
      expect.anything(),
    );
    expect(mockSpawn).toHaveBeenNthCalledWith(
      2,
      "teardown-a",
      [],
      expect.anything(),
    );
  });
});
