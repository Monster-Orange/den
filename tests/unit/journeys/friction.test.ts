/**
 * Unit tests for deterministic harness-side friction extraction
 * (src/pillars/journeys/report/friction.ts).
 *
 * Contract under test (plan: jrn-reporting packet, Approach §Reporting):
 * - friction_points[] are extracted deterministically from the persisted
 *   transcript (parsed JSONL lines), tool telemetry, and the SnapshotIndex —
 *   zero LLM involvement;
 * - categories: failed tool calls, retried tool calls, HTTP 4xx/5xx tool
 *   results (both surfaces), error-page markers in page summaries, dead-end
 *   navigation/backtracking, per-step latency outliers vs budget;
 * - every friction point carries evidence {transcriptRef, snapshotPath?}
 *   referencing the transcript position AND the nearest snapshot when one
 *   exists;
 * - friction NEVER affects the verdict (by construction — asserted against
 *   composeVerdict in reporting.test.ts as well).
 */

import { describe, expect, it } from "@jest/globals";
import {
  extractFrictionPoints,
  type FrictionInputs,
  type FrictionPoint,
} from "../../../src/pillars/journeys/report/friction.js";
import type { JourneyBudgets } from "../../../src/pillars/journeys/spec/schema.js";
import type { SnapshotIndexEntry } from "../../../src/pillars/journeys/tools/snapshot-store.js";

const BUDGETS: JourneyBudgets = {
  max_turns: 10,
  timeout_s: 300,
  max_total_tokens: 100_000,
};

function toolCall(
  name: string,
  status: "completed" | "error",
  result?: unknown,
): unknown {
  return {
    type: "tool_call",
    agent_id: "a1",
    run_id: "r1",
    call_id: `call-${Math.random().toString(36).slice(2, 8)}`,
    name,
    status,
    result,
  };
}

function snapshot(
  seq: number,
  action: string,
  filePath: string | null,
): SnapshotIndexEntry {
  const entry: SnapshotIndexEntry = {
    seq,
    action,
    url: "http://localhost:3000/app",
    path: filePath,
    ts: `2026-07-15T10:00:0${seq}.000Z`,
  };
  return entry;
}

function inputs(overrides: Partial<FrictionInputs>): FrictionInputs {
  return {
    transcript: [],
    snapshotIndex: [],
    budgets: BUDGETS,
    ...overrides,
  };
}

describe("extractFrictionPoints — failed tool calls", () => {
  it("flags a tool_call with status error as tool_error friction", () => {
    const transcript = [
      { type: "system", agent_id: "a1", run_id: "r1" },
      toolCall("browser_click", "error", { error: "element not found" }),
    ];

    const points = extractFrictionPoints(inputs({ transcript }));

    const errors = points.filter((p) => p.category === "tool_error");
    expect(errors).toHaveLength(1);
    expect(errors[0].surface).toBe("browser");
    expect(errors[0].severity).toBe("high");
    // Evidence references the transcript position (1-based line).
    expect(errors[0].evidence.transcriptRef).toBe("transcript.jsonl:2");
  });

  it("classifies non-browser tool errors as api surface", () => {
    const transcript = [
      toolCall("journeys_http_request", "error", { error: "boom" }),
    ];

    const points = extractFrictionPoints(inputs({ transcript }));

    expect(points).toHaveLength(1);
    expect(points[0].surface).toBe("api");
    expect(points[0].category).toBe("tool_error");
  });

  it("does not flag successful tool calls", () => {
    const transcript = [
      toolCall("browser_navigate", "completed", {
        summary: "Dashboard — all good",
      }),
    ];

    expect(extractFrictionPoints(inputs({ transcript }))).toHaveLength(0);
  });
});

describe("extractFrictionPoints — retried tool calls", () => {
  it("flags a same-name call immediately after a failed one as tool_retry", () => {
    const transcript = [
      toolCall("browser_click", "error", { error: "not interactable" }),
      toolCall("browser_click", "completed", { summary: "clicked" }),
    ];

    const points = extractFrictionPoints(inputs({ transcript }));

    const retries = points.filter((p) => p.category === "tool_retry");
    expect(retries).toHaveLength(1);
    expect(retries[0].evidence.transcriptRef).toBe("transcript.jsonl:2");
    expect(retries[0].severity).toBe("low");
  });

  it("does not flag a different tool after a failure as a retry", () => {
    const transcript = [
      toolCall("browser_click", "error", { error: "nope" }),
      toolCall("browser_snapshot", "completed", { summary: "page" }),
    ];

    const points = extractFrictionPoints(inputs({ transcript }));
    expect(points.filter((p) => p.category === "tool_retry")).toHaveLength(0);
  });
});

describe("extractFrictionPoints — HTTP 4xx/5xx tool results", () => {
  it("flags a 4xx structured tool result as http_error (medium)", () => {
    const transcript = [
      toolCall("journeys_http_request", "completed", {
        status: 404,
        body: '{"detail":"not found"}',
      }),
    ];

    const points = extractFrictionPoints(inputs({ transcript }));

    expect(points).toHaveLength(1);
    expect(points[0].category).toBe("http_error");
    expect(points[0].severity).toBe("medium");
    expect(points[0].surface).toBe("api");
    expect(points[0].description).toContain("404");
  });

  it("flags a 5xx structured tool result as http_error (high)", () => {
    const transcript = [
      toolCall("journeys_http_request", "completed", { status: 503 }),
    ];

    const points = extractFrictionPoints(inputs({ transcript }));
    expect(points[0].category).toBe("http_error");
    expect(points[0].severity).toBe("high");
  });

  it("does not flag 2xx/3xx results", () => {
    const transcript = [
      toolCall("journeys_http_request", "completed", { status: 201 }),
      toolCall("journeys_http_request", "completed", { status: 302 }),
    ];

    expect(extractFrictionPoints(inputs({ transcript }))).toHaveLength(0);
  });
});

describe("extractFrictionPoints — error-page markers in page summaries", () => {
  it("flags a page summary containing an error marker", () => {
    const transcript = [
      toolCall("browser_navigate", "completed", {
        summary: "Oops — Something went wrong. Try again later.",
      }),
    ];

    const points = extractFrictionPoints(inputs({ transcript }));

    expect(points).toHaveLength(1);
    expect(points[0].category).toBe("error_page");
    expect(points[0].surface).toBe("browser");
  });

  it("does not flag clean page summaries", () => {
    const transcript = [
      toolCall("browser_navigate", "completed", {
        summary: "Dashboard — Datasets, Items, Folders",
      }),
    ];

    expect(extractFrictionPoints(inputs({ transcript }))).toHaveLength(0);
  });
});

describe("extractFrictionPoints — dead-end navigation / backtracking", () => {
  it("flags a repeat navigation to an already-visited URL", () => {
    const transcript = [
      toolCall("browser_navigate", "completed", {
        summary: "Items page",
        url: "http://localhost:3000/items",
      }),
      toolCall("browser_navigate", "completed", {
        summary: "Settings page",
        url: "http://localhost:3000/settings",
      }),
      toolCall("browser_navigate", "completed", {
        summary: "Items page",
        url: "http://localhost:3000/items",
      }),
    ];

    const points = extractFrictionPoints(inputs({ transcript }));

    const deadEnds = points.filter((p) => p.category === "dead_end_navigation");
    expect(deadEnds).toHaveLength(1);
    expect(deadEnds[0].evidence.transcriptRef).toBe("transcript.jsonl:3");
    expect(deadEnds[0].severity).toBe("low");
  });

  it("does not flag first-time navigations", () => {
    const transcript = [
      toolCall("browser_navigate", "completed", {
        summary: "A",
        url: "http://localhost:3000/a",
      }),
      toolCall("browser_navigate", "completed", {
        summary: "B",
        url: "http://localhost:3000/b",
      }),
    ];

    expect(extractFrictionPoints(inputs({ transcript }))).toHaveLength(0);
  });
});

describe("extractFrictionPoints — per-step latency outliers vs budget", () => {
  // Step budget = timeout_s * 1000 / max_turns = 30_000ms for BUDGETS;
  // outliers are calls slower than 2x that.
  it("flags a tool call slower than 2x the per-step budget", () => {
    const call = toolCall("journeys_http_request", "completed", {
      status: 200,
    }) as { call_id: string };
    const transcript = [call];

    const points = extractFrictionPoints(
      inputs({
        transcript,
        toolTelemetry: [{ callId: call.call_id, durationMs: 61_000 }],
      }),
    );

    expect(points).toHaveLength(1);
    expect(points[0].category).toBe("latency_outlier");
    expect(points[0].evidence.transcriptRef).toBe("transcript.jsonl:1");
  });

  it("does not flag calls within the per-step budget", () => {
    const call = toolCall("journeys_http_request", "completed", {
      status: 200,
    }) as { call_id: string };

    const points = extractFrictionPoints(
      inputs({
        transcript: [call],
        toolTelemetry: [{ callId: call.call_id, durationMs: 59_000 }],
      }),
    );

    expect(points).toHaveLength(0);
  });
});

describe("extractFrictionPoints — snapshot evidence", () => {
  it("attaches the nearest snapshot path for browser-action friction", () => {
    const transcript = [
      toolCall("browser_navigate", "completed", {
        summary: "Login ok",
        url: "http://localhost:3000/",
      }),
      toolCall("browser_click", "error", { error: "element not found" }),
    ];
    const snapshotIndex = [
      snapshot(
        1,
        "navigate",
        "/reports/journeys/r1/snapshots/001-navigate.png",
      ),
      snapshot(
        2,
        "click-failure",
        "/reports/journeys/r1/snapshots/002-click-failure.png",
      ),
    ];

    const points = extractFrictionPoints(inputs({ transcript, snapshotIndex }));

    const error = points.find((p) => p.category === "tool_error");
    expect(error?.evidence.snapshotPath).toBe(
      "/reports/journeys/r1/snapshots/002-click-failure.png",
    );
  });

  it("falls back to the nearest earlier snapshot when the matching one was suppressed", () => {
    const transcript = [
      toolCall("browser_navigate", "completed", {
        summary: "ok",
        url: "http://localhost:3000/",
      }),
      toolCall("browser_type", "error", { error: "timeout" }),
    ];
    const snapshotIndex = [
      snapshot(
        1,
        "navigate",
        "/reports/journeys/r1/snapshots/001-navigate.png",
      ),
      snapshot(2, "type", null), // suppressed sensitive frame
    ];

    const points = extractFrictionPoints(inputs({ transcript, snapshotIndex }));

    const error = points.find((p) => p.category === "tool_error");
    expect(error?.evidence.snapshotPath).toBe(
      "/reports/journeys/r1/snapshots/001-navigate.png",
    );
  });

  it("omits snapshotPath when no snapshot exists", () => {
    const transcript = [toolCall("journeys_http_request", "error", {})];

    const points = extractFrictionPoints(inputs({ transcript }));

    expect(points[0].evidence.snapshotPath).toBeUndefined();
    expect(points[0].evidence.transcriptRef).toBe("transcript.jsonl:1");
  });
});

describe("extractFrictionPoints — determinism and shape", () => {
  it("is deterministic: same inputs produce identical output", () => {
    const transcript = [
      toolCall("browser_click", "error", { error: "x" }),
      toolCall("browser_click", "completed", { summary: "ok" }),
      toolCall("journeys_http_request", "completed", { status: 500 }),
    ];
    const args = inputs({ transcript });

    const first = extractFrictionPoints(args);
    const second = extractFrictionPoints(args);

    expect(second).toEqual(first);
  });

  it("every point carries the full FrictionPoint shape", () => {
    const transcript = [toolCall("browser_click", "error", { error: "x" })];

    const points = extractFrictionPoints(inputs({ transcript }));

    const point: FrictionPoint = points[0];
    expect(typeof point.step).toBe("number");
    expect(["browser", "api"]).toContain(point.surface);
    expect(["low", "medium", "high"]).toContain(point.severity);
    expect(typeof point.category).toBe("string");
    expect(typeof point.description).toBe("string");
    expect(typeof point.evidence.transcriptRef).toBe("string");
  });

  it("ignores non-tool-call transcript lines and malformed entries", () => {
    const transcript = [
      { type: "assistant", message: { role: "assistant", content: [] } },
      "not an object",
      null,
      42,
      { type: "tool_call" }, // malformed: no name/status
    ];

    expect(extractFrictionPoints(inputs({ transcript }))).toHaveLength(0);
  });
});
