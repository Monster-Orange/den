/**
 * Unit tests for the journey spec Zod schema
 * (src/pillars/journeys/spec/schema.ts).
 *
 * Contract under test (plan packet jrn-spec-schema):
 * - strict schema: unknown keys rejected at every level
 * - budgets: max_turns / timeout_s / max_total_tokens all REQUIRED,
 *   sanity-bounded, and never defaulted
 * - persona.role restricted to admin|user|beta (headlessLogin support)
 * - surface enum browser|api|mixed
 * - environments restricted to known env names
 * - success.assertions: non-empty discriminated union on `kind`,
 *   probe requests carry method + path + optional body
 * - rubric optional
 */

import { describe, expect, it } from "@jest/globals";
import * as yaml from "yaml";
import {
  journeySpecSchema,
  MAX_TIMEOUT_S,
} from "../../../src/pillars/journeys/spec/schema.js";
import type { JourneySpec } from "../../../src/pillars/journeys/spec/schema.js";

/** A fully valid journey spec exercising every assertion kind. */
function validSpec(): Record<string, unknown> {
  return {
    name: "user-first-item",
    persona: {
      role: "user",
      brief: "You are a new user creating your first item.",
    },
    surface: "browser",
    environments: ["local", "staging"],
    budgets: {
      max_turns: 40,
      timeout_s: 480,
      max_total_tokens: 2_000_000,
    },
    success: {
      assertions: [
        {
          kind: "http_status",
          request: { method: "GET", path: "/api/v1/items/{item_id}" },
          equals: 200,
        },
      ],
      rubric: ["The agent reached the answer without excessive retries."],
    },
  };
}

describe("journeySpecSchema — valid specs", () => {
  it("parses a fully valid spec and preserves all values", () => {
    const input = validSpec();
    const result = journeySpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const spec: JourneySpec = result.data;
    expect(spec.name).toBe("user-first-item");
    expect(spec.persona.role).toBe("user");
    expect(spec.surface).toBe("browser");
    expect(spec.environments).toEqual(["local", "staging"]);
    expect(spec.budgets).toEqual({
      max_turns: 40,
      timeout_s: 480,
      max_total_tokens: 2_000_000,
    });
    expect(spec.success.assertions).toHaveLength(1);
    expect(spec.success.rubric).toHaveLength(1);
  });

  it("accepts a spec without a rubric (rubric is optional)", () => {
    const input = validSpec();
    delete (input.success as Record<string, unknown>).rubric;
    const result = journeySpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.success.rubric).toBeUndefined();
  });

  it.each(["browser", "api", "mixed"] as const)(
    "accepts surface %s",
    (surface) => {
      const input = { ...validSpec(), surface };
      expect(journeySpecSchema.safeParse(input).success).toBe(true);
    },
  );

  it.each(["admin", "user", "beta"] as const)(
    "accepts persona role %s",
    (role) => {
      const input = validSpec();
      (input.persona as Record<string, unknown>).role = role;
      expect(journeySpecSchema.safeParse(input).success).toBe(true);
    },
  );

  it.each(["local", "dev", "sandbox", "staging", "production"])(
    "accepts known environment name %s",
    (env) => {
      const input = { ...validSpec(), environments: [env] };
      expect(journeySpecSchema.safeParse(input).success).toBe(true);
    },
  );
});

describe("journeySpecSchema — budgets are required, bounded, never defaulted", () => {
  it.each(["max_turns", "timeout_s", "max_total_tokens"])(
    "rejects a spec whose budgets is missing %s",
    (field) => {
      const input = validSpec();
      delete (input.budgets as Record<string, unknown>)[field];
      const result = journeySpecSchema.safeParse(input);
      expect(result.success).toBe(false);
    },
  );

  it("rejects a spec with no budgets block at all — no defaults injected", () => {
    const input = validSpec();
    delete input.budgets;
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ["max_turns", 0],
    ["max_turns", -3],
    ["max_turns", 2.5],
    ["max_turns", "40"],
    ["timeout_s", 0],
    ["timeout_s", -1],
    ["timeout_s", 1.5],
    ["max_total_tokens", 0],
    ["max_total_tokens", -100],
    ["max_total_tokens", 0.5],
  ])("rejects budget %s = %p (positive integers only)", (field, value) => {
    const input = validSpec();
    (input.budgets as Record<string, unknown>)[field] = value;
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("rejects timeout_s above the sanity ceiling", () => {
    const input = validSpec();
    (input.budgets as Record<string, unknown>).timeout_s = MAX_TIMEOUT_S + 1;
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("accepts timeout_s exactly at the sanity ceiling", () => {
    const input = validSpec();
    (input.budgets as Record<string, unknown>).timeout_s = MAX_TIMEOUT_S;
    expect(journeySpecSchema.safeParse(input).success).toBe(true);
  });

  it("never injects budget defaults — output equals input exactly", () => {
    const result = journeySpecSchema.safeParse(validSpec());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.budgets).toStrictEqual({
        max_turns: 40,
        timeout_s: 480,
        max_total_tokens: 2_000_000,
      });
    }
  });
});

describe("journeySpecSchema — strictness (unknown keys rejected)", () => {
  it.each([
    ["root", (s: Record<string, unknown>) => (s.judge_model = "gpt-5")],
    [
      "persona",
      (s: Record<string, unknown>) =>
        ((s.persona as Record<string, unknown>).email = "x@y.z"),
    ],
    [
      "budgets",
      (s: Record<string, unknown>) =>
        ((s.budgets as Record<string, unknown>).max_cost_usd = 1),
    ],
    [
      "success",
      (s: Record<string, unknown>) =>
        ((s.success as Record<string, unknown>).judge = "llm"),
    ],
    [
      "assertion",
      (s: Record<string, unknown>) => {
        const success = s.success as { assertions: Record<string, unknown>[] };
        success.assertions[0].retries = 3;
      },
    ],
    [
      "request",
      (s: Record<string, unknown>) => {
        const success = s.success as {
          assertions: { request: Record<string, unknown> }[];
        };
        success.assertions[0].request.headers = { "X-Foo": "bar" };
      },
    ],
  ])("rejects an unknown key at the %s level", (_level, mutate) => {
    const input = validSpec();
    mutate(input);
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("accepts an optional `model` field — the journey's declared default model", () => {
    const input = { ...validSpec(), model: "composer" };
    const result = journeySpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe("composer");
    }
  });

  it("rejects an empty `model` (declare a real model id or omit the field)", () => {
    const input = { ...validSpec(), model: "" };
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });
});

describe("journeySpecSchema — enums and required core fields", () => {
  it("rejects an unknown surface value", () => {
    const input = { ...validSpec(), surface: "ui" };
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("rejects persona role root_admin (no headless browser login path)", () => {
    const input = validSpec();
    (input.persona as Record<string, unknown>).role = "root_admin";
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("rejects unknown environment names", () => {
    const input = { ...validSpec(), environments: ["qa"] };
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an empty environments list", () => {
    const input = { ...validSpec(), environments: [] };
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an empty name", () => {
    const input = { ...validSpec(), name: "" };
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an empty persona brief", () => {
    const input = validSpec();
    (input.persona as Record<string, unknown>).brief = "";
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });
});

describe("journeySpecSchema — http_capabilities (review finding R2-1)", () => {
  it("is optional — omitting it keeps the spec valid (read-only tool default)", () => {
    const result = journeySpecSchema.safeParse(validSpec());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.http_capabilities).toBeUndefined();
  });

  it("accepts mutating grants of {methods, path_pattern}", () => {
    const input = {
      ...validSpec(),
      surface: "api",
      http_capabilities: [
        { methods: ["POST"], path_pattern: "/api/v1/items" },
        { methods: ["PUT", "PATCH"], path_pattern: "/api/v1/items/*" },
      ],
    };
    const result = journeySpecSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.http_capabilities).toEqual([
      { methods: ["POST"], path_pattern: "/api/v1/items" },
      { methods: ["PUT", "PATCH"], path_pattern: "/api/v1/items/*" },
    ]);
  });

  it("rejects DELETE and GET in grant methods — only POST/PUT/PATCH are grantable", () => {
    for (const method of ["DELETE", "GET"]) {
      const result = journeySpecSchema.safeParse({
        ...validSpec(),
        http_capabilities: [{ methods: [method], path_pattern: "/x" }],
      });
      expect(result.success).toBe(false);
    }
  });

  it("rejects a grant with an empty methods list or empty path_pattern", () => {
    expect(
      journeySpecSchema.safeParse({
        ...validSpec(),
        http_capabilities: [{ methods: [], path_pattern: "/x" }],
      }).success,
    ).toBe(false);
    expect(
      journeySpecSchema.safeParse({
        ...validSpec(),
        http_capabilities: [{ methods: ["POST"], path_pattern: "" }],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys inside a grant (strictness)", () => {
    const result = journeySpecSchema.safeParse({
      ...validSpec(),
      http_capabilities: [
        { methods: ["POST"], path_pattern: "/x", extra: true },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("journeySpecSchema — success.assertions contract", () => {
  it("rejects a spec with no assertions key", () => {
    const input = validSpec();
    delete (input.success as Record<string, unknown>).assertions;
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an empty assertions array (min 1)", () => {
    const input = validSpec();
    (input.success as Record<string, unknown>).assertions = [];
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  const assertionYamlByKind: Record<string, string> = {
    http_status: `
kind: http_status
request: { method: GET, path: "/api/v1/items/{item_id}" }
equals: 200
`,
    json_path_exists: `
kind: json_path_exists
request: { method: GET, path: "/api/v1/items/{item_id}" }
path: "$.id"
`,
    json_path_equals: `
kind: json_path_equals
request: { method: GET, path: "/api/v1/items/{item_id}" }
path: "$.status"
equals: "active"
`,
    json_path_contains: `
kind: json_path_contains
request: { method: GET, path: "/api/v1/items/{item_id}" }
path: "$.title"
contains: "item"
`,
    array_min_length: `
kind: array_min_length
request: { method: GET, path: "/api/v1/items/{item_id}/messages" }
path: "$[?(@.role=='assistant')]"
min: 2
`,
    array_contains_match: `
kind: array_contains_match
request:
  method: POST
  path: "/api/v1/folders/{folder_id}/browse"
  body: { container: "example-bucket" }
path: "$.nodes"
match: { type: "folder" }
`,
  };

  it.each(Object.keys(assertionYamlByKind))(
    "round-trips assertion kind %s from YAML",
    (kind) => {
      const assertion = yaml.parse(assertionYamlByKind[kind]);
      const input = validSpec();
      (input.success as Record<string, unknown>).assertions = [assertion];
      const result = journeySpecSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.success.assertions[0].kind).toBe(kind);
      }
    },
  );

  it("accepts a POST probe request with a body (method+body probes are first-class)", () => {
    const input = validSpec();
    (input.success as Record<string, unknown>).assertions = [
      {
        kind: "http_status",
        request: {
          method: "POST",
          path: "/api/v1/folders/{folder_id}/browse",
          body: { container: "example-bucket" },
        },
        equals: 200,
      },
    ];
    expect(journeySpecSchema.safeParse(input).success).toBe(true);
  });

  it("rejects an unknown assertion kind with a pointed error", () => {
    const input = validSpec();
    (input.success as Record<string, unknown>).assertions = [
      {
        kind: "http_body_matches",
        request: { method: "GET", path: "/x" },
      },
    ];
    const result = journeySpecSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths.some((p) => p.includes("assertions"))).toBe(true);
    }
  });

  it("rejects an http_status assertion missing `equals` with a pointed error", () => {
    const input = validSpec();
    (input.success as Record<string, unknown>).assertions = [
      { kind: "http_status", request: { method: "GET", path: "/x" } },
    ];
    const result = journeySpecSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("success.assertions.0.equals");
    }
  });

  it("rejects an array_min_length assertion missing `min`", () => {
    const input = validSpec();
    (input.success as Record<string, unknown>).assertions = [
      {
        kind: "array_min_length",
        request: { method: "GET", path: "/x" },
        path: "$.items",
      },
    ];
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an invalid HTTP method in a probe request", () => {
    const input = validSpec();
    (input.success as Record<string, unknown>).assertions = [
      {
        kind: "http_status",
        request: { method: "FETCH", path: "/x" },
        equals: 200,
      },
    ];
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("rejects an http_status assertion whose equals is not a valid status code", () => {
    const input = validSpec();
    (input.success as Record<string, unknown>).assertions = [
      {
        kind: "http_status",
        request: { method: "GET", path: "/x" },
        equals: 42,
      },
    ];
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });

  it("rejects a non-string rubric entry", () => {
    const input = validSpec();
    (input.success as Record<string, unknown>).rubric = ["ok", 42];
    expect(journeySpecSchema.safeParse(input).success).toBe(false);
  });
});
