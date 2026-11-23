/**
 * Issue 988 on a real Linux machine: the setup's steps run for real, the
 * sudo rule is tried, and the remove is checked. Only as root, in a
 * throwaway container, with DEN_OS_USER_E2E=1 (it makes logins and writes
 * /etc/sudoers.d); everywhere else it is skipped.
 *
 *   docker run --rm -e DEN_OS_USER_E2E=1 -v <checkout>:/den -w /den node:24 \
 *     sh -c 'apt-get update -qq && apt-get install -y -qq sudo >/dev/null &&
 *            npx jest --maxWorkers=1 tests/unit/agents/os-user-linux-988.test.ts'
 *
 * Invented names.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  launcherScript,
  machineReadDeps,
  osUserCheck,
  osUserNames,
  osUserPaths,
  readOsUserFacts,
  removePlan,
  setupPlan,
  sudoersLine,
  type OsUserLayout,
} from "../../../src/shared/agents/os-user.js";

const E2E =
  process.platform === "linux" &&
  typeof process.getuid === "function" &&
  process.getuid() === 0 &&
  process.env.DEN_OS_USER_E2E === "1";
const d = E2E ? describe : describe.skip;

const PERSON = "kit";
const RUNTIME = "/opt/den-fake-runtime.sh";
const STATE = `/home/${PERSON}/.den-state`;

const layout: OsUserLayout = {
  platform: "linux",
  person: PERSON,
  root: "/opt/den",
  runtime: { bin: "/bin/sh", script: RUNTIME },
  noLogin: fs.existsSync("/usr/sbin/nologin")
    ? "/usr/sbin/nologin"
    : "/bin/false",
};
const n = osUserNames("linux", PERSON);
const p = osUserPaths(layout.root, PERSON);

// jest's setup puts a sudo stand-in ahead of every spawn's PATH (the
// real-CLI sentinel, tests/sentinel.ts), so no other test can run sudo.
// This one, root in a throwaway container, means the real one: by full path.
const SUDO = "/usr/bin/sudo";
const SYSTEM_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" };
const real = (argv: string[]) =>
  argv[0] === "sudo" ? [SUDO, ...argv.slice(1)] : argv;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** Runs `argv` as `who` (root su's to it; a no-login user gets /bin/sh). */
function as(who: string, argv: string[]) {
  return spawnSync(
    "su",
    ["-s", "/bin/sh", who, "-c", real(argv).map(q).join(" ")],
    {
      encoding: "utf-8",
      env: SYSTEM_ENV,
    },
  );
}
const root = (argv: string[]) =>
  spawnSync(argv[0]!, argv.slice(1), { encoding: "utf-8", env: SYSTEM_ENV });

/** doctor's facts, with `sudo -n -l` run as the person, as doctor would. */
function facts() {
  const m = machineReadDeps();
  return readOsUserFacts(layout, STATE, {
    ...m,
    personUid: Number(root(["id", "-u", PERSON]).stdout.trim()),
    exec: (cmd, args) => {
      const r =
        cmd === "sudo" ? as(PERSON, [cmd, ...args]) : root([cmd, ...args]);
      return { status: r.status ?? 1, stdout: r.stdout ?? "" };
    },
  });
}

d("issue 988 on a real Linux machine (root, a throwaway container)", () => {
  it("setup runs, and doctor (reading as the person) finds it all as it should be", () => {
    expect(root(["useradd", "--create-home", PERSON]).status).toBe(0);
    fs.mkdirSync(STATE, { mode: 0o700 });
    fs.writeFileSync(path.join(STATE, "settings.yml"), "secret: yes\n", {
      mode: 0o600,
    });
    root(["chown", "-R", `${PERSON}:${PERSON}`, STATE]);
    fs.writeFileSync(
      RUNTIME,
      'echo "WHO $(id -un)"; echo "ARGS $*"; echo "HOME $HOME"\n',
      { mode: 0o755 },
    );
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "den-os-user-"));
    const staged = {
      launcher: path.join(stage, "launch"),
      sudoers: path.join(stage, "sudoers"),
    };
    fs.writeFileSync(
      staged.launcher,
      launcherScript({
        person: PERSON,
        user: n.user,
        home: p.home,
        runtime: layout.runtime,
      }),
    );
    fs.writeFileSync(
      staged.sudoers,
      `${sudoersLine({ person: PERSON, user: n.user, launcher: p.launcher })}\n`,
    );
    for (const s of setupPlan(layout, staged)) {
      const r = root(s.argv);
      if (r.status !== 0) throw new Error(`${s.argv.join(" ")}: ${r.stderr}`);
    }
    const c = osUserCheck({ on: true, layout }, facts());
    expect(c.problems).toEqual([]);
    expect(c.status).toBe("ok");
  });

  it("pin 1: the person runs the launcher as the agents' login, and nothing else", () => {
    const ok = as(PERSON, ["sudo", "-n", "-u", n.user, p.launcher, "scout"]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`WHO ${n.user}`);
    expect(ok.stdout).toContain("ARGS agents session scout");
    expect(ok.stdout).toContain(`HOME ${p.home}`);
    expect(
      as(PERSON, ["sudo", "-n", "-u", n.user, "/bin/sh", "-c", "id"]).status,
    ).not.toBe(0);
    expect(
      as(PERSON, ["sudo", "-n", "-u", "root", p.launcher, "scout"]).status,
    ).not.toBe(0);
    expect(as(PERSON, ["sudo", "-n", p.launcher, "scout"]).status).not.toBe(0);
    expect(
      as(PERSON, ["sudo", "-n", "-u", n.user, p.launcher, "../x"]).status,
    ).not.toBe(0);
  });

  it("pin 2: the person can't change the launcher or the folders above it", () => {
    expect(
      as(PERSON, ["sh", "-c", `echo id >> ${p.launcher}`]).status,
    ).not.toBe(0);
    expect(as(PERSON, ["mv", p.launcher, `${p.launcher}.x`]).status).not.toBe(
      0,
    );
    expect(as(PERSON, ["mkdir", `${p.bin}/x`]).status).not.toBe(0);
  });

  it("pin 4: the agents' login can't read the person's state, use sudo or log in", () => {
    expect(
      as(n.user, ["cat", path.join(STATE, "settings.yml")]).status,
    ).not.toBe(0);
    expect(as(n.user, ["ls", STATE]).status).not.toBe(0);
    expect(as(n.user, ["sudo", "-n", "true"]).status).not.toBe(0);
    const pw = root(["getent", "passwd", n.user]).stdout.trim().split(":");
    expect(pw[6]).toBe(layout.noLogin);
    expect(pw[5]).toBe(p.home);
  });

  it("pin 5: remove leaves no login, group, rule or folder, and doctor proves it", () => {
    for (const s of removePlan(layout)) root(s.argv);
    expect(root(["getent", "passwd", n.user]).status).not.toBe(0);
    expect(root(["getent", "group", n.group]).status).not.toBe(0);
    expect(fs.existsSync(p.sudoers)).toBe(false);
    expect(fs.existsSync(p.dir)).toBe(false);
    const c = osUserCheck({ on: false, layout }, facts());
    expect(c.problems).toEqual([]);
    expect(c.status).toBe("ok");
  });
});
