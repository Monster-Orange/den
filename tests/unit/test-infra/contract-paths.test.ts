import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SHIPPED = ["bin", "make", "service"];
const NAMED =
  /(?<![A-Za-z0-9_.-])(dist\/)?src\/[A-Za-z0-9_./-]+?\.(?:ts|mjs|js|json)\b/g;

function shippedFiles(): string[] {
  return execFileSync("git", ["ls-files", "--", ...SHIPPED], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

export function namedPaths(text: string): { path: string; built: boolean }[] {
  return [...text.matchAll(NAMED)].map((m) => ({
    path: m[1] ? m[0].slice(m[1].length) : m[0],
    built: !!m[1],
  }));
}

export function exists(
  root: string,
  p: { path: string; built: boolean },
): boolean {
  if (!p.built) return fs.existsSync(path.join(root, p.path));
  const stem = p.path.replace(/\.js$/, "");
  return [".ts", ".js", ".mjs", ".tsx"].some((x) =>
    fs.existsSync(path.join(root, stem + x)),
  );
}

describe("paths that shipped files name by string exist", () => {
  it("the matcher reads each kind of reference", () => {
    expect(
      namedPaths(
        [
          'entry="src/ui/cli/index.ts"',
          'built="dist/src/ui/cli/index.js"',
          "$(DEN_TSX) $(DEN_ENGINE)/src/scripts/register-repos.ts $(args)",
          'f"{engine}/src/ui/server/index.ts"',
        ].join("\n"),
      ),
    ).toEqual([
      { path: "src/ui/cli/index.ts", built: false },
      { path: "src/ui/cli/index.js", built: true },
      { path: "src/scripts/register-repos.ts", built: false },
      { path: "src/ui/server/index.ts", built: false },
    ]);
  });

  it("a built path counts when its source exists", () => {
    expect(exists(ROOT, { path: "src/ui/cli/index.js", built: true })).toBe(
      true,
    );
    expect(
      exists(ROOT, { path: "src/ui/cli/no-such-entry.js", built: true }),
    ).toBe(false);
  });

  it("every src path in bin/, make/ and service/ is in the tree", () => {
    const files = shippedFiles();
    expect(files.length).toBeGreaterThan(0);
    const missing: string[] = [];
    let seen = 0;
    for (const f of files) {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      text.split("\n").forEach((line, i) => {
        for (const p of namedPaths(line)) {
          seen++;
          if (!exists(ROOT, p)) missing.push(`${f}:${i + 1} ${p.path}`);
        }
      });
    }
    expect(seen).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it("every file guardrails.ts installs from its folder is there", () => {
    const src = fs.readFileSync(
      path.join(ROOT, "src/shared/agents/guardrails.ts"),
      "utf8",
    );
    const names = [
      ...src.matchAll(/path\.join\(dir, "([A-Za-z0-9_.-]+)"/g),
    ].map((m) => m[1]!);
    expect(names).toEqual(
      expect.arrayContaining(["pretooluse.mjs", "hooks.json"]),
    );
    const dir = path.join(ROOT, "src/shared/agents/guardrails");
    expect(names.filter((n) => !fs.existsSync(path.join(dir, n)))).toEqual([]);
  });
});
