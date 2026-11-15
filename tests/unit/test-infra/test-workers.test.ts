/**
 * Local full runs on a busy machine: how many jest workers is a setting
 * (DEN_TEST_WORKERS), never a number in the config. Unset, jest's own
 * default holds (CI). `npm run preflight` asks for 8 unless it is set.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "../../..");

/** process.env with `env` over it; an undefined value removes the name. */
function merged(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(env))
    if (v === undefined) delete out[k];
    else out[k] = v;
  return out;
}

function workersWith(env: Record<string, string | undefined>): unknown {
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "const c = (await import('./jest.config.js')).default; console.log(JSON.stringify({ w: c.maxWorkers ?? null }));",
    ],
    { cwd: ROOT, env: merged(env), encoding: "utf-8" },
  );
  return (JSON.parse(out.trim()) as { w: unknown }).w;
}

describe("jest workers (den#143)", () => {
  it("come from DEN_TEST_WORKERS, a number or a percentage", () => {
    expect(workersWith({ DEN_TEST_WORKERS: "8" })).toBe(8);
    expect(workersWith({ DEN_TEST_WORKERS: "50%" })).toBe("50%");
  });

  it("unset or blank: jest's own default", () => {
    expect(workersWith({ DEN_TEST_WORKERS: undefined })).toBeNull();
    expect(workersWith({ DEN_TEST_WORKERS: "" })).toBeNull();
  });

  it("preflight asks for 8 unless the setting is there", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.preflight).toContain(
      "DEN_TEST_WORKERS=${DEN_TEST_WORKERS:-8}",
    );
  });
});
