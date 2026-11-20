/**
 * agents.git.signing_key: an SSH key the agents Den starts sign their git
 * commits with. Only theirs: it reaches an agent as GIT_CONFIG_* in its
 * own env (gpg.format ssh, user.signingkey, commit.gpgsign true), so the
 * person's git config (~/.gitconfig, their GPG key) is never written or
 * read. The key has no passphrase (agents can't type one); the person
 * adds its .pub to GitHub as a signing key once (signingKeyAddLine).
 *
 * doctor proves it: a commit in a temp repo, signed with the key and
 * checked with git verify-commit (checkAgentSigning). Nothing here prints
 * the key, only its path.
 *
 * Issue 523: an agent never signs with the person's key. With no agents
 * key set, its env turns signing off and points every signer at `false`,
 * so the person's global commit.gpgsign and GPG key can't reach it.
 * checkRepoSigning resolves a repo's effective signing config (git config
 * in the repo: local over global) and refuses when it isn't the agents'
 * key; setRepoSigning writes the repo-local config Den gives a repo it
 * clones for agents.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { UiLanguage } from "../../ui/server/ui-language.js";
import { signingWord } from "./signing-words.js";

export interface AgentGitSettings {
  /** The private key's absolute path (~ expanded). */
  signingKey: string;
}

/** `agents.git` checked. Throws naming the key, as readAgentsConfig does. */
export function gitSigningBlock(
  raw: unknown,
  home: string = os.homedir(),
): AgentGitSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error(
      `agents.git: must be a mapping with signing_key (got ${JSON.stringify(raw)})`,
    );
  for (const k of Object.keys(raw))
    if (k !== "signing_key")
      throw new Error(`agents.git.${k}: unknown key (agents.git takes signing_key)`);
  const key = (raw as { signing_key?: unknown }).signing_key;
  if (key === undefined || key === null) return undefined;
  if (typeof key !== "string" || !key.trim())
    throw new Error(
      `agents.git.signing_key: must be the path of an SSH private key (got ${JSON.stringify(key)})`,
    );
  const p = key.trim();
  const abs =
    p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
  if (!path.isAbsolute(abs))
    throw new Error(
      `agents.git.signing_key: must be an absolute path or start with ~/ (got ${JSON.stringify(key)})`,
    );
  return { signingKey: path.normalize(abs) };
}

/**
 * The env an agent's session gets for it: git's own GIT_CONFIG_COUNT /
 * KEY_n / VALUE_n, which sit above every config file and write none.
 */
export function agentGitEnv(
  git: AgentGitSettings | undefined,
): Record<string, string> {
  // Issue 523: no agents key, no signing. The person's commit.gpgsign,
  // tag.gpgsign and user.signingkey are switched off for the agent, and an
  // explicit -S fails (every signer is `false`) rather than sign as them.
  const pairs: [string, string][] = git
    ? [
        ["gpg.format", "ssh"],
        ["user.signingkey", git.signingKey],
        ["commit.gpgsign", "true"],
      ]
    : [
        ["commit.gpgsign", "false"],
        ["tag.gpgsign", "false"],
        ["user.signingkey", ""],
        ["gpg.program", "false"],
        ["gpg.ssh.program", "false"],
        ["gpg.x509.program", "false"],
      ];
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(pairs.length),
  };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** What the person runs once so GitHub shows the agents' commits Verified. */
export function signingKeyAddLine(git: AgentGitSettings): string {
  return `gh ssh-key add ${JSON.stringify(`${git.signingKey}.pub`)} --type signing --title "Den agents"`;
}

export interface SigningCheck {
  ok: boolean;
  detail: string;
}

export interface SigningCheckDeps {
  /** The temp folder's parent (default: the OS's). */
  tmp?: string;
  /** The env git runs with (default: this process's, PATH and HOME). */
  env?: NodeJS.ProcessEnv;
}

/**
 * doctor: sign a commit in a temp repo with the key, as an agent would
 * (agentGitEnv), and check it with git verify-commit against the key's own
 * .pub. The person's git config is never read: GIT_CONFIG_GLOBAL and
 * GIT_CONFIG_SYSTEM point nowhere.
 */
export function checkAgentSigning(
  git: AgentGitSettings,
  d: SigningCheckDeps = {},
): SigningCheck {
  const pub = `${git.signingKey}.pub`;
  if (!fs.existsSync(git.signingKey))
    return { ok: false, detail: `no key at ${git.signingKey}` };
  if (!fs.existsSync(pub))
    return {
      ok: false,
      detail: `no public key at ${pub} (ssh-keygen -y -f <key> > <key>.pub makes it)`,
    };
  const dir = fs.mkdtempSync(path.join(d.tmp ?? os.tmpdir(), "den-signing-"));
  try {
    const allowed = path.join(dir, "allowed_signers");
    const pubLine = fs.readFileSync(pub, "utf8").trim().split(/\s+/);
    fs.writeFileSync(
      allowed,
      `den-agent@den.invalid namespaces="git" ${pubLine[0]} ${pubLine[1] ?? ""}\n`,
    );
    const base = d.env ?? process.env;
    const env: NodeJS.ProcessEnv = {
      PATH: base.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Den agent",
      GIT_AUTHOR_EMAIL: "den-agent@den.invalid",
      GIT_COMMITTER_NAME: "Den agent",
      GIT_COMMITTER_EMAIL: "den-agent@den.invalid",
      ...agentGitEnv(git),
    };
    const repo = path.join(dir, "repo");
    const run = (args: string[]) =>
      spawnSync("git", args, {
        cwd: fs.existsSync(repo) ? repo : dir,
        env,
        encoding: "utf8",
        timeout: 20_000,
      });
    const steps: [string, string[]][] = [
      ["git init", ["init", "-q", repo]],
      ["a signed commit", ["commit", "-q", "--allow-empty", "-m", "Den: signing check"]],
      [
        "git verify-commit",
        ["-c", `gpg.ssh.allowedSignersFile=${allowed}`, "verify-commit", "HEAD"],
      ],
    ];
    for (const [what, args] of steps) {
      const r = run(args);
      if (r.error || r.status !== 0) {
        const why = (r.stderr || r.error?.message || "")
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-1)[0];
        return {
          ok: false,
          detail: `${what} failed${why ? `: ${why}` : ""}`,
        };
      }
    }
    return { ok: true, detail: `commits sign with ${git.signingKey} and verify` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The GIT_CONFIG_* names a parent's env can carry (Den's own among them). */
const GIT_CONFIG_ENV = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/;

/** `env` without any GIT_CONFIG_* override: only the config files speak. */
export function withoutGitConfigEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !GIT_CONFIG_ENV.test(k)),
  );
}

interface Setting {
  value: string;
  /** Where git found it: local, global, system, worktree, command. */
  scope: string;
}

export interface EffectiveSigning {
  format?: Setting;
  key?: Setting;
  commitSign?: Setting;
  tagSign?: Setting;
}

/**
 * What git would sign `repo`'s commits with: `git config --get` in the
 * repo, with `env` (and `pre`, leading git args such as `-c k=v`), so a
 * local value beats the global one exactly as git's own commit sees it.
 */
export function effectiveSigning(
  repo: string,
  env: NodeJS.ProcessEnv = process.env,
  pre: readonly string[] = [],
): EffectiveSigning {
  const get = (key: string, bool = false): Setting | undefined => {
    const r = spawnSync(
      "git",
      [
        ...pre,
        "config",
        "--show-scope",
        ...(bool ? ["--type=bool"] : []),
        "--get",
        key,
      ],
      { cwd: repo, env, encoding: "utf8", timeout: 20_000 },
    );
    if (r.status !== 0) return undefined;
    const line = (r.stdout ?? "").replace(/\n$/, "");
    const tab = line.indexOf("\t");
    return tab < 0
      ? { value: line, scope: "unknown" }
      : { value: line.slice(tab + 1), scope: line.slice(0, tab) };
  };
  return {
    format: get("gpg.format"),
    key: get("user.signingkey"),
    commitSign: get("commit.gpgsign", true),
    tagSign: get("tag.gpgsign", true),
  };
}

/** Where a setting came from, in git's own words ("-c/env" for command). */
const scopeOf = (s: Setting) => (s.scope === "command" ? "-c/env" : s.scope);

/** The line that gives `repo` the agents' key as its own config. */
export function repoSigningFixLine(
  repo: string,
  git: AgentGitSettings,
): string {
  const r = JSON.stringify(repo);
  return `git -C ${r} config gpg.format ssh && git -C ${r} config user.signingkey ${JSON.stringify(git.signingKey)}`;
}

function sameKey(value: string, git: AgentGitSettings): boolean {
  const v = value.trim();
  if (!v || !path.isAbsolute(v)) return false;
  const n = path.normalize(v);
  return n === git.signingKey || n === `${git.signingKey}.pub`;
}

/**
 * Why a commit was refused: its word (signing-words.ts) and that word's
 * placeholders, so the bell and doctor say it in the person's language.
 */
export interface SigningRefusal {
  code: "noKey" | "notAgentsKey";
  vars: { repo: string; settings: string; fix?: string };
}

export type RepoSigningCheck =
  | { ok: true; reason?: undefined; refusal?: undefined }
  | { ok: false; reason: string; refusal: SigningRefusal };

/**
 * Issue 523: whether a commit in `repo` would sign as the agents. With an
 * agents key: the effective gpg.format must be ssh and user.signingkey the
 * agents' key, or it is refused. With none: signing must be off
 * (commit.gpgsign and tag.gpgsign), or the commit would sign with someone
 * else's key. The reason (in `lang`) names settings in git's notation and
 * where they come from, never a key.
 */
export function checkRepoSigning(
  repo: string,
  git: AgentGitSettings | undefined,
  env: NodeJS.ProcessEnv = process.env,
  pre: readonly string[] = [],
  lang: UiLanguage = "en",
): RepoSigningCheck {
  const e = effectiveSigning(repo, env, pre);
  const refuse = (refusal: SigningRefusal): RepoSigningCheck => ({
    ok: false,
    reason: signingWord(lang, refusal.code, refusal.vars),
    refusal,
  });
  if (!git) {
    const on: string[] = [];
    for (const [k, s] of [
      ["commit.gpgsign", e.commitSign],
      ["tag.gpgsign", e.tagSign],
    ] as const)
      if (s?.value === "true") on.push(`${k}=true (${scopeOf(s)})`);
    if (!on.length) return { ok: true };
    return refuse({
      code: "noKey",
      vars: { repo, settings: on.join(", ") },
    });
  }
  const why: string[] = [];
  const format = e.format?.value || "openpgp";
  if (format !== "ssh")
    why.push(
      `gpg.format=${format} (${e.format ? scopeOf(e.format) : "default"})`,
    );
  if (!e.key) why.push("user.signingkey (unset)");
  else if (!sameKey(e.key.value, git))
    why.push(`user.signingkey≠agents (${scopeOf(e.key)})`);
  if (!why.length) return { ok: true };
  return refuse({
    code: "notAgentsKey",
    vars: {
      repo,
      settings: why.join(", "),
      fix: repoSigningFixLine(repo, git),
    },
  });
}

/**
 * Issue 523: `repo`'s own config signs with the agents' key (gpg.format
 * ssh, user.signingkey), for a repo Den clones for agents. Throws with
 * git's reason when it can't.
 */
export function setRepoSigning(
  repo: string,
  git: AgentGitSettings,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [k, v] of [
    ["gpg.format", "ssh"],
    ["user.signingkey", git.signingKey],
  ]) {
    const r = spawnSync("git", ["config", "--local", k, v], {
      cwd: repo,
      env: withoutGitConfigEnv(env),
      encoding: "utf8",
      timeout: 20_000,
    });
    if (r.error || r.status !== 0)
      throw new Error(
        `git config ${k}: ${(r.stderr || r.error?.message || "failed").trim()}`,
      );
  }
}
