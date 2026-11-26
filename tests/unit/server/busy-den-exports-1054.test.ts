/**
 * Issue 1054 (review): every name Den's shell calls on the module that
 * loadBusy() loads (/busy-den.js) is one busy-den.js exports. holdRow was
 * called but never exported, so a dragged row was marked busy and never
 * showed its dots; the shell's catch hid the throw.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUB = path.join(__dirname, "../../../src/ui/server/public");
const SHELL = fs.readFileSync(path.join(PUB, "shell.js"), "utf-8");
const DEN = fs.readFileSync(path.join(PUB, "busy-den.js"), "utf-8");

/** The names called as m.<name>( in each method that calls loadBusy(). */
function called(): string[] {
  const out = new Set<string>();
  let at = SHELL.indexOf("loadBusy()");
  while (at !== -1) {
    // Only a load whose module is used (loadBusy().then(...)); a shell
    // method ends at its closing "    }," (four spaces in).
    if (/^\s*\.then\(/.test(SHELL.slice(at + "loadBusy()".length))) {
      const end = SHELL.indexOf("\n    },", at);
      const body = SHELL.slice(at, end === -1 ? undefined : end);
      for (const m of body.matchAll(/\bm\.([A-Za-z_]\w*)\(/g)) out.add(m[1]!);
    }
    at = SHELL.indexOf("loadBusy()", at + 1);
  }
  return [...out].sort();
}

function exported(): Set<string> {
  const out = new Set<string>();
  for (const m of DEN.matchAll(
    /^export (?:async )?(?:function|const|let) (\w+)/gm,
  ))
    out.add(m[1]!);
  for (const m of DEN.matchAll(/^export \{([^}]*)\}/gm))
    for (const n of m[1]!.split(","))
      out.add(
        n
          .trim()
          .split(/\s+as\s+/)
          .pop()!
          .trim(),
      );
  return out;
}

describe("issue 1054: the shell calls only what busy-den.js exports", () => {
  it("finds the calls (holdRow, holdDots and busyAction among them)", () => {
    expect(called()).toEqual(
      expect.arrayContaining(["busyAction", "holdDots", "holdRow"]),
    );
  });

  it("every name called on loadBusy()'s module is exported", () => {
    const have = exported();
    expect(called().filter((n) => !have.has(n))).toEqual([]);
  });

  it("a load that fails says so on the console (holdRow, holdDots), and still lets the row or button go", () => {
    for (const name of ["holdRow", "holdDots"]) {
      const i = SHELL.indexOf(`    ${name}: function`);
      const body = SHELL.slice(i, SHELL.indexOf("\n    },", i));
      expect(body).toMatch(
        new RegExp(
          `\\.catch\\(function \\(err\\) \\{[\\s\\S]{0,240}?console\\.error\\("${name}"`,
        ),
      );
      // The fallback when it failed: the row or button is let go.
      expect(body).toMatch(/removeAttribute\("aria-busy"\)/);
    }
  });
});
