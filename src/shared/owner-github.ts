/**
 * `web.owner_github` (D17): the GitHub login of the person who runs this
 * instance, recorded in config/local/user.yml at `web up` or `service
 * install` from `gh` when it is signed in here and no owner is linked yet.
 * With it, that person connects their GitHub account from any browser, on
 * any machine (a devbox they reach from a laptop), and nobody else can
 * claim the instance from another machine (github-routes.ts decideFlow).
 *
 * Only the login and the display name are kept (web.owner_github_name, or
 * the linked owner's web-owner.json): never a token. `gh api user` runs
 * once, at `web up`, with a short timeout, and only while the name isn't
 * known yet; gh missing or signed out records nothing.
 */
import { execFileSync } from "child_process";
import { readUserConfig, writeUserConfig } from "./den-config.js";
import { parseGithubName } from "./web-session.js";
import {
  githubDisplayName,
  readWebOwner,
  setWebOwnerName,
  type WebOwner,
} from "./web-owner.js";

/** Who `gh` is signed in as here: the login, and the display name if set. */
export interface GhUser {
  login: string;
  name?: string;
}

export interface OwnerGithubDeps {
  /** Who `gh` is signed in as here, or null (one `gh api user`). */
  ghUser?: () => GhUser | null;
  /** The login `gh` is signed in as here, or null (older callers). */
  ghLogin?: () => string | null;
  /** Whether an owner is linked already. */
  ownerLinked?: () => boolean;
  /** The linked owner (its display name, if kept). */
  readOwner?: () => WebOwner | null;
  /** Keep the linked owner's display name. */
  setOwnerName?: (login: string, name: string) => void;
  read?: typeof readUserConfig;
  write?: typeof writeUserConfig;
}

/**
 * `gh api user`'s login and display name, in one call, or null (gh
 * missing, signed out, slow, odd output). `bin` is gh's path (a test's
 * fake); by default the `gh` on PATH.
 */
export function ghUser(
  env: NodeJS.ProcessEnv = process.env,
  bin = "gh",
): GhUser | null {
  try {
    const out = execFileSync(
      bin,
      ["api", "user", "--jq", '[.login, (.name // "")] | @tsv'],
      {
        env,
        timeout: 8_000,
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      },
    );
    const [first = "", ...rest] = out.replace(/\n+$/, "").split("\t");
    const login = parseGithubName(first.trim(), "web.owner_github", "gh");
    if (!login) return null;
    const name = githubDisplayName(rest.join(" "));
    return { login, ...(name ? { name } : {}) };
  } catch {
    return null;
  }
}

/** `gh api user`'s login, or null (gh missing, signed out, slow, odd output). */
export function ghLogin(env: NodeJS.ProcessEnv = process.env): string | null {
  return ghUser(env)?.login ?? null;
}

/** The two logins are the same account's (GitHub logins ignore case). */
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type OwnerGithubResult =
  | { state: "linked" }
  | { state: "set"; login: string }
  | { state: "recorded"; login: string }
  | { state: "none" };

/**
 * Record `web.owner_github` from gh when no owner is linked and it isn't
 * set: `recorded`. Already set: `set`. An owner linked: `linked` (nothing
 * to do). gh can't say: `none`. Never throws.
 */
export function recordOwnerGithub(
  deps: OwnerGithubDeps = {},
): OwnerGithubResult {
  const gh = (): GhUser | null => {
    if (deps.ghUser) return deps.ghUser();
    if (deps.ghLogin) {
      const login = deps.ghLogin();
      return login ? { login } : null;
    }
    return ghUser();
  };
  try {
    if ((deps.ownerLinked ?? (() => readWebOwner() !== null))()) {
      // An owner linked before display names were kept: gh's, once, when
      // gh is signed in as that same owner.
      // (A caller that says only whether one is linked: nothing to read.)
      const owner = (
        deps.readOwner ?? (deps.ownerLinked ? () => null : () => readWebOwner())
      )();
      if (owner && !owner.name) {
        const u = gh();
        if (u?.name && same(u.login, owner.login))
          (deps.setOwnerName ?? ((l, n) => void setWebOwnerName(l, n)))(
            u.login,
            u.name,
          );
      }
      return { state: "linked" };
    }
    const read = deps.read ?? readUserConfig;
    const cfg = read();
    const web = { ...((cfg as { web?: Record<string, unknown> }).web ?? {}) };
    let set: string | undefined;
    try {
      set = parseGithubName(
        web.owner_github,
        "web.owner_github",
        "config/local/user.yml",
      );
    } catch {
      return { state: "none" }; // a value someone typed: leave it alone
    }
    if (set) {
      // The name kept with it (web.owner_github_name), once, from gh
      // signed in as that same login.
      if (!githubDisplayName(web.owner_github_name)) {
        const u = gh();
        if (u?.name && same(u.login, set)) {
          web.owner_github_name = u.name;
          (deps.write ?? writeUserConfig)({ ...cfg, web } as typeof cfg);
        }
      }
      return { state: "set", login: set };
    }
    const u = gh();
    if (!u) return { state: "none" };
    web.owner_github = u.login;
    if (u.name) web.owner_github_name = u.name;
    else delete web.owner_github_name;
    (deps.write ?? writeUserConfig)({ ...cfg, web } as typeof cfg);
    return { state: "recorded", login: u.login };
  } catch {
    return { state: "none" };
  }
}

/** The line `web up` and `service install` print, or null. */
export function ownerGithubLine(
  r: OwnerGithubResult,
  cli = "den",
): string | null {
  if (r.state === "recorded")
    return `GitHub owner: @${r.login} (from gh; web.owner_github in config/local/user.yml). Connect your GitHub account from any browser to sign in.`;
  if (r.state === "none") return ghNotSignedInHint(cli);
  return null;
}

/** No owner, no web.owner_github, and gh can't say who you are: the fix. */
export function ghNotSignedInHint(cli = "den"): string {
  return (
    "GitHub owner: not known, because gh isn't signed in here. " +
    `Run \`gh auth login\`, then \`${cli} web restart\`; or set web.owner_github: <your GitHub login> in config/local/user.yml. ` +
    "Then you can connect your GitHub account from any browser."
  );
}

export interface PublicNameDeps {
  /** GitHub's REST API base, no trailing slash (github-app.ts githubEndpoints). */
  api: string;
  /** Whether `api` is a test's fake GitHub on loopback. */
  fake?: boolean;
  fetch?: typeof fetch;
  /** How long GitHub may take to answer (web.owner_name_timeout_seconds; default 10 s). */
  timeoutMs?: number;
  readOwner?: () => WebOwner | null;
  /** Keep the linked owner's display name. */
  setOwnerName?: (login: string, name: string) => void;
  /**
   * Why no name was kept, in a few plain words (never the token, never
   * GitHub's whole answer). Not called when the owner already has a name,
   * or when no owner is linked yet: those are usual starts.
   */
  onSkip?: (why: string) => void;
  env?: NodeJS.ProcessEnv;
}

/**
 * Issue 406: an owner linked before display names were kept gets one, once,
 * from GitHub's public profile (`GET <api>/users/<login>`: no token, no
 * scope), at the server's start. Only while the owner has no name; only
 * when GitHub's answer is the same account (its id). In a test or CI run,
 * only a test's fake GitHub is ever asked. The name kept, or null. Never throws.
 */
export async function ownerNameFromGithub(
  deps: PublicNameDeps,
): Promise<string | null> {
  const skip = (why: string): null => {
    deps.onSkip?.(why);
    return null;
  };
  const timeoutMs = deps.timeoutMs ?? 10_000;
  try {
    const env = deps.env ?? process.env;
    // A test or CI run asks a fake GitHub only, never github.com.
    if ((env.JEST_WORKER_ID || env.CI || env.DEN_TEST_SENTINEL) && !deps.fake)
      return skip("a test or CI run asks only a fake GitHub");
    const owner = (deps.readOwner ?? (() => readWebOwner()))();
    if (!owner || owner.name) return null;
    const r = await (deps.fetch ?? fetch)(
      `${deps.api}/users/${encodeURIComponent(owner.login)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!r.ok) return skip(`GitHub answered ${r.status}`);
    const j = (await r.json()) as {
      id?: unknown;
      login?: unknown;
      name?: unknown;
    };
    const name = githubDisplayName(j.name);
    if (!name) return skip("GitHub's profile has no name");
    if (owner.owner !== `github:${String(j.id)}`)
      return skip("GitHub answered for someone else");
    try {
      (deps.setOwnerName ?? ((l, n) => void setWebOwnerName(l, n)))(
        owner.login,
        name,
      );
    } catch (err) {
      return skip(
        `the name couldn't be saved: ${String((err as Error)?.message ?? err).slice(0, 120)}`,
      );
    }
    return name;
  } catch (err) {
    const e = err as Error;
    return skip(
      e?.name === "TimeoutError"
        ? `GitHub didn't answer within ${timeoutMs / 1000} s`
        : `GitHub didn't answer: ${String(e?.message ?? err).slice(0, 120)}`,
    );
  }
}
