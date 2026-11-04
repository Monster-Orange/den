import type { FullConfig } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { releaseFixturesForConsumer } from "./cleanup.js";
import { getDistRoot } from "../../shared/paths.js";

import { product } from "../../shared/product.js";
// Den-root anchored: writes the fixture-handoff file that
// ensure-smoke-teardown.ts re-derives — the two must agree from any cwd.
const PROJECT_ROOT = getDistRoot();
const SMOKE_RUN_DIR = path.resolve(PROJECT_ROOT, ".smoke-run");

/** Persisted between global setup and teardown (same Playwright parent process). */
export const SMOKE_FIXTURE_HANDOFF_PATH = path.join(
  SMOKE_RUN_DIR,
  "smoke-fixture-handoff.json",
);

const smokeFixtureReleaseHandles = new Map<
  string,
  Array<() => Promise<void>>
>();

export function smokeFixtureConsumerKey(
  repoName: string,
  serviceName: string,
): string {
  return `${repoName}__${serviceName}`;
}

export function registerSmokeFixtureReleaseHandles(
  consumerKey: string,
  handles: ReadonlyArray<() => Promise<void>>,
): void {
  if (handles.length === 0) {
    return;
  }
  const prev = smokeFixtureReleaseHandles.get(consumerKey) ?? [];
  smokeFixtureReleaseHandles.set(consumerKey, [...prev, ...handles]);
}

export type SmokeFixtureHandoffPayload = {
  version: 1;
  /** Acquisition order; teardown releases in reverse (LIFO across consumers). */
  consumersInAcquireOrder: string[];
  bindings: Array<{
    consumerKey: string;
    fixtureInstanceId: string;
  }>;
};

export function writeSmokeFixtureHandoff(
  payload: Omit<SmokeFixtureHandoffPayload, "version">,
): void {
  const full: SmokeFixtureHandoffPayload = { version: 1, ...payload };
  fs.mkdirSync(SMOKE_RUN_DIR, { recursive: true });
  fs.writeFileSync(SMOKE_FIXTURE_HANDOFF_PATH, JSON.stringify(full, null, 2));
}

async function releaseAllRegisteredFixtures(): Promise<void> {
  const handlesInReverseRegistrationOrder = Array.from(
    smokeFixtureReleaseHandles.values(),
  ).reverse();
  for (const handles of handlesInReverseRegistrationOrder) {
    await releaseFixturesForConsumer(handles);
  }
}

/**
 * Releases fixtures registered for this run, using the persisted consumer order
 * (release-driven: refcount / shared instances, not per-repo shell hooks).
 */
export async function releaseSmokeFixturesFromHandoff(): Promise<void> {
  try {
    if (!fs.existsSync(SMOKE_FIXTURE_HANDOFF_PATH)) {
      await releaseAllRegisteredFixtures();
      console.log(
        `[${product().cli}] smoke global teardown: storage fixture releases completed`,
      );
      return;
    }

    let payload: SmokeFixtureHandoffPayload;
    try {
      payload = JSON.parse(
        fs.readFileSync(SMOKE_FIXTURE_HANDOFF_PATH, "utf-8"),
      ) as SmokeFixtureHandoffPayload;
    } catch {
      await releaseAllRegisteredFixtures();
      console.log(
        `[${product().cli}] smoke global teardown: storage fixture releases completed (handoff parse fallback)`,
      );
      return;
    }

    const bindingConsumerKeys = new Set(
      (payload.bindings ?? []).map((binding) => binding.consumerKey),
    );
    const order = (payload.consumersInAcquireOrder ?? []).filter((key) =>
      bindingConsumerKeys.has(key),
    );
    for (let i = order.length - 1; i >= 0; i -= 1) {
      const key = order[i];
      const handles = smokeFixtureReleaseHandles.get(key);
      if (handles?.length) {
        await releaseFixturesForConsumer(handles);
      }
    }
    // Safety net: any consumer registered in-memory but missing from handoff
    // order still must release (release fns are idempotent if already run).
    await releaseAllRegisteredFixtures();
    console.log(
      `[${product().cli}] smoke global teardown: storage fixture releases completed`,
    );
  } finally {
    smokeFixtureReleaseHandles.clear();

    try {
      fs.unlinkSync(SMOKE_FIXTURE_HANDOFF_PATH);
    } catch {
      // ignore
    }
  }
}

export function resetSmokeFixtureBridgeForTests(): void {
  smokeFixtureReleaseHandles.clear();
  try {
    fs.unlinkSync(SMOKE_FIXTURE_HANDOFF_PATH);
  } catch {
    // ignore
  }
}

async function globalTeardown(_config: FullConfig) {
  await releaseSmokeFixturesFromHandoff();
}

export default globalTeardown;
