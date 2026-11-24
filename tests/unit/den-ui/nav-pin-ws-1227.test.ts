/**
 * Issue 1227: the nav inventory compares against references taken on one
 * amd64 browser build. It used to treat any DEN_PW_WS as that build, so a
 * run on an ARM machine's native server (npm run pw:server, issue 635)
 * failed every case with "reference taken on X, running on Y".
 *
 * It now reaches its own server only through DEN_PW_NAV_WS, which
 * `npm run pw:server -- --nav` prints and CI's den-ui-nav job sets. With
 * only DEN_PW_WS set, it skips.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { navServer } from "./nav-inventory-helpers.js";

const ROOT = path.join(__dirname, "../../..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf-8");

describe("issue 1227: the nav check's own browser server", () => {
  it("only DEN_PW_WS set (a general server, maybe native ARM): skipped", () => {
    expect(navServer({ DEN_PW_WS: "ws://127.0.0.1:3000/" })).toBeNull();
  });

  it("DEN_PW_NAV_WS set: that server", () => {
    expect(
      navServer({
        DEN_PW_WS: "ws://127.0.0.1:3000/",
        DEN_PW_NAV_WS: " ws://127.0.0.1:3921/ ",
      }),
    ).toBe("ws://127.0.0.1:3921/");
  });

  it("DEN_PW_NAV_WS empty: skipped", () => {
    expect(navServer({ DEN_PW_NAV_WS: "  " })).toBeNull();
  });

  it("the browser test decides with navServer, not DEN_PW_WS", () => {
    const src = read("tests/unit/den-ui/nav-inventory.browser.test.ts");
    expect(src).toContain("navServer(process.env)");
    expect(src).not.toMatch(/!!process\.env\.DEN_PW_WS/);
  });

  it("CI's den-ui-nav job sets DEN_PW_NAV_WS", () => {
    expect(read(".github/workflows/ci.yml")).toContain(
      "DEN_PW_NAV_WS: ws://localhost:3921/",
    );
  });

  it("pw:server --nav prints DEN_PW_NAV_WS; the general server DEN_PW_WS", () => {
    const js = `
      const m = await import("./scripts/pw-server.mjs");
      process.stdout.write(JSON.stringify([m.envLine(true, 3921), m.envLine(false, 3000)]));
    `;
    const out = JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", js], {
        cwd: ROOT,
        encoding: "utf-8",
      }),
    );
    expect(out).toEqual([
      "DEN_PW_NAV_WS=ws://127.0.0.1:3921/\n",
      "DEN_PW_WS=ws://127.0.0.1:3000/\n",
    ]);
  });
});
