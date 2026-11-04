/**
 * Guard-behavior tests for make/security.mk. Scans send attack traffic, so
 * env=<name> must be stated on the command line ($(origin env) == "command
 * line"); the root Makefile's `env ?= local` default is rejected.
 *
 * Every invocation here either fails at the guard or is `make -n` (dry run
 * of make itself) — nothing ever executes npx, docker, or a scan.
 */

import { describe, expect, it } from "@jest/globals";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = process.cwd();

function scrubbedEnv(): NodeJS.ProcessEnv {
  const copy = { ...process.env };
  delete copy.env;
  delete copy.mode;
  delete copy.dry_run;
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

describe("make/security.mk explicit-env guard", () => {
  it("test-sec-all fails without env= on the command line", async () => {
    const { code, output } = await runMake(["test-sec-all"]);
    expect(code).not.toBe(0);
    expect(output).toMatch(/explicit env=<name>/i);
    expect(output).not.toMatch(/npx tsx/);
  });

  it("test-sec-<service> fails without env= on the command line", async () => {
    const { code, output } = await runMake(["test-sec-api"]);
    expect(code).not.toBe(0);
    expect(output).toMatch(/explicit env=<name>/i);
  });
});

describe("make/security.mk command construction (make -n)", () => {
  it("test-sec-all forwards env, mode and dry-run", async () => {
    const { code, output } = await runMake([
      "-n",
      "test-sec-all",
      "env=dev",
      "mode=all",
      "dry_run=1",
    ]);
    expect(code).toBe(0);
    expect(output).toMatch(
      /src\/pillars\/security\/run\.ts --env=dev\s+--mode=all --dry-run/,
    );
  });

  it("bare service name ignores the inherited repo default; repo= on the command line qualifies it", async () => {
    const bare = await runMake(["-n", "test-sec-api", "env=dev"]);
    expect(bare.output).toMatch(/--service=\$SERVICE_NAME/);
    expect(bare.output).not.toMatch(/SERVICE_NAME="shop\//);

    const qualified = await runMake([
      "-n",
      "test-sec-api",
      "env=dev",
      "repo=sample-webapp",
    ]);
    expect(qualified.output).toMatch(
      /SERVICE_NAME="sample-webapp\/\$SERVICE_NAME"/,
    );
  });
});
