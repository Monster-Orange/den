/**
 * Issue 635: the browser server general test runs reach through DEN_PW_WS
 * ran Playwright's amd64 build everywhere, emulated on an ARM machine,
 * because the one pinned image was the nav inventory's (its amd64 digest).
 *
 * scripts/pw-server.mjs (npm run pw:server) starts the general server from
 * the tag pinned by its multi-arch index digest, so Docker runs the host's
 * own build. `--nav` starts the nav inventory's server, which keeps its
 * exact amd64 pin (its references were taken there).
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "../../..");

/** The script's exports, read in a child Node (it's an ES module). */
function load(expr: string): unknown {
  const js = `
    const m = await import("./scripts/pw-server.mjs");
    const nav = await import("./packages/den-ui/inventory/nav-inventory.js");
    process.stdout.write(JSON.stringify(${expr}));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", js], {
      cwd: ROOT,
      encoding: "utf-8",
    }),
  );
}

describe("issue 635: the general browser server runs the host's own build", () => {
  it("its image is the nav image's tag, pinned by another (the index) digest", () => {
    const [general, nav] = load(
      "[m.BROWSER_SERVER_IMAGE, nav.NAV_BROWSER_IMAGE]",
    ) as [string, string];
    const tag = (s: string) => s.split("@")[0];
    expect(general).toMatch(/:v[\d.]+-\w+@sha256:[0-9a-f]{64}$/);
    expect(tag(general)).toBe(tag(nav));
    expect(general).not.toBe(nav);
  });

  it("its Playwright version is package-lock's", () => {
    const lock = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf-8"),
    );
    expect(load("m.PW_VERSION")).toBe(
      lock.packages["node_modules/playwright"].version,
    );
  });

  it("started without --platform, so Docker picks the host's build", () => {
    const args = load("m.serverArgs({ port: 3000, name: 'pw' })") as string[];
    expect(args).not.toContain("--platform");
    expect(args).toContain(load("m.BROWSER_SERVER_IMAGE") as string);
    expect(args.join(" ")).toMatch(/run-server --port 3000 --host 0\.0\.0\.0/);
    expect(args).toContain("127.0.0.1:3000:3000");
  });
});

describe("issue 635: the nav inventory keeps the build its references were taken on", () => {
  it("--nav: the exact amd64 pin, with --platform linux/amd64", () => {
    const args = load(
      "m.serverArgs({ nav: true, port: 3921, name: 'pw-nav' })",
    ) as string[];
    const i = args.indexOf("--platform");
    expect(args[i + 1]).toBe("linux/amd64");
    expect(args).toContain(load("nav.NAV_BROWSER_IMAGE") as string);
  });

  it("a port that isn't one: refused", () => {
    expect(() => load("m.serverArgs({ port: 0 })")).toThrow();
  });
});

describe("issue 635: the docs start the general server with the script", () => {
  it("CONTRIBUTING and the gate slots doc name npm run pw:server", () => {
    for (const f of ["CONTRIBUTING.md", "docs/gate-slots.md"])
      expect(fs.readFileSync(path.join(ROOT, f), "utf-8")).toContain(
        "npm run pw:server",
      );
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
    );
    expect(pkg.scripts["pw:server"]).toBe("node scripts/pw-server.mjs");
  });
});
