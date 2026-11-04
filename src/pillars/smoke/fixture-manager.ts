import { spawn } from "child_process";
import type { CommandDef } from "../../shared/types/index.js";

export interface ManagedFixtureSpec {
  fixtureKey: string;
  resolvedPayload: Record<string, unknown>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  setup?: CommandDef;
  teardown?: CommandDef;
}

function commandText(commandDef: CommandDef): string {
  return typeof commandDef === "string" ? commandDef : commandDef.cmd;
}

const UNDEFINED_SENTINEL = "__fixture_manager_undefined__";

/** Recursively sort object keys so serialization is stable for arbitrary payloads. */
function stableSortValue(value: unknown): unknown {
  if (value === undefined) {
    return UNDEFINED_SENTINEL;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stableSortValue);
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = stableSortValue(obj[key]);
  }
  return sorted;
}

/**
 * Deterministic identity for a managed fixture instance: stable serialization of
 * fixtureKey + resolvedPayload.
 */
export function fixtureInstanceId(
  fixtureKey: string,
  resolvedPayload: Record<string, unknown>,
): string {
  return JSON.stringify({
    fixtureKey,
    resolvedPayload: stableSortValue(resolvedPayload),
  });
}

function normalizedCommand(
  commandDef: CommandDef | undefined,
): string | undefined {
  return commandDef === undefined ? undefined : commandText(commandDef);
}

function specConflictKey(spec: ManagedFixtureSpec): string {
  return JSON.stringify(
    stableSortValue({
      cwd: spec.cwd,
      env: spec.env,
      setup: normalizedCommand(spec.setup),
      teardown: normalizedCommand(spec.teardown),
    }),
  );
}

export async function runRepoShellCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, [], {
      cwd,
      env,
      shell: true,
      stdio: "inherit",
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`Command failed with exit code ${code ?? 1}: ${command}`),
      );
    });

    proc.on("error", (error) => {
      reject(
        new Error(`Failed to start command "${command}": ${error.message}`),
      );
    });
  });
}

interface RegistryEntry {
  refCount: number;
  spec: ManagedFixtureSpec;
  specConflictKey: string;
}

const registry = new Map<string, RegistryEntry>();
const instanceTails = new Map<string, Promise<unknown>>();

function enqueueForInstance<T>(
  instanceId: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = instanceTails.get(instanceId) ?? Promise.resolve();
  const result = prev.then(() => task());
  instanceTails.set(
    instanceId,
    result.catch(() => {}),
  );
  return result as Promise<T>;
}

/**
 * Acquire a shared fixture: runs `setup` once per instance identity, increments refCount.
 * Returns a release function — call it in `finally` so teardown runs even when work fails.
 * The release function is idempotent (safe to call at most once; repeats are no-ops).
 */
export async function acquireFixture(
  spec: ManagedFixtureSpec,
): Promise<() => Promise<void>> {
  const instanceId = fixtureInstanceId(spec.fixtureKey, spec.resolvedPayload);
  const currentSpecConflictKey = specConflictKey(spec);

  return enqueueForInstance(instanceId, async () => {
    let entry = registry.get(instanceId);
    if (!entry) {
      entry = { refCount: 0, spec, specConflictKey: currentSpecConflictKey };
      registry.set(instanceId, entry);
    } else if (entry.specConflictKey !== currentSpecConflictKey) {
      throw new Error(
        `Conflicting fixture specs for shared fixture identity ${instanceId}`,
      );
    }

    if (entry.refCount === 0 && spec.setup !== undefined) {
      try {
        await runRepoShellCommand(commandText(spec.setup), spec.cwd, spec.env);
      } catch (error) {
        registry.delete(instanceId);
        throw error;
      }
    }

    entry.refCount += 1;

    let released = false;
    return async () => {
      await enqueueForInstance(instanceId, async () => {
        if (released) {
          return;
        }
        released = true;

        const current = registry.get(instanceId);
        if (!current) {
          throw new Error(
            `Fixture release for unknown instance (already torn down?): ${instanceId}`,
          );
        }

        current.refCount -= 1;
        if (current.refCount < 0) {
          throw new Error(`Fixture refCount underflow for ${instanceId}`);
        }

        if (current.refCount === 0) {
          if (current.spec.teardown !== undefined) {
            await runRepoShellCommand(
              commandText(current.spec.teardown),
              current.spec.cwd,
              current.spec.env,
            );
          }
          registry.delete(instanceId);
          instanceTails.delete(instanceId);
        }
      });
    };
  });
}

/**
 * Release multiple acquire handles in LIFO order (typical nested `try/finally` stack).
 * Runs every release even when one fails, then throws {@link AggregateError} if any failed.
 */
export async function releaseFixturesForConsumer(
  releases: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  const errors: Error[] = [];
  for (let i = releases.length - 1; i >= 0; i -= 1) {
    try {
      await releases[i]();
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `Fixture teardown failed (${errors.length} instance(s))`,
    );
  }
}

export function resetFixtureManagerForTests(): void {
  registry.clear();
  instanceTails.clear();
}
