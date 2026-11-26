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
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SESSION_SIGNING_DIR } from "./sandbox.js";

export interface AgentGitSettings {
  /** The private key's absolute path (~ expanded). */
  signingKey: string;
  /** An allowed_signers file git checks its own signatures with. */
  allowedSigners?: string;
}

/** `agents.git` as user.yml says it: each field only when set. */
export interface AgentGitBlock {
  /** agents.git.signing_key, ~ expanded. */
  signingKey?: string;
  /** agents.git.signing: off. Agents' commits are left as git makes them. */
  off?: true;
}

/** The key the agents' sessions sign with, and where it came from. */
export interface AgentSigning extends AgentGitSettings {
  /** setting: agents.git.signing_key; default: the install's own key. */
  source: "setting" | "default";
  /** This call made the default key (the start line says so, once). */
  made?: true;
}

/** <state>/agent-signing: the install's agents' key. Read-only to them. */
export const AGENT_SIGNING_DIR = SESSION_SIGNING_DIR;
const KEY_FOLDER = "key";
const KEY_FILE = "id_ed25519";
const SIGNER = "den-agents@den.invalid";

/** `agents.git` checked. Throws naming the key, as readAgentsConfig does. */
export function gitSigningBlock(
  raw: unknown,
  home: string = os.homedir(),
): AgentGitBlock | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new Error(
      `agents.git: must be a mapping with signing or signing_key (got ${JSON.stringify(raw)})`,
    );
  for (const k of Object.keys(raw))
    if (k !== "signing_key" && k !== "signing")
      throw new Error(
        `agents.git.${k}: unknown key (agents.git takes signing and signing_key)`,
      );
  const out: AgentGitBlock = {};
  const sw = (raw as { signing?: unknown }).signing;
  // YAML reads a bare off as false.
  if (sw === "off" || sw === false) out.off = true;
  else if (!(sw === undefined || sw === null || sw === "on" || sw === true))
    throw new Error(
      `agents.git.signing: must be on or off (got ${JSON.stringify(sw)})`,
    );
  const key = (raw as { signing_key?: unknown }).signing_key;
  if (key !== undefined && key !== null) {
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
    out.signingKey = path.normalize(abs);
  }
  return out.off || out.signingKey ? out : undefined;
}

/** The folder the install's agents' key lives in, once made. */
export function agentSigningKeyDir(stateDir: string): string {
  return path.join(stateDir, AGENT_SIGNING_DIR, KEY_FOLDER);
}

function keyIn(dir: string): AgentSigning {
  return {
    signingKey: path.join(dir, KEY_FILE),
    allowedSigners: path.join(dir, "allowed_signers"),
    source: "default",
  };
}

function complete(dir: string): boolean {
  const k = keyIn(dir);
  return [k.signingKey, `${k.signingKey}.pub`, k.allowedSigners!].every((f) =>
    fs.existsSync(f),
  );
}

/** The default key if it is made already (doctor: it never makes one). */
export function existingAgentSigningKey(
  stateDir: string,
): AgentSigning | undefined {
  const dir = agentSigningKeyDir(stateDir);
  return complete(dir) ? keyIn(dir) : undefined;
}

export function agentKeyInForce(
  git: AgentGitBlock | undefined,
  stateDir: string,
): AgentSigning | undefined {
  if (git?.off) return undefined;
  if (git?.signingKey) return { signingKey: git.signingKey, source: "setting" };
  return existingAgentSigningKey(stateDir);
}

export interface EnsureKeyDeps {
  /** Runs after the key is made, before it is moved into place (tests). */
  beforePlace?: () => void;
}

/**
 * The install's agents' key: made once. ssh-keygen writes it, its .pub and
 * allowed_signers into a fresh folder beside the final one; a rename moves
 * that folder into place only if none is there. Two Den processes that
 * race both make one, one rename wins, and the other uses the winner's.
 */
export function ensureAgentSigningKey(
  stateDir: string,
  d: EnsureKeyDeps = {},
): AgentSigning {
  const parent = path.join(stateDir, AGENT_SIGNING_DIR);
  const final = agentSigningKeyDir(stateDir);
  if (complete(final)) return keyIn(final);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  // A folder missing a file (a .pub deleted): moved aside, never used, so
  // the next make can land. Another process may have moved it first.
  // A complete one never turns incomplete: a racer's is left alone.
  if (fs.existsSync(final) && !complete(final))
    try {
      fs.renameSync(
        final,
        path.join(parent, `.incomplete-${Date.now()}-${process.pid}`),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  const tmp = fs.mkdtempSync(path.join(parent, ".new-"));
  try {
    const key = path.join(tmp, KEY_FILE);
    const r = spawnSync(
      "ssh-keygen",
      ["-q", "-t", "ed25519", "-N", "", "-C", "den agents", "-f", key],
      {
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    if (r.error || r.status !== 0)
      throw new Error(
        `agents' signing key: ssh-keygen failed: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`,
      );
    const pub = fs.readFileSync(`${key}.pub`, "utf8").trim().split(/\s+/);
    fs.writeFileSync(
      path.join(tmp, "allowed_signers"),
      `${SIGNER} namespaces="git" ${pub[0]} ${pub[1] ?? ""}\n`,
      { mode: 0o644 },
    );
    d.beforePlace?.();
    try {
      // A rename onto a folder that has files in it fails: the winner's.
      fs.renameSync(tmp, final);
      return { ...keyIn(final), made: true };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!(code === "ENOTEMPTY" || code === "EEXIST") || !complete(final))
        throw e;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return keyIn(final);
}

/** The person's own git, at `cwd`: does it sign commits (repo, then global)? */
export function personSignsCommits(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const clean: NodeJS.ProcessEnv = { ...env };
  // Only the person's files: never a session's GIT_CONFIG_* pairs.
  for (const k of Object.keys(clean))
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(k))
      delete clean[k];
  const r = spawnSync(
    "git",
    ["config", "--type=bool", "--get", "commit.gpgsign"],
    {
      cwd: fs.existsSync(cwd) ? cwd : os.homedir(),
      env: clean,
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  return r.status === 0 && r.stdout.trim() === "true";
}

export interface ResolveSigningInput {
  git: AgentGitBlock | undefined;
  stateDir: string;
  /** The agent's working folder: its repo's own config counts. */
  cwd: string;
  /** The person's env (their HOME, so their ~/.gitconfig). */
  env?: NodeJS.ProcessEnv;
  /** Makes (or finds) the default key; doctor's only finds it. */
  ensure?: (stateDir: string) => AgentSigning | undefined;
}

/**
 * Which key an agent's session signs with (issue 1316):
 *   agents.git.signing: off      none: commits as git makes them
 *   agents.git.signing_key set   that key
 *   the person's git signs       the install's own key, made once
 *   otherwise                    none: nothing changes
 */
export function resolveAgentSigning(
  i: ResolveSigningInput,
): AgentSigning | undefined {
  if (i.git?.off) return undefined;
  if (i.git?.signingKey)
    return { signingKey: i.git.signingKey, source: "setting" };
  if (!personSignsCommits(i.cwd, i.env)) return undefined;
  return (i.ensure ?? ensureAgentSigningKey)(i.stateDir);
}

/**
 * The env an agent's session gets for it: git's own GIT_CONFIG_COUNT /
 * KEY_n / VALUE_n, which sit above every config file and write none.
 */
export function agentGitEnv(
  git: AgentGitSettings | undefined,
): Record<string, string> {
  if (!git) return {};
  const pairs: [string, string][] = [
    ["gpg.format", "ssh"],
    ["user.signingkey", git.signingKey],
    ["commit.gpgsign", "true"],
  ];
  if (git.allowedSigners)
    pairs.push(["gpg.ssh.allowedSignersFile", git.allowedSigners]);
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: String(pairs.length),
  };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/**
 * Issue 1316: the files of agents.git.signing_key a session reads, the key
 * and its .pub, wherever they are (the state dir too): exact paths, never
 * their folder. The default key's folder is read back as a whole.
 */
export function signingReadFiles(
  git: { signingKey?: string; off?: true } | undefined,
): string[] {
  if (!git?.signingKey || git.off) return [];
  return [git.signingKey, `${git.signingKey}.pub`];
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
  /**
   * Issue 1316: git runs as an agent's session would, in its sandbox
   * (sandboxFor's argv and env), so a key the sandbox hides fails here too.
   */
  wrap?: (argv: string[]) => { argv: string[]; env: Record<string, string> };
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
    const run = (args: string[]) => {
      const w = d.wrap
        ? d.wrap(["git", ...args])
        : { argv: ["git", ...args], env: {} };
      return spawnSync(w.argv[0], w.argv.slice(1), {
        cwd: fs.existsSync(repo) ? repo : dir,
        env: { ...env, ...w.env },
        encoding: "utf8",
        timeout: 20_000,
      });
    };
    const steps: [string, string[]][] = [
      ["git init", ["init", "-q", repo]],
      [
        "a signed commit",
        ["commit", "-q", "--allow-empty", "-m", "Den: signing check"],
      ],
      [
        "git verify-commit",
        [
          "-c",
          `gpg.ssh.allowedSignersFile=${allowed}`,
          "verify-commit",
          "HEAD",
        ],
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
    return {
      ok: true,
      detail: `commits sign with ${git.signingKey} and verify`,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
