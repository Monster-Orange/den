/**
 * Issue 988, part 1: `agents os-user setup | remove | check`, and the
 * facts doctor reads from the machine. The commands run through stand-ins:
 * nothing here calls sudo or changes the machine.
 *
 *   setup   shows every step, asks, then runs each with sudo; a failure
 *           stops it. Sets agents.os_user: on.
 *   remove  asks, runs each step (gone already is fine), sets
 *           agents.os_user: off, then checks nothing is left (pin 5).
 *   check   doctor's row.
 *
 * All three are a person's: an agent's session is refused.
 *
 * Invented names.
 */
import { describe, expect, it } from "@jest/globals";
import {
  cmdOsUser,
  osUserDoctorRow,
  type OsUserCommandDeps,
} from "../../../src/ui/cli/os-user-command.js";
import {
  readOsUserFacts,
  type OsUserFacts,
  type OsUserLayout,
} from "../../../src/shared/agents/os-user.js";
import { osUserSetting } from "../../../src/shared/den-config.js";

const LAYOUT: OsUserLayout = {
  platform: "linux",
  person: "robin",
  root: "/opt/den",
  runtime: { bin: "/usr/local/bin/node", script: "/srv/den/dist/cli.js" },
  noLogin: "/usr/sbin/nologin",
};

const NONE: OsUserFacts = {
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

function rig(
  o: {
    yes?: boolean;
    fail?: string;
    env?: NodeJS.ProcessEnv;
    facts?: OsUserFacts;
    platform?: NodeJS.Platform;
  } = {},
) {
  const ran: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const set: boolean[] = [];
  const staged: Record<string, string> = {};
  const d: OsUserCommandDeps = {
    platform: o.platform ?? "linux",
    env: o.env ?? {},
    layout: async () => LAYOUT,
    stage: (files) => {
      Object.assign(staged, files);
      return { launcher: "/tmp/st/launch", sudoers: "/tmp/st/sudoers" };
    },
    confirm: async (q) => {
      asked.push(q);
      // Everything was shown before the question.
      asked.push(`shown:${out.length}`);
      return o.yes ?? false;
    },
    sudo: (argv) => {
      ran.push(argv.join(" "));
      return argv.join(" ").startsWith(o.fail ?? "\0")
        ? { ok: false, error: "no such thing" }
        : { ok: true };
    },
    facts: () => o.facts ?? NONE,
    setOn: (on) => set.push(on),
    on: () => set.at(-1) ?? false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cli: "den",
  };
  return { d, ran, out, err, asked, set, staged };
}

describe("issue 988: agents os-user setup", () => {
  it("shows every step and its command before asking; no means nothing runs", async () => {
    const r = rig({ yes: false });
    expect(await cmdOsUser(["setup"], r.d)).toBe(1);
    expect(r.ran).toEqual([]);
    const shown = r.out.join("\n");
    expect(shown).toMatch(/useradd --system/);
    expect(shown).toMatch(/visudo -c -f/);
    expect(shown).toMatch(/NOPASSWD/);
    expect(Number(r.asked[1]!.slice(6))).toBeGreaterThan(5);
    expect(r.set).toEqual([]);
  });

  it("yes: runs each step with sudo, in order, and turns agents.os_user on", async () => {
    const r = rig({ yes: true });
    expect(await cmdOsUser(["setup"], r.d)).toBe(0);
    expect(r.ran[0]).toBe("groupadd --system den-robin");
    expect(r.ran.at(-1)).toBe(
      "install -o root -g root -m 0440 /tmp/st/sudoers /etc/sudoers.d/den-robin",
    );
    expect(r.staged.sudoers).toBe(
      "robin ALL=(den-agents-robin) NOPASSWD: /opt/den/robin/bin/den-agent-launch\n",
    );
    expect(r.staged.launcher).toMatch(/^#!\/bin\/sh/);
    expect(r.set).toEqual([true]);
  });

  it("a failed step stops it, says which, and leaves agents.os_user as it was", async () => {
    const r = rig({ yes: true, fail: "visudo" });
    expect(await cmdOsUser(["setup"], r.d)).toBe(1);
    expect(r.ran.at(-1)).toMatch(/^visudo/);
    expect(r.ran.join("\n")).not.toMatch(/sudoers\.d/);
    expect(r.err.join("\n")).toMatch(/visudo/);
    expect(r.err.join("\n")).toMatch(/remove/);
    expect(r.set).toEqual([]);
  });

  it("an agent's session is refused, and nothing is shown or run", async () => {
    for (const env of [
      { DEN_ACTOR_TOKEN_FILE: "/x" },
      { DEN_ACTOR_TOKEN: "x" },
      { DEN_AGENT_SANDBOX: "1" },
    ]) {
      const r = rig({ yes: true, env });
      expect(await cmdOsUser(["setup"], r.d)).toBe(1);
      expect(r.ran).toEqual([]);
      expect(r.asked).toEqual([]);
      expect(r.err.join("\n")).toMatch(/only a person/i);
    }
  });

  it("Windows: says it isn't there, runs nothing", async () => {
    const r = rig({ yes: true, platform: "win32" });
    expect(await cmdOsUser(["setup"], r.d)).toBe(1);
    expect(r.ran).toEqual([]);
    expect(r.err.join("\n")).toMatch(/macOS and Linux/);
  });
});

describe("issue 988 (pin 5): agents os-user remove", () => {
  it("runs every step (gone already is fine), turns it off, and checks nothing is left", async () => {
    const r = rig({ yes: true, fail: "userdel" });
    expect(await cmdOsUser(["remove"], r.d)).toBe(0);
    expect(r.ran[0]).toBe("rm -f /etc/sudoers.d/den-robin");
    expect(r.ran).toContain("groupdel den-robin");
    expect(r.set).toEqual([false]);
    expect(r.out.join("\n")).toMatch(/nothing is left/i);
  });

  it("anything left behind is named, and it exits 1", async () => {
    const r = rig({
      yes: true,
      facts: { ...NONE, user: { exists: true, uid: 455 } },
    });
    expect(await cmdOsUser(["remove"], r.d)).toBe(1);
    expect(r.err.join("\n")).toMatch(/den-agents-robin/);
  });

  it("no means nothing runs", async () => {
    const r = rig({ yes: false });
    expect(await cmdOsUser(["remove"], r.d)).toBe(1);
    expect(r.ran).toEqual([]);
  });
});

describe("issue 988: agents os-user check", () => {
  it("prints doctor's row; off and not set up is fine", async () => {
    const r = rig();
    expect(await cmdOsUser(["check"], r.d)).toBe(0);
    expect(r.out.join("\n")).toMatch(/not set up/);
  });
});

describe("issue 988: agents.os_user in user.yml", () => {
  it("on or off (true, false); unset is off; anything else is an error", () => {
    expect(osUserSetting(undefined)).toBe(false);
    expect(osUserSetting({})).toBe(false);
    expect(osUserSetting({ os_user: "on" })).toBe(true);
    expect(osUserSetting({ os_user: true })).toBe(true);
    expect(osUserSetting({ os_user: "off" })).toBe(false);
    expect(osUserSetting({ os_user: false })).toBe(false);
    expect(() => osUserSetting({ os_user: "required" })).toThrow(
      /agents\.os_user/,
    );
  });
});

describe("issue 988: readOsUserFacts reads the machine", () => {
  type Exec = (
    cmd: string,
    args: string[],
  ) => { status: number; stdout: string };
  const statOf =
    (m: Record<string, { uid: number; mode: number }>) => (p: string) =>
      m[p] ?? null;

  it("Linux: getent, id and sudo -n -l", () => {
    const exec: Exec = (cmd, args) => {
      const k = [cmd, ...args].join(" ");
      const answers: Record<string, string> = {
        "getent passwd den-agents-robin":
          "den-agents-robin:x:455:455::/opt/den/robin/agents/home:/usr/sbin/nologin\n",
        "id -Gn den-agents-robin": "den-robin\n",
        "getent group den-robin": "den-robin:x:455:robin,kit\n",
        "sudo -n -l":
          "User robin may run the following commands on box:\n    (ALL) ALL\n    (den-agents-robin) NOPASSWD: /opt/den/robin/bin/den-agent-launch\n",
      };
      return k in answers
        ? { status: 0, stdout: answers[k]! }
        : { status: 2, stdout: "" };
    };
    const f = readOsUserFacts(LAYOUT, "/home/robin/.den/state", {
      exec,
      personUid: 1000,
      stat: statOf({
        "/etc/sudoers.d/den-robin": { uid: 0, mode: 0o100440 },
        "/home/robin/.den/state": { uid: 1000, mode: 0o40700 },
      }),
      read: () => null,
      chain: () => [],
    });
    expect(f.user).toEqual({
      exists: true,
      uid: 455,
      shell: "/usr/sbin/nologin",
      home: "/opt/den/robin/agents/home",
      groups: ["den-robin"],
    });
    expect(f.group).toEqual({ exists: true, members: ["robin", "kit"] });
    expect(f.personRules).toEqual([
      "(den-agents-robin) NOPASSWD: /opt/den/robin/bin/den-agent-launch",
    ]);
    expect(f.sudoers).toEqual({ uid: 0, mode: 0o100440 });
    expect(f.launcher).toBeNull();
    expect(f.dir).toBe(false);
  });

  it("macOS: dscl", () => {
    const exec: Exec = (cmd, args) => {
      const k = [cmd, ...args].join(" ");
      const answers: Record<string, string> = {
        "dscl . -read /Users/_den_agents_robin UniqueID UserShell NFSHomeDirectory":
          "NFSHomeDirectory: /opt/den/robin/agents/home\nUniqueID: 455\nUserShell: /usr/bin/false\n",
        "id -Gn _den_agents_robin": "_den_robin everyone\n",
        "dscl . -read /Groups/_den_robin GroupMembership":
          "GroupMembership: robin\n",
      };
      return k in answers
        ? { status: 0, stdout: answers[k]! }
        : { status: 1, stdout: "" };
    };
    const f = readOsUserFacts(
      { ...LAYOUT, platform: "darwin", noLogin: "/usr/bin/false" },
      "/Users/robin/.den/state",
      {
        exec,
        personUid: 501,
        stat: () => null,
        read: () => null,
        chain: () => [],
      },
    );
    expect(f.user).toEqual({
      exists: true,
      uid: 455,
      shell: "/usr/bin/false",
      home: "/opt/den/robin/agents/home",
      groups: ["_den_robin", "everyone"],
    });
    expect(f.group).toEqual({ exists: true, members: ["robin"] });
    // sudo -n -l asked for a password: not known.
    expect(f.personRules).toBeNull();
  });

  it("nothing there: nothing exists", () => {
    const f = readOsUserFacts(LAYOUT, "/s", {
      exec: () => ({ status: 2, stdout: "" }),
      personUid: 1000,
      stat: () => null,
      read: () => null,
      chain: () => [],
    });
    expect(f.user.exists).toBe(false);
    expect(f.group.exists).toBe(false);
    expect(f.sudoers).toBeNull();
    expect(f.dir).toBe(false);
  });
});

describe("issue 988: doctor's row", () => {
  it("Windows: no row", () => {
    expect(
      osUserDoctorRow("den", {
        platform: "win32",
        facts: () => NONE,
        on: () => false,
      }),
    ).toBeNull();
  });

  it("off and not set up: a quiet ✓, no problem", () => {
    const r = osUserDoctorRow("den", {
      platform: "linux",
      facts: () => NONE,
      on: () => false,
    });
    expect(r?.problem).toBe(false);
    expect(r?.line).toMatch(/^✓ Agents' own login: .*not set up/);
    expect(r?.check.id).toBe("agents-os-user");
  });

  it("left behind: ✗, with remove as the fix; on and missing: setup", () => {
    const left = osUserDoctorRow("den", {
      platform: "linux",
      facts: () => ({ ...NONE, dir: true }),
      on: () => false,
    });
    expect(left?.problem).toBe(true);
    expect(left?.check.fix).toBe("den agents os-user remove");
    const missing = osUserDoctorRow("den", {
      platform: "linux",
      facts: () => NONE,
      on: () => true,
    });
    expect(missing?.check.fix).toBe("den agents os-user setup");
  });
});
