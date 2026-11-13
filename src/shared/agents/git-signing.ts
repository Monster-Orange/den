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
  if (!git) return {};
  const pairs: [string, string][] = [
    ["gpg.format", "ssh"],
    ["user.signingkey", git.signingKey],
    ["commit.gpgsign", "true"],
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
