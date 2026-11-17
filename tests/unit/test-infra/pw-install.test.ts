/**
 * Playwright's browsers and their system packages, in CI
 * (scripts/ci-pw-install.sh). `npx playwright install --with-deps` hung
 * twice until a job's 20-minute timeout: the apt part (its system
 * packages) crawled from the Ubuntu mirror. So every job that installs
 * them goes through the script: each part (apt, then the browsers) has its
 * own time limit and one retry, and the step has its own timeout-minutes.
 * The browsers come from a cache keyed by the OS and Playwright's version.
 *
 * The script runs here against a fake npx: no network, no apt.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ROOT = process.cwd();
const SCRIPT = "bash scripts/ci-pw-install.sh";
// The install step: the script, alone or with a browser list (not `version`).
const installs = (s: Step) =>
  s.run === SCRIPT ||
  (!!s.run?.startsWith(`${SCRIPT} `) && !s.run.includes(" version"));

interface Step {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  "timeout-minutes"?: number;
  with?: Record<string, unknown>;
}

function jobs(file: string): Record<string, { steps?: Step[] }> {
  return (
    yaml.parse(
      fs.readFileSync(path.join(ROOT, ".github", "workflows", file), "utf-8"),
    ) as { jobs: Record<string, { steps?: Step[] }> }
  ).jobs;
}

const WORKFLOWS = fs
  .readdirSync(path.join(ROOT, ".github", "workflows"))
  .filter((f) => /\.ya?ml$/.test(f));

describe("CI installs Playwright only through scripts/ci-pw-install.sh", () => {
  it("no workflow step runs playwright install itself", () => {
    for (const file of WORKFLOWS)
      for (const [name, job] of Object.entries(jobs(file)))
        for (const s of job.steps ?? [])
          expect([file, name, /playwright install/.test(s.run ?? "")]).toEqual([
            file,
            name,
            false,
          ]);
  });

  it("the jobs that run the browser tests install through it", () => {
    const users = WORKFLOWS.flatMap((file) =>
      Object.entries(jobs(file))
        .filter(([, j]) => (j.steps ?? []).some(installs))
        .map(([name]) => `${file}:${name}`),
    );
    expect(users).toEqual(
      expect.arrayContaining([
        "ci.yml:tests",
        "release.yml:tests",
        "repeat.yml:repeat",
      ]),
    );
  });

  it("each install step has a step timeout, after the browser cache, keyed by OS and Playwright's version", () => {
    for (const file of WORKFLOWS)
      for (const [name, job] of Object.entries(jobs(file))) {
        const steps = job.steps ?? [];
        const at = steps.findIndex(installs);
        if (at < 0) continue;
        const t = steps[at]["timeout-minutes"];
        expect([file, name, typeof t === "number" && t > 0 && t <= 10]).toEqual(
          [file, name, true],
        );
        const cache = steps.findIndex(
          (s) =>
            s.uses?.startsWith("actions/cache@") &&
            s.with?.path === "~/.cache/ms-playwright",
        );
        expect([file, name, cache >= 0 && cache < at]).toEqual([
          file,
          name,
          true,
        ]);
        const key = String(steps[cache].with?.key);
        expect(key).toContain("${{ runner.os }}");
        expect(key).toContain("${{ steps.pw.outputs.version }}");
        const ver = steps.findIndex((s) => s.id === "pw");
        expect(ver).toBeGreaterThanOrEqual(0);
        expect(ver).toBeLessThan(cache);
        expect(steps[ver].run).toBe(`${SCRIPT} version >> "$GITHUB_OUTPUT"`);
      }
  });
});

describe("scripts/ci-pw-install.sh (a fake npx)", () => {
  let tmp: string;
  // The fake npx: `playwright install-deps` and `playwright install` each
  // hang (sleep) on the attempts FAKE_HANG_<part> lists, else succeed.
  const FAKE = `#!/bin/bash
part=$2
n=$(( $(cat "$FAKE_DIR/$part" 2>/dev/null || echo 0) + 1 ))
echo $n > "$FAKE_DIR/$part"
echo "fake npx $* (attempt $n)"
var="FAKE_HANG_\${part//-/_}"
case " \${!var} " in *" $n "*) exec sleep 30 ;; esac
exit 0
`;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pw-install-"));
    fs.mkdirSync(path.join(tmp, "bin"));
    fs.writeFileSync(path.join(tmp, "bin", "npx"), FAKE, { mode: 0o755 });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const run = (
    name: string,
    env: Record<string, string>,
    args: string[] = [],
  ) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    const r = spawnSync(
      "bash",
      [path.join(ROOT, "scripts", "ci-pw-install.sh"), ...args],
      {
        cwd: ROOT,
        encoding: "utf-8",
        env: {
          PATH: `${path.join(tmp, "bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          FAKE_DIR: dir,
          CI_PW_DEPS_SECONDS: "2",
          CI_PW_INSTALL_SECONDS: "2",
          ...env,
        },
      },
    );
    const count = (p: string) =>
      Number(
        fs.existsSync(path.join(dir, p))
          ? fs.readFileSync(path.join(dir, p), "utf-8")
          : 0,
      );
    return {
      code: r.status,
      out: r.stdout + r.stderr,
      deps: count("install-deps"),
      install: count("install"),
    };
  };

  it("both parts on the first try: one attempt each", () => {
    const r = run("ok", {});
    expect(r.code).toBe(0);
    expect([r.deps, r.install]).toEqual([1, 1]);
    expect(r.out).toMatch(/fake npx playwright install-deps chromium webkit/);
    expect(r.out).toMatch(/fake npx playwright install chromium webkit/);
  });

  it("apt hangs once: cut off at its limit, retried, and passes", () => {
    const r = run("deps-once", { FAKE_HANG_install_deps: "1" });
    expect(r.code).toBe(0);
    expect([r.deps, r.install]).toEqual([2, 1]);
    expect(r.out).toMatch(/::warning::.*install-deps.*2 s.*retrying/);
  }, 30_000);

  it("the browsers hang once: retried, and passes", () => {
    const r = run("install-once", { FAKE_HANG_install: "1" });
    expect(r.code).toBe(0);
    expect([r.deps, r.install]).toEqual([1, 2]);
  }, 30_000);

  it("hangs twice: fails loudly, and goes no further", () => {
    const r = run("deps-twice", { FAKE_HANG_install_deps: "1 2" });
    expect(r.code).not.toBe(0);
    expect([r.deps, r.install]).toEqual([2, 0]);
    expect(r.out).toMatch(/::error::.*install-deps.*failed twice/);
  }, 30_000);

  it("the browsers are arguments: chromium and webkit when none are given", () => {
    const r = run("chromium-only", {}, ["chromium"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/fake npx playwright install-deps chromium \(/);
    expect(r.out).toMatch(/fake npx playwright install chromium \(/);
  });

  it("an unknown browser is refused before anything installs", () => {
    const r = run("bad-browser", {}, ["chromium", "edge;rm"]);
    expect(r.code).toBe(2);
    expect([r.deps, r.install]).toEqual([0, 0]);
    expect(r.out).toMatch(/not a Playwright browser: edge;rm/);
  });

  it("the limits are settings; a bad one is refused", () => {
    const r = run("bad", { CI_PW_DEPS_SECONDS: "soon" });
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/CI_PW_DEPS_SECONDS is a number of seconds/);
  });

  it("version: Playwright's version from package-lock.json, for the cache key", () => {
    const r = run("version", {}, ["version"]);
    const lock = JSON.parse(
      fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf-8"),
    ) as { packages: Record<string, { version: string }> };
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(
      `version=${lock.packages["node_modules/playwright"].version}`,
    );
  });
});
