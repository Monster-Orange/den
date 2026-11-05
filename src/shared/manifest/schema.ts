/**
 * Zod schemas for .den.yml manifests.
 *
 * Each schema version is defined separately so migrations can validate
 * inputs and outputs at their respective version boundaries.
 *
 * Current version: 1  (all existing manifests without a version field are v1)
 */

import { z } from "zod";
import { journeysAppSchema } from "../../pillars/journeys/app-config.js";
import { SECRET_ENV_KEY_RE, secretEnvRefError } from "../secrets/secret-env.js";

export const CURRENT_SCHEMA_VERSION = 1;
export const KNOWN_VERSIONS = [1] as const;

// ── Shared primitives ─────────────────────────────────────────────────────────

// Command definition: plain string or object with options
const commandDef = z.union([
  z.string(),
  z.object({
    cmd: z.string(),
    detachable: z.boolean().optional(),
    interactive: z.boolean().optional(),
  }),
]);

// Health check: HTTP (with or without explicit type) or shell
//
// Valid shapes:
//   { url: "http://..." }                         — implicit HTTP
//   { type: "http", url: "http://..." }           — explicit HTTP
//   { type: "shell", cmd: "pg_isready ..." }      — shell
const healthConfig = z.union([
  // Shell health check — must have cmd
  z.object({
    type: z.literal("shell"),
    cmd: z.string({
      required_error: '"cmd" is required for shell health checks',
    }),
    label: z.string().optional(),
  }),
  // HTTP health check (explicit or implicit type) — must have url
  z.object({
    type: z.union([z.literal("http"), z.undefined()]).optional(),
    url: z.string({
      required_error: '"url" is required for HTTP health checks',
    }),
    label: z.string().optional(),
  }),
]);

// `distinct: true` marks a SUBSYSTEM's log as its own listed source in the
// /logs view (e.g. shop/db — shop runs its own postgres, not infra-stack's).
// Without it, only a system's primary service log is listed there.
const logSource = z.union([
  z.object({ type: z.literal("process"), distinct: z.boolean().optional() }),
  z.object({
    type: z.literal("shell"),
    cmd: z.string(),
    distinct: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("cloudwatch"),
    logGroup: z.string(),
    logStream: z.string().optional(),
    region: z.string().optional(),
    distinct: z.boolean().optional(),
  }),
]);

// secret_env (R16): ENV_NAME → "<vault>/<item>/<field>", resolved through the
// secrets provider at up/restart and passed only in the process env.
const secretEnvConfig = z.record(
  z.string().regex(SECRET_ENV_KEY_RE, "must be a valid env var name"),
  z.string().superRefine((ref, ctx) => {
    const err = secretEnvRefError(ref);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
  }),
);

// ── Service management config ─────────────────────────────────────────────────
//
// Keys for commands/logs/health are environment names (local, dev, …).
// We accept any string key here — Zod's z.record(z.enum(…)) requires all
// enum keys to be present (exhaustive), which is too strict for optional env blocks.

// depends_on entry: plain string or object with a `service` field and optional
// `wait` flag (opts this service's startup into blocking on the dep's health
// check — otherwise default fire-and-forget / detach-window behavior applies).
const dependsOnEntry = z.union([
  z.string(),
  z.object({
    service: z.string(),
    wait: z.boolean().optional(),
  }),
]);

const httpUrlString = z
  .string()
  .regex(/^https?:\/\/\S+$/, "must be an http(s) URL");

// Placement (R13): where a service runs per env, and where a remote one is.
// Env names are checked against the org's environments in placement.ts.
const statusCode = z.number().int().min(100).max(599);
const serviceTarget = z
  .object({
    env: z.string().min(1),
    account: z.string().min(1).optional(),
    url: httpUrlString.optional(),
    expect: z.union([statusCode, z.array(statusCode).min(1)]).optional(),
  })
  .strict();

const serviceManagementConfig = z.object({
  runs: z.record(z.string(), z.enum(["local", "remote"])).optional(),
  target: serviceTarget.optional(),
  secret_env: secretEnvConfig.optional(),
  depends_on: z.array(dependsOnEntry).optional(),
  commands: z.record(z.string(), z.record(z.string(), commandDef)).optional(),
  logs: z.record(z.string(), logSource).optional(),
  health: z.record(z.string(), healthConfig).optional(),
  // Open-in-new-tab: env → app URL, plus named extras. http(s) only.
  urls: z.record(z.string(), httpUrlString).optional(),
  links: z
    .array(
      z.object({
        label: z.string().min(1),
        urls: z.record(z.string(), httpUrlString),
      }),
    )
    .optional(),
});

// ── Smoke / perf / synthetics ─────────────────────────────────────────────────

const validAuthRoles = ["admin", "user", "beta"] as const;

const smokeServiceConfig = z.object({
  testDir: z.string(),
  testMatch: z.string(),
  baseUrlKey: z.enum(["api", "web"]),
  auth: z.array(z.enum(validAuthRoles)),
  fixtures: z.record(z.string(), z.unknown()).optional(),
});

const performanceServiceConfig = z.object({
  enabled: z.boolean().optional(),
  testDir: z.string(),
  testMatch: z.string(),
  baseUrlKey: z.enum(["api", "web"]),
  service: z.string(),
  tags: z.array(z.string()).optional(),
  fixtures: z.record(z.string(), z.unknown()).optional(),
});

const syntheticsConfig = z.object({
  testDir: z.string(),
  testMatch: z.string(),
  baseUrlKey: z.enum(["api", "web"]),
  auth: z.array(z.enum(validAuthRoles)),
});

// Journeys (agent-driven E2E) — top-level like `synthetics:`, one spec home
// per repo. Deliberately thinner than syntheticsConfig: no baseUrlKey (the
// journeys runner resolves both web and api base URLs from env config) and
// no auth array (each journey spec's persona.role declares its own role).
// `app` describes the app under test (resources, session token, web-origin
// API feed): see src/pillars/journeys/app-config.ts.
const journeysConfig = z.object({
  testDir: z.string(),
  testMatch: z.string(),
  app: journeysAppSchema.optional(),
});

// Security (ZAP scanning) — top-level record keyed by service name, like
// `smoke:`/`performance:`. Production may only ever list the passive
// `baseline` mode: the pillar caps it at runtime too, but a manifest that
// asks for more is rejected up front so the mistake is visible at validation.
const securityEnvironments = [
  "local",
  "dev",
  "sandbox",
  "staging",
  "production",
] as const;
const securityModes = ["baseline", "api", "full"] as const;

const securityServiceConfig = z
  .object({
    baseUrlKey: z.enum(["api", "web"]).optional(),
    hosts: z
      .partialRecord(
        z.enum(securityEnvironments),
        z.array(
          z
            .string()
            .url()
            .refine((u) => /^https?:\/\//.test(u), {
              message: "host must be an http(s) URL",
            }),
        ),
      )
      .optional(),
    openapi: z.string().min(1).optional(),
    auth: z.array(z.enum(validAuthRoles)).optional(),
    // Passed to ZAP's `-z` option, which splits on whitespace — a regex with
    // a literal space would silently become two options, so reject it.
    exclude: z
      .array(
        z
          .string()
          .min(1)
          .refine((r) => !/\s/.test(r), {
            message: "exclude regex must not contain whitespace (use \\s)",
          })
          .refine(
            (r) => {
              try {
                new RegExp(r);
                return true;
              } catch {
                return false;
              }
            },
            { message: "exclude entry is not a valid regular expression" },
          ),
      )
      .optional(),
    modes: z
      .partialRecord(
        z.enum(securityEnvironments),
        z.array(z.enum(securityModes)),
      )
      .optional(),
  })
  .refine((c) => c.baseUrlKey !== undefined || c.hosts !== undefined, {
    message: 'one of "baseUrlKey" or "hosts" is required',
  })
  .refine(
    (c) => (c.modes?.production ?? ["baseline"]).every((m) => m === "baseline"),
    {
      message: 'production may only allow the passive "baseline" mode',
      path: ["modes", "production"],
    },
  );
// What is deployed where. Per Den environment, the first source that answers
// wins: `version` (a JSON endpoint; `field` names the commit SHA, default
// "build"), then `deployment` (a GitHub environment's deployments, made by
// `workflow`), then the newest successful `workflow` run on main.
const releaseSource = z.object({
  version: z.string().optional(),
  field: z.string().optional(),
  deployment: z.string().optional(),
});
const releaseConfig = z.object({
  workflow: z.string().optional(),
  environments: z.record(z.string(), releaseSource).optional(),
});

// The repo's own test suites, run from its checkout. Local only unless
// `environments` says otherwise; the command gets DEN_ENV and BASE_URL.
const testSuite = z.object({
  cmd: z.string(),
  cwd: z.string().optional(),
  label: z.string().optional(),
  environments: z.array(z.string()).optional(),
});

const githubManifestConfig = z.object({
  environments: z.record(z.string(), z.string()).optional(),
});

// Docker Compose repos run behind the edge (see src/shared/stacks/types.ts).
const composeConfig = z.object({
  name: z.string().optional(),
  dir: z.string().optional(),
  files: z.array(z.string()).optional(),
  routes: z.record(z.string(), z.string()).optional(),
  generate: z.array(z.string()).optional(),
  uses: z.array(z.string()).optional(),
  env: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  profiles: z.array(z.string()).optional(),
  healthchecks: z.record(z.string(), z.array(z.string()).min(1)).optional(),
  // service → env vars set on that service in the override (wins by key).
  service_env: z
    .record(
      z.string(),
      z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    )
    .optional(),
  // Env vars resolved from the secrets provider into the docker compose
  // process's env at up/restart. Never written to the override.
  secret_env: secretEnvConfig.optional(),
});

// ── v1 manifest schema ────────────────────────────────────────────────────────

export const v1ManifestSchema = z.object({
  // Accept any integer version — the validator handles known/unknown version
  // warnings separately so that future versions don't fail schema validation.
  version: z.number().int().positive().optional(),
  name: z.string({ required_error: "name is required" }),
  entrypoint: z.string().optional(),
  services: z.record(z.string(), serviceManagementConfig).optional(),
  smoke: z.record(z.string(), smokeServiceConfig).optional(),
  performance: z.record(z.string(), performanceServiceConfig).optional(),
  synthetics: syntheticsConfig.optional(),
  journeys: journeysConfig.optional(),
  security: z.record(z.string(), securityServiceConfig).optional(),
  github: githubManifestConfig.optional(),
  compose: composeConfig.optional(),
  application: z.string().optional(),
  kind: z.enum(["service", "module", "library"]).optional(),
  contributes_to: z.array(z.string()).optional(),
  release: releaseConfig.optional(),
  tests: z.record(z.string(), testSuite).optional(),
});

export type V1Manifest = z.infer<typeof v1ManifestSchema>;

/** Map from version number to its Zod schema. */
export const schemaByVersion: Record<number, z.ZodTypeAny> = {
  1: v1ManifestSchema,
};
