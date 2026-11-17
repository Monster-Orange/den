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
import {
  ghUser,
  ownerNameFromGithub,
  recordOwnerGithub,
} from "../../../src/shared/owner-github.js";
import {
  githubDisplayName,
  readWebOwner,
  setWebOwnerName,
  syncWebOwnerName,
  writeWebOwner,
} from "../../../src/shared/web-owner.js";
import type { UserConfig } from "../../../src/shared/den-config.js";
import { readWebAuthConfig } from "../../../src/shared/web-session.js";
import {
  PERSON_ONLY_SETTINGS,
  patchCliRows,
} from "../../../src/shared/settings-cli-rows.js";
import { configKeyNames } from "../../../src/ui/cli/config-command.js";

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

describe("issue 406: a GitHub sign-in keeps the owner's name as GitHub has it", () => {
  it("sets it, replaces it, forgets it when GitHub has none; another account changes nothing", () => {
    const dir = path.join(tmp, "state-sync");
    writeWebOwner({ id: 4242, login: "octo-lead" }, dir);
    expect(syncWebOwnerName(4242, "Odette Lead", dir)?.name).toBe(
      "Odette Lead",
    );
    expect(syncWebOwnerName(99, "Sam Else", dir)).toBeNull();
    expect(readWebOwner(dir)?.name).toBe("Odette Lead");
    expect(syncWebOwnerName(4242, "Odette L.", dir)?.name).toBe("Odette L.");
    const gone = syncWebOwnerName(4242, undefined, dir);
    expect(gone).not.toHaveProperty("name");
    expect(readWebOwner(dir)).toMatchObject({
      owner: "github:4242",
      login: "octo-lead",
    });
    expect(readWebOwner(dir)).not.toHaveProperty("name");
  });
});

describe("issue 406: an owner linked before names were kept, from GitHub's public profile", () => {
  /** A fake fetch: GitHub's answer for /users/<login>, and the calls. */
  function fakeFetch(status: number, body: unknown) {
    const calls: { url: string; auth: boolean }[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: "authorization" in h });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const API = "http://localhost:9";

  it("reads it once, without a token, and keeps it", async () => {
    const dir = path.join(tmp, "state-public");
    writeWebOwner({ id: 4242, login: "octo-lead" }, dir);
    const { f, calls } = fakeFetch(200, {
      id: 4242,
      login: "octo-lead",
      name: "Odette Lead",
    });
    const deps = {
      api: API,
      fake: true,
      fetch: f,
      readOwner: () => readWebOwner(dir),
      setOwnerName: (l: string, n: string) => void setWebOwnerName(l, n, dir),
    };
    expect(await ownerNameFromGithub(deps)).toBe("Odette Lead");
    expect(readWebOwner(dir)?.name).toBe("Odette Lead");
    expect(calls).toEqual([{ url: `${API}/users/octo-lead`, auth: false }]);
    // Known now: GitHub isn't asked again.
    expect(await ownerNameFromGithub(deps)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("no name on GitHub, another account's answer, an error, or no owner: nothing kept", async () => {
    const dir = path.join(tmp, "state-public-none");
    writeWebOwner({ id: 4242, login: "octo-lead" }, dir);
    const base = {
      api: API,
      fake: true,
      readOwner: () => readWebOwner(dir),
      setOwnerName: (l: string, n: string) => void setWebOwnerName(l, n, dir),
    };
    for (const [status, body] of [
      [200, { id: 4242, login: "octo-lead", name: null }],
      [200, { id: 77, login: "octo-lead", name: "Someone Else" }],
      [404, { message: "Not Found" }],
    ] as const)
      expect(
        await ownerNameFromGithub({
          ...base,
          fetch: fakeFetch(status, body).f,
        }),
      ).toBeNull();
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await ownerNameFromGithub({ ...base, fetch: boom })).toBeNull();
    expect(readWebOwner(dir)).not.toHaveProperty("name");
    const { f, calls } = fakeFetch(200, {});
    expect(
      await ownerNameFromGithub({ ...base, readOwner: () => null, fetch: f }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("in a test run, never github.com: only a fake GitHub is asked", async () => {
    const dir = path.join(tmp, "state-public-real");
    writeWebOwner({ id: 4242, login: "octo-lead" }, dir);
    const { f, calls } = fakeFetch(200, { id: 4242, name: "Odette Lead" });
    expect(
      await ownerNameFromGithub({
        api: "https://api.github.com",
        fake: false,
        fetch: f,
        readOwner: () => readWebOwner(dir),
        env: { JEST_WORKER_ID: "1" },
      }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("issue 406: web.owner_name_timeout_seconds, a Settings row", () => {
  const root = (user: string) => {
    const r = fs.mkdtempSync(path.join(tmp, "root-"));
    fs.mkdirSync(path.join(r, "config", "local"), { recursive: true });
    fs.writeFileSync(path.join(r, "config", "den.yml"), "");
    fs.writeFileSync(path.join(r, "config", "local", "user.yml"), user);
    return r;
  };

  it("10 s by default; user.yml's value; a wrong value names the key", () => {
    expect(readWebAuthConfig(root(""))).toMatchObject({
      ownerNameTimeoutSeconds: 10,
    });
    expect(
      readWebAuthConfig(root("web:\n  owner_name_timeout_seconds: 30\n")),
    ).toMatchObject({ ownerNameTimeoutSeconds: 30 });
    expect(() =>
      readWebAuthConfig(root("web:\n  owner_name_timeout_seconds: 0\n")),
    ).toThrow(
      "web.owner_name_timeout_seconds must be a number of seconds above 0",
    );
  });

  it("Settings writes user.yml web.owner_name_timeout_seconds; null clears; a person's only", () => {
    const user: Record<string, unknown> = { web: { machine_name: "box" } };
    expect(
      patchCliRows(user, { web_github: { owner_name_timeout_seconds: 30 } }),
    ).toEqual({ ok: true });
    expect(user.web).toEqual({
      machine_name: "box",
      owner_name_timeout_seconds: 30,
    });
    expect(
      patchCliRows(user, { web_github: { owner_name_timeout_seconds: 0 } }),
    ).toMatchObject({ ok: false });
    expect(
      patchCliRows(user, { web_github: { owner_name_timeout_seconds: null } }),
    ).toEqual({ ok: true });
    expect(user.web).toEqual({ machine_name: "box" });
    expect(PERSON_ONLY_SETTINGS).toContain("web_github");
    expect(configKeyNames()).toContain("web.owner_name_timeout_seconds");
  });

  it("the start's GitHub call gives up after that long", async () => {
    const dir = path.join(tmp, "state-timeout");
    writeWebOwner({ id: 4242, login: "octo-lead" }, dir);
    // GitHub never answers: only the timeout ends the call.
    const f = ((_u: string, init?: RequestInit) =>
      new Promise((_ok, no) =>
        init?.signal?.addEventListener("abort", () => no(new Error("aborted"))),
      )) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(
      await ownerNameFromGithub({
        api: "http://localhost:9",
        fake: true,
        fetch: f,
        timeoutMs: 200,
        readOwner: () => readWebOwner(dir),
      }),
    ).toBeNull();
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});
