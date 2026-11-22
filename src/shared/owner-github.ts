/**
 * `web.owner_github` (D17): the GitHub login of the person who runs this
 * instance, recorded in config/local/user.yml at `web up` or `service
 * install` from `gh` when it is signed in here and no owner is linked yet.
 * With it, that person connects their GitHub account from any browser, on
 * any machine (a devbox they reach from a laptop), and nobody else can
 * claim the instance from another machine (github-routes.ts decideFlow).
 *
 * Only the login and the display name are kept: never a token. The login
 * is the person's setting (user.yml); the display name is Den's data, kept
 * in Den's state (issue 315: owner-github-name.json, or the linked owner's
 * web-owner.json), never in the person's user.yml. `gh api user` runs
 * once, at `web up`, with a short timeout, and only while the name isn't
 * known yet; gh missing or signed out records nothing.
 */
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { readUserConfig, writeUserConfig } from "./den-config.js";
import { getStateDir } from "./paths.js";
import { parseGithubName } from "./web-session.js";
import {
  githubDisplayName,
  readWebOwner,
  setWebOwnerName,
  type WebOwner,
} from "./web-owner.js";

/** Issue 315: the display name kept with web.owner_github, in Den's state. */
export const OWNER_GITHUB_NAME_FILE = "owner-github-name.json";

/** web.owner_github's display name as kept: the login it is for, and it. */
export interface OwnerGithubName {
  login: string;
  name: string;
}

/** The kept name, or null (none, or a file that isn't one). */
export function readOwnerGithubName(
  stateDir: string = getStateDir(),
): OwnerGithubName | null {
  try {
    const o = JSON.parse(
      fs.readFileSync(path.join(stateDir, OWNER_GITHUB_NAME_FILE), "utf-8"),
    ) as { login?: unknown; name?: unknown } | null;
    const name = githubDisplayName(o?.name);
    if (!o || typeof o.login !== "string" || !o.login || !name) return null;
    return { login: o.login, name };
  } catch {
    return null;
  }
}

/** Keep `login`'s display name (atomic, 0600); no name: forget it. */
export function writeOwnerGithubName(
  login: string,
  name: string | undefined,
  stateDir: string = getStateDir(),
): void {
  const file = path.join(stateDir, OWNER_GITHUB_NAME_FILE);
  const n = githubDisplayName(name);
  if (!n) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, login, name: n })}\n`, {
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
}

/** The kept name when it is `login`'s (logins ignore case), else undefined. */
function keptNameOf(
  login: string,
  kept: OwnerGithubName | null,
): string | undefined {
  return kept && kept.login.toLowerCase() === login.toLowerCase()
    ? kept.name
    : undefined;
}

/**
 * The install owner's identity for a browser on the Den machine: the
 * linked owner (web-owner.json), else web.owner_github with the name Den
 * keeps for it (issue 315), else an old user.yml name not moved yet.
 * Files only: no gh call. Null: none known.
 */
export function localOwnerIdentity(
  web: { ownerGithub?: string; ownerGithubName?: string },
  stateDir: string = getStateDir(),
): { login: string; name?: string; role: "owner" } | null {
  const linked = readWebOwner(stateDir);
  if (linked)
    return {
      login: linked.login,
      ...(linked.name ? { name: linked.name } : {}),
      role: "owner",
    };
  if (!web.ownerGithub) return null;
  const name =
    keptNameOf(web.ownerGithub, readOwnerGithubName(stateDir)) ??
    web.ownerGithubName;
  return { login: web.ownerGithub, ...(name ? { name } : {}), role: "owner" };
}

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
  /** The name kept with web.owner_github (Den's state). */
  readName?: () => OwnerGithubName | null;
  /** Keep (or, with none, forget) the name for a login (Den's state). */
  writeName?: (login: string, name?: string) => void;
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
    const write = deps.write ?? writeUserConfig;
    const readName = deps.readName ?? (() => readOwnerGithubName());
    const writeName =
      deps.writeName ?? ((l: string, n?: string) => writeOwnerGithubName(l, n));
    let cfg = read();
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
    // Issue 315: a name an older Den kept in user.yml moves to Den's
    // state once; user.yml never holds it again.
    if ("owner_github_name" in web) {
      const old = githubDisplayName(web.owner_github_name);
      if (set && old && !keptNameOf(set, readName())) writeName(set, old);
      delete web.owner_github_name;
      cfg = { ...cfg, web } as typeof cfg;
      write(cfg);
    }
    if (set) {
      // The name kept with it, once, from gh signed in as that same login.
      if (!keptNameOf(set, readName())) {
        const u = gh();
        if (u?.name && same(u.login, set)) writeName(set, u.name);
      }
      return { state: "set", login: set };
    }
    const u = gh();
    if (!u) return { state: "none" };
    web.owner_github = u.login;
    write({ ...cfg, web } as typeof cfg);
    writeName(u.login, u.name);
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
  try {
    const env = deps.env ?? process.env;
    // A test or CI run asks a fake GitHub only, never github.com.
    if ((env.JEST_WORKER_ID || env.CI || env.DEN_TEST_SENTINEL) && !deps.fake)
      return null;
    const owner = (deps.readOwner ?? (() => readWebOwner()))();
    if (!owner || owner.name) return null;
    const r = await (deps.fetch ?? fetch)(
      `${deps.api}/users/${encodeURIComponent(owner.login)}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
      },
    );
    if (!r.ok) return null;
    const j = (await r.json()) as {
      id?: unknown;
      login?: unknown;
      name?: unknown;
    };
    const name = githubDisplayName(j.name);
    if (!name || owner.owner !== `github:${String(j.id)}`) return null;
    (deps.setOwnerName ?? ((l, n) => void setWebOwnerName(l, n)))(
      owner.login,
      name,
    );
    return name;
  } catch {
    return null;
  }
}
