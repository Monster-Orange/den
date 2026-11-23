/**
 * Issue 988 (slice 2 of issue 936), part 1: agents as a second OS user:
 * the setup, the remove and doctor's check, as data. Nothing here starts
 * a session or changes the machine: the launcher test runs the generated
 * script against a stand-in runtime in a temp folder.
 *
 * The five things pinned:
 *   1. the sudoers rule runs as the agents user only, never root, with no
 *      ALL and no wildcards in the command;
 *   2. the launcher is root-owned and not writable by the person or the
 *      agents user, nor is any folder above it (doctor fails if it is);
 *   3. the launcher takes only an agent id, checked against Den's pattern,
 *      scrubs the environment to an allowlist, and execs only the binary
 *      Den registered;
 *   4. the agents user has no sudo, no login shell and no home outside
 *      Den's agent files;
 *   5. remove leaves no user, group, rule or file behind, and doctor
 *      proves it.
 *
 * Invented names.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  LAUNCH_ENV,
  launcherScript,
  osUserCheck,
  osUserNames,
  osUserPaths,
  removePlan,
  runPlan,
  setupPaths,
  setupPlan,
  sudoersLine,
  sudoersRuleProblem,
  writableChain,
  type OsUserFacts,
  type OsUserLayout,
  type PlanRunner,
} from "../../../src/shared/agents/os-user.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-os-user-988-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const ROOT = "/opt/den";

function layout(platform: "darwin" | "linux"): OsUserLayout {
  return {
    platform,
    person: "robin",
    root: ROOT,
    runtime: { bin: "/usr/local/bin/node", script: "/srv/den/dist/cli.js" },
    noLogin: platform === "linux" ? "/usr/sbin/nologin" : "/usr/bin/false",
    ids: { uid: 455, gid: 455 },
  };
}

describe("issue 988: names and paths", () => {
  it("one agents user and one group per person, by platform", () => {
    expect(osUserNames("linux", "robin")).toEqual({
      user: "den-agents-robin",
      group: "den-robin",
    });
    expect(osUserNames("darwin", "robin")).toEqual({
      user: "_den_agents_robin",
      group: "_den_robin",
    });
  });

  it("refuses a person name that isn't a plain OS user name", () => {
    for (const bad of ["", "Robin Hood", "../x", "-r", "a".repeat(17), "r;id"])
      expect(() => osUserNames("linux", bad)).toThrow(/not a login name/);
  });

  it("the launcher sits in a root folder of its own; the home is in the agent files", () => {
    const p = osUserPaths(ROOT, "robin");
    expect(p).toEqual({
      dir: "/opt/den/robin",
      bin: "/opt/den/robin/bin",
      launcher: "/opt/den/robin/bin/den-agent-launch",
      agents: "/opt/den/robin/agents",
      home: "/opt/den/robin/home",
      sudoers: "/etc/sudoers.d/den-robin",
    });
  });
});

describe("issue 988 (pin 1): the sudoers rule", () => {
  const L = "/opt/den/robin/bin/den-agent-launch";
  const ok = { person: "robin", user: "den-agents-robin", launcher: L };

  it("runs the launcher as the agents user, with no password, and nothing else", () => {
    expect(sudoersLine(ok)).toBe(`robin ALL=(den-agents-robin) NOPASSWD: ${L}`);
    expect(sudoersRuleProblem(sudoersLine(ok), ok)).toBeNull();
  });

  it("refuses root, ALL, wildcards, arguments and extra lines", () => {
    const bad = [
      `robin ALL=(root) NOPASSWD: ${L}`,
      `robin ALL=(ALL) NOPASSWD: ${L}`,
      `robin ALL=(ALL:ALL) NOPASSWD: ${L}`,
      `robin ALL=(den-agents-robin:den-robin) NOPASSWD: ${L}`,
      `robin ALL=(den-agents-robin) NOPASSWD: ALL`,
      `robin ALL=(den-agents-robin) NOPASSWD: ${L} *`,
      `robin ALL=(den-agents-robin) NOPASSWD: ${L} scout`,
      `robin ALL=(den-agents-robin) NOPASSWD: /opt/den/robin/bin/*`,
      `robin ALL=(den-agents-robin) NOPASSWD: ${L}\nrobin ALL=(ALL) ALL`,
      `ALL ALL=(den-agents-robin) NOPASSWD: ${L}`,
      `robin ALL=(den-agents-robin) NOPASSWD: ${L}, /bin/sh`,
    ];
    for (const b of bad) expect(sudoersRuleProblem(b, ok)).not.toBeNull();
  });

  it("refuses to write a rule for a launcher path with a wildcard or space", () => {
    expect(() =>
      sudoersLine({ ...ok, launcher: "/opt/den/r*/launch" }),
    ).toThrow(/launcher/);
    expect(() => sudoersLine({ ...ok, launcher: "/opt/den r/launch" })).toThrow(
      /launcher/,
    );
  });
});

describe("issue 988 (pin 3): the launcher", () => {
  // A stand-in runtime: prints its argv and its environment.
  const fake = path.join(tmp, "runtime.sh");
  fs.writeFileSync(
    fake,
    'printf "ARGS"; for a in "$@"; do printf " [%s]" "$a"; done; printf "\\n"; env | sort\n',
  );
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  const script = path.join(tmp, "den-agent-launch");
  fs.writeFileSync(
    script,
    launcherScript({
      person: "robin",
      user: "den-agents-robin",
      home,
      runtime: { bin: "/bin/sh", script: fake },
    }),
  );
  const run = (...args: string[]) =>
    spawnSync("/bin/sh", [script, ...args], {
      encoding: "utf-8",
      env: { FOO: "bar", TERM: "xterm-256color", HOME: "/nope", PATH: "/x" },
    });

  it("execs the registered runtime with the agent id, and nothing else", () => {
    const r = run("scout");
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe("ARGS [agents] [session] [scout]");
  });

  it("scrubs the environment to its allowlist", () => {
    const env = run("scout")
      .stdout.split("\n")
      .slice(1)
      .filter(Boolean)
      .map((l) => l.slice(0, l.indexOf("=")))
      .filter((k) => k !== "PWD" && k !== "SHLVL" && k !== "_");
    expect(env.sort()).toEqual([...LAUNCH_ENV].sort());
    const out = run("scout").stdout;
    expect(out).not.toMatch(/^FOO=/m);
    expect(out).toMatch(new RegExp(`^HOME=${home}$`, "m"));
    expect(out).toMatch(/^USER=den-agents-robin$/m);
    expect(out).toMatch(/^DEN_AGENT_ID=scout$/m);
    expect(out).toMatch(/^TERM=xterm-256color$/m);
  });

  it("takes exactly one agent id, by Den's pattern", () => {
    const bad = [
      [],
      ["scout", "more"],
      [""],
      ["../x"],
      ["-x"],
      [".x"],
      ["a b"],
      ["a;id"],
      ["a$(id)"],
      ["a".repeat(65)],
    ];
    for (const args of bad) {
      const r = run(...args);
      expect(r.status).toBe(64);
      expect(r.stdout).not.toContain("ARGS");
    }
    expect(run("a".repeat(64)).status).toBe(0);
    expect(run("Scout.2_b-c").status).toBe(0);
  });

  it("a bad TERM is replaced, never passed through", () => {
    const r = spawnSync("/bin/sh", [script, "scout"], {
      encoding: "utf-8",
      env: { TERM: "x;rm -rf /" },
    });
    expect(r.stdout).toMatch(/^TERM=dumb$/m);
  });

  it("refuses to register a runtime path a shell could misread", () => {
    expect(() =>
      launcherScript({
        person: "robin",
        user: "den-agents-robin",
        home,
        runtime: { bin: "/bin/s'h", script: fake },
      }),
    ).toThrow(/runtime/);
    expect(() =>
      launcherScript({
        person: "robin",
        user: "den-agents-robin",
        home,
        runtime: { bin: "sh", script: fake },
      }),
    ).toThrow(/runtime/);
  });
});

/** Every argv a plan runs, as one line each. */
const lines = (steps: { argv: string[] }[]) =>
  steps.map((s) => s.argv.join(" "));

describe("issue 988 (pins 2 and 4): the setup", () => {
  const staged = { launcher: "LAUNCHER TEXT\n", sudoers: "RULE TEXT\n" };

  it("Linux: a system user with no login shell, its home in the agent files, never in a sudo group", () => {
    const l = lines(setupPlan(layout("linux"), staged));
    expect(l).toContain("groupadd --system den-robin");
    expect(l).toContain(
      "useradd --system --gid den-robin --home-dir /opt/den/robin/home --no-create-home --shell /usr/sbin/nologin den-agents-robin",
    );
    expect(l).toContain("usermod --append --groups den-robin robin");
    expect(l.join("\n")).not.toMatch(
      /\b(sudo|wheel|admin|root)\b.*den-agents-robin|den-agents-robin.*\b(sudo|wheel|admin)\b/,
    );
  });

  it("macOS: a hidden user with no login shell, its home in the agent files", () => {
    const l = lines(setupPlan(layout("darwin"), staged));
    expect(l).toContain(
      "dscl . -create /Users/_den_agents_robin UserShell /usr/bin/false",
    );
    expect(l).toContain(
      "dscl . -create /Users/_den_agents_robin NFSHomeDirectory /opt/den/robin/home",
    );
    expect(l).toContain("dscl . -create /Users/_den_agents_robin IsHidden 1");
    expect(l).toContain("dscl . -create /Users/_den_agents_robin Password *");
    expect(l).toContain("dseditgroup -o edit -a robin -t user _den_robin");
    expect(l.join("\n")).not.toMatch(
      /-a _den_agents_robin -t user (admin|wheel)/,
    );
  });

  for (const platform of ["linux", "darwin"] as const)
    it(`${platform}: root owns the launcher and every folder above it; the rule is checked before it is installed`, () => {
      const l = lines(setupPlan(layout(platform), staged));
      const grp = platform === "linux" ? "root" : "wheel";
      expect(l).toContain(
        `install -d -o root -g ${grp} -m 0755 /opt/den /opt/den/robin /opt/den/robin/bin`,
      );
      const L = "/opt/den/robin/bin/den-agent-launch";
      const S = "/etc/sudoers.d/den-robin";
      // Each goes to a .new file in a root-only folder, is read back,
      // (the rule) checked by visudo, then moved into place.
      for (const [dest, mode] of [
        [L, "0555"],
        [S, "0440"],
      ] as const) {
        const order = [
          `tee ${dest}.new`,
          `chown root:${grp} ${dest}.new`,
          `chmod ${mode} ${dest}.new`,
          `cat ${dest}.new`,
          `mv -f ${dest}.new ${dest}`,
          `cat ${dest}`,
        ].map((x) => l.indexOf(x));
        expect(order.every((i) => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
      }
      const visudo = l.indexOf(`visudo -c -f ${S}.new`);
      expect(visudo).toBeGreaterThan(l.indexOf(`cat ${S}.new`));
      expect(visudo).toBeLessThan(l.indexOf(`mv -f ${S}.new ${S}`));
      // The launcher goes in before the rule that lets it run.
      expect(l.indexOf(`mv -f ${L}.new ${L}`)).toBeLessThan(
        l.indexOf(`mv -f ${S}.new ${S}`),
      );
      const n = osUserNames(platform, "robin");
      expect(l).toContain(
        `install -d -o robin -g ${n.group} -m 3770 /opt/den/robin/agents`,
      );
      expect(l).toContain(
        `install -d -o ${n.user} -g ${n.group} -m 0700 /opt/den/robin/home`,
      );
      // Every step says what it does, for the person to read first.
      for (const s of setupPlan(layout(platform), staged))
        expect(s.say.length).toBeGreaterThan(10);
    });
});

describe("issue 988: root installs nothing from a file anyone else can write", () => {
  const text = { launcher: "LAUNCHER TEXT\n", sudoers: "RULE TEXT\n" };

  for (const platform of ["linux", "darwin"] as const)
    it(`${platform}: every path a root step names is in a root-only place; the texts come on stdin`, () => {
      const steps = setupPlan(layout(platform), text);
      const allowed = [
        /^\/opt\/den(\/|$)/,
        /^\/etc\/sudoers\.d\//,
        /^\/bin\/sh$/,
        /^\/usr\/sbin\/nologin$/,
        /^\/usr\/bin\/false$/,
        /^\/(Users|Groups)\//, // dscl record names
      ];
      for (const s of steps)
        for (const a of s.argv.slice(1))
          if (a.startsWith("/"))
            expect(allowed.some((r) => r.test(a)) ? "ok" : a).toBe("ok");
      const fed = steps.filter((s) => s.stdin !== undefined);
      expect(fed.map((s) => [s.argv.join(" "), s.stdin])).toEqual([
        ["tee /opt/den/robin/bin/den-agent-launch.new", text.launcher],
        ["tee /etc/sudoers.d/den-robin.new", text.sudoers],
      ]);
    });

  it("first, it refuses if any path it writes is a link (a re-run would follow it)", () => {
    const first = setupPlan(layout("linux"), text)[0]!;
    expect(first.argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(first.argv.slice(4)).toEqual(setupPaths(layout("linux")));
    for (const p of [
      "/opt/den",
      "/opt/den/robin",
      "/opt/den/robin/bin",
      "/opt/den/robin/home",
      "/opt/den/robin/agents",
      "/etc/sudoers.d/den-robin",
      "/etc/sudoers.d/den-robin.new",
    ])
      expect(setupPaths(layout("linux"))).toContain(p);
    // The check itself, on the real shell: a link fails it.
    const d = fs.mkdtempSync(path.join(tmp, "links-"));
    fs.mkdirSync(path.join(d, "real"));
    fs.symlinkSync(path.join(d, "real"), path.join(d, "home"));
    const sh = (...ps: string[]) =>
      spawnSync(first.argv[0]!, [first.argv[1]!, first.argv[2]!, "sh", ...ps], {
        encoding: "utf-8",
      });
    expect(sh(path.join(d, "real"), path.join(d, "none")).status).toBe(0);
    const r = sh(path.join(d, "real"), path.join(d, "home"));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("is a link");
  });

  it("the home is in root's folder, not in the agent files the group can write", () => {
    const p = osUserPaths(ROOT, "robin");
    expect(path.posix.dirname(p.home)).toBe(p.dir);
    expect(p.home.startsWith(p.agents)).toBe(false);
  });

  it("a re-run keeps the login and the group it made", () => {
    const again = lines(
      setupPlan(layout("linux"), text, { user: true, group: true }),
    ).join("\n");
    expect(again).not.toMatch(/useradd|groupadd/);
    expect(again).toMatch(/usermod --append --groups den-robin robin/);
    const mac = lines(
      setupPlan({ ...layout("darwin"), ids: undefined }, text, {
        user: true,
        group: true,
      }),
    ).join("\n");
    expect(mac).not.toMatch(/-create \/(Users|Groups)\//);
  });
});

describe("issue 988: runPlan", () => {
  /** A stand-in for root: files in a map; `tamper` changes one after it is written. */
  function machine(tamper?: { path: string; to: string }) {
    const files = new Map<string, string>();
    const ran: string[] = [];
    const run: PlanRunner = (argv, stdin) => {
      ran.push(argv.join(" "));
      const [cmd, a] = argv;
      if (cmd === "tee") {
        files.set(a!, stdin ?? "");
        if (tamper && tamper.path === a) files.set(a!, tamper.to);
        return { ok: true, stdout: stdin ?? "" };
      }
      if (cmd === "cat")
        return files.has(a!)
          ? { ok: true, stdout: files.get(a!)! }
          : { ok: false, error: "no such file" };
      if (cmd === "mv") {
        // mv -f <from> <to>
        const [from, to] = [argv[2]!, argv[3]!];
        files.set(to, files.get(from) ?? "");
        files.delete(from);
        return { ok: true };
      }
      if (cmd === "rm") {
        for (const f of argv.slice(2)) files.delete(f);
        return { ok: true };
      }
      return { ok: true };
    };
    return { run, files, ran };
  }
  const text = { launcher: "LAUNCHER TEXT\n", sudoers: "RULE TEXT\n" };
  const S = "/etc/sudoers.d/den-robin";
  const L = "/opt/den/robin/bin/den-agent-launch";

  it("as shown: everything goes in", () => {
    const m = machine();
    expect(runPlan(setupPlan(layout("linux"), text), m.run)).toEqual({
      ok: true,
    });
    expect(m.files.get(S)).toBe(text.sudoers);
    expect(m.files.get(L)).toBe(text.launcher);
  });

  it("a rule changed after it was written: it stops before the rule is in place, and removes it", () => {
    const m = machine({
      path: `${S}.new`,
      to: "robin ALL=(ALL) NOPASSWD: ALL\n",
    });
    const r = runPlan(setupPlan(layout("linux"), text), m.run);
    expect(r.ok).toBe(false);
    expect(m.files.has(S)).toBe(false);
    expect(m.files.has(`${S}.new`)).toBe(false);
    expect(m.ran.join("\n")).not.toMatch(/visudo|mv -f \/etc/);
    if (!r.ok) expect(r.error).toMatch(/not what was shown/);
  });

  it("a launcher changed after it was written: nothing goes in, the rule is never written", () => {
    const m = machine({ path: `${L}.new`, to: "#!/bin/sh\nexec /bin/sh\n" });
    expect(runPlan(setupPlan(layout("linux"), text), m.run).ok).toBe(false);
    expect(m.files.has(L)).toBe(false);
    expect(m.ran.join("\n")).not.toMatch(
      /^(tee|mv|chmod|chown|visudo)\b.*sudoers/m,
    );
  });
});

describe("issue 988 (pin 5): remove undoes everything setup makes", () => {
  for (const platform of ["linux", "darwin"] as const)
    it(`${platform}: the user, the group, the rule and the folder all go`, () => {
      const n = osUserNames(platform, "robin");
      const l = lines(removePlan(layout(platform))).join("\n");
      expect(l).toContain("rm -f /etc/sudoers.d/den-robin");
      expect(l).toContain("rm -rf /opt/den/robin");
      if (platform === "linux") {
        expect(l).toContain(`userdel ${n.user}`);
        expect(l).toContain(`groupdel ${n.group}`);
      } else {
        expect(l).toContain(`dscl . -delete /Users/${n.user}`);
        expect(l).toContain(`dscl . -delete /Groups/${n.group}`);
      }
      // The rule goes first, so no step after it can be run through it.
      expect(l.indexOf("rm -f /etc/sudoers.d/den-robin")).toBe(l.indexOf("rm"));
    });
});

/** Facts for a setup that is all as it should be (Linux). */
function goodFacts(): OsUserFacts {
  const L = "/opt/den/robin/bin/den-agent-launch";
  const lay = layout("linux");
  return {
    user: {
      exists: true,
      uid: 455,
      shell: "/usr/sbin/nologin",
      home: "/opt/den/robin/home",
      groups: ["den-robin"],
    },
    group: { exists: true, members: ["robin"] },
    personUid: 1000,
    sudoers: { uid: 0, mode: 0o100440 },
    personRules: [`(den-agents-robin) NOPASSWD: ${L}`],
    launcher: {
      uid: 0,
      mode: 0o100555,
      text: launcherScript({
        person: "robin",
        user: "den-agents-robin",
        home: "/opt/den/robin/home",
        runtime: lay.runtime,
      }),
    },
    launcherChain: [
      { path: "/opt/den/robin/bin", uid: 0, mode: 0o40755 },
      { path: "/opt/den/robin", uid: 0, mode: 0o40755 },
      { path: "/opt/den", uid: 0, mode: 0o40755 },
      { path: "/opt", uid: 0, mode: 0o40755 },
      { path: "/", uid: 0, mode: 0o40755 },
    ],
    agentsDir: { uid: 1000, mode: 0o43770 },
    homeDir: { uid: 455, mode: 0o40700 },
    stateDir: { uid: 1000, mode: 0o40700 },
    dir: true,
  };
}

const check = (on: boolean, f: OsUserFacts) =>
  osUserCheck({ on, layout: layout("linux") }, f);

describe("issue 988: doctor's check", () => {
  it("all as it should be: ok", () => {
    const r = check(true, goodFacts());
    expect(r.problems).toEqual([]);
    expect(r.status).toBe("ok");
  });

  it("not set up, and agents.os_login off: ok, says so", () => {
    const none: OsUserFacts = {
      user: { exists: false },
      group: { exists: false },
      personUid: 1000,
      sudoers: null,
      personRules: [],
      launcher: null,
      launcherChain: [],
      agentsDir: null,
      homeDir: null,
      stateDir: { uid: 1000, mode: 0o40700 },
      dir: false,
    };
    const r = check(false, none);
    expect(r.status).toBe("ok");
    expect(r.detail).toMatch(/not set up/);
    expect(check(true, none).status).toBe("fail");
  });

  it("pin 2: a launcher the person (or anyone but root) can change fails", () => {
    const f = goodFacts();
    expect(
      check(true, { ...f, launcher: { ...f.launcher!, uid: 1000 } }).status,
    ).toBe("fail");
    expect(
      check(true, { ...f, launcher: { ...f.launcher!, mode: 0o100775 } })
        .status,
    ).toBe("fail");
    expect(
      check(true, {
        ...f,
        launcher: { ...f.launcher!, text: f.launcher!.text + "id\n" },
      }).status,
    ).toBe("fail");
    const chain = f.launcherChain.map((c) => ({ ...c }));
    chain[2] = { ...chain[2]!, uid: 1000 };
    expect(
      check(true, { ...f, launcherChain: chain }).problems.join("\n"),
    ).toMatch(/\/opt\/den/);
    const chain2 = f.launcherChain.map((c) => ({ ...c }));
    chain2[3] = { ...chain2[3]!, mode: 0o40777 };
    expect(check(true, { ...f, launcherChain: chain2 }).status).toBe("fail");
  });

  it("pin 1: a rule wider than the launcher, or a loose rule file, fails", () => {
    const f = goodFacts();
    expect(
      check(true, { ...f, personRules: ["(den-agents-robin) NOPASSWD: ALL"] })
        .status,
    ).toBe("fail");
    expect(
      check(true, {
        ...f,
        personRules: [
          ...f.personRules!,
          "(den-agents-robin) NOPASSWD: /bin/sh",
        ],
      }).status,
    ).toBe("fail");
    expect(
      check(true, { ...f, sudoers: { uid: 0, mode: 0o100666 } }).status,
    ).toBe("fail");
    expect(check(true, { ...f, sudoers: null }).status).toBe("fail");
  });

  it("pin 4: sudo, a login shell or a home outside the agent files fails", () => {
    const f = goodFacts();
    for (const g of ["sudo", "wheel", "admin", "root"])
      expect(
        check(true, { ...f, user: { ...f.user, groups: ["den-robin", g] } })
          .status,
      ).toBe("fail");
    expect(
      check(true, { ...f, user: { ...f.user, shell: "/bin/bash" } }).status,
    ).toBe("fail");
    expect(
      check(true, { ...f, user: { ...f.user, home: "/home/den-agents-robin" } })
        .status,
    ).toBe("fail");
  });

  it("Den's state readable by anyone but the person fails", () => {
    const f = goodFacts();
    expect(
      check(true, {
        ...f,
        stateDir: { uid: 1000, mode: 0o40750 },
      }).problems.join("\n"),
    ).toMatch(/state/);
    expect(
      check(true, { ...f, stateDir: { uid: 1000, mode: 0o40711 } }).status,
    ).toBe("fail");
  });

  it("pin 5: after a remove, anything left behind fails and is named", () => {
    const left: OsUserFacts = {
      user: { exists: true, uid: 455 },
      group: { exists: false },
      personUid: 1000,
      sudoers: { uid: 0, mode: 0o100440 },
      personRules: [],
      launcher: null,
      launcherChain: [],
      agentsDir: null,
      homeDir: null,
      stateDir: { uid: 1000, mode: 0o40700 },
      dir: true,
    };
    const r = check(false, left);
    expect(r.status).toBe("fail");
    const p = r.problems.join("\n");
    expect(p).toMatch(/den-agents-robin/);
    expect(p).toMatch(/sudoers/);
    expect(p).toMatch(/\/opt\/den\/robin/);
  });
});

describe("issue 988: writableChain (the real folders)", () => {
  it("names each folder above a file that root doesn't own, or anyone else can write", () => {
    const d = path.join(tmp, "chain", "bin");
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, "launch");
    fs.writeFileSync(f, "#!/bin/sh\n");
    const chain = writableChain(f);
    expect(chain[0]!.path).toBe(fs.realpathSync(d));
    expect(chain[chain.length - 1]!.path).toBe("/");
    // This test runs as a person, so the temp folders aren't root's.
    expect(chain.some((c) => c.uid !== 0)).toBe(true);
  });
});
