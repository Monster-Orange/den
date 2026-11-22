/**
 * Issue 1012: test files are type-checked. A test that imports a name its
 * helper doesn't export fails `npm run typecheck`, held to a per-file
 * baseline that only goes down (scripts/typecheck-tests.mjs).
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const root = path.resolve(__dirname, "../../..");
const script = path.join(root, "scripts/typecheck-tests.mjs");

/** Calls one of the script's functions (an ES module) in its own Node. */
function call(name: string, ...args: unknown[]): unknown {
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import * as m from ${JSON.stringify(script)}; ` +
        `process.stdout.write(JSON.stringify(m[${JSON.stringify(name)}](...${JSON.stringify(args)})));`,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe("issue 1012: test files are type-checked", () => {
  it("npm run typecheck runs the tests project, which takes every test file", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.typecheck).toContain("scripts/typecheck-tests.mjs");
    const cfg = fs.readFileSync(path.join(root, "tsconfig.tests.json"), "utf8");
    expect(cfg).toContain('"tests/**/*.ts"');
    const exclude = /"exclude":\s*\[([^\]]*)\]/.exec(cfg)?.[1] ?? "";
    expect(exclude).not.toContain("test.ts");
  });

  it("a test importing a name its helper doesn't export fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc1012-"));
    try {
      fs.writeFileSync(
        path.join(dir, "helper.ts"),
        "export function boxGuardKept(): string[] { return []; }\n",
      );
      fs.writeFileSync(
        path.join(dir, "uses.test.ts"),
        'import { boxGuardBlocks } from "./helper";\nexport const x = boxGuardBlocks();\n',
      );
      fs.writeFileSync(
        path.join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            types: [],
            module: "commonjs",
            target: "ES2022",
          },
          include: ["*.ts"],
        }),
      );
      const r = spawnSync(
        process.execPath,
        [
          script,
          "-p",
          path.join(dir, "tsconfig.json"),
          "--baseline",
          path.join(dir, "none.json"),
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/uses\.test\.ts: 0 -> 1/);
      expect(r.stderr).toMatch(/boxGuardBlocks/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("only a file over its baseline fails; the baseline only goes down", () => {
    const out = [
      "tests/a.test.ts(1,2): error TS2305: Module has no exported member 'b'.",
      "tests/a.test.ts(3,4): error TS2322: Type 'x' is not assignable.",
      "tests/b.test.ts(1,1): error TS2322: Type 'y' is not assignable.",
    ].join("\n");
    const c = call("countErrors", out) as Record<string, number>;
    expect(c).toEqual({ "tests/a.test.ts": 2, "tests/b.test.ts": 1 });
    expect(
      call("regressions", c, { "tests/a.test.ts": 2, "tests/b.test.ts": 1 }),
    ).toEqual([]);
    expect(call("regressions", c, { "tests/a.test.ts": 1 })).toEqual([
      { file: "tests/a.test.ts", was: 1, now: 2 },
      { file: "tests/b.test.ts", was: 0, now: 1 },
    ]);
    // Lowered: a fixed file leaves, a worse one is never raised.
    expect(
      call("lowered", c, {
        "tests/a.test.ts": 1,
        "tests/b.test.ts": 3,
        "tests/c.test.ts": 4,
      }),
    ).toEqual({ "tests/a.test.ts": 1, "tests/b.test.ts": 1 });
  });
});
