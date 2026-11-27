import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.join(__dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "shim-imports.mjs");

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>, shims: string[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-shims-"));
  tmps.push(d);
  const all = { ...files, "scripts/shims.json": JSON.stringify({ shims }) };
  for (const [f, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
    fs.writeFileSync(path.join(d, f), text);
  }
  execFileSync("git", ["init", "-q"], { cwd: d });
  execFileSync("git", ["add", "-A"], { cwd: d });
  return d;
}

function run(root: string) {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root], {
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const MOVED = {
  "src/shared/hub/hub-url.ts": "export const hubUrl = 1;\n",
  "src/shared/hub-url.ts": 'export * from "./hub/hub-url.js";\n',
};

describe("scripts/shim-imports.mjs", () => {
  it("passes when every importer uses the new path", () => {
    const r = run(
      repo(
        {
          ...MOVED,
          "src/ui/a.ts": 'import { hubUrl } from "../shared/hub/hub-url.js";\n',
        },
        ["src/shared/hub-url.ts"],
      ),
    );
    expect(r).toEqual({ code: 0, out: "shim-imports: ok\n" });
  });

  it("fails on each kind of in-repo import of a shim, and names the new path", () => {
    const r = run(
      repo(
        {
          ...MOVED,
          "src/ui/a.ts": 'import { hubUrl } from "../shared/hub-url.js";\n',
          "tests/b.test.ts":
            'const m = await import("../src/shared/hub-url");\n',
          "tests/c.test.ts":
            'jest.unstable_mockModule("../src/shared/hub-url.js", () => ({}));\n',
          "scripts/d.mjs": [
            "import ",
            '"@monster-orange/den/src/shared/hub-url.js";\n',
          ].join(""),
        },
        ["src/shared/hub-url.ts"],
      ),
    );
    expect(r.code).toBe(1);
    for (const where of [
      "src/ui/a.ts:1",
      "tests/b.test.ts:1",
      "tests/c.test.ts:1",
      "scripts/d.mjs:1",
    ])
      expect(r.out).toContain(
        `${where}: imports src/shared/hub-url.ts, a shim; import src/shared/hub/hub-url.ts instead`,
      );
  });

  it("fails when a listed shim grows code, or is gone", () => {
    const r = run(
      repo(
        {
          ...MOVED,
          "src/shared/hub-url.ts":
            'export * from "./hub/hub-url.js";\nexport const extra = 2;\n',
        },
        ["src/shared/hub-url.ts", "src/shared/hub-gone.ts"],
      ),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "src/shared/hub-url.ts: a listed shim must be one export-* line and nothing else",
    );
    expect(r.out).toContain(
      "src/shared/hub-gone.ts: listed in scripts/shims.json, but not in the tree",
    );
  });

  it("passes on this repo", () => {
    expect(run(ROOT)).toEqual({ code: 0, out: "shim-imports: ok\n" });
  });
});
