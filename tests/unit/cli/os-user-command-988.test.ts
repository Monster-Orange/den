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
  personHome: "/home/robin",
  root: "/opt/den",
  runtime: { bin: "/usr/local/bin/node", script: "/srv/den/dist/cli.js" },
  noLogin: "/usr/sbin/nologin",
};

const NONE: OsUserFacts = {
  user: { exists: false },
  group: { exists: false },
  personUid: 1000,
  personHome: { uid: 1000, mode: 0o40700, acl: [] },
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
    tamper?: { path: string; to: string };
    platform?: NodeJS.Platform;
  } = {},
) {
  const ran: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const set: boolean[] = [];
  const files = new Map<string, string>();
  const d: OsUserCommandDeps = {
    platform: o.platform ?? "linux",
    env: o.env ?? {},
    layout: async () => LAYOUT,
    confirm: async (q) => {
      asked.push(q);
      asked.push(`shown:${out.length}`);
      return o.yes ?? false;
    },
    sudo: (argv, stdin) => {
      ran.push(argv.join(" "));
      if (argv.join(" ").startsWith(o.fail ?? "\0"))
        return { ok: false, error: "no such thing" };
      const [cmd, a] = argv;
      if (cmd === "tee") {
        files.set(a!, stdin ?? "");
        if (o.tamper?.path === a) files.set(a!, o.tamper.to);
      }
      if (cmd === "cat")
        return files.has(a!)
          ? { ok: true, stdout: files.get(a!)! }
          : { ok: false, error: "no such file" };
      if (cmd === "mv") {
        files.set(argv[3]!, files.get(argv[2]!) ?? "");
        files.delete(argv[2]!);
      }
      if (cmd === "rm") for (const f of argv.slice(2)) files.delete(f);
      return { ok: true, stdout: "" };
    },
    facts: () => o.facts ?? NONE,
    setOn: (on) => set.push(on),
    on: () => set.at(-1) ?? false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cli: "den",
  };
  return { d, ran, out, err, asked, set, files };
}

describe("issue 988: agents os-login setup", () => {
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

  it("yes: runs each step with sudo, in order, and turns agents.os_login on", async () => {
    const r = rig({ yes: true });
    expect(await cmdOsUser(["setup"], r.d)).toBe(0);
    expect(r.ran[0]).toMatch(/^\/bin\/sh -c .*is a link/);
    expect(r.ran[1]).toBe("groupadd --system den-robin");
    expect(r.ran.at(-1)).toBe("cat /etc/sudoers.d/den-robin");
    expect(r.files.get("/etc/sudoers.d/den-robin")).toBe(
      "robin ALL=(den-agents-robin) NOPASSWD: /opt/den/robin/bin/den-agent-launch\n",
    );
    expect(r.files.get("/opt/den/robin/bin/den-agent-launch")).toMatch(
      /^#!\/bin\/sh/,
    );
    expect(r.set).toEqual([true]);
  });

  it("Den's runtime the login could change: setup refuses before it asks, and runs nothing", async () => {
    const r = rig({
      yes: true,
      facts: { ...NONE, runtime: ["/opt/node is 0777: anyone can change it"] },
    });
    expect(await cmdOsUser(["setup"], r.d)).toBe(1);
    expect(r.ran).toEqual([]);
    expect(r.asked).toEqual([]);
    expect(r.err.join("\n")).toContain("/opt/node is 0777");
    expect(r.set).toEqual([]);
  });

  it("a failed step stops it, says which, and leaves agents.os_login as it was", async () => {
    const r = rig({ yes: true, fail: "visudo" });
    expect(await cmdOsUser(["setup"], r.d)).toBe(1);
    expect(r.ran.at(-2)).toMatch(/^visudo/);
    expect(r.ran.at(-1)).toBe("rm -f /etc/sudoers.d/den-robin.new");
    expect(r.files.has("/etc/sudoers.d/den-robin")).toBe(false);
    expect(r.files.has("/etc/sudoers.d/den-robin.new")).toBe(false);
    expect(r.err.join("\n")).toMatch(/visudo/);
    expect(r.err.join("\n")).toMatch(/remove/);
    expect(r.set).toEqual([]);
  });

  it("shows the launcher's text and the rule from Den itself, never a file path to go and read", async () => {
    const r = rig({ yes: false });
    await cmdOsUser(["setup"], r.d);
    const shown = r.out.join("\n");
    expect(shown).toMatch(/^ {2}\| #!\/bin\/sh$/m);
    expect(shown).toMatch(/^ {2}\| exec \/usr\/bin\/env -i /m);
    expect(shown).toContain(
      "robin ALL=(den-agents-robin) NOPASSWD: /opt/den/robin/bin/den-agent-launch",
    );
    expect(shown).not.toMatch(/\/tmp\/|\/var\/folders\//);
  });

  it("a same-login process changes the rule between the yes and the install: setup refuses, and installs no rule", async () => {
    const r = rig({
      yes: true,
      tamper: {
        path: "/etc/sudoers.d/den-robin.new",
        to: "robin ALL=(ALL) NOPASSWD: ALL\n",
      },
    });
    expect(await cmdOsUser(["setup"], r.d)).toBe(1);
    expect(r.files.has("/etc/sudoers.d/den-robin")).toBe(false);
    expect(r.files.has("/etc/sudoers.d/den-robin.new")).toBe(false);
    expect(r.err.join("\n")).toMatch(/not what was shown/);
    expect(r.set).toEqual([]);
  });

  it("the same for the launcher: nothing of it stays, and the rule is never written", async () => {
    const r = rig({
      yes: true,
      tamper: {
        path: "/opt/den/robin/bin/den-agent-launch.new",
        to: "#!/bin/sh\nexec /bin/sh\n",
      },
    });
    expect(await cmdOsUser(["setup"], r.d)).toBe(1);
    expect(r.files.has("/opt/den/robin/bin/den-agent-launch")).toBe(false);
    expect(r.files.has("/opt/den/robin/bin/den-agent-launch.new")).toBe(false);
    expect(r.ran.join("\n")).not.toMatch(
      /^(tee|mv|chmod|chown|visudo)\b.*sudoers/m,
    );
  });

  it("a re-run keeps the login and the group", async () => {
    const r = rig({
      yes: true,
      facts: {
        ...NONE,
        user: { exists: true, uid: 455 },
        group: { exists: true },
      },
    });
    expect(await cmdOsUser(["setup"], r.d)).toBe(0);
    expect(r.ran.join("\n")).not.toMatch(/useradd|groupadd/);
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

describe("issue 988 (pin 5): agents os-login remove", () => {
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

describe("issue 988: agents os-login check", () => {
  it("prints doctor's row; off and not set up is fine", async () => {
    const r = rig();
    expect(await cmdOsUser(["check"], r.d)).toBe(0);
    expect(r.out.join("\n")).toMatch(/not set up/);
  });
});

describe("issue 988: agents.os_login in user.yml", () => {
  it("on or off (true, false); unset is off; anything else is an error", () => {
    expect(osUserSetting(undefined)).toBe(false);
    expect(osUserSetting({})).toBe(false);
    expect(osUserSetting({ os_login: "on" })).toBe(true);
    expect(osUserSetting({ os_login: true })).toBe(true);
    expect(osUserSetting({ os_login: "off" })).toBe(false);
    expect(osUserSetting({ os_login: false })).toBe(false);
    expect(() => osUserSetting({ os_login: "required" })).toThrow(
      /agents\.os_login/,
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
    expect(r?.check.id).toBe("agents-os-login");
  });

  it("left behind: ✗, with remove as the fix; on and missing: setup", () => {
    const left = osUserDoctorRow("den", {
      platform: "linux",
      facts: () => ({ ...NONE, dir: true }),
      on: () => false,
    });
    expect(left?.problem).toBe(true);
    expect(left?.check.fix).toBe("den agents os-login remove");
    const missing = osUserDoctorRow("den", {
      platform: "linux",
      facts: () => NONE,
      on: () => true,
    });
    expect(missing?.check.fix).toBe("den agents os-login setup");
  });
});
