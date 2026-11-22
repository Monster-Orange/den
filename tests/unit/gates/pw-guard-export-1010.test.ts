/**
 * Issue 1010: the box guard as `@monster-orange/den/pw-guard`.
 *
 *  - After `npm pack`, a fresh project imports it in ESM and gets its types
 *    (tsc), with no Playwright installed.
 *  - The exported allowedUrl refuses :80, :443 and a port the run didn't
 *    open, and allows the run's own port (a "host:*" entry, ownPorts).
 *  - The committed build (lib/pw-guard/) matches its source.
 *  - Den's own deep paths still resolve (the exports map keeps them).
 *  - The semver promise is in the README. (The CHANGELOG gets it from the
 *    release commit, which writes each version's entry.)
 *  - Den's own browser helper imports it from the subpath.
 * Temp dirs only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { allowedUrl, boxOwnPort, ownPorts } from "@monster-orange/den/pw-guard";

const ROOT = path.resolve(__dirname, "../../..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
) as { exports?: Record<string, unknown>; files?: string[] };

describe("issue 1010: the exported guard", () => {
  it("refuses :80, :443 and a port the run didn't open; allows its own", async () => {
    const srv = net.createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const allow = ["127.0.0.1:*"];
      const own = ownPorts();
      expect(allowedUrl(`http://127.0.0.1:${port}/`, allow, own)).toBe(true);
      expect(allowedUrl("http://127.0.0.1:80/", allow, own)).toBe(false);
      expect(allowedUrl("https://127.0.0.1/", allow, own)).toBe(false);
      expect(allowedUrl("http://127.0.0.1:443/", allow, own)).toBe(false);
      const free = port === 65000 ? 65001 : 65000;
      expect(allowedUrl(`http://127.0.0.1:${free}/`, allow, own)).toBe(false);
      boxOwnPort(free);
      expect(allowedUrl(`http://127.0.0.1:${free}/`, allow, own)).toBe(true);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  it("the committed build matches its source", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [path.join(ROOT, "scripts/build-pw-guard.mjs"), "--check"],
        { cwd: ROOT, stdio: "pipe" },
      ),
    ).not.toThrow();
  }, 60_000);

  it("the exports map names the subpath and keeps Den's own deep paths", () => {
    expect(pkg.exports?.["./pw-guard"]).toEqual({
      types: "./lib/pw-guard/pw-guard-export.d.ts",
      default: "./lib/pw-guard/pw-guard-export.js",
    });
    expect(pkg.exports?.["./*"]).toBe("./*");
    expect(pkg.exports?.["./package.json"]).toBe("./package.json");
    expect(pkg.files).toContain("lib/pw-guard/");
  });

  it("the semver promise is in the README", () => {
    for (const f of ["README.md"]) {
      const t = fs.readFileSync(path.join(ROOT, f), "utf8");
      expect(t).toMatch(/@monster-orange\/den\/pw-guard/);
      expect(t).toMatch(/only in a major version/);
      expect(t).toMatch(/never gets looser in a patch/);
    }
  });

  it("Den's browser helper and child servers import it from the subpath", () => {
    for (const f of ["tests/unit/helpers/browser.ts", "tests/child-servers.ts"])
      expect(fs.readFileSync(path.join(ROOT, f), "utf8")).toMatch(
        /from "@monster-orange\/den\/pw-guard"/,
      );
    expect(
      fs.existsSync(path.join(ROOT, "tests/unit/helpers/own-ports.ts")),
    ).toBe(false);
  });
});

describe("issue 1010: a fresh project, after npm pack", () => {
  let dir = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1010-"));
    // As the release packs: without scripts.
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", dir],
      { cwd: ROOT, stdio: "ignore" },
    );
    const tgz = fs.readdirSync(dir).find((f) => f.endsWith(".tgz"))!;
    const at = path.join(dir, "app/node_modules/@monster-orange/den");
    fs.mkdirSync(at, { recursive: true });
    execFileSync("tar", [
      "-xzf",
      path.join(dir, tgz),
      "-C",
      at,
      "--strip-components=1",
    ]);
    fs.writeFileSync(
      path.join(dir, "app/package.json"),
      JSON.stringify({ name: "app", type: "module", private: true }),
    );
  }, 180_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("imports it in ESM, with no Playwright", () => {
    fs.writeFileSync(
      path.join(dir, "app/use.mjs"),
      [
        'import { allowedUrl, checkBaseUrl, allowOf, allowFromEnv, guardContext, guardBrowser, pinLoopbackNames, ownPorts, boxOwnPort } from "@monster-orange/den/pw-guard";',
        "for (const f of [allowedUrl, checkBaseUrl, allowOf, allowFromEnv, guardContext, guardBrowser, pinLoopbackNames, ownPorts, boxOwnPort]) if (typeof f !== 'function') throw new Error('missing');",
        'console.log(allowedUrl("http://127.0.0.1:80/", ["127.0.0.1:80"]), allowedUrl("http://127.0.0.1:4100/", ["127.0.0.1:4100"]));',
      ].join("\n"),
    );
    const out = execFileSync(process.execPath, ["use.mjs"], {
      cwd: path.join(dir, "app"),
      encoding: "utf8",
    });
    expect(out.trim()).toBe("false true");
  });

  it("gets its types (tsc)", () => {
    fs.writeFileSync(
      path.join(dir, "app/use.ts"),
      [
        'import { allowedUrl, ownPorts, type ContextLike } from "@monster-orange/den/pw-guard";',
        'const ok: boolean = allowedUrl("http://127.0.0.1:4100/", ["127.0.0.1:*"], ownPorts());',
        "export const c: ContextLike | null = null;",
        "export { ok };",
        "// @ts-expect-error allowedUrl takes a string",
        "allowedUrl(1, []);",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "app/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "nodenext",
          moduleResolution: "nodenext",
          target: "es2022",
          strict: true,
          noEmit: true,
          types: ["node"],
          typeRoots: [path.join(ROOT, "node_modules/@types")],
        },
        files: ["use.ts"],
      }),
    );
    expect(() =>
      execFileSync(
        process.execPath,
        [path.join(ROOT, "node_modules/typescript/bin/tsc"), "-p", "."],
        { cwd: path.join(dir, "app"), encoding: "utf8", stdio: "pipe" },
      ),
    ).not.toThrow();
  }, 60_000);
});
