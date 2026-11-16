/**
 * den-ui 0.6.1: the kit's types. Each src/*.js has a .d.ts beside it that
 * declares every name the .js exports, the package names its types, and a
 * consumer (fixtures/types-consumer.ts.txt, kept out of Den's own program:
 * it needs the DOM lib) compiles against them with --strict.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PKG = path.join(process.cwd(), "packages", "den-ui");
const SRC = path.join(PKG, "src");

/** The names a module exports (its own and re-exported). */
function exported(src: string): string[] {
  const names = new Set<string>();
  for (const m of src.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm,
  ))
    names.add(m[1]!);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm))
    for (const part of m[1]!.split(","))
      if (part.trim())
        names.add(
          part
            .trim()
            .split(/\s+as\s+/)
            .pop()!,
        );
  if (/^export\s+default\b/m.test(src)) names.add("default");
  return [...names].sort();
}

describe("den-ui types", () => {
  const js = fs.readdirSync(SRC).filter((f) => f.endsWith(".js"));

  it.each(js)("%s has a .d.ts declaring every export", (f) => {
    const dts = path.join(SRC, f.replace(/\.js$/, ".d.ts"));
    expect(fs.existsSync(dts)).toBe(true);
    const want = exported(fs.readFileSync(path.join(SRC, f), "utf-8"));
    const have = exported(fs.readFileSync(dts, "utf-8"));
    expect(want.filter((n) => !have.includes(n))).toEqual([]);
  });

  it("the package names its types, and packs them", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PKG, "package.json"), "utf-8"),
    ) as { types?: string; files: string[] };
    expect(pkg.types).toBe("./src/kit.d.ts");
    expect(fs.existsSync(path.join(PKG, pkg.types!))).toBe(true);
    expect(pkg.files).toContain("src/");
  });

  it("a consumer compiles against them with --strict", () => {
    const tsc = path.join(process.cwd(), "node_modules", ".bin", "tsc");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-ui-types-"));
    const consumer = path.join(dir, "consumer.ts");
    fs.writeFileSync(
      consumer,
      fs
        .readFileSync(
          path.join(__dirname, "fixtures", "types-consumer.ts.txt"),
          "utf-8",
        )
        .replaceAll("@kit/", SRC + "/"),
    );
    const r = spawnSync(
      tsc,
      [
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--target",
        "es2022",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--lib",
        "es2022,dom",
        consumer,
      ],
      { encoding: "utf-8" },
    );
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  }, 120_000);
});
