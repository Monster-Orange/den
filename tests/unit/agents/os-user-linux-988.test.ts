import { beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  launcherScript,
  machineReadDeps,
  osUserCheck,
  osUserNames,
  osUserPaths,
  readOsUserFacts,
  removePlan,
  runPlan,
  setupPlan,
  sudoersLine,
  type OsUserLayout,
  type PlanRunner,
} from "../../../src/shared/agents/os-user.js";
import { allowWrites } from "../../write-guard.js";

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
  personHome: `/home/${PERSON}`,
  root: "/opt/den",
  runtime: { bin: "/bin/sh", script: RUNTIME },
  noLogin: fs.existsSync("/usr/sbin/nologin")
    ? "/usr/sbin/nologin"
    : "/bin/false",
};
const n = osUserNames("linux", PERSON);
const p = osUserPaths(layout.root, PERSON);

const SUDO = "/usr/bin/sudo";
const SYSTEM_ENV = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" };
const real = (argv: string[]) =>
  argv[0] === "sudo" ? [SUDO, ...argv.slice(1)] : argv;
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
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

const TEXT = {
  launcher: launcherScript({
    person: PERSON,
    user: n.user,
    home: p.home,
    runtime: layout.runtime,
  }),
  sudoers: `${sudoersLine({ person: PERSON, user: n.user, launcher: p.launcher })}\n`,
};
const rootRun: PlanRunner = (argv, stdin) => {
  const r = spawnSync(argv[0]!, argv.slice(1), {
    encoding: "utf-8",
    env: SYSTEM_ENV,
    input: stdin ?? "",
  });
  return r.status === 0
    ? { ok: true, stdout: r.stdout ?? "" }
    : { ok: false, error: (r.stderr || `exit ${r.status}`).trim() };
};

d("issue 988 on a real Linux machine (root, a throwaway container)", () => {
  beforeAll(() => {
    allowWrites(`/home/${PERSON}`);
    allowWrites(RUNTIME);
  });

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
    expect(
      runPlan(
        setupPlan(layout, TEXT, {
          user: false,
          group: false,
          homeMode: fs.statSync(layout.personHome).mode,
        }),
        rootRun,
      ),
    ).toEqual({ ok: true });
    expect(fs.statSync(layout.personHome).mode & 0o777).toBe(0o700);
    const c = osUserCheck({ on: true, layout }, facts());
    expect(c.problems).toEqual([]);
    expect(c.status).toBe("ok");
  });

  it("the agents' login can't read a dotfile in the person's home", () => {
    const dot = path.join(layout.personHome, ".zshenv");
    fs.writeFileSync(dot, "export STAND_IN=1\n", { mode: 0o644 });
    const r = as(n.user, ["cat", dot]);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("STAND_IN");
  });

  it("pin 1: the person runs the launcher as the agents' login, and nothing else", () => {
    const ok = as(PERSON, [
      "sudo",
      "-n",
      "-u",
      n.user,
      p.launcher,
      "scout",
      "0123456789abcdef0123456789abcdef",
    ]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`WHO ${n.user}`);
    expect(ok.stdout).toContain(
      "ARGS agents session scout 0123456789abcdef0123456789abcdef",
    );
    expect(ok.stdout).toContain(`HOME ${p.home}`);
    expect(
      as(PERSON, ["sudo", "-n", "-u", n.user, "/bin/sh", "-c", "id"]).status,
    ).not.toBe(0);
    expect(
      as(PERSON, [
        "sudo",
        "-n",
        "-u",
        "root",
        p.launcher,
        "scout",
        "0123456789abcdef0123456789abcdef",
      ]).status,
    ).not.toBe(0);
    expect(
      as(PERSON, [
        "sudo",
        "-n",
        p.launcher,
        "scout",
        "0123456789abcdef0123456789abcdef",
      ]).status,
    ).not.toBe(0);
    expect(
      as(PERSON, [
        "sudo",
        "-n",
        "-u",
        n.user,
        p.launcher,
        "../x",
        "0123456789abcdef0123456789abcdef",
      ]).status,
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

  it("the agents' login can't move its home or plant anything in root's folder", () => {
    expect(as(n.user, ["mv", p.home, `${p.dir}/h2`]).status).not.toBe(0);
    expect(as(n.user, ["ln", "-s", STATE, `${p.dir}/x`]).status).not.toBe(0);
    const mine = path.join(p.agents, "person-file");
    expect(as(PERSON, ["touch", mine]).status).toBe(0);
    expect(as(n.user, ["rm", "-f", mine]).status).not.toBe(0);
    expect(fs.existsSync(mine)).toBe(true);
  });

  it("a re-run is safe: it keeps the login, and refuses (changing nothing) when a path it writes is a link", () => {
    expect(
      runPlan(setupPlan(layout, TEXT, { user: true, group: true }), rootRun),
    ).toEqual({ ok: true });
    fs.rmSync(p.home, { recursive: true });
    fs.symlinkSync(STATE, p.home);
    const before = fs.statSync(STATE);
    const r = runPlan(
      setupPlan(layout, TEXT, { user: true, group: true }),
      rootRun,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/is a link/);
    const after = fs.statSync(STATE);
    expect([after.uid, after.mode]).toEqual([before.uid, before.mode]);
    fs.rmSync(p.home);
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
