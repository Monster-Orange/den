import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  OS_LOGIN_OWED,
  osUserCheck,
  readOsUserFacts,
  type OsUserFacts,
  type OsUserLayout,
} from "../../../src/shared/agents/os-user.js";
import {
  makeLogsPrivate,
  rotateIfOversized,
} from "../../../src/shared/process/log-rotation.js";
import { spawnDaemon } from "../../../src/shared/process/spawn-streaming.js";

const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-os-user-logs-988-")),
);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mode = (p: string) => fs.lstatSync(p).mode & 0o777;

function runOnce(log: string): Promise<void> {
  return new Promise((resolve) => {
    const tail = spawnDaemon(
      "echo hi",
      process.env,
      log,
      () => {},
      () => {},
      tmp,
      () => {
        tail.kill();
        resolve();
      },
    );
  });
}

describe("issue 988: service logs are private to the person's login", () => {
  it("a new service log is 0600 in a 0700 folder", async () => {
    const log = path.join(tmp, "new", "logs", "repo", "svc.log");
    await runOnce(log);
    expect(mode(log)).toBe(0o600);
    expect(mode(path.dirname(log))).toBe(0o700);
  });

  it("an old 0644 log is made 0600 when a service starts", async () => {
    const log = path.join(tmp, "old", "svc.log");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, "before\n");
    fs.chmodSync(log, 0o644);
    await runOnce(log);
    expect(mode(log)).toBe(0o600);
  });

  it("the rotated copy is 0600, even over an old 0644 one", () => {
    const log = path.join(tmp, "rot", "svc.log");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, "x\n".repeat(200), { mode: 0o600 });
    fs.writeFileSync(`${log}.1`, "old\n");
    fs.chmodSync(`${log}.1`, 0o644);
    expect(rotateIfOversized(log, 100, 50)).toBe(true);
    expect(mode(`${log}.1`)).toBe(0o600);
  });

  it("at start every folder under the logs is made 0700 and every file 0600; links are left alone", () => {
    const root = path.join(tmp, "start", "logs");
    const outside = path.join(tmp, "start", "outside.txt");
    fs.mkdirSync(path.join(root, "repo", "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "server.log"), "");
    fs.writeFileSync(path.join(root, "repo", "svc.log"), "");
    fs.writeFileSync(path.join(root, "repo", "svc.log.1"), "");
    fs.writeFileSync(path.join(root, "repo", "deep", "x.log"), "");
    fs.writeFileSync(outside, "");
    fs.chmodSync(outside, 0o644);
    fs.symlinkSync(outside, path.join(root, "repo", "link.log"));
    for (const d of [
      root,
      path.join(root, "repo"),
      path.join(root, "repo", "deep"),
    ])
      fs.chmodSync(d, 0o755);
    for (const f of [
      "server.log",
      "repo/svc.log",
      "repo/svc.log.1",
      "repo/deep/x.log",
    ])
      fs.chmodSync(path.join(root, f), 0o644);

    makeLogsPrivate(root);

    for (const d of [
      root,
      path.join(root, "repo"),
      path.join(root, "repo", "deep"),
    ])
      expect([d, mode(d)]).toEqual([d, 0o700]);
    for (const f of [
      "server.log",
      "repo/svc.log",
      "repo/svc.log.1",
      "repo/deep/x.log",
    ])
      expect([f, mode(path.join(root, f))]).toEqual([f, 0o600]);
    expect(mode(outside)).toBe(0o644);
  });

  it("no logs folder yet is fine", () => {
    expect(() => makeLogsPrivate(path.join(tmp, "none", "logs"))).not.toThrow();
  });
});

const LAYOUT: OsUserLayout = {
  platform: "darwin",
  person: "robin",
  personHome: "/Users/robin",
  root: "/opt/den",
  runtime: { bin: "/usr/local/bin/node", script: "/srv/den/dist/cli.js" },
  noLogin: "/usr/bin/false",
};

const facts = (
  logsDir: OsUserFacts["logsDir"],
  exists = true,
): OsUserFacts => ({
  user: { exists },
  group: { exists: false },
  personUid: 501,
  personHome: { uid: 501, mode: 0o40700, acl: [] },
  sudoers: null,
  personRules: [],
  launcher: null,
  launcherChain: [],
  agentsDir: null,
  homeDir: null,
  stateDir: { uid: 501, mode: 0o40700 },
  dir: false,
  logsDir,
});

const problems = (f: OsUserFacts, on = true) =>
  osUserCheck({ on, layout: LAYOUT }, f).problems.join("\n");

describe("issue 988: check and Doctor say when the agents' login could read the logs", () => {
  const P = "/Users/robin/.local/state/den/logs";

  it("an open logs folder is named; a 0700 one isn't", () => {
    expect(
      problems(facts({ path: P, uid: 501, mode: 0o40755, acl: [] })),
    ).toContain(P);
    expect(
      problems(facts({ path: P, uid: 501, mode: 0o40700, acl: [] })),
    ).not.toContain(P);
  });

  it("an ACL entry that lets someone else in is named; a deny entry or the person's own isn't", () => {
    const with_ = (acl: string[]) =>
      problems(facts({ path: P, uid: 501, mode: 0o40700, acl }));
    expect(with_(["group:everyone allow list,search"])).toContain(P);
    expect(with_(["group:everyone deny list"])).not.toContain(P);
    expect(with_(["user:robin allow list"])).not.toContain(P);
  });

  it("with the login off and no login made, it says nothing about the logs", () => {
    expect(
      problems(
        facts({ path: P, uid: 501, mode: 0o40755, acl: [] }, false),
        false,
      ),
    ).not.toContain(P);
  });

  it("the facts read the logs folder under the state folder, ACLs from ls -le on macOS", () => {
    const state = path.join(tmp, "facts-state");
    const logs = path.join(state, "logs");
    fs.mkdirSync(logs, { recursive: true });
    fs.chmodSync(logs, 0o755);
    const f = readOsUserFacts(LAYOUT, state, {
      exec: (cmd, args) =>
        cmd === "/bin/ls" && args.includes(logs)
          ? {
              status: 0,
              stdout: `drwxr-xr-x+ 2 robin staff 64 Nov 27 19:00 ${logs}\n 0: group:everyone allow list\n`,
            }
          : { status: 1, stdout: "" },
      personUid: 501,
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
    expect(f.logsDir?.path).toBe(logs);
    expect((f.logsDir?.mode ?? 0) & 0o777).toBe(0o755);
    expect(f.logsDir?.acl).toEqual(["group:everyone allow list"]);
  });
});

describe("issue 988 review: logs fail closed", () => {
  const P = "/Users/robin/.local/state/den/logs";

  it("a logs folder the person doesn't own is named, even at 0700", () => {
    expect(
      problems(facts({ path: P, uid: 455, mode: 0o40700, acl: [] })),
    ).toContain(P);
  });

  it("ACLs on the logs folder that can't be read are a problem", () => {
    expect(
      problems(
        facts({ path: P, uid: 501, mode: 0o40700, acl: [], aclUnread: true }),
      ),
    ).toMatch(/can't read the ACL on the logs folder/);
    const state = path.join(tmp, "unread-state");
    fs.mkdirSync(path.join(state, "logs"), { recursive: true });
    const f = readOsUserFacts({ ...LAYOUT, personHome: state }, state, {
      exec: () => ({ status: 1, stdout: "" }),
      personUid: 501,
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
    expect(f.logsDir?.aclUnread).toBe(true);
    expect(f.personHome?.aclUnread).toBe(true);
  });

  it("a service log that is a link isn't written through", async () => {
    const dir = path.join(tmp, "linked");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(tmp, "linked-target.txt");
    fs.writeFileSync(target, "keep\n");
    fs.chmodSync(target, 0o644);
    const log = path.join(dir, "svc.log");
    fs.symlinkSync(target, log);
    await expect(runOnce(log)).rejects.toThrow(/link/);
    expect(fs.readFileSync(target, "utf-8")).toBe("keep\n");
    expect(mode(target)).toBe(0o644);
  });

  it("a rotated copy that is a link isn't written through, and a log that is a link isn't rotated", () => {
    const dir = path.join(tmp, "rotlink");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(tmp, "rotlink-target.txt");
    fs.writeFileSync(target, "keep\n");
    fs.chmodSync(target, 0o644);
    const log = path.join(dir, "svc.log");
    fs.writeFileSync(log, "x\n".repeat(200), { mode: 0o600 });
    fs.symlinkSync(target, `${log}.1`);
    expect(rotateIfOversized(log, 100, 50)).toBe(false);
    expect(fs.readFileSync(target, "utf-8")).toBe("keep\n");
    expect(mode(target)).toBe(0o644);
    const big = path.join(tmp, "rotlink-big.txt");
    fs.writeFileSync(big, "x\n".repeat(200));
    const linkLog = path.join(dir, "linked.log");
    fs.symlinkSync(big, linkLog);
    expect(rotateIfOversized(linkLog, 100, 50)).toBe(false);
    expect(fs.statSync(big).size).toBe(400);
  });
});

describe("issue 988: the logs item leaves the owed list", () => {
  it("OS_LOGIN_OWED no longer lists the logs, and still lists the Linux home's access lists", () => {
    const owed = OS_LOGIN_OWED.join("\n");
    expect(owed).not.toMatch(/logs/);
    expect(owed).toMatch(/Linux access lists on the person's home/);
  });
});
