/**
 * Guard-behavior tests for make/journeys.mk (plan: jrn-pilot-journeys/
 * add-make-targets).
 *
 * The root Makefile sets `env ?= local`, which would silently point
 * journeys at local — journeys targets therefore REQUIRE env=<name> on the
 * command line ($(origin env) == "command line") and fail fast with a clear
 * message otherwise. (Model configuration is enforced by the runner per
 * journey — spec `model` field or JOURNEYS_MODEL override — not by make.)
 *
 * Both invocations below fail BEFORE any `npx tsx` line runs, so these
 * tests never touch the SDK, a browser, or a live stack.
 */

import { describe, expect, it } from "@jest/globals";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const REPO_ROOT = process.cwd();

/** Env for spawned make: no `env` variable, no JOURNEYS_MODEL. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const copy = { ...process.env };
  delete copy.env;
  delete copy.JOURNEYS_MODEL;
  return copy;
}

async function runMake(
  args: string[],
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("make", args, {
      cwd: REPO_ROOT,
      env: scrubbedEnv(),
      timeout: 15_000,
    });
    return { code: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? 1,
      output: `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
    };
  }
}

describe("make/journeys.mk explicit-env guard", () => {
  it("test-jrn-all fails without env= on the command line (rejects the Makefile default)", async () => {
    const { code, output } = await runMake(["test-jrn-all"]);
    expect(code).not.toBe(0);
    expect(output).toMatch(/explicit env=<name>/i);
    expect(output).not.toMatch(/npx tsx/);
  });

  it("test-jrn-<name> fails without env= on the command line", async () => {
    const { code, output } = await runMake(["test-jrn-user-first-item"]);
    expect(code).not.toBe(0);
    expect(output).toMatch(/explicit env=<name>/i);
  });
});
