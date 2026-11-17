/**
 * Issue 95: pinNavFonts as another product runs it. The packed kit,
 * installed by its name in a folder of its own, imported as a plain ES
 * module (no __dirname, no test runner): it finds its own font files
 * beside itself and serves one, with no guess from the working folder.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PKG = path.join(__dirname, "../../../packages/den-ui");
let tmp = "";

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-ui-esm-"));
  const out = execFileSync(
    "npm",
    ["pack", "--silent", "--pack-destination", tmp],
    { cwd: PKG, encoding: "utf-8" },
  ).trim();
  const tgz = path.join(tmp, out.split("\n").pop()!);
  const dest = path.join(
    tmp,
    "app",
    "node_modules",
    "@monster-orange",
    "den-ui",
  );
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["xzf", tgz, "-C", dest, "--strip-components=1"]);
}, 120_000);
afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const SCRIPT = `
import { pinNavFonts } from "@monster-orange/den-ui/inventory";
const routes = [];
const ctx = {
  route: async (u, h) => void routes.push(h),
  addInitScript: async () => {},
};
await pinNavFonts(ctx);
let got;
await routes[0]({
  request: () => ({ url: () => "http://x.test/__pin-fonts/rubik-latin-400-normal.woff2" }),
  fulfill: async (o) => void (got = o),
});
console.log(JSON.stringify({ type: got.contentType, bytes: got.body.length }));
`;

/** Runs SCRIPT as app/run.mjs (it imports the kit by name) from `cwd`. */
function run(cwd: string): string {
  const file = path.join(tmp, "app", "run.mjs");
  fs.writeFileSync(file, SCRIPT);
  try {
    return execFileSync(process.execPath, [file], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err) {
    const e = err as { stderr?: string };
    return "ERROR " + (/ERR_[A-Z_]+/.exec(String(e.stderr)) ?? [e.stderr])[0];
  }
}

describe("pinNavFonts, the packed kit under plain ESM", () => {
  const want = () =>
    JSON.stringify({
      type: "font/woff2",
      bytes: fs.statSync(
        path.join(PKG, "src", "fonts", "rubik-latin-400-normal.woff2"),
      ).size,
    });
  it("serves the kit's own font, run from the app's folder", () => {
    expect(run(path.join(tmp, "app"))).toBe(want());
  });
  it("and from any other working folder: nothing is guessed from it", () => {
    expect(run(os.tmpdir())).toBe(want());
  });
});
