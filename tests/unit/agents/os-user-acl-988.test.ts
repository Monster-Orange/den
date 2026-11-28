import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  aclLetsAgentsWrite,
  darwinAcls,
  OS_LOGIN_OWED,
  parseLsAcl,
  runtimeProblemsOrUnread,
  runtimeWritableProblems,
} from "../../../src/shared/agents/os-user.js";

const tmp = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-os-user-acl-988-")),
);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const WHO = { name: "_denagents", groupNames: ["_denagents", "everyone"] };

describe("issue 988: an ACL entry that lets the agents' login write is a problem", () => {
  it("allow entries with a write right for the login, its groups, everyone or an unknown id count", () => {
    for (const e of [
      "group:everyone allow write",
      "everyone allow append",
      "user:_denagents allow delete",
      "group:_denagents allow add_file,delete_child",
      "group:_denagents allow add_subdirectory",
      "user:_denagents allow writeattr",
      "user:_denagents allow writeextattr",
      "user:_denagents allow writesecurity",
      "user:_denagents allow chown",
      "ABCDEFAB-CDEF-ABCD-EFAB-CDEF0000000C allow write",
      "group:everyone inherited allow write,file_inherit",
    ])
      expect([e, aclLetsAgentsWrite(e, WHO)]).toEqual([e, true]);
  });

  it("deny entries, read rights and other people's entries don't", () => {
    for (const e of [
      "group:everyone deny delete",
      "group:everyone allow read,execute,readattr,readextattr,readsecurity,list,search",
      "user:someone allow write",
      "group:admin allow write",
    ])
      expect([e, aclLetsAgentsWrite(e, WHO)]).toEqual([e, false]);
  });

  it("without the login's names, every allow entry with a write right counts", () => {
    expect(aclLetsAgentsWrite("user:someone allow write", {})).toBe(true);
    expect(aclLetsAgentsWrite("user:someone allow read", {})).toBe(false);
  });
});

describe("issue 988: ls -led output is read per path", () => {
  it("entries go to the path above them, spaces and all", () => {
    const out = [
      "drwxr-xr-x  4 me  staff  128 Nov 27 18:38 /e",
      "drwxr-xr-x+ 3 me  staff   96 Nov 27 18:38 /e/a b",
      " 0: user:nobody allow add_file,delete_child",
      "-rw-r--r--+ 1 me  staff    0 Nov 27 18:38 /e/a b/f 2",
      " 0: group:staff deny delete",
      " 1: group:everyone allow write",
      "-rw-r--r--  1 me  staff    0 Nov 27 18:38 /e/f1",
    ].join("\n");
    const m = parseLsAcl(out, ["/e", "/e/a b", "/e/a b/f 2", "/e/f1"]);
    expect(m.get("/e/a b")).toEqual([
      "user:nobody allow add_file,delete_child",
    ]);
    expect(m.get("/e/a b/f 2")).toEqual([
      "group:staff deny delete",
      "group:everyone allow write",
    ]);
    expect(m.has("/e")).toBe(false);
    expect(m.has("/e/f1")).toBe(false);
  });
});

describe("issue 988: the runtime check reads ACLs on everything it checks", () => {
  function engine(name: string) {
    const e = path.join(tmp, name);
    fs.mkdirSync(path.join(e, "dist"), { recursive: true });
    fs.mkdirSync(path.join(e, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(e, "dist", "cli.js"), "");
    fs.writeFileSync(path.join(e, "node_modules", "dep", "index.js"), "");
    return e;
  }
  const stat = (p: string) => {
    const s = fs.lstatSync(p);
    return { uid: 0, gid: 0, mode: (s.mode & 0o170000) | 0o755 };
  };
  const AGENTS = { uid: 455, gids: [455], ...WHO };
  const run = (e: string, acls: Record<string, string[]>, asked?: string[]) =>
    runtimeWritableProblems(
      {
        bin: process.execPath,
        script: path.join(e, "dist", "cli.js"),
        engineRoot: e,
      },
      AGENTS,
      {
        stat,
        acl: (paths) => {
          asked?.push(...paths);
          return new Map(Object.entries(acls));
        },
      },
    ).join("\n");

  it("a file deep in node_modules, or a folder above the CLI, with such an entry is named", () => {
    const e = engine("named");
    const dep = path.join(e, "node_modules", "dep", "index.js");
    expect(run(e, {})).toBe("");
    expect(run(e, { [dep]: ["group:everyone allow write"] })).toContain(dep);
    expect(run(e, { [tmp]: ["user:_denagents allow add_file"] })).toContain(
      tmp,
    );
    expect(run(e, { [dep]: ["group:everyone deny write"] })).toBe("");
  });

  it("every file and folder it checks is asked about, node's own too", () => {
    const e = engine("asked");
    const asked: string[] = [];
    run(e, {}, asked);
    for (const p of [
      fs.realpathSync(process.execPath),
      path.dirname(fs.realpathSync(process.execPath)),
      path.join(e, "node_modules", "dep", "index.js"),
      path.join(e, "dist"),
      tmp,
    ])
      expect(asked).toContain(p);
  });

  it("ACLs that can't be read fail closed", () => {
    const e = engine("unread");
    expect(
      runtimeProblemsOrUnread(
        {
          bin: process.execPath,
          script: path.join(e, "dist", "cli.js"),
          engineRoot: e,
        },
        AGENTS,
        {
          acl: () => {
            throw new Error("ls failed");
          },
        },
      ).join("\n"),
    ).toContain("ls failed");
  });
});

const onMac = process.platform === "darwin" ? it : it.skip;
describe("issue 988: on macOS the ACLs come from ls -le", () => {
  onMac("a real entry on a real file is read", () => {
    const d = path.join(tmp, "real dir");
    fs.mkdirSync(d);
    const f = path.join(d, "f 1");
    fs.writeFileSync(f, "");
    const r = spawnSync("/bin/chmod", ["+a", "group:everyone allow write", f]);
    expect(r.status).toBe(0);
    const m = darwinAcls([d, f]);
    expect(m.get(f)).toEqual(["group:everyone allow write"]);
    expect(m.has(d)).toBe(false);
  });
});

describe("issue 988: the ACL check is no longer owed", () => {
  it("OS_LOGIN_OWED doesn't list it", () => {
    expect(OS_LOGIN_OWED.join("\n")).not.toMatch(/ACL/);
  });
});
