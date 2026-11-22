/**
 * Issue 730: an install either signs its own commits, or says plainly that
 * it doesn't, and offers to fix it.
 *   1. doctor has a row for agent commit signing even when no key is set,
 *      with the fix;
 *   2. a held write makes the agents' signing key (no passphrase, under the
 *      state dir), sets agents.git.signing_key and shows the public key;
 *      only the person's own Allow runs it;
 *   3. when the pin's branch requires signed commits and no key is set, Den
 *      opens a pull request instead of pushing, and says why.
 *
 * Real git and ssh-keygen in temp dirs only (HOME and the global config
 * point into them); a fake gh. Invented names.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { execFileSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  commitPin,
  ghRepoOf,
  ghSignaturesRequired,
  pinGit,
} from "../../../src/ui/server/pin-commit.js";
import {
  AGENT_SIGNING_KEY_ACTION,
  agentSigningKeyOp,
} from "../../../src/shared/agents/agent-signing-key.js";
import { CRITICAL_HELD_ACTIONS } from "../../../src/ui/server/held-actions.js";
import { policyFor } from "../../../src/shared/approval-policy.js";
import { signingLines } from "../../../src/ui/cli/doctor-command.js";

let tmp: string;
let remote: string;
let root: string;
let stateDir: string;
let env: NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
    { cwd, env, encoding: "utf8" },
  ).replace(/\n+$/, "");

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-730-")));
  const home = path.join(tmp, "home");
  fs.mkdirSync(home);
  env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
  };
  remote = path.join(tmp, "remote.git");
  root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "state");
  git(tmp, "init", "-q", "--bare", "-b", "main", remote);
  git(tmp, "init", "-q", "-b", "main", root);
  fs.writeFileSync(path.join(root, "package.json"), '{"v":"1.0.0"}\n');
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"v":"1.0.0"}\n');
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the distribution");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "-q", "-u", "origin", "main");
  // The new pin, as a verified self-update leaves it.
  fs.writeFileSync(path.join(root, "package.json"), '{"v":"1.1.0"}\n');
  fs.writeFileSync(path.join(root, "package-lock.json"), '{"v":"1.1.0"}\n');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A fake gh that answers `pr create` with an address and logs its calls. */
function fakeGh(): { argv: string[]; calls: () => string[][] } {
  const log = path.join(tmp, "gh.jsonl");
  const script = path.join(tmp, "gh.cjs");
  fs.writeFileSync(
    script,
    `require("fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("https://example.invalid/acme/dist/pull/9\\n");`,
  );
  return {
    argv: [process.execPath, script],
    calls: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as string[])
        : [],
  };
}

describe("1. doctor: a row for agent commit signing, set or not", () => {
  it("no agents.git block: not signed, with the fix", () => {
    const r = signingLines("Den", () => undefined);
    const text = r.lines.join("\n");
    expect(text).toMatch(/agents' commit signing/);
    expect(text).toMatch(/not signed: no agents\.git\.signing_key/);
    expect(text).toMatch(/agent_signing_key_create/);
    expect(r.checks[0]).toMatchObject({ status: "warn" });
    expect(r.problem).toBe(false);
  });

  it("an agents.git block with no key: the same row", () => {
    const r = signingLines("Den", () => ({}) as never);
    expect(r.lines.join("\n")).toMatch(
      /not signed: no agents\.git\.signing_key/,
    );
  });

  it("a key set: signed with the agents' key", () => {
    const r = signingLines(
      "Den",
      () => ({ signingKey: "/k/id_ed25519" }) as never,
      () => ({ ok: true, detail: "signed with the agents' key" }) as never,
    );
    expect(r.lines.join("\n")).toMatch(/✓\s+signed with the agents' key/);
  });
});

describe("2. the held write that makes the agents' signing key", () => {
  it("is critical: no approval policy runs it without the person", () => {
    expect(CRITICAL_HELD_ACTIONS.has(AGENT_SIGNING_KEY_ACTION)).toBe(true);
    const loose = {
      policy: "auto",
      writes: { [AGENT_SIGNING_KEY_ACTION]: "auto" },
    } as const;
    expect(policyFor(AGENT_SIGNING_KEY_ACTION, {}).kind).toBe("ask");
    expect(
      policyFor(AGENT_SIGNING_KEY_ACTION, { install: loose, project: loose })
        .kind,
    ).toBe("ask");
  });

  it("makes a no-passphrase ed25519 key under the state dir, sets agents.git.signing_key, and shows only the public key", async () => {
    let set: string | undefined;
    const op = agentSigningKeyOp({
      stateDir,
      current: () => set,
      setKey: (p) => {
        set = p;
      },
      env,
    });
    const c = op.check({});
    expect(c.ok && c.personOnly).toBe(true);
    const r = (await op.run({})) as {
      path: string;
      publicKey: string;
      addLine: string;
    };
    expect(r.path.startsWith(stateDir)).toBe(true);
    expect(set).toBe(r.path);
    expect(fs.statSync(r.path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(r.path)).mode & 0o777).toBe(0o700);
    expect(r.publicKey).toMatch(/^ssh-ed25519 /);
    expect(JSON.stringify(r)).not.toMatch(/PRIVATE KEY/);
    expect(r.addLine).toMatch(/gh ssh-key add .*--type signing/);
    // No passphrase: ssh-keygen reads it with an empty one.
    const y = spawnSync("ssh-keygen", ["-y", "-P", "", "-f", r.path], { env });
    expect(y.status).toBe(0);
    // Signs a pin commit.
    const step = await commitPin("1.1.0", {
      root,
      stateDir,
      git: pinGit(root, { env, signingKey: r.path }),
    });
    expect(step).toMatchObject({ did: "pushed" });
    expect(git(root, "cat-file", "commit", "HEAD")).toMatch(
      /BEGIN SSH SIGNATURE/,
    );
  });

  it("refused when a key is already set and there, before anything is made", () => {
    const key = path.join(tmp, "have");
    fs.writeFileSync(key, "x");
    const op = agentSigningKeyOp({
      stateDir,
      current: () => key,
      setKey: () => undefined,
      env,
    });
    const c = op.check({});
    expect(c.ok).toBe(false);
    expect(!c.ok && c.error).toMatch(/already set/);
    expect(fs.existsSync(path.join(stateDir, "agent-signing"))).toBe(false);
  });
});

describe("3. a branch that requires signed commits, and no key", () => {
  it("opens a pull request instead of pushing, and says why", async () => {
    const gh = fakeGh();
    const head = git(root, "rev-parse", "HEAD");
    const step = await commitPin("1.1.0", {
      root,
      stateDir,
      git: pinGit(root, { env }),
      gh: gh.argv,
      signed: false,
      signaturesRequired: async () => true,
    });
    expect(step).toMatchObject({ did: "pr", unsignedRequired: true });
    // main on the remote never moved; the pin is on its own branch.
    expect(git(remote, "rev-parse", "main")).toBe(head);
    expect(git(remote, "rev-parse", "den/pin-1.1.0~1")).toBe(head);
    expect(gh.calls()[0].slice(0, 2)).toEqual(["pr", "create"]);
  });

  it("signed: it pushes as before", async () => {
    const step = await commitPin("1.1.0", {
      root,
      stateDir,
      git: pinGit(root, { env }),
      signed: true,
      signaturesRequired: async () => true,
    });
    expect(step).toMatchObject({ did: "pushed" });
  });

  it("not required, or not known: it pushes as before", async () => {
    for (const [i, req] of [false, null].entries()) {
      fs.writeFileSync(path.join(root, "package.json"), `{"v":"${i}"}\n`);
      const step = await commitPin(`1.1.${i + 1}`, {
        root,
        stateDir,
        git: pinGit(root, { env }),
        signed: false,
        signaturesRequired: async () => req,
      });
      expect(step).toMatchObject({ did: "pushed" });
    }
  });

  it("reads GitHub's branch rules through gh: a required_signatures rule, or classic protection", async () => {
    expect(ghRepoOf("git@github.com:acme/dist.git")).toBe("acme/dist");
    expect(ghRepoOf("https://github.com/acme/dist")).toBe("acme/dist");
    expect(ghRepoOf("/srv/remote.git")).toBeNull();
    const answer = (rules: string, classic: number) =>
      ghSignaturesRequired(async (argv) => {
        const u = argv[argv.length - 1];
        if (u.includes("/rules/branches/")) return { code: 0, out: rules };
        return classic === 200
          ? { code: 0, out: '{"enabled":true}' }
          : { code: 1, out: `HTTP ${classic}` };
      });
    expect(
      await answer('[{"type":"required_signatures"}]', 404)(
        "git@github.com:acme/dist.git",
        "main",
      ),
    ).toBe(true);
    expect(
      await answer("[]", 200)("git@github.com:acme/dist.git", "main"),
    ).toBe(true);
    expect(
      await answer("[]", 404)("git@github.com:acme/dist.git", "main"),
    ).toBe(false);
    expect(await answer("[]", 404)("/srv/remote.git", "main")).toBeNull();
  });
});
