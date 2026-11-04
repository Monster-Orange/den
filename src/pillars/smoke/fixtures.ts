import type {
  CommandDef,
  Environment,
  PerformanceServiceConfig,
  RawManifest,
  SmokeCleanupContextConfig,
  SmokeCleanupFixtureConfig,
  SmokeObjectStoreCleanupTargetConfig,
  SmokeServiceConfig,
  SmokeStorageFixtureConfig,
} from "../../shared/types/index.js";

export interface ResolvedSmokeStorageFixture {
  endpoint: string;
  apiEndpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  cleanupContext?: ResolvedSmokeCleanupContext;
}

export interface ResolvedSmokeObjectStoreCleanupTarget {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export interface ResolvedSmokeCleanupContext {
  objectStores?: Record<string, ResolvedSmokeObjectStoreCleanupTarget>;
}

/** Resolved storage fixture with lifecycle metadata and env injection derived from the resolved payload. */
export interface ResolvedSmokeStorageFixtureLifecycle {
  fixtureKey: string;
  resolvedPayload: ResolvedSmokeStorageFixture;
  envVars: Record<string, string>;
  setup?: CommandDef;
  teardown?: CommandDef;
  /** When set, smoke/perf runners probe this path under the service base URL before tests. */
  adminProbePath?: string;
  /** Service-authored hint appended to the 403 error from the admin probe. */
  adminProbe403Hint?: string;
}

/** Resolved teardown-only cleanup fixture (no storage payload). */
export interface ResolvedSmokeCleanupFixtureLifecycle {
  fixtureKey: string;
  resolvedPayload: Record<string, unknown>;
  envVars: Record<string, string>;
  setup?: CommandDef;
  teardown: CommandDef;
  adminProbePath?: string;
  adminProbe403Hint?: string;
}

type FixtureCapableServiceConfig =
  | SmokeServiceConfig
  | PerformanceServiceConfig;

function resolveFixtureValue(
  fixture: SmokeStorageFixtureConfig | SmokeObjectStoreCleanupTargetConfig,
  key: "endpoint" | "apiEndpoint" | "bucket" | "accessKey" | "secretKey",
  env: NodeJS.ProcessEnv,
  missingEnvVars: string[],
): string | undefined {
  const literalKey = key as keyof typeof fixture;
  const fromEnvKey = `${key}FromEnv` as keyof typeof fixture;

  const literalValue = fixture[literalKey];
  if (typeof literalValue === "string" && literalValue.length > 0) {
    return literalValue;
  }

  const envVarName = fixture[fromEnvKey];
  if (typeof envVarName === "string" && envVarName.length > 0) {
    const envValue = env[envVarName];
    if (typeof envValue === "string" && envValue.length > 0) {
      return envValue;
    }
    missingEnvVars.push(envVarName);
  }

  return undefined;
}

function resolveCleanupContext(
  cleanupContext: SmokeCleanupContextConfig | undefined,
  env: NodeJS.ProcessEnv,
  missingEnvVars: string[],
): ResolvedSmokeCleanupContext | undefined {
  if (!cleanupContext?.objectStores) {
    return undefined;
  }

  const objectStores = Object.entries(cleanupContext.objectStores).reduce<
    Record<string, ResolvedSmokeObjectStoreCleanupTarget>
  >((acc, [targetName, target]) => {
    const endpoint = resolveFixtureValue(
      target,
      "endpoint",
      env,
      missingEnvVars,
    );
    const bucket = resolveFixtureValue(target, "bucket", env, missingEnvVars);
    const accessKey = resolveFixtureValue(
      target,
      "accessKey",
      env,
      missingEnvVars,
    );
    const secretKey = resolveFixtureValue(
      target,
      "secretKey",
      env,
      missingEnvVars,
    );
    const fieldIsConfigured = (
      config: SmokeObjectStoreCleanupTargetConfig,
      key: "endpoint" | "bucket" | "accessKey" | "secretKey",
    ) =>
      Boolean(
        (typeof config[key] === "string" && config[key]!.length > 0) ||
        (typeof config[`${key}FromEnv`] === "string" &&
          config[`${key}FromEnv`]!.length > 0),
      );
    const missingFields = [
      ["endpoint", endpoint, fieldIsConfigured(target, "endpoint")],
      ["bucket", bucket, fieldIsConfigured(target, "bucket")],
      ["accessKey", accessKey, fieldIsConfigured(target, "accessKey")],
      ["secretKey", secretKey, fieldIsConfigured(target, "secretKey")],
    ]
      .filter(([, value, isConfigured]) => !value && !isConfigured)
      .map(([field]) => field);

    if (missingFields.length > 0) {
      throw new Error(
        `Storage fixture cleanupContext.objectStores.${targetName} is missing required fields: ${missingFields.join(", ")}`,
      );
    }

    acc[targetName] = {
      endpoint,
      bucket,
      accessKey,
      secretKey,
    } as ResolvedSmokeObjectStoreCleanupTarget;
    return acc;
  }, {});

  return Object.keys(objectStores).length > 0 ? { objectStores } : undefined;
}

/**
 * Deterministic JSON string for hashing or stable comparison: fixture key + resolved payload fields in fixed key order.
 */
export function smokeStorageFixtureHashInput(
  fixtureKey: string,
  resolvedPayload: ResolvedSmokeStorageFixture,
): string {
  return JSON.stringify({
    fixtureKey,
    resolvedPayload: {
      accessKey: resolvedPayload.accessKey,
      apiEndpoint: resolvedPayload.apiEndpoint,
      bucket: resolvedPayload.bucket,
      ...(resolvedPayload.cleanupContext
        ? { cleanupContext: resolvedPayload.cleanupContext }
        : {}),
      endpoint: resolvedPayload.endpoint,
      secretKey: resolvedPayload.secretKey,
    },
  });
}

function validateAdminProbePath(
  adminProbePath: string | undefined,
  label: string,
): void {
  if (
    adminProbePath !== undefined &&
    adminProbePath.length > 0 &&
    (!adminProbePath.startsWith("/") || adminProbePath.includes("://"))
  ) {
    throw new Error(
      `${label} adminProbePath must be a bare path starting with "/" (got ${JSON.stringify(adminProbePath)})`,
    );
  }
}

function coerceTeardownEnv(
  teardownEnv: Record<string, string | number | boolean> | undefined,
  label: string,
): Record<string, string> {
  const teardownEnvStrings: Record<string, string> = {};
  if (teardownEnv !== undefined) {
    for (const [key, value] of Object.entries(teardownEnv)) {
      if (value === undefined || value === null) {
        throw new Error(
          `${label} teardownEnv.${key} must not be null or undefined`,
        );
      }
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(
          `${label} teardownEnv.${key} must be a string, number, or boolean`,
        );
      }
      teardownEnvStrings[key] = String(value);
    }
  }
  return teardownEnvStrings;
}

/**
 * Resolve the teardown-only cleanup fixture for `smoke.<service>.fixtures.cleanup.<env>`.
 * Returns null when the service declares no cleanup fixture for the environment.
 */
export function resolveSmokeCleanupFixture(
  manifest: RawManifest,
  serviceName: string,
  environment: Environment,
): ResolvedSmokeCleanupFixtureLifecycle | null {
  const service = manifest.smoke?.[serviceName];
  if (!service) {
    throw new Error(`Smoke service "${serviceName}" not found in manifest`);
  }

  const fixture: SmokeCleanupFixtureConfig | undefined =
    service.fixtures?.cleanup?.[environment];
  if (!fixture) {
    return null;
  }

  const label = `Cleanup fixture for smoke.${serviceName}.${environment}`;
  if (fixture.teardown === undefined) {
    throw new Error(`${label} must define a teardown command`);
  }
  validateAdminProbePath(fixture.adminProbePath, label);
  const teardownEnvStrings = coerceTeardownEnv(fixture.teardownEnv, label);

  return {
    fixtureKey: `${serviceName}:cleanup:${environment}`,
    resolvedPayload: { environment, teardownEnv: teardownEnvStrings },
    envVars: teardownEnvStrings,
    teardown: fixture.teardown,
    ...(fixture.setup !== undefined ? { setup: fixture.setup } : {}),
    ...(fixture.adminProbePath !== undefined &&
    fixture.adminProbePath.length > 0
      ? { adminProbePath: fixture.adminProbePath }
      : {}),
    ...(fixture.adminProbe403Hint !== undefined &&
    fixture.adminProbe403Hint.length > 0
      ? { adminProbe403Hint: fixture.adminProbe403Hint }
      : {}),
  };
}

export function resolveSmokeStorageFixture(
  manifest: RawManifest,
  serviceName: string,
  environment: Environment,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSmokeStorageFixtureLifecycle {
  const service = manifest.smoke?.[serviceName];
  if (!service) {
    throw new Error(`Smoke service "${serviceName}" not found in manifest`);
  }

  return resolveStorageFixtureLifecycle(
    service,
    "smoke",
    serviceName,
    environment,
    env,
    undefined,
  );
}

export function resolvePerformanceStorageFixture(
  manifest: RawManifest,
  moduleName: string,
  environment: Environment,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSmokeStorageFixtureLifecycle {
  const moduleConfig = manifest.performance?.[moduleName];
  if (!moduleConfig) {
    throw new Error(`Performance module "${moduleName}" not found in manifest`);
  }

  return resolveStorageFixtureLifecycle(
    moduleConfig,
    "performance",
    moduleConfig.service,
    environment,
    env,
    moduleName,
  );
}

function resolveStorageFixtureLifecycle(
  service: FixtureCapableServiceConfig,
  pillar: "smoke" | "performance",
  serviceName: string,
  environment: Environment,
  env: NodeJS.ProcessEnv,
  /** Manifest key for `performance.<name>` — scopes fixture identity per k6 module (distinct PERF_TEST_ID / teardown). */
  performanceModuleKey?: string,
): ResolvedSmokeStorageFixtureLifecycle {
  const fixture = service.fixtures?.storage?.[environment];
  if (!fixture) {
    throw new Error(
      `Storage fixture for ${pillar}.${serviceName} is not defined for environment "${environment}"`,
    );
  }

  validateAdminProbePath(
    fixture.adminProbePath,
    `Storage fixture for ${pillar}.${serviceName}.${environment}:`,
  );

  const missingEnvVars: string[] = [];
  const endpoint = resolveFixtureValue(
    fixture,
    "endpoint",
    env,
    missingEnvVars,
  );
  const apiEndpoint = resolveFixtureValue(
    fixture,
    "apiEndpoint",
    env,
    missingEnvVars,
  );
  const bucket = resolveFixtureValue(fixture, "bucket", env, missingEnvVars);
  const accessKey = resolveFixtureValue(
    fixture,
    "accessKey",
    env,
    missingEnvVars,
  );
  const secretKey = resolveFixtureValue(
    fixture,
    "secretKey",
    env,
    missingEnvVars,
  );
  const cleanupContext = resolveCleanupContext(
    fixture.cleanupContext,
    env,
    missingEnvVars,
  );

  if (missingEnvVars.length > 0) {
    throw new Error(
      `Storage fixture for ${pillar}.${serviceName}.${environment} is missing required env vars: ${missingEnvVars.join(", ")}`,
    );
  }

  const missingFields = [
    ["endpoint", endpoint],
    ["apiEndpoint", apiEndpoint],
    ["bucket", bucket],
    ["accessKey", accessKey],
    ["secretKey", secretKey],
  ]
    .filter(([, value]) => !value)
    .map(([field]) => field);

  if (missingFields.length > 0) {
    throw new Error(
      `Storage fixture for ${pillar}.${serviceName}.${environment} is missing required fields: ${missingFields.join(", ")}`,
    );
  }

  const resolvedPayload = {
    endpoint,
    apiEndpoint,
    bucket,
    accessKey,
    secretKey,
    ...(cleanupContext ? { cleanupContext } : {}),
  } as ResolvedSmokeStorageFixture;

  const fixtureKey =
    pillar === "performance" && performanceModuleKey !== undefined
      ? `${serviceName}:perf:${performanceModuleKey}:storage:${environment}`
      : `${serviceName}:storage:${environment}`;
  const storageFixtureEnvPayload = {
    endpoint,
    apiEndpoint,
    bucket,
    accessKey,
    secretKey,
  };

  const teardownEnvStrings: Record<string, string> = {};
  if (fixture.teardownEnv !== undefined) {
    for (const [key, value] of Object.entries(fixture.teardownEnv)) {
      if (value === undefined || value === null) {
        throw new Error(
          `Storage fixture teardownEnv.${key} for ${pillar}.${serviceName}.${environment} must not be null or undefined`,
        );
      }
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new Error(
          `Storage fixture teardownEnv.${key} for ${pillar}.${serviceName}.${environment} must be a string, number, or boolean`,
        );
      }
      teardownEnvStrings[key] = String(value);
    }
  }

  return {
    fixtureKey,
    resolvedPayload,
    envVars: {
      SMOKE_STORAGE_FIXTURE_JSON: JSON.stringify(storageFixtureEnvPayload),
      ...(cleanupContext
        ? {
            SMOKE_CLEANUP_CONTEXT_JSON: JSON.stringify(cleanupContext),
          }
        : {}),
      ...teardownEnvStrings,
    },
    ...(fixture.setup !== undefined ? { setup: fixture.setup } : {}),
    ...(fixture.teardown !== undefined ? { teardown: fixture.teardown } : {}),
    ...(fixture.adminProbePath !== undefined &&
    fixture.adminProbePath.length > 0
      ? { adminProbePath: fixture.adminProbePath }
      : {}),
    ...(fixture.adminProbe403Hint !== undefined &&
    fixture.adminProbe403Hint.length > 0
      ? { adminProbe403Hint: fixture.adminProbe403Hint }
      : {}),
  };
}

export function buildSmokeFixtureEnv(
  manifest: RawManifest,
  serviceName: string,
  environment: Environment,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return resolveSmokeStorageFixture(manifest, serviceName, environment, env)
    .envVars;
}

export function buildPerformanceFixtureEnv(
  manifest: RawManifest,
  moduleName: string,
  environment: Environment,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return resolvePerformanceStorageFixture(
    manifest,
    moduleName,
    environment,
    env,
  ).envVars;
}
