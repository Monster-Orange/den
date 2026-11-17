/**
 * The install owner's GitHub display name, for the account entry of a
 * browser on this machine: read from the same `gh api user` call as the
 * login (a fake gh, by its full path in a temp dir: never the real one),
 * and kept with the login (web.owner_github_name, or the linked owner's
 * web-owner.json). gh runs only while the name isn't known yet.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ghUser, recordOwnerGithub } from "../../../src/shared/owner-github.js";
import {
  githubDisplayName,
  readWebOwner,
  setWebOwnerName,
  writeWebOwner,
} from "../../../src/shared/web-owner.js";
import type { UserConfig } from "../../../src/shared/den-config.js";

let tmp = "";
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-ghname-")));
});
afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

/** A fake gh at a full path: prints `out` for `api user --jq …`, logs its args. */
function fakeGh(name: string, out: string, code = 0): string {
  const bin = path.join(tmp, name);
  const log = `${bin}.args`;
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nprintf '${out}'\nexit ${code}\n`,
    { mode: 0o755 },
  );
  return bin;
}

function store(start: Record<string, unknown> = {}) {
  let cfg = start as UserConfig;
  const writes: UserConfig[] = [];
  return {
    read: () => cfg,
    write: (c: UserConfig) => {
      writes.push(c);
      cfg = c;
    },
    writes,
  };
}

describe("ghUser: one gh api user call, the login and the name", () => {
  it("asks gh once for both, and reads them", () => {
    const bin = fakeGh("gh-named", "octo-lead\\tOdette Lead\\n");
    expect(ghUser({ PATH: "/usr/bin:/bin" }, bin)).toEqual({
      login: "octo-lead",
      name: "Odette Lead",
    });
    const args = fs.readFileSync(`${bin}.args`, "utf-8").trim().split("\n");
    expect(args.slice(0, 3)).toEqual(["api", "user", "--jq"]);
    expect(args.slice(3).join("\n")).toContain(".name");
  });

  it("no name on GitHub: the login alone", () => {
    const bin = fakeGh("gh-plain", "octo-lead\\t\\n");
    expect(ghUser({ PATH: "/usr/bin:/bin" }, bin)).toEqual({
      login: "octo-lead",
    });
  });

  it("signed out (gh fails): null", () => {
    const bin = fakeGh("gh-out", "", 1);
    expect(ghUser({ PATH: "/usr/bin:/bin" }, bin)).toBeNull();
  });
});

describe("recordOwnerGithub keeps the name with the login", () => {
  it("records gh's login and name together", () => {
    const s = store({ web: { machine_name: "Studio" } });
    const r = recordOwnerGithub({
      ownerLinked: () => false,
      ghUser: () => ({ login: "octo-lead", name: "Odette Lead" }),
      read: s.read,
      write: s.write,
    });
    expect(r).toEqual({ state: "recorded", login: "octo-lead" });
    expect(s.writes).toEqual([
      {
        web: {
          machine_name: "Studio",
          owner_github: "octo-lead",
          owner_github_name: "Odette Lead",
        },
      },
    ]);
  });

  it("a login set before names were kept: the name from gh once, when it is that login", () => {
    const s = store({ web: { owner_github: "octo-lead" } });
    let calls = 0;
    const gh = () => (calls++, { login: "Octo-Lead", name: "Odette Lead" });
    expect(
      recordOwnerGithub({ ownerLinked: () => false, ghUser: gh, ...s }),
    ).toEqual({ state: "set", login: "octo-lead" });
    expect(s.writes).toEqual([
      { web: { owner_github: "octo-lead", owner_github_name: "Odette Lead" } },
    ]);
    // Known now: gh doesn't run again.
    recordOwnerGithub({ ownerLinked: () => false, ghUser: gh, ...s });
    expect(calls).toBe(1);
    // gh signed in as someone else: their name is never kept.
    const other = store({ web: { owner_github: "octo-lead" } });
    recordOwnerGithub({
      ownerLinked: () => false,
      ghUser: () => ({ login: "someone-else", name: "Sam Else" }),
      ...other,
    });
    expect(other.writes).toEqual([]);
  });

  it("a linked owner with no name: gh's, when gh is that owner; never again once kept", () => {
    const dir = path.join(tmp, "state-linked");
    writeWebOwner({ id: 4242, login: "octo-lead" }, dir);
    let calls = 0;
    const deps = {
      ownerLinked: () => true,
      readOwner: () => readWebOwner(dir),
      setOwnerName: (l: string, n: string) => void setWebOwnerName(l, n, dir),
      ghUser: () => (calls++, { login: "octo-lead", name: "Odette Lead" }),
    };
    expect(recordOwnerGithub(deps)).toEqual({ state: "linked" });
    expect(readWebOwner(dir)).toMatchObject({
      owner: "github:4242",
      login: "octo-lead",
      name: "Odette Lead",
    });
    recordOwnerGithub(deps);
    expect(calls).toBe(1);
  });
});

describe("the owner file keeps a display name", () => {
  it("written with the link, read back; cleaned of control characters", () => {
    const dir = path.join(tmp, "state-link");
    writeWebOwner(
      { id: 7, login: "octo-lead", name: " Odette\u0007 Lead " },
      dir,
    );
    expect(readWebOwner(dir)?.name).toBe("Odette Lead");
    expect(githubDisplayName("")).toBeUndefined();
    expect(githubDisplayName(null)).toBeUndefined();
    expect(setWebOwnerName("someone-else", "Sam Else", dir)).toBeNull();
    expect(readWebOwner(dir)?.name).toBe("Odette Lead");
  });
});
