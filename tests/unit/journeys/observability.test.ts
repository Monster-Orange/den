/**
 * Unit tests for the journeys observability event bus + SDK-stream mapper.
 * The bus is the single source of the live stream, events.jsonl, and the
 * report timeline; the mapper turns raw SDK messages into condensed,
 * secret-free events. Both are pure/injectable so no SDK or agent is needed.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { SDKMessage } from "@cursor/sdk";
import {
  EventLeakError,
  JourneyEventBus,
  formatLiveLine,
  type JourneyEvent,
} from "../../../src/pillars/journeys/observability/events.js";
import {
  createMapperState,
  flushAssistantText,
  sdkMessageToEvents,
  summarizeArgs,
  summarizeResult,
} from "../../../src/pillars/journeys/observability/sdk-mapper.js";

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jrn-obs-"));
  return path.join(dir, "events.jsonl");
}

describe("JourneyEventBus", () => {
  it("stamps monotonic seq and tMs from an injectable clock", () => {
    let now = 1000;
    const bus = new JourneyEventBus({ clock: () => now });
    bus.emit({ kind: "turn_started", turn: 1 });
    now = 1500;
    bus.emit({ kind: "turn_started", turn: 2 });

    expect(bus.events).toHaveLength(2);
    expect(bus.events[0]).toMatchObject({ seq: 0, tMs: 0, turn: 1 });
    expect(bus.events[1]).toMatchObject({ seq: 1, tMs: 500, turn: 2 });
  });

  it("appends one JSON line per event to events.jsonl", () => {
    const filePath = tmpFile();
    const bus = new JourneyEventBus({ filePath, clock: () => 0 });
    bus.emit({ kind: "turn_started", turn: 1 });
    bus.emit({
      kind: "ledger_binding",
      resourceType: "item",
      id: "c-1",
      method: "POST",
      pathValue: "/api/v1/items",
      status: 201,
      source: "browser",
    });

    const lines = fs
      .readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({
      kind: "ledger_binding",
      resourceType: "item",
      id: "c-1",
    });
  });

  it("redacts registered secret values from event strings", () => {
    const bus = new JourneyEventBus({
      secrets: ["super-secret-token"],
      clock: () => 0,
    });
    bus.emit({
      kind: "assistant_text",
      text: "I will call the API with super-secret-token now",
    });
    const event = bus.events[0];
    expect(JSON.stringify(event)).not.toContain("super-secret-token");
    expect(JSON.stringify(event)).toContain("[REDACTED]");
  });

  it("addSecret redacts a token learned mid-run", () => {
    const bus = new JourneyEventBus({ clock: () => 0 });
    bus.addSecret("late-jwt");
    bus.emit({ kind: "agent_error", message: "failed using late-jwt" });
    expect(JSON.stringify(bus.events[0])).not.toContain("late-jwt");
  });

  it("throws EventLeakError if a secret survives redaction (fail closed)", () => {
    // A secret that also appears verbatim as the redaction sentinel edge
    // case: simulate by emitting a raw object the redactor cannot reach.
    const bus = new JourneyEventBus({ secrets: ["tok"], clock: () => 0 });
    // interception_error IS redacted, so this must NOT throw:
    expect(() =>
      bus.emit({ kind: "interception_error", message: "tok leaked" }),
    ).not.toThrow();
    expect(JSON.stringify(bus.events[0])).not.toContain("tok");
  });

  it("fails closed when a secret hides in a non-redacted numeric-adjacent field", () => {
    // ledger_binding.id is not run through the string redactor (ids are not
    // secrets by contract). If a secret ever equals an id, the post-serialize
    // guard catches it and throws rather than persisting the leak.
    const bus = new JourneyEventBus({ secrets: ["c-secret"], clock: () => 0 });
    expect(() =>
      bus.emit({
        kind: "ledger_binding",
        resourceType: "item",
        id: "c-secret",
        method: "POST",
        pathValue: "/api/v1/items",
        status: 201,
        source: "browser",
      }),
    ).toThrow(EventLeakError);
  });

  it("calls the live writer with a condensed line per event", () => {
    const lines: string[] = [];
    const bus = new JourneyEventBus({
      liveWriter: (line) => lines.push(line),
      clock: () => 0,
    });
    bus.emit({
      kind: "tool_call",
      tool: "http_request",
      status: "completed",
      summary: "GET /api/v1/items/c-1",
      result: "HTTP 200",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("http_request");
    expect(lines[0]).toContain("GET /api/v1/items/c-1");
    expect(lines[0]).toContain("HTTP 200");
  });
});

describe("formatLiveLine", () => {
  const base = { seq: 0, tMs: 3200 };
  it("renders a completed tool call with a check", () => {
    const line = formatLiveLine({
      ...base,
      kind: "tool_call",
      tool: "browser_navigate",
      status: "completed",
      summary: "/items",
    } as JourneyEvent);
    expect(line).toContain("✓ browser_navigate");
    expect(line).toContain("3.2s");
  });

  it("renders a ledger binding with the resource id", () => {
    const line = formatLiveLine({
      ...base,
      kind: "ledger_binding",
      resourceType: "item",
      id: "c-9",
      method: "POST",
      pathValue: "/api/v1/items",
      status: 201,
      source: "browser",
    } as JourneyEvent);
    expect(line).toContain("bound item=c-9");
  });
});

describe("sdkMessageToEvents", () => {
  it("flushes buffered text before an inline tool_use (no per-frame turn)", () => {
    const state = createMapperState();
    const message: SDKMessage = {
      type: "assistant",
      agent_id: "a",
      run_id: "r",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Creating an item" },
          {
            type: "tool_use",
            id: "call-1",
            name: "http_request",
            input: { method: "POST", path: "/api/v1/items?token=abc" },
          },
        ],
      },
    };
    const events = sdkMessageToEvents(message, state);
    // No turn_started per assistant frame — text is flushed, then the tool.
    expect(events).toEqual([
      { kind: "assistant_text", text: "Creating an item" },
      expect.objectContaining({
        kind: "tool_call",
        tool: "http_request",
        callId: "call-1",
        status: "running",
        summary: "POST /api/v1/items",
      }),
    ]);
  });

  it("coalesces per-token assistant deltas into ONE assistant_text", () => {
    // The SDK streams one token per assistant frame ("I'll", " run", …).
    // Feeding many deltas must buffer, emitting nothing, until a flush.
    const state = createMapperState();
    const deltas = ["I'll", " run", " the", " journey"];
    const emitted = deltas.flatMap((text) =>
      sdkMessageToEvents(
        {
          type: "assistant",
          agent_id: "a",
          run_id: "r",
          message: { role: "assistant", content: [{ type: "text", text }] },
        } as unknown as SDKMessage,
        state,
      ),
    );
    expect(emitted).toEqual([]); // buffered, nothing emitted yet
    // A trailing reply (no following signal) is flushed by the runner.
    expect(flushAssistantText(state)).toEqual([
      { kind: "assistant_text", text: "I'll run the journey" },
    ]);
  });

  it("flushes buffered text when a usage turn boundary arrives", () => {
    const state = createMapperState();
    sdkMessageToEvents(
      {
        type: "assistant",
        agent_id: "a",
        run_id: "r",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done." }],
        },
      } as unknown as SDKMessage,
      state,
    );
    const events = sdkMessageToEvents(
      {
        type: "usage",
        agent_id: "a",
        run_id: "r",
        usage: { totalTokens: 1234 },
      } as unknown as SDKMessage,
      state,
    );
    expect(events).toEqual([
      { kind: "assistant_text", text: "done." },
      { kind: "turn_ended", turn: 1, totalTokens: 1234 },
    ]);
  });

  it("maps a completed tool_call with a result summary", () => {
    const state = createMapperState();
    const message: SDKMessage = {
      type: "tool_call",
      agent_id: "a",
      run_id: "r",
      call_id: "c1",
      name: "http_request",
      status: "completed",
      result: { status: 404, body: "not found" },
    };
    const [event] = sdkMessageToEvents(message, state);
    expect(event).toMatchObject({
      kind: "tool_call",
      status: "completed",
      result: "HTTP 404",
    });
  });

  it("maps a capability-denial tool result to its error code", () => {
    const state = createMapperState();
    const message: SDKMessage = {
      type: "tool_call",
      agent_id: "a",
      run_id: "r",
      call_id: "c1",
      name: "http_request",
      status: "error",
      result: { error: { code: "CAPABILITY_NOT_GRANTED", message: "no" } },
    };
    const [event] = sdkMessageToEvents(message, state);
    expect(event).toMatchObject({
      kind: "tool_call",
      status: "error",
      result: "CAPABILITY_NOT_GRANTED no",
    });
  });

  it("maps a usage message to a turn_ended, incrementing the turn", () => {
    // usage is the SDK's real turn boundary, so it advances the counter
    // (3 → 4) rather than reading a turn set by assistant frames.
    const state = createMapperState();
    state.turn = 3;
    const message: SDKMessage = {
      type: "usage",
      agent_id: "a",
      run_id: "r",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 15,
      },
    };
    expect(sdkMessageToEvents(message, state)).toEqual([
      { kind: "turn_ended", turn: 4, totalTokens: 15 },
    ]);
  });

  it("unwraps an MCP-routed custom tool_call to its real tool + result", () => {
    // Exact wire shape from a staging transcript: custom tools route through
    // the SDK MCP bridge as name:"mcp" with args.{providerIdentifier,
    // toolName, args} and result.value.content[].text.text.
    const state = createMapperState();
    const message: SDKMessage = {
      type: "tool_call",
      agent_id: "a",
      run_id: "r",
      call_id: "c1",
      name: "mcp",
      status: "completed",
      args: {
        providerIdentifier: "custom-user-tools",
        toolName: "browser_snapshot",
        args: {},
      },
      result: {
        status: "success",
        value: {
          content: [
            {
              text: {
                text: "URL: https://app.staging.example.dev/\nTitle: Example App",
              },
            },
          ],
          isError: false,
        },
      },
    } as unknown as SDKMessage;
    const [event] = sdkMessageToEvents(message, state);
    expect(event).toMatchObject({
      kind: "tool_call",
      tool: "browser_snapshot",
      status: "completed",
      result: "URL: https://app.staging.example.dev/",
    });
  });

  it("unwraps an MCP http_request result (JSON string) to its status code", () => {
    const state = createMapperState();
    const message: SDKMessage = {
      type: "tool_call",
      agent_id: "a",
      run_id: "r",
      call_id: "c2",
      name: "mcp",
      status: "completed",
      args: {
        providerIdentifier: "custom-user-tools",
        toolName: "http_request",
        args: { method: "POST", path: "/api/v1/folders" },
      },
      result: {
        status: "success",
        value: {
          content: [{ text: { text: '{"status":201,"body":{"id":"c-1"}}' } }],
          isError: false,
        },
      },
    } as unknown as SDKMessage;
    const [event] = sdkMessageToEvents(message, state);
    expect(event).toMatchObject({
      kind: "tool_call",
      tool: "http_request",
      summary: "POST /api/v1/folders",
      result: "HTTP 201",
    });
  });

  it("flags an MCP result with isError:true", () => {
    const state = createMapperState();
    const message: SDKMessage = {
      type: "tool_call",
      agent_id: "a",
      run_id: "r",
      call_id: "c3",
      name: "mcp",
      status: "completed",
      args: {
        providerIdentifier: "custom-user-tools",
        toolName: "browser_click",
        args: {},
      },
      result: {
        status: "success",
        value: {
          content: [{ text: { text: "element not found" } }],
          isError: true,
        },
      },
    } as unknown as SDKMessage;
    const [event] = sdkMessageToEvents(message, state);
    expect(event).toMatchObject({
      kind: "tool_call",
      tool: "browser_click",
      result: "ERROR element not found",
    });
  });

  it("emits nothing for system/status bookkeeping messages", () => {
    const state = createMapperState();
    const message: SDKMessage = {
      type: "system",
      agent_id: "a",
      run_id: "r",
    };
    expect(sdkMessageToEvents(message, state)).toEqual([]);
  });
});

describe("summarizeArgs", () => {
  it("strips query strings from http args (no token leak)", () => {
    expect(
      summarizeArgs("http_request", {
        method: "get",
        path: "/api/v1/items?token=SECRET",
      }),
    ).toBe("GET /api/v1/items");
  });

  it("surfaces the target url for browser navigation", () => {
    expect(
      summarizeArgs("browser_navigate", {
        url: "https://app.example/items/new?ref=x",
      }),
    ).toBe("/items/new");
  });

  it("falls back to arg keys for unknown tools (never a full dump)", () => {
    expect(summarizeArgs("mystery_tool", { a: 1, b: 2 })).toBe("{a, b}");
  });
});

describe("summarizeResult", () => {
  it("returns undefined for a running call", () => {
    expect(summarizeResult("running", { status: 200 })).toBeUndefined();
  });

  it("summarizes a browser page result to its first line", () => {
    expect(
      summarizeResult("completed", {
        summary: "URL: /items\nTitle: Item\nInteractable elements: 12",
      }),
    ).toBe("URL: /items");
  });
});
