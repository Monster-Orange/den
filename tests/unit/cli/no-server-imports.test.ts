/**
 * The CLI (src/ui/cli) imports no web-server module (src/ui/server): a
 * command that only talks to the server over HTTP must not load its code.
 * Shared helpers both need live in src/shared (e.g. confirm-code.ts, the
 * `web login` confirmation code).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const CLI = path.resolve(__dirname, "../../../src/ui/cli");

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(p);
    return e.name.endsWith(".ts") ? [p] : [];
  });
}

describe("the CLI imports no server module", () => {
  it("no src/ui/cli file imports from src/ui/server", () => {
    const hits: string[] = [];
    for (const f of tsFiles(CLI)) {
      const src = fs.readFileSync(f, "utf8");
      const re = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const target = path.resolve(path.dirname(f), m[1]);
        if (target.includes(`${path.sep}ui${path.sep}server${path.sep}`))
          hits.push(`${path.relative(CLI, f)} → ${m[1]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
