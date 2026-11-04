/**
 * Unit tests for TestRunner logic that doesn't require spawning processes
 * or launching real browsers.
 *
 * Covered:
 *  - formatDuration     pure private helper — milliseconds → human string
 *  - getBaseUrl         reads real config/environments/*.json
 *  - getApiUrl          reads real config/environments/*.json
 *  - pingServer         HTTP health check decision logic (fetch mocked)
 *  - spawnStreaming      ANSI-stripping and line-splitting (spawn mocked)
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

// ─── Mock child_process.spawn before TestRunner is imported ──────────────────

jest.mock("child_process", () => ({
  spawn: jest.fn(),
}));

// @playwright/test is imported transitively via token-refresh.ts; mock it so
// no browser is launched even if the module is loaded.
jest.mock("@playwright/test", () => ({
  chromium: { launch: jest.fn() },
}));

// Mock inquirer so interactive prompts don't block tests
jest.mock("inquirer", () => ({
  default: {
    prompt: jest
      .fn()
      .mockResolvedValue({ shouldContinue: false, shouldSetup: false }),
  },
  prompt: jest
    .fn()
    .mockResolvedValue({ shouldContinue: false, shouldSetup: false }),
}));

// Mock token refresh to avoid Playwright browser launches
jest.mock("../../src/shared/auth/token-refresh.js", () => ({
  refreshAuthIfNeeded: jest.fn().mockResolvedValue(true),
}));

import { EventEmitter } from "events";
import { spawn } from "child_process";
import { TestRunner } from "../../src/ui/cli/test-runner.js";

const mockSpawn = spawn as jest.Mock;
const runner = new TestRunner();

// ─── formatDuration ───────────────────────────────────────────────────────────

describe("TestRunner.formatDuration (private)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fmt = (ms: number) => (runner as any).formatDuration(ms);

  it("returns milliseconds for durations under 1 second", () => {
    expect(fmt(0)).toBe("0ms");
    expect(fmt(500)).toBe("500ms");
    expect(fmt(999)).toBe("999ms");
  });

  it("returns seconds for durations between 1s and 1m", () => {
    expect(fmt(1000)).toBe("1s");
    expect(fmt(59000)).toBe("59s");
  });

  it("returns minutes and seconds for durations of 1m or more", () => {
    expect(fmt(60000)).toBe("1m 0s");
    expect(fmt(90000)).toBe("1m 30s");
    expect(fmt(125000)).toBe("2m 5s");
  });
});

// ─── getBaseUrl / getApiUrl ───────────────────────────────────────────────────

describe("TestRunner.getBaseUrl / getApiUrl (private)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getBaseUrl = (env: string) => (runner as any).getBaseUrl(env);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getApiUrl = (env: string) => (runner as any).getApiUrl(env);

  it("getBaseUrl('local') reads the real config and returns the web URL", async () => {
    const url = await getBaseUrl("local");
    expect(url).toBe("http://localhost:3000");
  });

  it("getApiUrl('local') reads the real config and returns the api URL", async () => {
    const url = await getApiUrl("local");
    expect(url).toBe("http://localhost:3001");
  });

  it("getBaseUrl falls back to localhost:3000 for unknown environments", async () => {
    const url = await getBaseUrl("does-not-exist-xyz");
    expect(url).toBe("http://localhost:3000");
  });

  it("getApiUrl falls back to localhost:4000 for unknown environments", async () => {
    const url = await getApiUrl("does-not-exist-xyz");
    expect(url).toBe("http://localhost:4000");
  });
});

// ─── pingServer ───────────────────────────────────────────────────────────────

describe("TestRunner.pingServer (private) — HTTP status decision logic", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ping = (url: string) => (runner as any).pingServer(url, "Test Server");

  let fetchSpy: jest.SpiedFunction<typeof global.fetch>;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, "fetch") as jest.SpiedFunction<
      typeof global.fetch
    >;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  const fakeResponse = (status: number) =>
    Promise.resolve({ status } as Response);

  it("returns true for 200 OK", async () => {
    fetchSpy.mockReturnValue(fakeResponse(200));
    expect(await ping("http://localhost:3000")).toBe(true);
  });

  it("returns true for 3xx redirects (server is up)", async () => {
    fetchSpy.mockReturnValue(fakeResponse(301));
    expect(await ping("http://localhost:3000")).toBe(true);
    fetchSpy.mockReturnValue(fakeResponse(302));
    expect(await ping("http://localhost:3000")).toBe(true);
  });

  it("returns true for 401 Unauthorized (auth is working — server is up)", async () => {
    fetchSpy.mockReturnValue(fakeResponse(401));
    expect(await ping("http://localhost:3000")).toBe(true);
  });

  it("returns true for 403 Forbidden (server is up)", async () => {
    fetchSpy.mockReturnValue(fakeResponse(403));
    expect(await ping("http://localhost:3000")).toBe(true);
  });

  it("returns false for 404 Not Found", async () => {
    fetchSpy.mockReturnValue(fakeResponse(404));
    expect(await ping("http://localhost:3000")).toBe(false);
  });

  it("returns false for 500 Internal Server Error", async () => {
    fetchSpy.mockReturnValue(fakeResponse(500));
    expect(await ping("http://localhost:3000")).toBe(false);
  });

  it("returns false when fetch throws AbortError (timeout)", async () => {
    const err = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    fetchSpy.mockRejectedValue(err);
    expect(await ping("http://localhost:3000")).toBe(false);
  });

  it("returns false when fetch throws ECONNREFUSED", async () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    fetchSpy.mockRejectedValue(err);
    expect(await ping("http://localhost:3000")).toBe(false);
  });

  it("returns false when fetch throws ENOTFOUND (hostname not found)", async () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
    });
    fetchSpy.mockRejectedValue(err);
    expect(await ping("http://nonexistent.invalid")).toBe(false);
  });
});

// ─── spawnStreaming ───────────────────────────────────────────────────────────

describe("TestRunner.spawnStreaming — ANSI stripping and line splitting", () => {
  beforeEach(() => {
    mockSpawn.mockClear();
  });

  function makeProc() {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    return proc;
  }

  it("strips ANSI colour codes from stdout lines", () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);

    const lines: string[] = [];
    runner.spawnStreaming(
      "echo",
      ["hi"],
      {},
      (l) => lines.push(l),
      () => {},
    );

    proc.stdout.emit("data", Buffer.from("\x1b[32mGreen text\x1b[0m"));
    expect(lines).toEqual(["Green text"]);
  });

  it("strips ANSI codes from stderr lines", () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);

    const lines: string[] = [];
    runner.spawnStreaming(
      "echo",
      ["err"],
      {},
      (l) => lines.push(l),
      () => {},
    );

    proc.stderr.emit("data", Buffer.from("\x1b[31mError message\x1b[0m"));
    expect(lines).toEqual(["Error message"]);
  });

  it("splits multi-line output into separate onLine calls", () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);

    const lines: string[] = [];
    runner.spawnStreaming(
      "cmd",
      [],
      {},
      (l) => lines.push(l),
      () => {},
    );

    proc.stdout.emit("data", Buffer.from("line one\nline two\nline three\n"));
    expect(lines).toEqual(["line one", "line two", "line three"]);
  });

  it("ignores blank/whitespace-only lines", () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);

    const lines: string[] = [];
    runner.spawnStreaming(
      "cmd",
      [],
      {},
      (l) => lines.push(l),
      () => {},
    );

    proc.stdout.emit("data", Buffer.from("real line\n   \n\nother line\n"));
    expect(lines).toEqual(["real line", "other line"]);
  });

  it("calls onClose with the process exit code", () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);

    const closeCodes: number[] = [];
    runner.spawnStreaming(
      "cmd",
      [],
      {},
      () => {},
      (code) => closeCodes.push(code),
    );

    proc.emit("close", 42);
    expect(closeCodes).toEqual([42]);
  });

  it("calls onClose with 1 when the process exits with null code", () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);

    const closeCodes: number[] = [];
    runner.spawnStreaming(
      "cmd",
      [],
      {},
      () => {},
      (code) => closeCodes.push(code),
    );

    proc.emit("close", null);
    expect(closeCodes).toEqual([1]);
  });

  it("emits error message and calls onClose(1) on process error", () => {
    const proc = makeProc();
    mockSpawn.mockReturnValue(proc);

    const lines: string[] = [];
    const closeCodes: number[] = [];
    runner.spawnStreaming(
      "bad-cmd",
      [],
      {},
      (l) => lines.push(l),
      (code) => closeCodes.push(code),
    );

    proc.emit("error", new Error("ENOENT"));
    expect(lines.some((l) => l.includes("ENOENT"))).toBe(true);
    expect(closeCodes).toEqual([1]);
  });
});

// ── executeTestCommand (via runTests) ────────────────────────────────────────
// These tests exercise the pillar dispatch and individual run methods by
// calling the public runTests() method with a mock spawn that immediately
// exits with a controlled code.

describe("TestRunner pillar dispatch", () => {
  /** Make spawn immediately emit close with a given code. */
  function spawnExits(code: number) {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as ReturnType<
        typeof import("child_process").spawn
      >;
      (proc as unknown as Record<string, unknown>).stdout = new EventEmitter();
      (proc as unknown as Record<string, unknown>).stderr = new EventEmitter();
      process.nextTick(() => proc.emit("close", code));
      return proc;
    });
  }

  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("throws for unknown pillar", async () => {
    spawnExits(0);
    await expect(
      runner.runTests({
        pillar: "nonexistent" as "smoke",
        environment: "local",
      }),
    ).rejects.toThrow("Unknown pillar");
  });

  it("runs smoke tests via make target", async () => {
    spawnExits(0);
    const result = await runner.runTests({
      pillar: "smoke",
      environment: "local",
      modules: ["shop/api"],
    });
    expect(result.success).toBe(true);
    expect(mockSpawn).toHaveBeenCalledWith(
      "make",
      expect.arrayContaining(["test-smk-api-all"]),
      expect.anything(),
    );
  });

  it("builds correct smoke target with collection", async () => {
    spawnExits(0);
    await runner.runTests({
      pillar: "smoke",
      environment: "local",
      modules: ["shop/api"],
      smokeCollection: "items",
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      "make",
      expect.arrayContaining(["test-smk-api-items"]),
      expect.anything(),
    );
  });

  it("uses test-smk-all when no smoke module specified", async () => {
    spawnExits(0);
    await runner.runTests({
      pillar: "smoke",
      environment: "local",
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      "make",
      expect.arrayContaining(["test-smk-all"]),
      expect.anything(),
    );
  });

  it("returns failure when spawn exits non-zero", async () => {
    spawnExits(1);
    const result = await runner.runTests({
      pillar: "smoke",
      environment: "local",
    });
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
  });
});

// ── partitionPerformanceModules ─────────────────────────────────────────────

describe("TestRunner.partitionPerformanceModules (private)", () => {
  // Accessed indirectly via buildCommand which calls partitionPerformanceModules

  it("separates internal modules from repo-scoped modules", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "local",
      modules: ["api-health", "files-api/ingest"],
    });
    // Internal module → k6 run step
    expect(
      steps.some((s) => s.args.some((a: string) => a.includes("api-health"))),
    ).toBe(true);
    // Repo module → tsx run step
    expect(
      steps.some((s) => s.args.some((a: string) => a.includes("files-api"))),
    ).toBe(true);
  });

  it("returns empty steps when no performance modules specified", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "local",
      modules: [],
    });
    expect(steps).toEqual([]);
  });
});

// ── buildCommand ────────────────────────────────────────────────────────────

describe("TestRunner.buildCommand — all pillars", () => {
  it("smoke: stages and runs playwright when modules specified", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "local",
      modules: ["shop/api"],
    });
    // stage + playwright run + teardown verify
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.some((s) => s.label?.includes("Stage"))).toBe(true);
    expect(steps.some((s) => s.args.includes("playwright"))).toBe(true);
  });

  it("smoke: stages all and runs global config when no modules", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "local",
    });
    expect(
      steps.some((s) => s.args.includes("src/pillars/smoke/setup-global.ts")),
    ).toBe(true);
    expect(
      steps.some((s) =>
        s.args.includes(
          "--config=src/pillars/smoke/playwright-global.config.ts",
        ),
      ),
    ).toBe(true);
  });

  it("smoke: targets specific suite dir when smokeCollection is set", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "local",
      modules: ["shop/api"],
      smokeCollection: "items",
    });
    expect(
      steps.some((s) => s.args.some((a: string) => a.includes("items"))),
    ).toBe(true);
  });

  it("integration: produces one npx playwright step", () => {
    const steps = runner.buildCommand({
      pillar: "integration",
      environment: "local",
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].command).toBe("npx");
    expect(steps[0].args).toContain("playwright");
  });

  it("integration: adds module path when modules specified", () => {
    const steps = runner.buildCommand({
      pillar: "integration",
      environment: "local",
      modules: ["items"],
    });
    expect(steps[0].args).toContain("src/pillars/api/tests/items/");
  });

  it("synthetic: produces two steps (stage + run)", () => {
    const steps = runner.buildCommand({
      pillar: "synthetic",
      environment: "local",
    });
    expect(steps).toHaveLength(2);
    expect(steps[0].label).toBe("Stage tests");
    expect(steps[1].label).toBe("Run Playwright");
  });

  it("performance: internal module produces k6 + report steps", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "local",
      modules: ["api-health"],
    });
    expect(steps.length).toBeGreaterThanOrEqual(2); // k6 run + report
    expect(steps[0].command).toBe("k6");
  });

  it("performance: repo module produces env-setup + tsx run steps for non-local", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "staging",
      modules: ["files-api/ingest"],
    });
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(
      steps.some((s) => s.args.some((a: string) => a.includes("setup-env"))),
    ).toBe(true);
  });

  it("performance: repo module skips env-setup for local", () => {
    const steps = runner.buildCommand({
      pillar: "performance",
      environment: "local",
      modules: ["files-api/ingest"],
    });
    expect(
      steps.every((s) => !s.args.some((a: string) => a.includes("setup-env"))),
    ).toBe(true);
  });

  it("smoke: passes useLocalCheckout env var when set", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "staging",
      modules: ["shop/api"],
      useLocalCheckout: true,
    });
    expect(steps[0].env?.USE_LOCAL_CHECKOUT).toBe("1");
  });

  it("integration: adds --headed when headed option is true", () => {
    const steps = runner.buildCommand({
      pillar: "integration",
      environment: "local",
      headed: true,
    });
    expect(steps[0].args).toContain("--headed");
  });

  it("integration: adds --grep when grep option is set", () => {
    const steps = runner.buildCommand({
      pillar: "integration",
      environment: "local",
      grep: "auth",
    });
    expect(steps[0].args).toContain("--grep");
    expect(steps[0].args).toContain("auth");
  });

  it("sets PLAYWRIGHT_HTML_OPEN=never for all pillars", () => {
    for (const pillar of ["synthetic", "integration", "smoke"] as const) {
      const steps = runner.buildCommand({ pillar, environment: "local" });
      expect(steps[0].env?.PLAYWRIGHT_HTML_OPEN).toBe("never");
    }
  });

  it("passes BASE_API_URL when baseApiUrl is provided", () => {
    const steps = runner.buildCommand({
      pillar: "smoke",
      environment: "local",
      baseApiUrl: "http://custom:8080",
    });
    expect(steps[0].env?.BASE_API_URL).toBe("http://custom:8080");
  });
});

// ── checkK6Installed ────────────────────────────────────────────────────────

describe("TestRunner.checkK6Installed (private, via runTests)", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("returns failure when k6 is not installed", async () => {
    // First spawn call is `which k6` — make it fail
    mockSpawn.mockImplementationOnce(() => {
      const proc = new EventEmitter() as ReturnType<
        typeof import("child_process").spawn
      >;
      (proc as unknown as Record<string, unknown>).stdout = new EventEmitter();
      (proc as unknown as Record<string, unknown>).stderr = new EventEmitter();
      process.nextTick(() => proc.emit("close", 1)); // k6 not found
      return proc;
    });

    const result = await runner.runTests({
      pillar: "performance",
      environment: "local",
      modules: ["api-health"],
    });
    expect(result.success).toBe(false);
  });
});

// ── spawnProcess ────────────────────────────────────────────────────────────

describe("TestRunner.spawnProcess (private, via runTests)", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("resolves with success:true when process exits 0", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as ReturnType<
        typeof import("child_process").spawn
      >;
      (proc as unknown as Record<string, unknown>).stdout = new EventEmitter();
      (proc as unknown as Record<string, unknown>).stderr = new EventEmitter();
      process.nextTick(() => proc.emit("close", 0));
      return proc;
    });

    const result = await runner.runTests({
      pillar: "smoke",
      environment: "local",
    });
    expect(result.success).toBe(true);
  });

  it("returns failure when server health check fails for synthetic", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as ReturnType<
        typeof import("child_process").spawn
      >;
      (proc as unknown as Record<string, unknown>).stdout = new EventEmitter();
      (proc as unknown as Record<string, unknown>).stderr = new EventEmitter();
      process.nextTick(() => proc.emit("close", 0));
      return proc;
    });

    const origFetch = global.fetch;
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;

    const result = await runner.runTests({
      pillar: "synthetic",
      environment: "local",
    });
    // Health check fails → inquirer asks shouldContinue → mock returns false
    expect(result.success).toBe(false);
    global.fetch = origFetch;
  });

  it("resolves with success:false when process emits error", async () => {
    mockSpawn.mockImplementation(() => {
      const proc = new EventEmitter() as ReturnType<
        typeof import("child_process").spawn
      >;
      (proc as unknown as Record<string, unknown>).stdout = new EventEmitter();
      (proc as unknown as Record<string, unknown>).stderr = new EventEmitter();
      process.nextTick(() => proc.emit("error", new Error("ENOENT")));
      return proc;
    });

    const result = await runner.runTests({
      pillar: "smoke",
      environment: "local",
    });
    expect(result.success).toBe(false);
  });
});
