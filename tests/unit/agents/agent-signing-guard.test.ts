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
  repoSigningFixLine,
  setRepoSigning,
} from "../../../src/shared/agents/git-signing.js";
import { agentSessionEnv } from "../../../src/shared/agents/runtimes.js";
import { SIGNING_WORDS, signingWord } from "../../../src/shared/agents/signing-words.js";
import { pinGit, pinSigningBell } from "../../../src/ui/server/pin-commit.js";
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

  it("an agent with the agents key can't switch to the person's GPG or x509 signer", () => {
    const repo = newRepo();
    const env = agentEnv(agentsKey);
    for (const fmt of ["openpgp", "x509"]) {
      const c = git(repo, ["-c", `gpg.format=${fmt}`, "commit", "-q", "--allow-empty", "-S", "-m", fmt], env);
      expect([fmt, c.status]).not.toEqual([fmt, 0]);
    }
    const k = git(
      repo,
      ["-c", "gpg.format=openpgp", "commit", "-q", "--allow-empty", `-S${PERSON_KEY}`, "-m", "k"],
      env,
    );
    expect(k.status).not.toBe(0);
    expect(signerLog()).not.toContain("gpg ");
    expect(signerLog()).not.toContain(PERSON_KEY);
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
  /** A linked worktree of `repo` (one commit first, made unsigned). */
  function worktreeOf(repo: string, name: string): string {
    const plain = {
      ...base,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
    };
    expect(git(repo, ["commit", "-q", "--allow-empty", "-m", "first"], plain).status).toBe(0);
    const wt = path.join(dir, name);
    expect(git(repo, ["worktree", "add", "-q", wt], plain).status).toBe(0);
    return wt;
  }

  it("fails a linked worktree that would sign as someone else, with a fix for that worktree only", () => {
    const good = newRepo("good");
    setRepoSigning(good, { signingKey: agentsKey }, base);
    const main = newRepo("main");
    const wt = worktreeOf(main, "wt");
    const r = agentRepoSigningLines("Acme", [good, wt, path.join(wt, "sub")], { signingKey: agentsKey }, base);
    expect(r.problem).toBe(true);
    const rows = r.checks.filter((c) => c.id === "agents:signing:repo");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("fail");
    expect(rows[0].detail).toContain(wt);
    expect(rows[0].fix).toBe(repoSigningFixLine(wt, { signingKey: agentsKey }));
    expect(rows[0].fix).toContain("config --worktree");
    expect(r.lines.join("\n")).not.toContain(PERSON_KEY);
    // The fix changes that worktree only: the person's main checkout still
    // signs with their own key.
    const fixed = spawnSync("sh", ["-c", rows[0].fix!], { env: base, encoding: "utf8" });
    expect(fixed.stderr).toBe("");
    expect(checkRepoSigning(wt, { signingKey: agentsKey }, base)).toEqual({ ok: true });
    expect(git(main, ["config", "--get", "user.signingkey"], base).stdout.trim()).toBe(PERSON_KEY);
    expect(checkRepoSigning(main, { signingKey: agentsKey }, base).ok).toBe(false);
  });

  it("a main checkout that would sign as someone else fails with no config fix: Den won't change the person's checkout", () => {
    const main = newRepo("main");
    const r = agentRepoSigningLines("Acme", [main], { signingKey: agentsKey }, base);
    expect(r.problem).toBe(true);
    const [row] = r.checks.filter((c) => c.id === "agents:signing:repo");
    expect(row.status).toBe("fail");
    expect(row.fix).toBeUndefined();
    expect(row.detail).toBe(
      signingWord("en", "doctor.repoMain", {
        repo: main,
        settings: "gpg.format=openpgp (default), user.signingkey≠agents (global)",
      }),
    );
  });

  it("a repo whose config signs nothing is a note, not a fault: agents sign there through Den's env", () => {
    const quiet = newRepo("quiet");
    git(quiet, ["config", "commit.gpgsign", "false"], base);
    git(quiet, ["config", "tag.gpgsign", "false"], base);
    const r = agentRepoSigningLines("Acme", [quiet], { signingKey: agentsKey }, base);
    expect(r.problem).toBe(false);
    const [row] = r.checks.filter((c) => c.id === "agents:signing:repo");
    expect(row).toEqual({
      id: "agents:signing:repo",
      status: "warn",
      detail: signingWord("en", "doctor.repoNote", {
        repo: quiet,
        settings: "gpg.format=openpgp (default), user.signingkey≠agents (global)",
      }),
    });
    expect(r.lines.join("\n")).toContain("ℹ");
  });

  it("the fix line single-quotes the folder and key, so $ and backticks stay text", () => {
    const repo = path.join(dir, "a $(touch x) `touch y`");
    const key = path.join(dir, "k $HOME `id`");
    const line = repoSigningFixLine(repo, { signingKey: key });
    expect(line).toContain(`git -C '${repo}' config extensions.worktreeConfig true`);
    expect(line).toContain(`git -C '${repo}' config --worktree gpg.format ssh`);
    expect(line).toContain(`config --worktree user.signingkey '${key}'`);
    // A quote in the folder name is closed and reopened, never left open.
    expect(repoSigningFixLine("/r'q", { signingKey: "/k" })).toContain(`git -C '/r'\\''q' config`);
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

  it("says it in the person's language", () => {
    const es = agentRepoSigningLines("Acme", [], undefined, base, "es");
    expect(es.checks[0].detail).toBe(SIGNING_WORDS.es["doctor.unsigned"]);
    const bad = newRepo("bad");
    const ja = agentRepoSigningLines("Acme", [bad], { signingKey: agentsKey }, base, "ja");
    expect(ja.checks[0].detail).toBe(
      signingWord("ja", "doctor.repoMain", { repo: bad, settings: "gpg.format=openpgp (default), user.signingkey≠agents (global)" }),
    );
    expect(ja.lines.join("\n")).toContain(bad);
  });
});

describe("the refusal's words (issue 523)", () => {
  const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it("es and ja have every en line, with the same placeholders", () => {
    const en = SIGNING_WORDS.en;
    for (const lang of ["es", "ja"] as const) {
      const tr = SIGNING_WORDS[lang];
      expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en) as (keyof typeof en)[])
        expect([lang, k, ph(tr[k])]).toEqual([lang, k, ph(en[k])]);
    }
  });

  it("a refusal carries its word and placeholders, and says it in ja", () => {
    const repo = newRepo();
    const r = checkRepoSigning(repo, { signingKey: agentsKey }, base, [], "ja");
    expect(r.ok).toBe(false);
    expect(r.refusal).toEqual({
      code: "notAgentsKey",
      vars: {
        repo,
        settings: "gpg.format=openpgp (default), user.signingkey≠agents (global)",
        fix: expect.stringContaining("gpg.format ssh"),
      },
    });
    expect(r.reason).toBe(signingWord("ja", "notAgentsKey", r.refusal!.vars));
    expect(r.reason).not.toContain(PERSON_KEY);
  });

  it("the pin bell picks its own line for each refusal", () => {
    expect(
      pinSigningBell({ code: "noKey", vars: { repo: "/r", settings: "commit.gpgsign=true (global)" } }),
    ).toEqual({
      key: "bell.m.pinSigningNoKey",
      vars: { repo: "/r", settings: "commit.gpgsign=true (global)" },
    });
    expect(
      pinSigningBell({ code: "notAgentsKey", vars: { repo: "/r", settings: "s", fix: "git f" } }),
    ).toEqual({
      key: "bell.m.pinSigningRefused",
      vars: { repo: "/r", settings: "s", fix: "git f" },
    });
    expect(pinSigningBell({ code: "notAgentsKey", vars: { repo: "/r", settings: "s" } }).vars).toEqual({
      repo: "/r",
      settings: "s",
    });
  });

  it("Den's pin commit hands the bell the refusal, not only text", async () => {
    const repo = newRepo();
    fs.writeFileSync(path.join(repo, "package.json"), "{}\n");
    const run = pinGit(repo, {
      signingKey: agentsKey,
      env: { ...base, GIT_CONFIG_PARAMETERS: `'gpg.format'='openpgp'` },
    });
    await run(["add", "--", "package.json"]);
    const c = await run(["commit", "-q", "-m", "pin"]);
    expect(c.refused?.code).toBe("notAgentsKey");
    expect(c.refused?.vars.settings).toBe("gpg.format=openpgp (-c/env)");
  });
});
