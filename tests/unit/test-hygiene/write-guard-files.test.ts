/**
 * Issue 1356: the write guard's end-of-file check works for every test
 * file a worker runs, not only its first. The fs core module (and the
 * wrappers installed on it) outlives a test file, while each file gets its
 * own globalThis and its own load of write-guard.ts: the refusal list has
 * to live on the fs module.
 *
 * A child jest runs two files in one worker (--runInBand) with the guard
 * armed as tests/setup.ts arms it: the first is clean, the second swallows
 * a refused write. The second must fail, naming the path; the first passes.
 * Nothing real is written: the guard refuses the write itself either way.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-1356-files-")),
);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("the write guard across test files (issue 1356)", () => {
  it("a later file that swallows a refused write fails, naming the path", () => {
    const fixtures = path.join(tmp, "fixtures");
    const cache = path.join(tmp, "cache");
    const checkout = path.join(tmp, "checkout");
    fs.mkdirSync(fixtures);
    fs.mkdirSync(cache);
    fs.mkdirSync(path.join(checkout, "config", "local"), { recursive: true });
    const probe = path.join(checkout, "config", "local", "zz-1356.yml");
    const guard = path.resolve(__dirname, "..", "..", "write-guard.ts");
    // The child's writes may reach only its fixtures and its cache.
    const roots = { checkout, temp: [fixtures, cache] };
    fs.writeFileSync(
      path.join(fixtures, "setup.js"),
      `require(${JSON.stringify(guard)}).armWriteGuard(afterAll, ${JSON.stringify(roots)});\n`,
    );
    fs.writeFileSync(
      path.join(fixtures, "a-clean.fx.test.js"),
      `test("clean", () => {});\n`,
    );
    fs.writeFileSync(
      path.join(fixtures, "b-swallows.fx.test.js"),
      `test("swallows a refused write", () => {
  try { require("fs").writeFileSync(${JSON.stringify(probe)}, "x"); } catch {}
});\n`,
    );
    // The clean file first, so the swallowing one is a later file.
    fs.writeFileSync(
      path.join(fixtures, "seq.js"),
      `const Base = require(${JSON.stringify(require.resolve("@jest/test-sequencer"))}).default;
module.exports = class extends Base {
  sort(tests) { return [...tests].sort((a, b) => a.path.localeCompare(b.path)); }
};\n`,
    );
    const config = {
      rootDir: fixtures,
      testMatch: ["**/*.fx.test.js"],
      setupFilesAfterEnv: [path.join(fixtures, "setup.js")],
      cacheDirectory: cache,
      testEnvironment: "node",
      transform: {
        "\\.ts$": [
          require.resolve("ts-jest"),
          {
            isolatedModules: true,
            tsconfig: { module: "commonjs", esModuleInterop: true },
          },
        ],
      },
    };
    const env = { ...process.env };
    delete env.JEST_WORKER_ID;
    const run = spawnSync(
      process.execPath,
      [
        require.resolve("jest/bin/jest"),
        "--config",
        JSON.stringify(config),
        "--runInBand",
        "--ci",
        "--testSequencer",
        path.join(fixtures, "seq.js"),
      ],
      { cwd: fixtures, env, encoding: "utf-8", timeout: 120_000 },
    );
    const out = `${run.stdout}\n${run.stderr}`;
    expect(out).toMatch(/PASS .*a-clean\.fx\.test\.js/);
    expect(out).toMatch(/FAIL .*b-swallows\.fx\.test\.js/);
    expect(out).toContain(
      "This test file wrote outside its temp folders (issue 1356)",
    );
    expect(out).toContain(probe);
    expect(run.status).not.toBe(0);
    expect(fs.existsSync(probe)).toBe(false);
  }, 150_000);
});
