import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  launcherScript,
  osUserCheck,
  readOsUserFacts,
  setupPlan,
  type OsUserFacts,
  type OsUserLayout,
} from "../../../src/shared/agents/os-user.js";
import {
  cmdOsUser,
  terminalConfirm,
  type OsUserCommandDeps,
} from "../../../src/ui/cli/os-user-command.js";
import {
  runAgentSession,
  type AgentSessionDeps,
} from "../../../src/shared/agents/os-user-session.js";
import {
  writeAgentLaunch,
  type AgentLaunchSpec,
} from "../../../src/shared/agents/os-user-launch-files.js";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "osr-")));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const LAYOUT: OsUserLayout = {
  platform: "linux",
  person: "robin",
  personHome: "/home/robin",
  root: "/opt/den",
  runtime: { bin: "/usr/local/bin/node", script: "/srv/den/dist/cli.js" },
  noLogin: "/usr/sbin/nologin",
};

function good(l: OsUserLayout = LAYOUT): OsUserFacts {
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
    personHome: { uid: 1000, mode: 0o40700, acl: [] },
    sudoers: { uid: 0, mode: 0o100440 },
    personRules: [
      "(den-agents-robin) NOPASSWD: /opt/den/robin/bin/den-agent-launch",
    ],
    launcher: {
      uid: 0,
      mode: 0o100555,
      text: launcherScript({
        person: "robin",
        user: "den-agents-robin",
        home: "/opt/den/robin/home",
        runtime: l.runtime,
      }),
    },
    launcherChain: [],
    agentsDir: { uid: 1000, mode: 0o42750 },
    homeDir: { uid: 455, mode: 0o40700 },
    stateDir: { uid: 1000, mode: 0o40700 },
    dir: true,
  };
}

const check = (f: OsUserFacts, l: OsUserLayout = LAYOUT) =>
  osUserCheck({ on: true, layout: l }, f);

describe("issue 988 review, must 1: the person's home", () => {
  it("a stand-in 0755 home with a 0644 dotfile: doctor fails and names the home", () => {
    const home = path.join(tmp, "home-open");
    fs.mkdirSync(home);
    fs.chmodSync(home, 0o755);
    fs.writeFileSync(path.join(home, ".zshenv"), "export X=1\n");
    fs.chmodSync(path.join(home, ".zshenv"), 0o644);
    const l = { ...LAYOUT, personHome: home };
    const f = readOsUserFacts(l, path.join(tmp, "state"), {
      exec: () => ({ status: 1, stdout: "" }),
      personUid: process.getuid!(),
      stat: (p) => {
        try {
          const s = fs.statSync(p);
          return { uid: s.uid, mode: s.mode };
        } catch {
          return null;
        }
      },
      read: () => null,
      chain: () => [],
    });
    expect((f.personHome?.mode ?? 0) & 0o777).toBe(0o755);
    const r = check({ ...good(l), personHome: f.personHome }, l);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain(home);
    expect(r.detail).toMatch(/0755/);
    expect(r.detail).toMatch(/0700/);
  });

  it("a closed home passes; any group or other bit fails", () => {
    expect(check(good()).status).toBe("ok");
    for (const mode of [0o40750, 0o40701, 0o40710, 0o40770])
      expect(
        check({ ...good(), personHome: { uid: 1000, mode, acl: [] } }).status,
      ).toBe("fail");
  });

  it("an ACL entry that lets anyone else in fails; a deny entry doesn't", () => {
    const acl = (e: string) => ({
      ...good(),
      personHome: { uid: 1000, mode: 0o40700, acl: [e] },
    });
    expect(check(acl("group:everyone deny delete")).status).toBe("ok");
    const r = check(acl("group:staff allow list,search"));
    expect(r.status).toBe("fail");
    expect(r.detail).toMatch(/group:staff allow list,search/);
  });

  it("a home it can't read fails", () => {
    expect(check({ ...good(), personHome: null }).status).toBe("fail");
  });

  it("setup closes an open home as a step it shows, and only when open", () => {
    const text = { launcher: "x", sudoers: "y" };
    const close = (f: number) =>
      setupPlan(LAYOUT, text, { user: false, group: false, homeMode: f })
        .map((s) => s.argv.join(" "))
        .filter((a) => a === "chmod 0700 /home/robin");
    expect(close(0o40755)).toHaveLength(1);
    expect(close(0o40700)).toHaveLength(0);
  });

  it("a runtime inside the person's home fails doctor, and setup refuses before asking", async () => {
    const inHome = {
      ...LAYOUT,
      runtime: {
        bin: "/usr/local/bin/node",
        script: "/home/robin/den/dist/cli.js",
      },
    };
    const r = check(good(inHome), inHome);
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("/home/robin/den/dist/cli.js");
    const { d, asked, ran, err } = rig({ layout: inHome });
    expect(await cmdOsUser(["setup"], d)).toBe(1);
    expect(asked).toEqual([]);
    expect(ran).toEqual([]);
    expect(err.join("\n")).toContain("/home/robin/den/dist/cli.js");
  });
});

describe("issue 988 review, must 2: nothing says agents run as the login yet", () => {
  it("doctor's ok says the login is set up and not in use", () => {
    const r = check(good());
    expect(r.status).toBe("ok");
    expect(r.detail).not.toMatch(/agents run as den-agents/);
    expect(r.detail).toMatch(/not in use yet/);
  });

  it("setup's lines never say agents run or will run as the login", async () => {
    const { d, out } = rig({ yes: true, facts: NONE });
    expect(await cmdOsUser(["setup"], d)).toBe(0);
    const all = out.join("\n");
    expect(all).not.toMatch(/[Aa]gents (will )?run as den-agents/);
    expect(all).toMatch(/not in use yet/);
  });
});

describe("issue 988 review, should 3: remove", () => {
  it("turns agents.os_login off only once nothing is left", async () => {
    const { d, set } = rig({ yes: true, facts: good(), fail: "userdel" });
    expect(await cmdOsUser(["remove"], d)).toBe(1);
    expect(set).toEqual([]);
  });

  it("all steps done and nothing left: off", async () => {
    const { d, set } = rig({ yes: true, facts: NONE });
    expect(await cmdOsUser(["remove"], d)).toBe(0);
    expect(set).toEqual([false]);
  });

  it("the real question asks only a terminal: a piped yes is a no", async () => {
    const asked: string[] = [];
    const piped = await terminalConfirm("Run?", {
      stdinIsTTY: false,
      stdoutIsTTY: true,
      ask: async (q) => {
        asked.push(q);
        return "y";
      },
    });
    expect(piped).toBe(false);
    expect(asked).toEqual([]);
    const typed = await terminalConfirm("Run?", {
      stdinIsTTY: true,
      stdoutIsTTY: true,
      ask: async () => "yes",
    });
    expect(typed).toBe(true);
  });
});

describe("issue 988 review, should 4: agents/ has no group write", () => {
  it("setup makes it 2750, and doctor fails 3770", () => {
    const steps = setupPlan(LAYOUT, { launcher: "x", sudoers: "y" })
      .map((s) => s.argv.join(" "))
      .filter((a) => a.endsWith(" /opt/den/robin/agents"));
    expect(steps.join("\n")).toContain("-m 2750 /opt/den/robin/agents");
    expect(steps.join("\n")).not.toContain("3770");
    expect(
      check({ ...good(), agentsDir: { uid: 1000, mode: 0o43770 } }).status,
    ).toBe("fail");
  });
});

describe("issue 988 review, should 5: whose launch files", () => {
  it("refuses when the files' owner is the login itself, or root", async () => {
    for (const personUid of [4242, 0]) {
      const errs: string[] = [];
      const d: AgentSessionDeps = {
        home: path.join(tmp, "s5", "home"),
        personUid,
        ownUid: 4242,
        readToken: async () => {
          throw new Error("no token should be read");
        },
        makeTmp: () => undefined,
        removeTmp: () => {},
        wrap: () => ({ applied: false, argv: [], env: {}, reason: "x" }),
        run: async () => 0,
        err: (m) => errs.push(m),
      };
      await expect(
        runAgentSession(["scout", "0123456789abcdef0123456789abcdef"], d),
      ).resolves.toBe(65);
      expect(errs.join("\n")).toMatch(/must be the person's/);
    }
  });
});

describe("issue 988 review, nit 6: a launch file's env", () => {
  it("refuses loader and node option names", () => {
    const agents = path.join(tmp, "n6");
    fs.mkdirSync(agents, { recursive: true });
    const spec = (env: Record<string, string>): AgentLaunchSpec => ({
      agentId: "scout",
      argv: ["/usr/local/bin/node"],
      cwd: "/srv/work",
      env,
    });
    for (const k of [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
    ])
      expect(() => writeAgentLaunch(agents, spec({ [k]: "x" }))).toThrow(
        new RegExp(k),
      );
    expect(() => writeAgentLaunch(agents, spec({ LANG: "C" }))).not.toThrow();
  });
});

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
    facts?: OsUserFacts;
    layout?: OsUserLayout;
  } = {},
) {
  const ran: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const set: boolean[] = [];
  const files = new Map<string, string>();
  const d: OsUserCommandDeps = {
    platform: "linux",
    env: {},
    layout: async () => o.layout ?? LAYOUT,
    confirm: async (q) => {
      asked.push(q);
      return o.yes ?? false;
    },
    sudo: (argv, stdin) => {
      ran.push(argv.join(" "));
      if (argv.join(" ").startsWith(o.fail ?? "\0"))
        return { ok: false, error: "no such thing" };
      const [cmd, a] = argv;
      if (cmd === "tee") files.set(a!, stdin ?? "");
      if (cmd === "cat")
        return files.has(a!)
          ? { ok: true, stdout: files.get(a!)! }
          : { ok: false, error: "no such file" };
      if (cmd === "mv") {
        files.set(argv[3]!, files.get(argv[2]!) ?? "");
        files.delete(argv[2]!);
      }
      return { ok: true, stdout: "" };
    },
    facts: () => o.facts ?? NONE,
    setOn: (on) => set.push(on),
    on: () => set.at(-1) ?? false,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cli: "den",
  };
  return { d, ran, out, err, asked, set };
}
