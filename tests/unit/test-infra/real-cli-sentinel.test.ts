/**
 * The real-CLI sentinel (issue 163): no test, child process or server a test
 * starts may run this machine's claude, op, doppler, security, launchctl,
 * sudo, mkcert or gh. Jest's global setup puts a sentinel folder on the
 * real PATH, after the harness's own inert fakes and ahead of every folder
 * of this machine, before any worker starts; its stubs log their name and
 * argv (never stdin) and exit 99, and a run with any logged call fails.
 *
 * The first block only RESOLVES names (which file the PATH would run):
 * nothing is executed. Only once the first hit is the sentinel's stub does
 * the second block run it, to show the exit 99 and the log line.
 */
import { describe, expect, it } from "@jest/globals";
import { execFile, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import { serverEnv } from "../../child-servers.js";
import { SENTINEL_BINS, clearSentinel, sentinelCalls } from "../../sentinel.js";

/** The file `name` resolves to on `PATH`, without running anything. */
function resolve(name: string, PATH: string | undefined): string | null {
  for (const dir of (PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const f = path.join(dir, name);
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* not here */
    }
  }
  return null;
}

const sentinel = () => process.env.DEN_TEST_SENTINEL ?? "<no sentinel>";
const inSentinel = (f: string | null) => !!f && path.dirname(f) === sentinel();

/**
 * A sentinel stub: in the sentinel folder, or a sibling of it holding only
 * the names a PATH needed guarded.
 */
/**
 * What a guarded name may resolve to where a test set the PATH: a stub or
 * a test's fake (temp folders), or nothing at all (a name this platform
 * lacks stays missing: launchctl and security on Linux). Never a real one.
 */
const inertOrMissing = (f: string | null) => !f || isTmp(path.dirname(f));

const stub = (f: string | null) => {
  if (!f) return false;
  const d = path.dirname(f);
  return d === sentinel() || d.startsWith(`${sentinel()}-`);
};

/** Folders a test makes (fakes, stand-ins, the sentinel): under the temp dir. */
const tmpRoots = [
  os.tmpdir(),
  fs.realpathSync(os.tmpdir()),
  "/tmp",
  "/private/tmp",
];
const isTmp = (p: string) =>
  tmpRoots.some((t) => p === t || p.startsWith(t.endsWith("/") ? t : `${t}/`));

/**
 * PATH's sentinel guard: the sentinel is on it, every folder ahead of it is
 * a temp folder (a fake), and from the sentinel on, `name` is its stub.
 */
function guarded(name: string, PATH: string | undefined): void {
  const parts = (PATH ?? "").split(path.delimiter).filter(Boolean);
  const at = parts.indexOf(sentinel());
  expect(at).toBeGreaterThanOrEqual(0);
  expect(parts.slice(0, at).filter((p) => !isTmp(p))).toEqual([]);
  expect(resolve(name, parts.slice(at).join(path.delimiter))).toBe(
    path.join(sentinel(), name),
  );
  // Whatever runs is a temp stand-in, never this machine's program.
  expect(isTmp(resolve(name, PATH) ?? "")).toBe(true);
}

describe("every guarded name resolves to a fake or the sentinel's stub (nothing runs)", () => {
  it.each([...SENTINEL_BINS])("%s, on this worker's real PATH", (name) => {
    guarded(name, process.env.PATH);
  });

  it.each(["doppler", "security"])(
    "%s, with no fake for it, is the sentinel's stub itself",
    (name) => {
      expect(resolve(name, process.env.PATH)).toBe(path.join(sentinel(), name));
    },
  );

  it.each(["security", "sudo", "launchctl"])(
    "%s, in a started den child server's env, even one that sets its own PATH",
    (name) => {
      // A helper's own fakes first (a temp dir), then the system's.
      const env = serverEnv({ PATH: "/tmp/den-fakes-x:/usr/bin:/bin" });
      expect(inertOrMissing(resolve(name, env.PATH))).toBe(true);
      // The helper's fakes stay ahead of the sentinel.
      expect(env.PATH!.split(path.delimiter)[0]).toBe("/tmp/den-fakes-x");
    },
  );

  it("a started server's gh and sudo are inert fakes or missing; its system sudo is the fake", () => {
    const env = serverEnv({
      PATH: "/tmp/den-fakes-x:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
      DEN_SYSTEM_SUDO: path.join(sentinel(), "sudo"),
    });
    for (const name of ["gh", "sudo"])
      expect(inertOrMissing(resolve(name, env.PATH))).toBe(true);
    expect(env.DEN_SYSTEM_SUDO).toBe(
      path.join(path.dirname(sentinel()), "server-fakes", "sudo"),
    );
    // A test's own sudo stays its own.
    expect(
      serverEnv({ PATH: "/bin", DEN_SYSTEM_SUDO: "/tmp/x/sudo" })
        .DEN_SYSTEM_SUDO,
    ).toBe("/tmp/x/sudo");
  });

  it.each(["doppler", "mkcert", "claude"])(
    "%s, missing from a PATH a test set, stays missing (a test of not installed)",
    (name) => {
      const env = serverEnv({ PATH: "/tmp/den-fakes-x:/usr/bin:/bin" });
      expect(resolve(name, env.PATH)).toBeNull();
    },
  );
});

describe("a spawn whose env sets its own PATH keeps the sentinel (nothing runs)", () => {
  // `command -v` only names the file the child's PATH would run.
  const which = (name: string, opts: object) =>
    spawnSync("/bin/sh", ["-c", `command -v ${name}`], {
      encoding: "utf-8",
      ...opts,
    }).stdout.trim();

  it.each(["security", "launchctl", "sudo"])(
    "%s, from a spawn with env PATH /usr/bin:/bin",
    (name) => {
      const f = which(name, { env: { PATH: "/usr/bin:/bin" } });
      expect(inertOrMissing(f)).toBe(true);
      // Present on this platform: the stub itself (no test fake here).
      if (f) expect(stub(f)).toBe(true);
    },
  );

  it("doppler, not in /usr/bin:/bin, stays missing there", () => {
    expect(which("doppler", { env: { PATH: "/usr/bin:/bin" } })).toBe("");
  });

  it("promisified execFile too", async () => {
    const { stdout } = await promisify(execFile)(
      "/bin/sh",
      ["-c", "command -v security || true"],
      { env: { PATH: "/usr/bin:/bin" } },
    );
    const f = stdout.trim();
    expect(inertOrMissing(f)).toBe(true);
    if (f) expect(stub(f)).toBe(true);
  });

  it("a test's own fake folder stays ahead of the sentinel", () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "den-sentinel-fake-"));
    try {
      fs.writeFileSync(path.join(bin, "security"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      expect(which("security", { env: { PATH: `${bin}:/usr/bin:/bin` } })).toBe(
        path.join(bin, "security"),
      );
      const sudo = which("sudo", { env: { PATH: `${bin}:/usr/bin:/bin` } });
      expect(inertOrMissing(sudo)).toBe(true);
      if (sudo) expect(stub(sudo)).toBe(true);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it("Den's system sudo (an absolute path, never PATH) is the sentinel's stub", () => {
    expect(process.env.DEN_SYSTEM_SUDO).toBe(path.join(sentinel(), "sudo"));
    // Even in a spawn whose env leaves it out; a test's own fake wins.
    const echo = (env: NodeJS.ProcessEnv) =>
      spawnSync("/bin/sh", ["-c", 'printf %s "$DEN_SYSTEM_SUDO"'], {
        encoding: "utf-8",
        env,
      }).stdout;
    expect(echo({ PATH: "/usr/bin:/bin" })).toBe(path.join(sentinel(), "sudo"));
    expect(echo({ PATH: "/bin", DEN_SYSTEM_SUDO: "/tmp/x/sudo" })).toBe(
      "/tmp/x/sudo",
    );
  });

  it("a call from a spawn whose env leaves JEST_WORKER_ID out lands in this worker's log", () => {
    // A guarded program this platform has in /usr/bin:/bin (launchctl on
    // macOS, sudo on a Linux runner), shadowed by the stub: logged here,
    // not as log 0. Never run unless the stub is what would run.
    const env = { PATH: "/usr/bin:/bin" };
    const name = ["launchctl", "sudo", "security"].find((n) =>
      stub(which(n, { env })),
    );
    if (!name) return; // none here: nothing real to shadow
    const r = spawnSync(name, ["managername"], { env });
    expect(r.status).toBe(99);
    expect(sentinelCalls()).toContain(`${name} managername`);
    clearSentinel();
  });
});

describe("the stub, once it is first: exit 99 and a logged call", () => {
  it.each([
    ["doppler", ["--version"]],
    ["security", ["help"]],
  ])("bare %s exits 99 and is logged (argv only)", (name, args) => {
    // Never run unless the sentinel is what would run.
    const f = resolve(name, process.env.PATH);
    expect(inSentinel(f)).toBe(true);
    if (!inSentinel(f)) return;
    const r = spawnSync(name, args, { input: "never-logged-stdin" });
    expect(r.status).toBe(99);
    const calls = sentinelCalls();
    expect(calls.some((c) => c.includes(`${name} ${args.join(" ")}`))).toBe(
      true,
    );
    expect(calls.join("\n")).not.toContain("never-logged-stdin");
    // This test trips it on purpose: the run must not fail for it.
    clearSentinel();
  });
});
