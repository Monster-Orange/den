/**
 * Issue 730: an install either signs its own commits, or says plainly that
 * it doesn't.
 *   1. doctor has a row for agent commit signing even when no key is in
 *      force, said as information;
 *   2. the key in force is agents.git.signing_key, else the install's own
 *      key (issue 1316) once it is made; doctor and the pin commit both use
 *      it, so with only the install's own key both say signed;
 *   3. when the pin's branch requires signed commits and no key is in
 *      force, Den opens a pull request instead of pushing, and says why.
 *
 * Real git and ssh-keygen in temp dirs only (HOME and the global config
 * point into them); a fake gh. Invented names.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  commitPin,
  ghRepoOf,
  ghSignaturesRequired,
  pinBellMessage,
  pinGit,
} from "../../../src/ui/server/pin-commit.js";
import {
  agentKeyInForce,
  checkAgentSigning,
  ensureAgentSigningKey,
} from "../../../src/shared/agents/git-signing.js";
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

describe("1. doctor: a row for agent commit signing, in force or not", () => {
  it("no key in force: not signed, with the fix, as information in the text and the JSON", () => {
    const r = signingLines("Den", () => undefined);
    const text = r.lines.join("\n");
    expect(text).toMatch(/agents' commit signing/);
    expect(text).toMatch(/signing {2}ℹ {2}not signed: no agents' signing key/);
    expect(text).toMatch(/agents\.git\.signing_key/);
    expect(text).not.toMatch(/agent_signing_key_create|⚠/);
    // The JSON says what the text says: information is not a warning.
    expect(r.checks[0]).toMatchObject({ id: "agents:signing", status: "ok" });
    expect(r.problem).toBe(false);
  });

  it("signing turned off: not signed, and it says it was turned off", () => {
    const r = signingLines("Den", () => ({ off: true }));
    expect(r.lines.join("\n")).toMatch(
      /ℹ {2}not signed: agents\.git\.signing is off/,
    );
    expect(r.checks[0]).toMatchObject({ status: "ok" });
  });

  it("only the install's own key (issue 1316): signed with it, never 'not signed'", () => {
    ensureAgentSigningKey(stateDir);
    const r = signingLines(
      "Den",
      () => agentKeyInForce(undefined, stateDir),
      (g) => checkAgentSigning(g, { tmp, env }),
    );
    const text = r.lines.join("\n");
    expect(text).toMatch(/signing {2}✓ {2}commits sign with .*agent-signing/);
    expect(text).not.toMatch(/not signed/);
    expect(r.checks[0]).toMatchObject({ status: "ok" });
  });
});

describe("2. the key in force", () => {
  it("agents.git.signing_key when it is set, even beside the install's own", () => {
    ensureAgentSigningKey(stateDir);
    expect(
      agentKeyInForce({ signingKey: "/k/id_ed25519" }, stateDir),
    ).toMatchObject({ signingKey: "/k/id_ed25519", source: "setting" });
  });

  it("else the install's own key once it is made; never makes one", () => {
    expect(agentKeyInForce(undefined, stateDir)).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, "agent-signing"))).toBe(false);
    const made = ensureAgentSigningKey(stateDir);
    expect(agentKeyInForce({}, stateDir)).toMatchObject({
      signingKey: made.signingKey,
      source: "default",
    });
  });

  it("none when signing is turned off", () => {
    ensureAgentSigningKey(stateDir);
    expect(agentKeyInForce({ off: true }, stateDir)).toBeUndefined();
  });

  it("only the install's own key: the pin is signed with it and pushed, not sent to a pull request", async () => {
    ensureAgentSigningKey(stateDir);
    const key = agentKeyInForce(undefined, stateDir);
    const step = await commitPin("1.1.0", {
      root,
      stateDir,
      git: pinGit(root, { env, signingKey: key?.signingKey }),
      signed: !!key,
      signaturesRequired: async () => true,
    });
    expect(step).toMatchObject({ did: "pushed" });
    expect(step).not.toHaveProperty("unsignedRequired");
    expect(git(root, "cat-file", "commit", "HEAD")).toMatch(
      /BEGIN SSH SIGNATURE/,
    );
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

  it("the bell says why it is a pull request", () => {
    const m = pinBellMessage(
      {
        did: "pr",
        version: "1.1.0",
        branch: "den/pin-1.1.0",
        url: "https://example.invalid/acme/dist/pull/9",
        unsignedRequired: true,
      } as never,
      "Den",
    );
    expect(m).toMatchObject({ key: "bell.m.pinPrUnsigned" });
    expect(m?.text).toMatch(/requires signed commits/);
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
    // No admin rights: classic protection answers 403: it can't tell.
    expect(
      await answer("[]", 403)("git@github.com:acme/dist.git", "main"),
    ).toBeNull();
  });
});
