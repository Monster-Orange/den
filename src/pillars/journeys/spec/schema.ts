/**
 * Zod schema for *.journey.yml journey specs (journeys pillar).
 *
 * Design rules (plan: agent-e2e-journeys, packet jrn-spec-schema):
 * - STRICT everywhere: unknown keys are rejected at every level, so typos
 *   and unsupported fields fail loudly at load time.
 * - Budgets are fail-closed: max_turns, timeout_s, and max_total_tokens are
 *   all REQUIRED with sanity bounds only — no default values are ever
 *   injected; spec authors set every budget explicitly.
 * - `model` is an optional spec field — the journey's declared default
 *   agent model. The JOURNEYS_MODEL env var, when set, overrides every
 *   spec's model (operator control for cost pinning / CI). A journey with
 *   neither source configured is refused at run time (fail-closed).
 * - persona.role is limited to admin|user|beta: browser session minting via
 *   headlessLogin only supports those roles
 *   (src/shared/auth/headless-login.ts). root_admin is excluded until a
 *   browser login path exists for it.
 * - success.assertions is the sole pass/fail authority: a discriminated
 *   union on `kind`, each carrying a deterministic API probe request
 *   ({method, path, body?} — POST probes with bodies are first-class).
 */

import { z } from "zod";

// ── Budgets ──────────────────────────────────────────────────────────────────

// HLD catalog rule: an individual journey must complete within 10 minutes.
export const MAX_TIMEOUT_S = 600;

const budgetsSchema = z
  .strictObject({
    /** Hard cap on agent turns; exceeded → run.cancel(). */
    max_turns: z.int().positive(),
    /** Wall-clock cap in seconds; bounded by the HLD's 10-minute catalog rule. */
    timeout_s: z.int().positive().max(MAX_TIMEOUT_S),
    /** Cumulative TokenUsage.totalTokens cap; exceeded → run.cancel(). */
    max_total_tokens: z.int().positive(),
  })
  .describe(
    "All budgets are required and fail-closed; no defaults are injected.",
  );

// ── Persona / surface / environments ────────────────────────────────────────

// Roles supported by headlessLogin (browser session minting); root_admin
// intentionally excluded — no headless browser login path exists for it.
const personaRoleSchema = z.enum(["admin", "user", "beta"]);

const personaSchema = z.strictObject({
  role: personaRoleSchema,
  /** Natural-language brief the synthetic user acts on. */
  brief: z.string().min(1),
});

const surfaceSchema = z.enum(["browser", "api", "mixed"]);

// ── HTTP capabilities (review finding R2-1) ─────────────────────────────────

// Only POST/PUT/PATCH are grantable: GET stays origin-wide on the scoped
// HTTP tool (reads are its purpose) and DELETE is harness-only (teardown).
const httpCapabilityMethodSchema = z.enum(["POST", "PUT", "PATCH"]);

/**
 * One journey-scoped mutating-capability grant for the agent's HTTP tool.
 * `path_pattern` matches the full request path; `*` matches exactly one
 * path segment (e.g. `/api/v1/items/{*}/notes`, written without the
 * braces in real patterns).
 */
const httpCapabilitySchema = z.strictObject({
  methods: z.array(httpCapabilityMethodSchema).min(1),
  path_pattern: z.string().min(1),
});

// Must match config/environments/*.json (env-selector's known set).
// The runner additionally hard-refuses production and prod regardless of spec content.
const environmentNameSchema = z.enum([
  "local",
  "dev",
  "sandbox",
  "staging",
  "beta",
  "prod",
  "production",
]);

// ── Assertion probe request ──────────────────────────────────────────────────

const probeMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Deterministic API probe executed by the verifier (harness-side,
 * allowlist + JWT client). `{placeholders}` in `path` bind to
 * ledger-extracted resource ids at verification time.
 */
const probeRequestSchema = z.strictObject({
  method: probeMethodSchema,
  path: z.string().min(1),
  /** Optional JSON request body (e.g. search POST probes). */
  body: z.record(z.string(), z.unknown()).optional(),
});

// JSON literal usable in equality / containment / match predicates.
const jsonLiteralSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

// ── Assertion discriminated union ────────────────────────────────────────────

const httpStatusAssertion = z.strictObject({
  kind: z.literal("http_status"),
  request: probeRequestSchema,
  /** Expected HTTP status code. */
  equals: z.int().min(100).max(599),
});

const jsonPathExistsAssertion = z.strictObject({
  kind: z.literal("json_path_exists"),
  request: probeRequestSchema,
  /** JSONPath that must resolve to a value. */
  path: z.string().min(1),
});

const jsonPathEqualsAssertion = z.strictObject({
  kind: z.literal("json_path_equals"),
  request: probeRequestSchema,
  path: z.string().min(1),
  /** Literal the JSONPath value must equal. */
  equals: jsonLiteralSchema,
});

const jsonPathContainsAssertion = z.strictObject({
  kind: z.literal("json_path_contains"),
  request: probeRequestSchema,
  path: z.string().min(1),
  /** String/array containment target at the JSONPath. */
  contains: jsonLiteralSchema,
});

const arrayMinLengthAssertion = z.strictObject({
  kind: z.literal("array_min_length"),
  request: probeRequestSchema,
  path: z.string().min(1),
  /** Minimum number of items the array at the JSONPath must contain. */
  min: z.int().positive(),
});

const arrayContainsMatchAssertion = z.strictObject({
  kind: z.literal("array_contains_match"),
  request: probeRequestSchema,
  path: z.string().min(1),
  /** Field predicates at least one array item must match. */
  match: z
    .record(z.string(), jsonLiteralSchema)
    .refine((m) => Object.keys(m).length > 0, {
      message: "match must declare at least one field predicate",
    }),
});

export const journeyAssertionSchema = z.discriminatedUnion("kind", [
  httpStatusAssertion,
  jsonPathExistsAssertion,
  jsonPathEqualsAssertion,
  jsonPathContainsAssertion,
  arrayMinLengthAssertion,
  arrayContainsMatchAssertion,
]);

// ── Journey spec ─────────────────────────────────────────────────────────────

const successSchema = z.strictObject({
  /** Deterministic assertions — the sole pass/fail authority. Min 1. */
  assertions: z.array(journeyAssertionSchema).min(1),
  /** Optional advisory rubric lines for the (advisory-only) LLM judge. */
  rubric: z.array(z.string()).optional(),
});

export const journeySpecSchema = z.strictObject({
  name: z.string().min(1),
  persona: personaSchema,
  surface: surfaceSchema,
  /**
   * Default agent model for this journey (e.g. "composer"). The
   * JOURNEYS_MODEL env var overrides it when set; with neither configured
   * the runner refuses the journey (fail-closed, no invented default).
   */
  model: z.string().min(1).optional(),
  /** Environments this journey may run against. The runner targets exactly one per invocation. */
  environments: z.array(environmentNameSchema).min(1),
  budgets: budgetsSchema,
  /**
   * Mutating grants for the scoped HTTP tool (api/mixed surfaces).
   * OMITTED → the tool is read-only for mutations (safe default): every
   * POST/PUT/PATCH is rejected before fetching. GET needs no grant.
   */
  http_capabilities: z.array(httpCapabilitySchema).optional(),
  success: successSchema,
});

export type JourneySpec = z.infer<typeof journeySpecSchema>;
export type JourneyHttpCapability = z.infer<typeof httpCapabilitySchema>;
export type JourneyAssertion = z.infer<typeof journeyAssertionSchema>;
export type JourneyProbeRequest = z.infer<typeof probeRequestSchema>;
export type JourneyBudgets = z.infer<typeof budgetsSchema>;
export type JourneyPersonaRole = z.infer<typeof personaRoleSchema>;
export type JourneySurface = z.infer<typeof surfaceSchema>;
