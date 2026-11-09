/**
 * `web.owner_github` (D17): the GitHub login of the person who runs this
 * instance, recorded in config/local/user.yml at `web up` or `service
 * install` from `gh` when it is signed in here and no owner is linked yet.
 * With it, that person connects their GitHub account from any browser, on
 * any machine (a devbox they reach from a laptop), and nobody else can
 * claim the instance from another machine (github-routes.ts decideFlow).
 *
 * Only the login is kept: never a token. `gh api user` runs with a short
 * timeout; gh missing or signed out records nothing.
 */
import { execFileSync } from "child_process";
import { readUserConfig, writeUserConfig } from "./den-config.js";
import { parseGithubName } from "./web-session.js";
import { readWebOwner } from "./web-owner.js";

export interface OwnerGithubDeps {
  /** The login `gh` is signed in as here, or null. */
  ghLogin?: () => string | null;
  /** Whether an owner is linked already. */
  ownerLinked?: () => boolean;
  read?: typeof readUserConfig;
  write?: typeof writeUserConfig;
}

/** `gh api user`'s login, or null (gh missing, signed out, slow, odd output). */
export function ghLogin(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const out = execFileSync("gh", ["api", "user", "--jq", ".login"], {
      env,
      timeout: 8_000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf-8",
    }).trim();
    return parseGithubName(out, "gh api user", "gh") ?? null;
  } catch {
    return null;
  }
}

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
  try {
    if ((deps.ownerLinked ?? (() => readWebOwner() !== null))())
      return { state: "linked" };
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
    if (set) return { state: "set", login: set };
    const login = (deps.ghLogin ?? ghLogin)();
    if (!login) return { state: "none" };
    web.owner_github = login;
    (deps.write ?? writeUserConfig)({ ...cfg, web } as typeof cfg);
    return { state: "recorded", login };
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
