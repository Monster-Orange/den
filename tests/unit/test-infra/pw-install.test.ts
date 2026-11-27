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

const DEFAULT_S = (name: string) =>
  Number(
    new RegExp(`\\$\\{${name}:-(\\d+)\\}`).exec(
      fs.readFileSync(path.join(ROOT, "scripts", "ci-pw-install.sh"), "utf-8"),
    )?.[1],
  );
const WORST_CASE_S =
  3 * DEFAULT_S("CI_PW_DEPS_SECONDS") + 2 * DEFAULT_S("CI_PW_INSTALL_SECONDS");

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
        "release-gates.yml:tests",
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
        // The step's limit covers the script's worst case: two apt tries,
        // the wait for a cut-off apt run between them, two browser tries.
        expect([file, name, typeof t === "number" && t > 0 && t <= 15]).toEqual(
          [file, name, true],
        );
        expect([file, name, (t as number) * 60 >= WORST_CASE_S]).toEqual([
          file,
          name,
          true,
        ]);
        const cache = steps.findIndex(
          (s) =>
            s.uses?.startsWith("actions/cache@") &&
            String(s.with?.path ?? "")
              .split("\n")
              .map((l) => l.trim())
              .includes("~/.cache/ms-playwright") &&
            // apt's packages too: a stuck mirror is skipped once one job
            // has them (2026-11-17).
            String(s.with?.path ?? "")
              .split("\n")
              .map((l) => l.trim())
              .includes("~/.cache/den-apt"),
        );
        expect([file, name, cache >= 0 && cache < at]).toEqual([
          file,
          name,
          true,
        ]);
        const key = String(steps[cache].with?.key);
        expect(key).toContain("${{ runner.os }}");
        expect(key).toContain("${{ steps.pw.outputs.version }}");
        // actions/cache never overwrites a key: a key saved before the apt
        // packages joined the cache would keep restoring a cache without
        // them, on every branch that has it (main did). So the key names what
        // is in it.
        expect([file, name, /-apt\b/.test(key)]).toEqual([file, name, true]);
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
# apt run as root outlives the cut-off and holds dpkg's lock: while the
# leftover runs, the next install-deps fails at once (exit 100).
if [ "$part" = install-deps ] && [ -e "$FAKE_DIR/lock" ]; then
  echo "E: Could not get lock (fake)"; exit 100
fi
if [ "$part" = install-deps ] && [ -n "\${CI_PW_APT_SOURCES:-}" ]; then
  ls "$CI_PW_APT_SOURCES" > "$FAKE_DIR/sources-at-install" 2>/dev/null
  if grep -qsF packages.microsoft.com "$CI_PW_APT_SOURCES"/*; then
    echo "E: Failed to fetch https://packages.microsoft.com/ubuntu/26.04/prod/dists/resolute/InRelease  403  Forbidden"; exit 100
  fi
fi
if [ "$part" = install-deps ] && [ -n "\${FAKE_ARCHIVES:-}" ]; then
  ls "$FAKE_ARCHIVES" > "$FAKE_DIR/archives-at-install" 2>/dev/null
  touch "$FAKE_ARCHIVES/fetched_1.0_amd64.deb"
fi
var="FAKE_HANG_\${part//-/_}"
case " \${!var} " in *" $n "*)
  if [ "$part" = install-deps ] && [ -n "\${FAKE_LEFTOVER:-}" ]; then
    touch "$FAKE_DIR/lock"
    bash "$FAKE_BIN/fake-apt-leftover" "$FAKE_DIR" "$FAKE_LEFTOVER" &
  fi
  exec sleep 30 ;;
esac
exit 0
`;
  // The leftover ignores TERM (as root's apt does a non-root timeout),
  // finishes after its seconds, and frees the lock.
  const LEFTOVER = `#!/bin/bash
trap '' TERM
sleep "$2"
rm -f "$1/lock"
`;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pw-install-"));
    fs.mkdirSync(path.join(tmp, "bin"));
    fs.writeFileSync(path.join(tmp, "bin", "npx"), FAKE, { mode: 0o755 });
    fs.writeFileSync(
      path.join(tmp, "bin", "apt-cache"),
      `#!/bin/bash
echo " 500 http://archive.example/mirror noble-updates/main amd64 Packages"
[ -n "\${FAKE_NO_UBUNTU:-}" ] && echo "     release o=vendor-other,a=noble" || echo "     release v=24.04,o=Ubuntu,a=noble-updates,n=noble,l=Ubuntu,c=main,b=amd64"
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(tmp, "bin", "fake-apt-leftover"), LEFTOVER, {
      mode: 0o755,
    });
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
          FAKE_BIN: path.join(tmp, "bin"),
          CI_PW_BUSY_PATTERN: `fake-apt-leftover ${dir}`,
          CI_PW_APT_CACHE: path.join(dir, "apt-cache"),
          CI_PW_APT_ARCHIVES: path.join(dir, "apt-archives"),
          CI_PW_SUDO: "",
          CI_PW_APT_SOURCES: path.join(dir, "no-sources"),
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

  it("apt cut off but still running: the retry waits for it to finish, then passes", () => {
    // CI, 2026-11-17: the first try was cut off at its limit, its apt-get
    // (root) went on holding dpkg's lock, and the retry failed at once.
    const r = run("deps-leftover", {
      FAKE_HANG_install_deps: "1",
      FAKE_LEFTOVER: "4",
    });
    expect(r.out).toMatch(/waiting for the cut-off apt run to finish/);
    expect(r.code).toBe(0);
    expect([r.deps, r.install]).toEqual([2, 1]);
  }, 30_000);

  it("apt's packages come from the cache, and go back to it after a good install", () => {
    const cache = path.join(tmp, "apt-cache");
    const archives = path.join(tmp, "apt-archives");
    fs.mkdirSync(cache);
    fs.mkdirSync(archives);
    fs.writeFileSync(path.join(cache, "cached_1.0_amd64.deb"), "");
    const r = run("apt-cache-run", {
      CI_PW_APT_CACHE: cache,
      CI_PW_APT_ARCHIVES: archives,
      CI_PW_SUDO: "",
      FAKE_ARCHIVES: archives,
    });
    expect(r.code).toBe(0);
    // The cached package was in apt's folder when install-deps ran.
    expect(
      fs.readFileSync(
        path.join(tmp, "apt-cache-run", "archives-at-install"),
        "utf-8",
      ),
    ).toContain("cached_1.0_amd64.deb");
    expect(fs.readdirSync(cache).sort()).toEqual([
      "cached_1.0_amd64.deb",
      "fetched_1.0_amd64.deb",
    ]);
  });

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

  it("install-deps fails on a runner with no Ubuntu apt sources: no retry, and the error says why and never to re-run", () => {
    const r = run("no-ubuntu", {
      FAKE_HANG_install_deps: "1",
      FAKE_NO_UBUNTU: "1",
      ImageOS: "ubuntu26",
      ImageVersion: "20261116.88.1",
    });
    expect(r.code).not.toBe(0);
    expect([r.deps, r.install]).toEqual([1, 0]);
    expect(r.out).toMatch(
      /::error::.*ubuntu26 20261116\.88\.1.*no Ubuntu apt sources.*never re-run/,
    );
    expect(r.out).not.toMatch(/(?<!never )re-run the job/);
  }, 30_000);

  it("failing twice names the runner image and asks for a fresh head, never a re-run", () => {
    const r = run("deps-twice-hint", {
      FAKE_HANG_install_deps: "1 2",
      ImageOS: "ubuntu26",
      ImageVersion: "20261116.88.1",
    });
    expect(r.out).toMatch(
      /::error::.*failed twice.*ubuntu26 20261116\.88\.1.*fresh head/,
    );
    expect(r.out).not.toMatch(/(?<!never )re-run the job/);
  }, 30_000);

  const MS_SOURCE =
    "Types: deb\nURIs: https://packages.microsoft.com/ubuntu/26.04/prod\nSuites: resolute\nComponents: main\n";
  const withSources = (name: string) => {
    const dir = path.join(tmp, `${name}-sources`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "azure-cli.sources"), MS_SOURCE);
    fs.writeFileSync(
      path.join(dir, "microsoft-named.list"),
      "deb http://archive.example/ubuntu noble main\n",
    );
    return dir;
  };
  const atInstall = (name: string) =>
    fs.readFileSync(path.join(tmp, name, "sources-at-install"), "utf-8");

  it("an apt source naming packages.microsoft.com (it 403s) is set aside for install-deps, matched by content, and put back after", () => {
    const sources = withSources("ms-403");
    const r = run("ms-403", { CI_PW_APT_SOURCES: sources });
    expect(r.code).toBe(0);
    expect([r.deps, r.install]).toEqual([1, 1]);
    expect(atInstall("ms-403")).not.toContain("azure-cli.sources");
    expect(atInstall("ms-403")).toContain("microsoft-named.list");
    expect(fs.readdirSync(sources).sort()).toEqual([
      "azure-cli.sources",
      "microsoft-named.list",
    ]);
    expect(
      fs.readFileSync(path.join(sources, "azure-cli.sources"), "utf-8"),
    ).toBe(MS_SOURCE);
  });

  it("the Microsoft source is put back when install-deps fails twice too", () => {
    const sources = withSources("ms-fail");
    const r = run("ms-fail", {
      CI_PW_APT_SOURCES: sources,
      FAKE_HANG_install_deps: "1 2",
    });
    expect(r.code).not.toBe(0);
    expect(atInstall("ms-fail")).not.toContain("azure-cli.sources");
    expect(
      fs.readFileSync(path.join(sources, "azure-cli.sources"), "utf-8"),
    ).toBe(MS_SOURCE);
  }, 30_000);

  it("with the Microsoft source aside, no Ubuntu sources still fails fast, and the source is put back", () => {
    const sources = withSources("ms-no-ubuntu");
    const r = run("ms-no-ubuntu", {
      CI_PW_APT_SOURCES: sources,
      FAKE_HANG_install_deps: "1",
      FAKE_NO_UBUNTU: "1",
    });
    expect(r.code).not.toBe(0);
    expect([r.deps, r.install]).toEqual([1, 0]);
    expect(r.out).toMatch(/::error::.*no Ubuntu apt sources/);
    expect(atInstall("ms-no-ubuntu")).not.toContain("azure-cli.sources");
    expect(fs.readdirSync(sources)).toContain("azure-cli.sources");
  }, 30_000);

  it("a Microsoft source that can't be put back is kept where it was set aside, with a warning, never deleted", () => {
    const sources = withSources("ms-stuck");
    const sudo = path.join(tmp, "ms-stuck-sudo");
    fs.writeFileSync(
      sudo,
      `#!/bin/bash
[ "$1" = mv ] && [ "\${3%/*}" = "${sources}" ] && exit 1
exec "$@"
`,
      { mode: 0o755 },
    );
    const r = run("ms-stuck", { CI_PW_APT_SOURCES: sources, CI_PW_SUDO: sudo });
    expect(r.code).toBe(0);
    expect(fs.readdirSync(sources)).not.toContain("azure-cli.sources");
    const kept = /::warning::could not put \S+ back: kept in (\S+)/.exec(
      r.out,
    )?.[1];
    expect(kept).toBeDefined();
    expect(
      fs.readFileSync(path.join(kept as string, "azure-cli.sources"), "utf-8"),
    ).toBe(MS_SOURCE);
    fs.rmSync(kept as string, { recursive: true, force: true });
  });

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
