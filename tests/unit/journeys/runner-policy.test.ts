/**
 * Unit tests for runner policy refusals + fail-closed budget enforcement
 * (src/pillars/journeys/runner.ts). SDK fully mocked — no live agent.
 *
 * Contract under test (plan: jrn-runner packet, Approach §Budget
 * enforcement / §Explicit environment targeting):
 * - exactly ONE target environment per invocation; specs whose
 *   environments allowlist excludes it are refused;
 * - environment=production is hard-refused regardless of spec content;
 * - no configured model (JOURNEYS_MODEL) → loud refusal, no default;
 * - surface-based tool mounting: browser => browser toolset only,
 *   api => HTTP tool only, mixed => both;
 * - timeout_s wall-clock → run.cancel();
 * - max_turns counted from the guaranteed turn-ended InteractionUpdate
 *   (onDelta), NOT from optional usage events → run.cancel();
 * - max_total_tokens on cumulative reported usage at each turn-ended →
 *   run.cancel();
 * - FAIL-CLOSED: turn-ended without usage AND run.usage unavailable →
 *   cancel + failure_kind=budget_unverifiable;
 * - cancelled budget runs report failure_kind=budget_exceeded;
 * - startup CursorAgentError vs result.status==='error' → distinct
 *   failure_kinds (infra_error vs agent_error).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { CursorAgentError } from "@cursor/sdk";
import {
  CLEANUP_TIMEOUT_MS,
  JourneyPolicyError,
  runJourney,
} from "../../../src/pillars/journeys/runner.js";
import type {
  AgentCreateOptionsLike,
  AgentRunLike,
  InteractionUpdateLike,
  RunnerDeps,
  RunUsage,
  TurnUsage,
} from "../../../src/pillars/journeys/runner.js";
import { prepareSandbox } from "../../../src/pillars/journeys/sandbox.js";
import type {
  JourneyEvent,
  JourneyEventBody,
  JourneyEventSink,
} from "../../../src/pillars/journeys/observability/events.js";
import type { JourneySpec } from "../../../src/pillars/journeys/spec/schema.js";
import type { BrowserToolset } from "../../../src/pillars/journeys/tools/browser-tool.js";
import {
  HTTP_TOOL_NAME,
  type ScopedHttpToolOptions,
} from "../../../src/pillars/journeys/tools/http-tool.js";
import { TEST_APP } from "./fixtures/test-app.js";

// ── Spec + env fixtures ──────────────────────────────────────────────────────

function makeSpec(overrides: Partial<JourneySpec> = {}): JourneySpec {
  return {
    name: "user-first-item",
    persona: { role: "user", brief: "Create an item and ask a question." },
    surface: "browser",
    environments: ["local", "staging"],
    budgets: { max_turns: 10, timeout_s: 300, max_total_tokens: 1_000 },
    success: {
      assertions: [
        {
          kind: "http_status",
          request: { method: "GET", path: "/api/v1/items/{item_id}" },
          equals: 200,
        },
      ],
    },
    ...overrides,
  };
}

const ENV_CONFIG = {
  name: "local",
  baseUrls: {
    web: "http://localhost:3000",
    api: "http://localhost:8000",
    services: { folders: "http://localhost:8084" },
  },
};

function usageTurn(total: number): TurnUsage {
  return {
    inputTokens: total,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

// ── Controllable fake SDK ────────────────────────────────────────────────────

/**
 * One scripted turn: a per-turn usage payload, `null` for a turn-ended
 * WITHOUT usage, or "trigger-timeout" to fire the captured wall-clock
 * timer callback at that point in the stream.
 */
type ScriptedTurn = TurnUsage | null | "trigger-timeout";

class FakeRun implements AgentRunLike {
  onDelta:
    | ((args: { update: InteractionUpdateLike }) => void | Promise<void>)
    | undefined;
  cancelled = false;
  readonly cancel = jest.fn(async () => {
    this.cancelled = true;
  });
  usage?: RunUsage;
  resultStatus: string | undefined;
  resultError: { message: string; code?: string } | undefined;

  constructor(
    private readonly turns: ScriptedTurn[],
    private readonly triggerTimeout?: () => void,
  ) {}

  async *stream(): AsyncGenerator<unknown, void> {
    for (const turn of this.turns) {
      if (this.cancelled) return;
      if (turn === "trigger-timeout") {
        this.triggerTimeout?.();
        continue;
      }
      await this.onDelta?.({
        update: { type: "turn-ended", ...(turn ? { usage: turn } : {}) },
      });
      if (this.cancelled) return;
      yield { type: "assistant", text: "step" };
    }
  }

  async wait() {
    return {
      status: this.resultStatus ?? (this.cancelled ? "cancelled" : "finished"),
      usage: this.usage,
      ...(this.resultError ? { error: this.resultError } : {}),
    };
  }
}

function fakeBrowserToolset(): BrowserToolset {
  const tool = { description: "stub", execute: async () => "ok" };
  return {
    tools: {
      browser_navigate: tool,
      browser_snapshot: tool,
      browser_click: tool,
      browser_type: tool,
      browser_select: tool,
      browser_wait: tool,
    },
    start: async () => undefined,
    drain: async () => undefined,
    dispose: async () => undefined,
    policyReports: [],
  };
}

/** In-memory event sink so tests can assert on the emitted timeline. */
class RecordingEventSink implements JourneyEventSink {
  readonly recorded: JourneyEvent[] = [];
  private seq = 0;
  emit(body: JourneyEventBody): void {
    this.recorded.push({ seq: this.seq++, tMs: 0, ...body });
  }
  addSecret(): void {
    /* no-op: redaction is covered by the bus's own tests */
  }
  get events(): readonly JourneyEvent[] {
    return this.recorded;
  }
}

interface Harness {
  deps: Partial<RunnerDeps>;
  run: FakeRun;
  getCreateOptions: () => AgentCreateOptionsLike | undefined;
  provisionCalls: string[];
  eventSink: RecordingEventSink;
}

function makeHarness(
  turns: ScriptedTurn[] = [],
  configure: (run: FakeRun) => void = () => undefined,
): Harness {
  let timeoutCb: (() => void) | undefined;
  const run = new FakeRun(turns, () => timeoutCb?.());
  configure(run);

  let createOptions: AgentCreateOptionsLike | undefined;
  const provisionCalls: string[] = [];
  const eventSink = new RecordingEventSink();
  const reportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-policy-"));
  const sandboxBase = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-policy-sb-"));
  const httpToolMarker = { description: "http", execute: async () => "ok" };

  const deps: Partial<RunnerDeps> = {
    loadEnvironment: async () => ENV_CONFIG,
    captureSecrets: async () => ({
      cursorApiKey: "captured-key",
    }),
    provisionBrowserSession: async (role) => {
      provisionCalls.push(role);
      return "/tmp/playwright/.auth/user-local.json";
    },
    deriveApiToken: async () => ({
      apiToken: "session-jwt",
      headers: { "X-Org-ID": "org-abc" },
    }),
    prepareSandbox: (journeyName) =>
      prepareSandbox(journeyName, { baseDir: sandboxBase }),
    createAgent: async (options) => {
      createOptions = options;
      return {
        send: async (_message, sendOptions) => {
          run.onDelta = sendOptions.onDelta;
          return run;
        },
        close: () => undefined,
      };
    },
    buildHttpTool: () => httpToolMarker,
    buildBrowserToolset: () => fakeBrowserToolset(),
    buildEventSink: () => eventSink,
    reportRoot,
    env: { JOURNEYS_MODEL: "test-model" },
    timers: {
      setTimeout: (callback: () => void) => {
        timeoutCb = callback;
        return 0 as unknown as NodeJS.Timeout;
      },
      clearTimeout: () => undefined,
    },
  };

  return {
    deps,
    run,
    getCreateOptions: () => createOptions,
    provisionCalls,
    eventSink,
  };
}

// ── Policy refusals ──────────────────────────────────────────────────────────

describe("runner policy refusals", () => {
  it("hard-refuses environment=production regardless of spec content", async () => {
    const harness = makeHarness();
    const spec = makeSpec({
      environments: ["local", "staging", "production"],
    });

    await expect(runJourney(spec, "production", harness.deps)).rejects.toThrow(
      JourneyPolicyError,
    );
    await expect(runJourney(spec, "production", harness.deps)).rejects.toThrow(
      /production/,
    );
  });

  it("hard-refuses prod the same way", async () => {
    const harness = makeHarness();
    const spec = makeSpec({ environments: ["local", "beta", "prod"] });
    await expect(runJourney(spec, "prod", harness.deps)).rejects.toThrow(
      /production/,
    );
  });

  it("refuses specs whose environments allowlist excludes the target env", async () => {
    const harness = makeHarness();
    const spec = makeSpec({ environments: ["staging"] });

    await expect(runJourney(spec, "local", harness.deps)).rejects.toThrow(
      JourneyPolicyError,
    );
    await expect(runJourney(spec, "local", harness.deps)).rejects.toThrow(
      /environments/,
    );
  });

  it("refuses to start when neither the spec `model` nor JOURNEYS_MODEL is configured — no default model", async () => {
    const harness = makeHarness();
    harness.deps.env = {};

    await expect(runJourney(makeSpec(), "local", harness.deps)).rejects.toThrow(
      JourneyPolicyError,
    );
    await expect(runJourney(makeSpec(), "local", harness.deps)).rejects.toThrow(
      /JOURNEYS_MODEL/,
    );
  });

  it("uses the spec's declared `model` when JOURNEYS_MODEL is unset", async () => {
    const harness = makeHarness();
    harness.deps.env = {};

    await runJourney(makeSpec({ model: "spec-model" }), "local", harness.deps);

    expect(harness.getCreateOptions()?.model).toEqual({ id: "spec-model" });
  });

  it("JOURNEYS_MODEL overrides the spec's declared `model` (operator control)", async () => {
    const harness = makeHarness();
    harness.deps.env = { JOURNEYS_MODEL: "operator-model" };

    await runJourney(makeSpec({ model: "spec-model" }), "local", harness.deps);

    expect(harness.getCreateOptions()?.model).toEqual({ id: "operator-model" });
  });

  it("refuses a spec without budgets (defense in depth behind the schema)", async () => {
    const harness = makeHarness();
    const spec = makeSpec();
    (spec as { budgets?: unknown }).budgets = undefined;

    await expect(runJourney(spec, "local", harness.deps)).rejects.toThrow(
      JourneyPolicyError,
    );
  });

  it("refusals happen BEFORE any secret capture or provisioning", async () => {
    const captureSecrets = jest.fn(async () => ({
      cursorApiKey: "k",
    }));
    const harness = makeHarness();
    harness.deps.captureSecrets = captureSecrets as never;
    harness.deps.env = {};

    await expect(runJourney(makeSpec(), "local", harness.deps)).rejects.toThrow(
      JourneyPolicyError,
    );
    expect(captureSecrets).not.toHaveBeenCalled();
  });
});

// ── Surface-based tool mounting ──────────────────────────────────────────────

describe("surface-based tool mounting", () => {
  it("browser surface mounts the browser toolset ONLY", async () => {
    const harness = makeHarness([usageTurn(10)]);

    await runJourney(makeSpec({ surface: "browser" }), "local", harness.deps);

    const tools = Object.keys(
      harness.getCreateOptions()?.local.customTools ?? {},
    ).sort();
    expect(tools).toEqual([
      "browser_click",
      "browser_navigate",
      "browser_select",
      "browser_snapshot",
      "browser_type",
      "browser_wait",
    ]);
    expect(harness.provisionCalls).toEqual(["user"]);
  });

  it("api surface mounts the HTTP tool ONLY (no browser TOOLSET), but still mints a session to derive the token", async () => {
    const harness = makeHarness([usageTurn(10)]);

    await runJourney(makeSpec({ surface: "api" }), "local", harness.deps);

    const tools = Object.keys(
      harness.getCreateOptions()?.local.customTools ?? {},
    );
    // The agent still gets only the HTTP tool — no browser tools exposed.
    expect(tools).toEqual([HTTP_TOOL_NAME]);
    // But a session IS minted: ROPC was removed, so the API-assertion token
    // is derived from a real browser session even for api-surface journeys.
    expect(harness.provisionCalls).toEqual(["user"]);
  });

  it("builds the HTTP tool with surface-derived method capabilities (review finding 4)", async () => {
    const seen: unknown[] = [];
    const harness = makeHarness([usageTurn(10)]);
    harness.deps.buildHttpTool = (options) => {
      seen.push(
        (options as { allowedMethods?: readonly string[] }).allowedMethods,
      );
      return { description: "http", execute: async () => "ok" };
    };

    await runJourney(makeSpec({ surface: "api" }), "local", harness.deps);
    await runJourney(makeSpec({ surface: "mixed" }), "local", harness.deps);
    await runJourney(makeSpec({ surface: "browser" }), "local", harness.deps);

    expect(seen[0]).toEqual(["GET", "POST", "PUT", "PATCH"]);
    expect(seen[1]).toEqual(["GET", "POST", "PUT", "PATCH"]);
    expect(seen[2]).toEqual(["GET"]);
  });

  it("constructs HTTP-tool capability grants from the spec's http_capabilities (review finding R2-1)", async () => {
    const seen: unknown[] = [];
    const harness = makeHarness([usageTurn(10)]);
    harness.deps.buildHttpTool = (options) => {
      seen.push((options as { capabilities?: unknown }).capabilities);
      return { description: "http", execute: async () => "ok" };
    };

    await runJourney(
      makeSpec({
        surface: "api",
        http_capabilities: [
          { methods: ["POST"], path_pattern: "/api/v1/items" },
        ],
      }),
      "local",
      harness.deps,
    );
    await runJourney(makeSpec({ surface: "api" }), "local", harness.deps);

    expect(seen[0]).toEqual([
      { methods: ["POST"], pathPattern: "/api/v1/items" },
    ]);
    // No http_capabilities in the spec → safe read-only default (no grants).
    expect(seen[1]).toEqual([]);
  });

  it("mixed surface mounts both toolsets", async () => {
    const harness = makeHarness([usageTurn(10)]);

    await runJourney(makeSpec({ surface: "mixed" }), "local", harness.deps);

    const tools = Object.keys(
      harness.getCreateOptions()?.local.customTools ?? {},
    ).sort();
    expect(tools).toEqual([
      "browser_click",
      "browser_navigate",
      "browser_select",
      "browser_snapshot",
      "browser_type",
      "browser_wait",
      HTTP_TOOL_NAME,
    ]);
    expect(harness.provisionCalls).toEqual(["user"]);
  });

  it("creates the agent sandboxed in the staged cwd with the configured model", async () => {
    const harness = makeHarness([usageTurn(10)]);

    await runJourney(makeSpec(), "local", harness.deps);

    const options = harness.getCreateOptions();
    // Sandbox is disabled: the OS sandbox blocks the custom-user-tools MCP
    // server (browser_*/http_request) outright; shell is denied by the hook.
    expect(options?.local.sandboxOptions).toEqual({ enabled: false });
    // settingSources must load the staged .cursor/ so the shell-deny hook
    // and the custom-tools mcpAllowlist take effect (default [] ignores them).
    expect(options?.local.settingSources).toEqual(["project"]);
    expect(options?.model).toEqual({ id: "test-model" });
    expect(
      fs.existsSync(path.join(options?.local.cwd ?? "", ".cursor/hooks.json")),
    ).toBe(true);
    // The mcpAllowlist that unblocks the harness's own custom tools.
    expect(
      fs.existsSync(
        path.join(options?.local.cwd ?? "", ".cursor/permissions.json"),
      ),
    ).toBe(true);
  });
});

// ── Budget enforcement (fail-closed) ─────────────────────────────────────────

describe("budget enforcement", () => {
  it("cancels the run when max_turns is exceeded (counted from turn-ended, not usage events)", async () => {
    // 3 turn-ended updates against max_turns=2. Turns deliberately carry
    // NO usage payload except cumulative run.usage — proving the count
    // comes from turn-ended itself.
    const harness = makeHarness([null, null, null], (run) => {
      run.usage = {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
      };
    });
    const spec = makeSpec({
      budgets: { max_turns: 2, timeout_s: 300, max_total_tokens: 1_000 },
    });

    const outcome = await runJourney(spec, "local", harness.deps);

    expect(harness.run.cancel).toHaveBeenCalled();
    expect(outcome.failure_kind).toBe("budget_exceeded");
  });

  it("cancels the run when cumulative max_total_tokens is exceeded", async () => {
    const harness = makeHarness([
      usageTurn(400),
      usageTurn(400),
      usageTurn(400),
    ]);
    const spec = makeSpec({
      budgets: { max_turns: 10, timeout_s: 300, max_total_tokens: 1_000 },
    });

    const outcome = await runJourney(spec, "local", harness.deps);

    expect(harness.run.cancel).toHaveBeenCalled();
    expect(outcome.failure_kind).toBe("budget_exceeded");
  });

  it("cancels the run on wall-clock timeout_s expiry", async () => {
    const harness = makeHarness([
      usageTurn(10),
      "trigger-timeout",
      usageTurn(10),
    ]);

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    expect(harness.run.cancel).toHaveBeenCalled();
    expect(outcome.failure_kind).toBe("budget_exceeded");
  });

  it("FAIL-CLOSED: turn-ended without usage AND run.usage unavailable → budget_unverifiable", async () => {
    const harness = makeHarness([null]);

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    expect(harness.run.cancel).toHaveBeenCalled();
    expect(outcome.failure_kind).toBe("budget_unverifiable");
  });

  it("turn-ended without usage is fine when cumulative run.usage IS available and under cap", async () => {
    const harness = makeHarness([null, null], (run) => {
      run.usage = {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
      };
    });

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    expect(harness.run.cancel).not.toHaveBeenCalled();
    expect(outcome.failure_kind).toBeUndefined();
  });

  it("cumulative run.usage over the cap also cancels as budget_exceeded", async () => {
    const harness = makeHarness([null], (run) => {
      run.usage = {
        inputTokens: 2_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2_000,
      };
    });

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    expect(harness.run.cancel).toHaveBeenCalled();
    expect(outcome.failure_kind).toBe("budget_exceeded");
  });

  it("never undercounts after a missing-usage turn — one monotonic cumulative total (review finding 5)", async () => {
    // turn1 reports 600 via its payload; turn2 has NO payload (the run
    // handle's cumulative usage — a stale 900 — covers it); turn3 reports
    // 300. True spend is >= 1200 > 1000. The old accounting reset to the
    // per-turn sum (600+300=900) after the missing-usage turn and let the
    // run continue.
    const harness = makeHarness(
      [usageTurn(600), null, usageTurn(300)],
      (run) => {
        run.usage = {
          inputTokens: 900,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 900,
        };
      },
    );
    const spec = makeSpec({
      budgets: { max_turns: 10, timeout_s: 300, max_total_tokens: 1_000 },
    });

    const outcome = await runJourney(spec, "local", harness.deps);

    expect(harness.run.cancel).toHaveBeenCalled();
    expect(outcome.failure_kind).toBe("budget_exceeded");
  });

  it("a clean run reports usage and no failure_kind", async () => {
    const harness = makeHarness([usageTurn(100), usageTurn(100)]);

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    expect(harness.run.cancel).not.toHaveBeenCalled();
    expect(outcome.failure_kind).toBeUndefined();
    expect(outcome.usage?.totalTokens).toBe(200);
    expect(outcome.runId).toMatch(/^jrn-user-first-item-/);
  });
});

// ── Deadline coverage (review finding 6) ─────────────────────────────────────

describe("wall-clock deadline", () => {
  it("starts BEFORE provisioning — a hung captureSecrets cannot stall past timeout_s", async () => {
    const harness = makeHarness();
    harness.deps.captureSecrets = () => new Promise(() => undefined);
    let fire: (() => void) | undefined;
    harness.deps.timers = {
      setTimeout: (callback: () => void) => {
        fire = callback;
        return 0 as unknown as NodeJS.Timeout;
      },
      clearTimeout: () => undefined,
    };

    const pending = runJourney(makeSpec(), "local", harness.deps);
    expect(fire).toBeDefined();
    fire?.();
    const outcome = await pending;

    expect(outcome.failure_kind).toBe("budget_exceeded");
  });

  it("covers Agent.create waits too", async () => {
    const harness = makeHarness();
    harness.deps.createAgent = () => new Promise(() => undefined);
    let fire: (() => void) | undefined;
    harness.deps.timers = {
      setTimeout: (callback: () => void) => {
        fire = callback;
        return 0 as unknown as NodeJS.Timeout;
      },
      clearTimeout: () => undefined,
    };

    const pending = runJourney(makeSpec(), "local", harness.deps);
    // Let provisioning resolve, then fire the deadline.
    await new Promise((resolve) => setImmediate(resolve));
    fire?.();
    const outcome = await pending;

    expect(outcome.failure_kind).toBe("budget_exceeded");
  });

  it("threads the deadline AbortSignal into the HTTP tool", async () => {
    const harness = makeHarness([usageTurn(10)]);
    let seenSignal: AbortSignal | undefined;
    harness.deps.buildHttpTool = (options) => {
      seenSignal = (options as { signal?: AbortSignal }).signal;
      return { description: "http", execute: async () => "ok" };
    };

    await runJourney(makeSpec({ surface: "api" }), "local", harness.deps);

    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });
});

// ── Bounded cleanup + orphan observation (review finding R2-2) ──────────────

describe("bounded cleanup on deadline expiry", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Flush pending microtasks/immediates so the run reaches its next await. */
  async function flush(): Promise<void> {
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it("returns an outcome even when activeRun.cancel() never resolves after the deadline", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    const harness = makeHarness([usageTurn(10), "trigger-timeout"], (run) => {
      (run as { cancel: unknown }).cancel = jest.fn(
        () => new Promise(() => undefined),
      );
    });

    const pending = runJourney(makeSpec(), "local", harness.deps);
    await flush();
    jest.advanceTimersByTime(CLEANUP_TIMEOUT_MS + 1);
    await flush();
    const outcome = await pending;

    expect(outcome.failure_kind).toBe("budget_exceeded");
  });

  it("returns an outcome even when browser disposal never resolves", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    const harness = makeHarness([usageTurn(10)]);
    harness.deps.buildBrowserToolset = () => ({
      ...fakeBrowserToolset(),
      dispose: () => new Promise(() => undefined),
    });

    const pending = runJourney(makeSpec(), "local", harness.deps);
    await flush();
    jest.advanceTimersByTime(CLEANUP_TIMEOUT_MS + 1);
    await flush();
    const outcome = await pending;

    expect(outcome.failure_kind).toBeUndefined();
  });

  it("observes orphaned provisioning work after deadline expiry — its late rejection is never unhandled", async () => {
    const harness = makeHarness();
    let rejectCapture: ((error: Error) => void) | undefined;
    harness.deps.captureSecrets = () =>
      new Promise((_resolve, reject) => {
        rejectCapture = reject;
      });
    let fire: (() => void) | undefined;
    harness.deps.timers = {
      setTimeout: (callback: () => void) => {
        fire = callback;
        return 0 as unknown as NodeJS.Timeout;
      },
      clearTimeout: () => undefined,
    };

    const pending = runJourney(makeSpec(), "local", harness.deps);
    fire?.();
    const outcome = await pending;
    expect(outcome.failure_kind).toBe("budget_exceeded");

    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    try {
      rejectCapture?.(new Error("late provisioning failure"));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.removeListener("unhandledRejection", listener);
    }
    expect(unhandled).toHaveLength(0);
  });
});

// ── Failure-kind distinction ─────────────────────────────────────────────────

describe("failure kinds", () => {
  it("startup CursorAgentError → failure_kind=infra_error (not a throw)", async () => {
    const harness = makeHarness();
    harness.deps.createAgent = async () => {
      throw new CursorAgentError("api key rejected");
    };

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    expect(outcome.failure_kind).toBe("infra_error");
  });

  it("run result status 'error' → failure_kind=agent_error", async () => {
    const harness = makeHarness([usageTurn(10)], (run) => {
      run.resultStatus = "error";
    });

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    expect(outcome.failure_kind).toBe("agent_error");
  });

  it("captures the SDK error detail on agent_error into outcome + timeline", async () => {
    const harness = makeHarness([usageTurn(10)], (run) => {
      run.resultStatus = "error";
      run.resultError = {
        message: "model refused the tool call",
        code: "TOOL_REFUSED",
      };
    });

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    // Detail is no longer dropped — it lands on the outcome (report header)
    // and as a structured agent_error event on the timeline.
    expect(outcome.error).toBe("model refused the tool call");
    const agentError = harness.eventSink.recorded.find(
      (e) => e.kind === "agent_error",
    );
    expect(agentError).toMatchObject({
      kind: "agent_error",
      message: "model refused the tool call",
      code: "TOOL_REFUSED",
    });
  });

  it("brackets the timeline with run_started and run_ended events", async () => {
    const harness = makeHarness([usageTurn(10)]);

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    const kinds = harness.eventSink.recorded.map((e) => e.kind);
    expect(kinds[0]).toBe("run_started");
    expect(kinds[kinds.length - 1]).toBe("run_ended");
    // The outcome exposes the same timeline for the report to read.
    expect(outcome.events).toBe(harness.eventSink.events);
  });

  it("post-ledger generic failures return an infra_error outcome carrying the ledger (review finding 8)", async () => {
    const harness = makeHarness([usageTurn(10)]);
    harness.run.stream = async function* () {
      yield { type: "assistant", text: "one step" };
      throw new Error("stream exploded mid-run");
    };

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    expect(outcome.failure_kind).toBe("infra_error");
    expect(outcome.error).toContain("stream exploded mid-run");
    expect(outcome.ledger).toBeDefined();
    expect(outcome.runId).toMatch(/^jrn-/);
  });

  it("redacts captured secret values from the infra_error outcome message", async () => {
    const harness = makeHarness([usageTurn(10)]);
    harness.run.stream = async function* () {
      yield { type: "assistant", text: "harmless step" };
      // session-jwt is the browser-session-derived API token (ROPC removed);
      // captured-key is the Cursor key.
      throw new Error("boom session-jwt boom captured-key");
    };

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    expect(outcome.failure_kind).toBe("infra_error");
    expect(outcome.error).not.toContain("session-jwt");
    expect(outcome.error).not.toContain("captured-key");
    expect(outcome.error).toContain("[REDACTED]");
  });

  it("a transcript secret leak fails the run as infra_error and never persists the secret", async () => {
    const harness = makeHarness([usageTurn(10)]);
    const leakyRun = harness.run;
    const originalStream = leakyRun.stream.bind(leakyRun);
    leakyRun.stream = async function* () {
      yield { type: "assistant", text: "leaking session-jwt here" };
      yield* originalStream();
    };

    const outcome = await runJourney(makeSpec(), "local", harness.deps);

    expect(outcome.failure_kind).toBe("infra_error");
    if (fs.existsSync(outcome.transcriptPath)) {
      expect(fs.readFileSync(outcome.transcriptPath, "utf-8")).not.toContain(
        "session-jwt",
      );
    }
  });
});

// ── The app under test (journeys.app) ────────────────────────────────────────

describe("app-under-test wiring (journeys.app)", () => {
  it("passes session_token to deriveApiToken, web_api to the browser toolset, and builds the ledger from resources", async () => {
    const harness = makeHarness([usageTurn(10)]);
    let sessionTokenSeen: unknown = "unset";
    let webApiSeen: unknown = "unset";
    let httpOptions: ScopedHttpToolOptions | undefined;
    harness.deps.app = TEST_APP;
    harness.deps.deriveApiToken = async (_authFile, _env, sessionToken) => {
      sessionTokenSeen = sessionToken;
      return { apiToken: "session-jwt", headers: { "X-Org-ID": "org-abc" } };
    };
    harness.deps.buildBrowserToolset = (options) => {
      webApiSeen = options.webApi;
      return fakeBrowserToolset();
    };
    harness.deps.buildHttpTool = (options) => {
      httpOptions = options;
      return { description: "http", execute: async () => "ok" };
    };

    const outcome = await runJourney(
      makeSpec({ surface: "mixed" }),
      "local",
      harness.deps,
    );

    expect(sessionTokenSeen).toEqual(TEST_APP.session_token);
    expect(webApiSeen).toEqual(TEST_APP.web_api);
    await expect(httpOptions?.headersProvider?.()).resolves.toEqual({
      "X-Org-ID": "org-abc",
    });
    // The run ledger recognises the app's declared resources.
    outcome.ledger.record(
      {
        method: "POST",
        pathOrUrl: "/api/v1/items",
        status: 201,
        body: { id: "item-1" },
      },
      "http-tool",
    );
    expect(outcome.ledger.entries[0]).toEqual(
      expect.objectContaining({
        resourceType: "item",
        cleanup: { method: "DELETE", path: "/api/v1/items/item-1" },
      }),
    );
  });

  it("with no app declared, tracks nothing (every mutation is unmanaged)", async () => {
    const harness = makeHarness([usageTurn(10)]);

    const outcome = await runJourney(makeSpec(), "local", harness.deps);
    outcome.ledger.record(
      {
        method: "POST",
        pathOrUrl: "/api/v1/items",
        status: 201,
        body: { id: "item-1" },
      },
      "http-tool",
    );

    expect(outcome.ledger.entries).toHaveLength(0);
    expect(outcome.ledger.warnings).toHaveLength(1);
  });
});
