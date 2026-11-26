/**
 * Issue 1527: a visual-reference test compares against its references only
 * in the browser they were taken on: the record beside them (platform,
 * Chromium build, font widths), the same rule the gate routes boxes by.
 *
 * In any other browser (a CI shard's own Chromium, an arm64 box) the
 * comparison is skipped, saying how it differs. In CI's visual job
 * (DEN_VISUAL_JOB=1), where the references' browser is meant to be, it
 * fails instead: never green on a browser that can't compare.
 */
import type { Browser } from "@playwright/test";
import * as path from "path";
import {
  envMismatch,
  readVisualEnv,
  visualEnvOf,
} from "../../../src/shared/gates/visual.js";

const ROOT = path.resolve(__dirname, "..", "..", "..");

/**
 * "" when `browser` is the one the record (a path from the repo's top)
 * describes; else why not. Throws in CI's visual job.
 */
export async function visualOff(
  browser: Browser,
  record: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const want = readVisualEnv(path.join(ROOT, record));
  const why =
    typeof want === "string"
      ? want
      : envMismatch(want, await visualEnvOf(browser));
  if (!why) return "";
  const said =
    typeof want === "string" ? why : `this browser ${why} (${record})`;
  if (env.DEN_VISUAL_JOB === "1")
    throw new Error(`visual job: the references can't be compared: ${said}`);
  console.log(`visual references: skipped, ${said}`);
  return said;
}
