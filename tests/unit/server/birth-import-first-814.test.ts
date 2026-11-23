/**
 * Issue 814: index.ts imports test-install-birth.ts first, so a new test
 * install's state folder is claimed before any other module runs (and
 * may write there). ESM runs imports in source order, so the first import
 * statement is what counts. A merge once put other imports above it.
 *
 * DEN_BIRTH_FILE points the check at another copy of index.ts (to see it
 * fail on that order).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const FILE =
  process.env.DEN_BIRTH_FILE ??
  path.resolve(__dirname, "../../../src/ui/server/index.ts");

/** Each import's module, in source order (multi-line imports included). */
function importsOf(src: string): string[] {
  const out: string[] = [];
  const re = /^import\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["'];/gms;
  for (const m of src.matchAll(re)) out.push(m[1]);
  return out;
}

describe("issue 814: index.ts imports the test-install birth first", () => {
  it("its first import is ./test-install-birth.js", () => {
    const first = importsOf(fs.readFileSync(FILE, "utf-8"))[0];
    expect(first).toBe("./test-install-birth.js");
  });

  it("the parser reads multi-line imports in order", () => {
    expect(
      importsOf(
        'import {\n  a,\n  b,\n} from "./x.js";\nimport { c } from "./y.js";\nimport "./z.js";\n',
      ),
    ).toEqual(["./x.js", "./y.js", "./z.js"]);
  });
});
