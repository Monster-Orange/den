/**
 * API health — integration test.
 *
 * Unauthenticated probe of the environment's API base URL
 * (config/environments/<env>.json → baseUrls.api). Override the path with
 * E2E_API_HEALTH_PATH when a stack serves health elsewhere.
 */

import { test, expect } from "../../fixtures/index.js";

const HEALTH_PATH = process.env.E2E_API_HEALTH_PATH ?? "/health";

test(`GET ${HEALTH_PATH} responds 2xx`, async ({ apiContext }) => {
  const res = await apiContext.get(HEALTH_PATH);
  expect(
    res.ok(),
    `Expected 2xx, got ${res.status()}: ${await res.text()}`,
  ).toBe(true);
});
