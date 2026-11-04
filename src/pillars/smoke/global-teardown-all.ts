import type { FullConfig } from "@playwright/test";
import { releaseSmokeFixturesFromHandoff } from "./global-teardown.js";

async function globalTeardownAll(_config: FullConfig) {
  await releaseSmokeFixturesFromHandoff();
}

export default globalTeardownAll;
