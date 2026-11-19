/**
 * Issue 501: every session host a test starts dies with the test, and a run
 * that leaves one alive fails, naming the test file.
 *
 * - The host Den's CLI starts on demand carries DEN_HOST_TAG on its command
 *   line (hostArgs), which is how a run finds its own hosts on a machine
 *   whose ps shows no other process's env.
 * - Child jest runs (tests/fixtures/test-hosts/*.fixture.ts): a host started
 *   outside the helper and left running fails the run, naming its file, and
 *   is stopped; a host started with the helper by a test that throws first
 *   is stopped after that test, and the run passes.
 * - Nothing here signals a process this file didn't start: the guard only
 *   ever matches its own run's tag.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { hostArgs } from "../../../src/ui/cli/sessions-command.js";
import { hostTag, taggedHosts } from "../../test-hosts.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const core = require("../../test-hosts-core.cjs") as {
  parseHosts(ps: string): {
    pid: number;
    pgid: number;
    run: string;
    file: string | null;
    owner: string | null;
  }[];
};

const ROOT = path.resolve(__dirname, "../../..");
const LOADER = path.join(ROOT, "node_modules/tsx/dist/loader.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-test-hosts-"));
const started: ChildProcess[] = [];

afterAll(() => {
  for (const c of started)
    try {
      if (c.pid) process.kill(-c.pid, "SIGKILL");
    } catch {
      /* gone */
    }
  // A host left in one of these state dirs stops once its dir is gone.
  fs.rmSync(tmp, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the tag on a host's command line", () => {
  it("DEN_HOST_TAG goes on `sessions host` as --tag", () => {
    expect(
      hostArgs({ DEN_HOST_TAG: "den-test-42@tests/unit/a.test.ts~o1" }),
    ).toEqual([
      "sessions",
      "host",
      "--tag=den-test-42@tests/unit/a.test.ts~o1",
    ]);
  });

  it("no tag, or one that isn't one plain word, leaves it out", () => {
    expect(hostArgs({})).toEqual(["sessions", "host"]);
    expect(hostArgs({ DEN_HOST_TAG: "a b" })).toEqual(["sessions", "host"]);
    expect(hostArgs({ DEN_HOST_TAG: "$(x)" })).toEqual(["sessions", "host"]);
    expect(hostArgs({ DEN_HOST_TAG: "x".repeat(201) })).toEqual([
      "sessions",
      "host",
    ]);
  });

  it("names the run, the test file and the owner; a file name becomes one word", () => {
    expect(hostTag(7)).toBe("den-test-7");
    expect(hostTag(7, "tests/a b.test.ts", "o1")).toBe(
      "den-test-7@tests/a_b.test.ts~o1",
    );
  });

  it("only a host's command line with a test run's tag is one of them", () => {
    const ps = [
      " 10 10 /usr/bin/node --import l.mjs /x/src/ui/cli/index.ts sessions host --tag=den-test-7@tests/unit/a.test.ts~o1",
      " 11 11 /usr/bin/node --import l.mjs /x/tests/unit/sessions/helpers/pipe-host.ts /tmp/s --tag=den-test-7",
      " 12 12 /usr/bin/node --import l.mjs /x/src/ui/cli/index.ts sessions host --stand-by",
      " 13 13 /usr/bin/node /x/src/ui/cli/index.ts web up --tag=den-test-7",
      " 14 14 /bin/sh -c echo sessions host --tag=den-test-7x",
    ].join("\n");
    expect(core.parseHosts(ps)).toEqual([
      expect.objectContaining({
        pid: 10,
        run: "7",
        file: "tests/unit/a.test.ts",
        owner: "o1",
      }),
      expect.objectContaining({ pid: 11, run: "7", file: null, owner: null }),
    ]);
  });

  it("a run never finds another run's host", () => {
    const fake = path.join(tmp, "other-host.ts");
    fs.writeFileSync(fake, "setInterval(() => undefined, 1000);\n");
    const other = spawn(
      process.execPath,
      ["--import", `file://${LOADER}`, fake, tmp, `--tag=${hostTag(1)}`],
      { stdio: "ignore", detached: true },
    );
    started.push(other);
    const run = process.env.DEN_TEST_RUN ?? "0";
    const deadline = Date.now() + 10_000;
    while (
      !taggedHosts({ run: "1" }).some((h) => h.pid === other.pid) &&
      Date.now() < deadline
    )
      spawnSync("sleep", ["0.1"]);
    expect(taggedHosts({ run: "1" }).map((h) => h.pid)).toContain(other.pid);
    expect(taggedHosts({ run }).map((h) => h.pid)).not.toContain(other.pid);
  }, 20_000);
});

/** A fixture in a child jest: its exit code, its output, and the host's pid. */
function childJest(fixture: string): {
  code: number | null;
  out: string;
  hostPid: number;
} {
  const dir = fs.mkdtempSync(path.join(tmp, "state-"));
  const out = path.join(dir, "host.pid");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEN_TEST_HOSTS_FIXTURE_OUT: out,
    DEN_TEST_HOSTS_FIXTURE_DIR: dir,
    // The guard waits for nothing: a host still alive is left behind.
    DEN_TEST_HOST_GRACE_MS: "0",
  };
  for (const k of [
    "JEST_WORKER_ID",
    "DEN_TEST_DOCKER",
    "DEN_TEST_QUARANTINE",
    "DEN_HOST_TAG",
    "DEN_TEST_RUN",
  ])
    delete env[k];
  const r = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "node_modules", "jest", "bin", "jest.js"),
      "--forceExit",
      "--ci",
      "--maxWorkers=1",
      "--testMatch",
      `**/tests/fixtures/test-hosts/${fixture}`,
    ],
    { cwd: ROOT, env, encoding: "utf-8", timeout: 150_000 },
  );
  const pid = fs.existsSync(out) ? Number(fs.readFileSync(out, "utf-8")) : 0;
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, hostPid: pid };
}

describe("a run's guard (red first)", () => {
  it("a host started outside the helper and left running fails the run, naming its file, and is stopped", () => {
    const r = childJest("leak.fixture.ts");
    expect(r.hostPid).toBeGreaterThan(1);
    expect(r.out).toMatch(/outlived its test file/);
    expect(r.out).toContain(
      `pid ${r.hostPid}, from tests/fixtures/test-hosts/leak.fixture.ts`,
    );
    expect(r.code).not.toBe(0);
    expect(alive(r.hostPid)).toBe(false);
  }, 180_000);

  it("a host started with the helper, by a test that throws first, is stopped after it; the run passes", () => {
    const r = childJest("throws.fixture.ts");
    expect(r.hostPid).toBeGreaterThan(1);
    expect(r.out).not.toMatch(/outlived its test file/);
    expect(alive(r.hostPid)).toBe(false);
    expect(r.code).toBe(0);
  }, 180_000);
});
