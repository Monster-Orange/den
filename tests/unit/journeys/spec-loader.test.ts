/**
 * Unit tests for the journey spec YAML loader
 * (src/pillars/journeys/spec/loader.ts).
 *
 * The loader reads a *.journey.yml file, parses it with the yaml package,
 * validates it against journeySpecSchema, and either returns a typed
 * JourneySpec or throws a JourneySpecError carrying the offending file
 * path plus manifest-style mapped validation errors
 * (modeled on src/shared/manifest/validate-manifest.ts).
 */

import { describe, expect, it } from "@jest/globals";
import * as path from "path";
import {
  JourneySpecError,
  loadJourneySpec,
  parseJourneySpec,
} from "../../../src/pillars/journeys/spec/loader.js";

// Jest runs with cwd = repo root (see other suites' process.cwd() usage).
const fixturesDir = path.join(
  process.cwd(),
  "tests",
  "unit",
  "journeys",
  "fixtures",
);

function fixture(name: string): string {
  return path.join(fixturesDir, name);
}

describe("loadJourneySpec", () => {
  it("loads and validates a valid journey YAML file", () => {
    const spec = loadJourneySpec(fixture("valid.journey.yml"));
    expect(spec.name).toBe("user-first-item");
    expect(spec.surface).toBe("browser");
    expect(spec.persona.role).toBe("user");
    expect(spec.budgets.max_total_tokens).toBe(2_000_000);
    expect(spec.success.assertions).toHaveLength(3);
    expect(spec.success.assertions[0].kind).toBe("http_status");
    expect(spec.success.assertions[1].kind).toBe("array_min_length");
    expect(spec.success.assertions[2].kind).toBe("array_contains_match");
  });

  it("throws JourneySpecError with mapped issues for a spec missing a budget", () => {
    const filePath = fixture("invalid-missing-budget.journey.yml");
    let caught: unknown;
    try {
      loadJourneySpec(filePath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JourneySpecError);
    const specErr = caught as JourneySpecError;
    expect(specErr.filePath).toBe(filePath);
    expect(specErr.message).toContain(filePath);
    const budgetError = specErr.errors.find(
      (e) => e.path === "budgets.max_total_tokens",
    );
    expect(budgetError).toBeDefined();
    expect(budgetError?.message).toContain("required");
  });

  it("throws JourneySpecError naming the unrecognized key for a strict violation", () => {
    let caught: unknown;
    try {
      loadJourneySpec(fixture("invalid-unknown-key.journey.yml"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JourneySpecError);
    const specErr = caught as JourneySpecError;
    const messages = specErr.errors.map((e) => e.message).join("\n");
    expect(messages).toContain("judge_model");
  });

  it("throws JourneySpecError with a YAML parse message for malformed YAML", () => {
    let caught: unknown;
    try {
      loadJourneySpec(fixture("malformed.journey.yml"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JourneySpecError);
    const specErr = caught as JourneySpecError;
    expect(specErr.errors[0].message).toContain("Could not parse YAML");
  });

  it("throws JourneySpecError for a nonexistent file", () => {
    const filePath = fixture("does-not-exist.journey.yml");
    let caught: unknown;
    try {
      loadJourneySpec(filePath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JourneySpecError);
    expect((caught as JourneySpecError).message).toContain(filePath);
  });
});

describe("parseJourneySpec", () => {
  it("parses a raw YAML string", () => {
    const spec = parseJourneySpec(
      [
        "name: api-journey",
        "persona: { role: admin, brief: 'Probe the API.' }",
        "surface: api",
        "environments: [local]",
        "budgets: { max_turns: 5, timeout_s: 60, max_total_tokens: 50000 }",
        "success:",
        "  assertions:",
        "    - kind: http_status",
        "      request: { method: GET, path: '/healthz' }",
        "      equals: 200",
      ].join("\n"),
    );
    expect(spec.name).toBe("api-journey");
    expect(spec.surface).toBe("api");
  });

  it("parses an already-parsed object", () => {
    const spec = parseJourneySpec({
      name: "obj-journey",
      persona: { role: "beta", brief: "Try the beta feature." },
      surface: "mixed",
      environments: ["dev"],
      budgets: { max_turns: 5, timeout_s: 60, max_total_tokens: 50_000 },
      success: {
        assertions: [
          {
            kind: "json_path_exists",
            request: { method: "GET", path: "/api/v1/things" },
            path: "$.items",
          },
        ],
      },
    });
    expect(spec.name).toBe("obj-journey");
  });

  it("maps invalid enum values to a pointed must-be-one-of error", () => {
    const input = {
      name: "bad-surface",
      persona: { role: "user", brief: "x" },
      surface: "ui",
      environments: ["local"],
      budgets: { max_turns: 5, timeout_s: 60, max_total_tokens: 50_000 },
      success: {
        assertions: [
          {
            kind: "http_status",
            request: { method: "GET", path: "/healthz" },
            equals: 200,
          },
        ],
      },
    };
    let caught: unknown;
    try {
      parseJourneySpec(input);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JourneySpecError);
    const surfaceError = (caught as JourneySpecError).errors.find(
      (e) => e.path === "surface",
    );
    expect(surfaceError).toBeDefined();
    expect(surfaceError?.message).toMatch(/one of/i);
  });

  it("rejects non-object YAML documents (scalar / null)", () => {
    for (const doc of ["42", "null", '"just a string"']) {
      expect(() => parseJourneySpec(doc)).toThrow(JourneySpecError);
    }
  });
});
