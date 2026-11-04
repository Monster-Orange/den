import {
  describe,
  expect,
  it,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";
import type { ResolvedService } from "../../../src/shared/types/index.js";

jest.mock("../../../src/shared/environment-manager/health.js");

import { waitForReady } from "../../../src/shared/environment-manager/readiness.js";
import { checkServiceHealth } from "../../../src/shared/environment-manager/health.js";

const mockCheck = checkServiceHealth as jest.MockedFunction<
  typeof checkServiceHealth
>;

function makeResolved(address = "shop/db"): ResolvedService {
  return {
    address,
    repoName: address.split("/")[0],
    subsystem: address.includes("/") ? address.split("/")[1] : address,
    repoPath: `/repos/${address.split("/")[0]}`,
    branch: null,
    mode: "dev-managed",
  };
}

function makeResult(
  health: "ok" | "error" | "unknown",
  detail?: string,
): ReturnType<typeof checkServiceHealth> extends Promise<infer R> ? R : never {
  const r = makeResolved();
  return {
    address: r.address,
    repoName: r.repoName,
    subsystem: r.subsystem,
    repoPath: r.repoPath,
    mode: r.mode,
    branch: null,
    health,
    healthDetail: detail,
  };
}

beforeEach(() => {
  mockCheck.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("waitForReady", () => {
  it("returns ok immediately when first check is healthy", async () => {
    mockCheck.mockResolvedValueOnce(makeResult("ok"));
    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue();

    const result = await waitForReady(makeResolved(), "local", {
      timeoutMs: 10_000,
      intervalMs: 100,
      sleep,
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(sleep).not.toHaveBeenCalled();
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });

  it("fails open (skipped: true) when the dep has no health config", async () => {
    mockCheck.mockResolvedValueOnce(
      makeResult("unknown", "no health check configured"),
    );

    const result = await waitForReady(makeResolved(), "local", {
      timeoutMs: 10_000,
      intervalMs: 100,
      sleep: jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(),
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.detail).toBe("no health check configured");
  });

  it("polls until health becomes ok", async () => {
    mockCheck
      .mockResolvedValueOnce(makeResult("error", "connection refused"))
      .mockResolvedValueOnce(makeResult("error", "connection refused"))
      .mockResolvedValueOnce(makeResult("ok"));

    const sleep = jest.fn<(ms: number) => Promise<void>>().mockResolvedValue();
    const ticks: string[] = [];

    const result = await waitForReady(makeResolved(), "local", {
      timeoutMs: 10_000,
      intervalMs: 100,
      sleep,
      onTick: (detail) => ticks.push(detail),
    });

    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(mockCheck).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(ticks).toEqual(["connection refused", "connection refused"]);
  });

  it("times out when health never becomes ok", async () => {
    mockCheck.mockResolvedValue(makeResult("error", "connection refused"));

    // Simulate time passing on every now() call so the deadline is reached
    // after a small number of iterations.
    let t = 0;
    const now = jest.fn<() => number>(() => {
      const v = t;
      t += 600; // each call advances 600ms
      return v;
    });

    const result = await waitForReady(makeResolved(), "local", {
      timeoutMs: 1_000,
      intervalMs: 100,
      sleep: jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(),
      now,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("connection refused");
  });

  it("bails early with detail='cancelled' when isCancelled returns true between polls", async () => {
    mockCheck
      .mockResolvedValueOnce(makeResult("error", "connection refused"))
      .mockResolvedValueOnce(makeResult("error", "connection refused"));

    let pollsCompleted = 0;
    // Cancel after the second poll.
    const isCancelled = jest.fn<() => boolean>(() => pollsCompleted >= 2);

    const sleep = jest
      .fn<(ms: number) => Promise<void>>()
      .mockImplementation(async () => {
        pollsCompleted++;
      });

    const result = await waitForReady(makeResolved(), "local", {
      timeoutMs: 60_000,
      intervalMs: 100,
      sleep,
      isCancelled,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("cancelled");
    // Should not hit the third mockResolvedValueOnce — no more health calls after cancel.
    expect(mockCheck.mock.calls.length).toBeLessThan(4);
  });

  it("reports timeout with a default detail when healthDetail is missing", async () => {
    mockCheck.mockResolvedValue(makeResult("error"));

    let t = 0;
    const now = jest.fn<() => number>(() => {
      const v = t;
      t += 2_000;
      return v;
    });

    const result = await waitForReady(makeResolved(), "local", {
      timeoutMs: 1_000,
      intervalMs: 100,
      sleep: jest.fn<(ms: number) => Promise<void>>().mockResolvedValue(),
      now,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("timeout");
  });
});
