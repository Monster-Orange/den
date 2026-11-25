/**
 * The Docker edge suites make their folders in the home folder
 * (Docker's VM sees only it), under ~/.den-test-docker. A run that never
 * reached a suite's afterAll left them for good, and nothing said so.
 *
 * Global teardown, run here as jest runs it (a process of its own, HOME a
 * temp folder): a folder this run left fails the run, named, and is
 * removed; the share folder goes once it's empty; another run's folder is
 * left alone while that run lives; folders of ended runs, and the older
 * ones straight in the home folder, are listed with the line that removes
 * them, never removed.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const SHARE = ".den-test-docker";
/** No process has this pid (macOS's most is 99998, Linux's 4194304). */
const DEAD = "4194399";

let home = "";
afterEach(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = "";
});

/**
 * Runs `suites` (code that makes and maybe removes folders, as a suite
 * would, with its own run's `run`), then global teardown, in one process
 * whose home is a temp folder.
 */
function teardownAfter(suites: string) {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "den-1567-home-"));
  const js = `
    import * as fs from "fs";
    import * as path from "path";
    const run = String(process.pid);
    const { default: { shareTmp } } = await import("./tests/home-strays.cjs");
    ${suites}
    const { default: teardown } = await import("./tests/global-teardown.mjs");
    try {
      await teardown();
      console.log("OK");
    } catch (e) {
      console.log("FAILED " + e.message);
    }`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.DEN_TEST_GLOBAL_STUBS;
  delete env.DEN_TEST_RUN;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    env,
    encoding: "utf-8",
    timeout: 60_000,
  });
  return { out: r.stdout.trim(), err: r.stderr, status: r.status };
}

const share = () => path.join(home, SHARE);
const left = () => (fs.existsSync(share()) ? fs.readdirSync(share()) : null);

describe("issue 1567: global teardown and the home folder", () => {
  it("a suite that removes its folder: the run passes, and the share folder is gone", () => {
    const r = teardownAfter(`
      const d = shareTmp({ home: process.env.HOME, prefix: "edge-idle-", run });
      fs.writeFileSync(path.join(d, "traefik.yml"), "x");
      fs.rmSync(d, { recursive: true, force: true });`);
    expect(r.out).toBe("OK");
    expect(left()).toBeNull();
  });

  it("a suite that skips its cleanup: the run fails, naming the folder, and it is removed", () => {
    const r = teardownAfter(`
      const d = shareTmp({ home: process.env.HOME, prefix: "edge-proof-", run });
      fs.writeFileSync(path.join(d, "traefik.yml"), "x");
      console.log("MADE " + path.basename(d));`);
    const made = /MADE (\S+)/.exec(r.out)?.[1] ?? "";
    expect(made).toMatch(/^r\d+-edge-proof-/);
    expect(r.out).toMatch(/FAILED .*left in the home folder/);
    expect(r.out).toContain(made);
    expect(left()).toBeNull();
  });

  it("another run still going: its folder is left alone and not flagged", () => {
    const r = teardownAfter(`
      fs.mkdirSync(path.join(process.env.HOME, "${SHARE}", "r${process.pid}-455-abc"), { recursive: true });`);
    expect(r.out).toBe("OK");
    expect(r.err).not.toContain("r" + process.pid);
    expect(left()).toEqual([`r${process.pid}-455-abc`]);
  });

  it("an ended run's folder and the older ones in the home folder: listed with the remove line, kept", () => {
    const r = teardownAfter(`
      fs.mkdirSync(path.join(process.env.HOME, "${SHARE}", "r${DEAD}-edge-idle-abc"), { recursive: true });
      fs.mkdirSync(path.join(process.env.HOME, "${SHARE}", "edge-proof-old"), { recursive: true });
      fs.mkdirSync(path.join(process.env.HOME, ".den-test-edge-idle-KIXuWK"));
      fs.mkdirSync(path.join(process.env.HOME, ".den-test-455-6bWCLO"));
      fs.mkdirSync(path.join(process.env.HOME, ".den-unrelated"));`);
    expect(r.out).toBe("OK");
    expect(r.err).toContain("left by test runs that have ended");
    for (const n of [
      `${SHARE}/r${DEAD}-edge-idle-abc`,
      `${SHARE}/edge-proof-old`,
      ".den-test-edge-idle-KIXuWK",
      ".den-test-455-6bWCLO",
    ])
      expect(r.err).toContain(n);
    expect(r.err).not.toContain(".den-unrelated");
    expect(r.err).toMatch(/rm -rf /);
    expect(fs.existsSync(path.join(home, ".den-test-edge-idle-KIXuWK"))).toBe(
      true,
    );
    expect(left()?.sort()).toEqual([
      "edge-proof-old",
      `r${DEAD}-edge-idle-abc`,
    ]);
  });
});
