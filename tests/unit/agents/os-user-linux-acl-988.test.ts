import { describe, expect, it } from "@jest/globals";
import {
  aclLetsAgentsWrite,
  getfaclEntries,
  homeProblems,
  OS_LOGIN_OWED,
  osUserCheck,
  readOsUserFacts,
  type OsUserFacts,
  type OsUserLayout,
} from "../../../src/shared/agents/os-user.js";

const LAYOUT: OsUserLayout = {
  platform: "linux",
  person: "robin",
  personHome: "/home/robin",
  root: "/opt/den",
  runtime: { bin: "/usr/local/bin/node", script: "/srv/den/dist/cli.js" },
  noLogin: "/usr/sbin/nologin",
};

const facts = (home: OsUserFacts["personHome"]): OsUserFacts => ({
  user: { exists: true },
  group: { exists: false },
  personUid: 1000,
  personHome: home,
  sudoers: null,
  personRules: [],
  launcher: null,
  launcherChain: [],
  agentsDir: null,
  homeDir: null,
  stateDir: { uid: 1000, mode: 0o40700 },
  dir: false,
});

const said = (home: OsUserFacts["personHome"]) =>
  homeProblems(LAYOUT, facts(home)).join("\n");

const home = (
  acl: string[],
  more: Partial<NonNullable<OsUserFacts["personHome"]>> = {},
) => ({ uid: 1000, mode: 0o40700, acl, parents: [], ...more });

describe("issue 988: getfacl output is read per entry, effective rights first", () => {
  it("drops comments and blank lines, and uses the #effective rights", () => {
    const out = [
      "# file: /home/robin",
      "user::rwx",
      "user:bob:rwx\t\t\t#effective:r-x",
      "group::---",
      "group:staff:rwx\t#effective:---",
      "mask::r-x",
      "other::---",
      "default:user:bob:rwx",
      "",
    ].join("\n");
    expect(getfaclEntries(out)).toEqual([
      "user::rwx",
      "user:bob:r-x",
      "group::---",
      "group:staff:---",
      "mask::r-x",
      "other::---",
      "default:user:bob:rwx",
    ]);
  });
});

describe("issue 988: an access list on the Linux home that lets someone else in fails", () => {
  it("a named user or group with any right is named; the person, base entries and --- aren't", () => {
    for (const e of ["user:bob:r--", "group:staff:--x", "default:user:bob:rwx"])
      expect([e, said(home([e]))]).toEqual([e, expect.stringContaining(e)]);
    expect(
      said(
        home([
          "user::rwx",
          "user:robin:rwx",
          "group::---",
          "group:staff:---",
          "mask::---",
          "other::---",
          "default:other::---",
        ]),
      ),
    ).toBe("");
  });

  it("an entry it can't read counts", () => {
    expect(said(home(["weird entry"]))).toContain("weird entry");
  });

  it("access lists it couldn't read fail", () => {
    expect(said(home([], { aclUnread: true }))).toMatch(
      /access lists on your home \/home\/robin couldn't be read/,
    );
  });

  it("a folder above the home: a named entry that can write fails, read-only doesn't; unread fails", () => {
    const parent = (acl: string[], unread = false) =>
      said(home([], { parents: [{ path: "/home", acl, unread }] }));
    expect(parent(["group:den-robin:rwx"])).toContain("/home");
    expect(parent(["default:user:bob:-w-"])).toContain("/home");
    expect(parent(["user:bob:r-x", "group::rwx", "other::r-x"])).toBe("");
    expect(parent([], true)).toContain("/home");
    expect(parent(["nonsense"])).toContain("/home");
  });
});

describe("issue 988: the Linux facts read ls -ld, then getfacl when it shows +", () => {
  const ls = (p: string, plus: boolean) =>
    `drwx------${plus ? "+" : ""} 2 robin robin 4096 Nov 27 19:00 ${p}\n`;
  const read = (exec: (cmd: string, args: string[]) => string | null) =>
    readOsUserFacts(LAYOUT, "/home/robin/.local/state/den", {
      exec: (cmd, args) => {
        const out = exec(cmd, args);
        return out === null
          ? { status: 1, stdout: "" }
          : { status: 0, stdout: out };
      },
      personUid: 1000,
      stat: (p) => (p === "/home/robin" ? { uid: 1000, mode: 0o40700 } : null),
      read: () => null,
      chain: () => [],
    }).personHome;

  it("the home with + is read with getfacl, and each folder above it with ls", () => {
    const asked: string[] = [];
    const h = read((cmd, args) => {
      const p = args[args.length - 1]!;
      asked.push(`${cmd} ${p}`);
      if (cmd === "ls") return ls(p, p === "/home/robin");
      if (cmd === "getfacl" && p === "/home/robin")
        return "user::rwx\nuser:bob:r-x\ngroup::---\nmask::r-x\nother::---\n";
      return null;
    });
    expect(h?.acl).toEqual([
      "user::rwx",
      "user:bob:r-x",
      "group::---",
      "mask::r-x",
      "other::---",
    ]);
    expect(h?.aclUnread).toBeFalsy();
    expect(h?.parents).toEqual([
      { path: "/home", acl: [], unread: false },
      { path: "/", acl: [], unread: false },
    ]);
    expect(asked).not.toContain("getfacl /home");
  });

  it("ls that fails, or getfacl that fails on a +, is unread", () => {
    const noLs = read(() => null);
    expect(noLs?.aclUnread).toBe(true);
    expect(noLs?.parents?.every((x) => x.unread)).toBe(true);
    const noGetfacl = read((cmd, args) =>
      cmd === "ls" ? ls(args[args.length - 1]!, true) : null,
    );
    expect(noGetfacl?.aclUnread).toBe(true);
  });

  it("an SELinux dot is no access list", () => {
    const h = read((cmd, args) =>
      cmd === "ls"
        ? `drwx------. 2 robin robin 4096 Nov 27 19:00 ${args[args.length - 1]}\n`
        : null,
    );
    expect(h?.aclUnread).toBe(false);
    expect(h?.acl).toEqual([]);
  });
});

describe("issue 988 review low: a principal is read up to the last allow or deny", () => {
  it('a name holding " allow " doesn\'t hide a write right', () => {
    const WHO = { name: "_denagents", groupNames: ["_denagents"] };
    expect(aclLetsAgentsWrite("group:a allow read x allow write", WHO)).toBe(
      true,
    );
    expect(
      aclLetsAgentsWrite("group:_denagents inherited allow write", WHO),
    ).toBe(true);
    expect(aclLetsAgentsWrite("user:other inherited allow write", WHO)).toBe(
      false,
    );
  });
});

describe("issue 988: the Linux home's access lists leave the owed list", () => {
  it("OS_LOGIN_OWED no longer lists them, and lists every gap still known", () => {
    expect(OS_LOGIN_OWED.join("\n")).not.toMatch(/Linux access lists/);
    expect([...OS_LOGIN_OWED]).toEqual([
      "a sandbox policy for the agents' login",
      "own/ files read without following links (O_NOFOLLOW)",
      "the Linux end-to-end run as root in CI",
      "the sign-in token passed by file handle, not the environment",
      "access lists on the folders above the person's home on macOS",
    ]);
  });
});

describe("issue 988 review low: a name holding deny doesn't hide an allow entry", () => {
  it('"user:deny allow read" on the logs folder is named', () => {
    const f: OsUserFacts = {
      ...facts(home([])),
      logsDir: {
        path: "/home/robin/.local/state/den/logs",
        uid: 1000,
        mode: 0o40700,
        acl: ["user:deny allow read"],
      },
    };
    expect(
      osUserCheck({ on: true, layout: LAYOUT }, f).problems.join("\n"),
    ).toContain("user:deny allow read");
  });
});
