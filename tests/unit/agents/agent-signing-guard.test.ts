/**
 * Issue 523: an agent's commit must never be signed with the person's key.
 * A repo with no signing config of its own fell back to the person's
 * global user.signingkey (a GPG key), and the agent's commits carried the
 * person's signature.
 *
 * Every git here runs in a temp folder: a temp HOME, GIT_CONFIG_GLOBAL a
 * temp file, no system config. No real key is read or used: the signers
 * are shims (gpg.program, gpg.ssh.program) that write down the key they
 * were asked for and answer a dummy signature.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  agentGitEnv,
  checkRepoSigning,
  setRepoSigning,
} from "../../../src/shared/agents/git-signing.js";
import { agentSessionEnv } from "../../../src/shared/agents/runtimes.js";
import { pinGit } from "../../../src/ui/server/pin-commit.js";
import { runClone } from "../../../src/shared/repo-clone.js";
import { agentRepoSigningLines } from "../../../src/ui/cli/doctor-command.js";

/** A made-up GPG key id: the "person's" key in these tests. */
const PERSON_KEY = "FAKE0PERSON0GPG0KEY";

let dir: string;
let home: string;
let globalCfg: string;
let log: string;
let agentsKey: string;
let base: NodeJS.ProcessEnv;
let globalText: string;

function shim(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-523-")));
  home = path.join(dir, "home");
  fs.mkdirSync(home);
  log = path.join(dir, "signer.log");
  // A stand-in agents key: a path, never a real key. Only shims read it.
  agentsKey = path.join(dir, "agents_key");
  fs.writeFileSync(agentsKey, "not a key\n", { mode: 0o600 });
  // gpg: `--status-fd=2 -bsau <key>`; it says SIG_CREATED and signs.
  const gpg = shim(
    "fake-gpg",
    [
      `echo "gpg $*" >> "${log}"`,
      "cat > /dev/null",
      'echo "[GNUPG:] SIG_CREATED D 1 8 00 0 0" >&2',
      'printf -- "-----BEGIN PGP SIGNATURE-----\\n\\nAAAA\\n-----END PGP SIGNATURE-----\\n"',
    ].join("\n"),
  );
  // ssh: `-Y sign -n git -f <key> <file>`; it writes <file>.sig.
  const ssh = shim(
    "fake-ssh-sign",
    [
      `echo "ssh $*" >> "${log}"`,
      'for last; do :; done',
      'printf -- "-----BEGIN SSH SIGNATURE-----\\nAAAA\\n-----END SSH SIGNATURE-----\\n" > "$last.sig"',
    ].join("\n"),
  );
  globalCfg = path.join(dir, "global.gitconfig");
  globalText = [
    "[user]",
    "\tname = person",
    "\temail = person@example.test",
    `\tsigningkey = ${PERSON_KEY}`,
    "[commit]",
    "\tgpgsign = true",
    "[tag]",
    "\tgpgsign = true",
    "[gpg]",
    `\tprogram = ${gpg}`,
    '[gpg "ssh"]',
    `\tprogram = ${ssh}`,
    "[init]",
    "\tdefaultBranch = main",
    "",
  ].join("\n");
  fs.writeFileSync(globalCfg, globalText);
  base = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: globalCfg,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const signerLog = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "");

function newRepo(name = "repo"): string {
  const repo = path.join(dir, name);
  const r = spawnSync("git", ["init", "-q", repo], { env: base, encoding: "utf8" });
  expect(r.status).toBe(0);
  return repo;
}

function git(repo: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
}

/** An agent's own env, as `agents start` builds it, in this temp world. */
function agentEnv(key?: string): NodeJS.ProcessEnv {
  const env = agentSessionEnv(
    { PATH: process.env.PATH, HOME: home },
    {},
    {},
    "a1",
    undefined,
    [],
    agentGitEnv(key ? { signingKey: key } : undefined),
  );
  return { ...env, GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_NOSYSTEM: "1" };
}

describe("no agents key set (issue 523)", () => {
  it("global GPG key and gpgsign on: an agent's commit and tag are unsigned; the person's signer never runs", () => {
    const repo = newRepo();
    const env = agentEnv();
    const c = git(repo, ["commit", "-q", "--allow-empty", "-m", "agent work"], env);
    expect(c.status).toBe(0);
    expect(git(repo, ["cat-file", "commit", "HEAD"], env).stdout).not.toMatch(/gpgsig/);
    const t = git(repo, ["tag", "-a", "v1", "-m", "agent tag"], env);
    expect(t.status).toBe(0);
    expect(git(repo, ["cat-file", "tag", "v1"], env).stdout).not.toMatch(/BEGIN/);
    // Asked outright (-S), it still never signs as the person: it fails.
    const s = git(repo, ["commit", "-q", "-S", "--allow-empty", "-m", "signed?"], env);
    expect(s.status).not.toBe(0);
    expect(signerLog()).toBe("");
    expect(fs.readFileSync(globalCfg, "utf8")).toBe(globalText);
  });

  it("the guard: signing on with no agents key is refused, in plain words; Den's own env is fine", () => {
    const repo = newRepo();
    const r = checkRepoSigning(repo, undefined, base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no agents signing key/);
    expect(r.reason).not.toContain(PERSON_KEY);
    expect(checkRepoSigning(repo, undefined, { ...base, ...agentGitEnv(undefined) }).ok).toBe(true);
  });

  it("tag.gpgsign on globally, commit.gpgsign off: still refused", () => {
    fs.writeFileSync(globalCfg, globalText.replace("[commit]\n\tgpgsign = true", "[commit]\n\tgpgsign = false"));
    const repo = newRepo();
    const r = checkRepoSigning(repo, undefined, base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tag\.gpgsign/);
  });
});

describe("an agents key set (issue 523)", () => {
  it("a repo with no local config and a global GPG key set is refused at commit time", () => {
    const repo = newRepo();
    const r = checkRepoSigning(repo, { signingKey: agentsKey }, base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/isn't the agents' key/);
    expect(r.reason).toMatch(/global/);
    expect(r.reason).not.toContain(PERSON_KEY);
  });

  it("a different local key is refused", () => {
    const repo = newRepo();
    git(repo, ["config", "gpg.format", "ssh"], base);
    git(repo, ["config", "user.signingkey", path.join(dir, "some_other_key")], base);
    const r = checkRepoSigning(repo, { signingKey: agentsKey }, base);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/isn't the agents' key/);
    expect(r.reason).toMatch(/local/);
  });

  it("the local config Den sets passes, and only the repo's config changes", () => {
    const repo = newRepo();
    setRepoSigning(repo, { signingKey: agentsKey }, base);
    expect(git(repo, ["config", "--local", "gpg.format"], base).stdout.trim()).toBe("ssh");
    expect(git(repo, ["config", "--local", "user.signingkey"], base).stdout.trim()).toBe(agentsKey);
    expect(checkRepoSigning(repo, { signingKey: agentsKey }, base)).toEqual({ ok: true });
    // An agent outside Den's env now signs with the agents key, not the person's.
    const c = git(repo, ["commit", "-q", "--allow-empty", "-m", "agent work"], base);
    expect(c.status).toBe(0);
    expect(signerLog()).toContain(`-f ${agentsKey}`);
    expect(signerLog()).not.toContain(PERSON_KEY);
    expect(fs.readFileSync(globalCfg, "utf8")).toBe(globalText);
  });

  it("Den's pin commit refuses when a leaked config would sign as the person", async () => {
    const repo = newRepo();
    fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
    const run = pinGit(repo, {
      signingKey: agentsKey,
      env: {
        ...base,
        // A parent `git -c` leaks this to its children; it beats GIT_CONFIG_*.
        GIT_CONFIG_PARAMETERS: `'gpg.format'='openpgp' 'user.signingkey'='${PERSON_KEY}'`,
      },
    });
    expect((await run(["add", "--", "package.json"])).code).toBe(0);
    const c = await run(["commit", "-q", "-m", "pin"]);
    expect(c.code).not.toBe(0);
    expect(c.out).toMatch(/isn't the agents' key/);
    expect(signerLog()).toBe("");
  });
});

describe("a repo Den clones for agents (issue 523)", () => {
  it("gets the repo-local signing config: gpg.format ssh and the agents key", async () => {
    const dest = path.join(dir, "repos", "cloned");
    const fakeClone = async (args: string[]) => {
      expect(args).toContain("clone");
      fs.mkdirSync(dest, { recursive: true });
      spawnSync("git", ["init", "-q", dest], { env: base });
    };
    const out = await runClone(
      { ok: true, url: "https://example.test/o/r.git", shown: "o/r", name: "cloned", dest, gh: false },
      fakeClone,
      { signing: { signingKey: agentsKey }, env: base },
    );
    expect(out).toEqual({ ok: true, path: dest });
    expect(git(dest, ["config", "--local", "gpg.format"], base).stdout.trim()).toBe("ssh");
    expect(git(dest, ["config", "--local", "user.signingkey"], base).stdout.trim()).toBe(agentsKey);
  });

  it("no agents key: the clone's config is left alone", async () => {
    const dest = path.join(dir, "repos", "plain");
    const out = await runClone(
      { ok: true, url: "https://example.test/o/r.git", shown: "o/r", name: "plain", dest, gh: false },
      async () => {
        fs.mkdirSync(dest, { recursive: true });
        spawnSync("git", ["init", "-q", dest], { env: base });
      },
      { env: base },
    );
    expect(out.ok).toBe(true);
    expect(git(dest, ["config", "--local", "user.signingkey"], base).status).not.toBe(0);
  });
});

describe("doctor: agent repos whose signing key isn't the agents key (issue 523)", () => {
  it("lists the repo that would sign as someone else, with the fix line; not the one set up", () => {
    const good = newRepo("good");
    const bad = newRepo("bad");
    setRepoSigning(good, { signingKey: agentsKey }, base);
    const r = agentRepoSigningLines("Acme", [good, bad, path.join(bad, "sub")], { signingKey: agentsKey }, base);
    expect(r.problem).toBe(true);
    const rows = r.checks.filter((c) => c.id === "agents:signing:repo");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("fail");
    expect(rows[0].detail).toContain(bad);
    expect(rows[0].fix).toBe(
      `git -C ${JSON.stringify(bad)} config gpg.format ssh && git -C ${JSON.stringify(bad)} config user.signingkey ${JSON.stringify(agentsKey)}`,
    );
    expect(r.lines.join("\n")).toContain(bad);
    expect(r.lines.join("\n")).not.toContain(PERSON_KEY);
  });

  it("no agents key: a warning that agent commits are unsigned, with the line to set one", () => {
    const r = agentRepoSigningLines("Acme", [], undefined, base);
    expect(r.problem).toBe(false);
    expect(r.checks).toEqual([
      expect.objectContaining({
        id: "agents:signing",
        status: "warn",
        detail: "agent commits are unsigned; set an agents signing key",
      }),
    ]);
    expect(r.checks[0].fix).toMatch(/ssh-keygen -t ed25519 -N "" -C "Den agents" -f ~\/\.ssh\/den_agents/);
  });
});
