/**
 * SEC-1b (SEC-1 spec §2): the browser's sign-in.
 *
 *  - The login code: one-time, valid for `web.login_link_ttl` (D16: 5
 *    minutes unless set; it was 60 s), derived from web.secret.
 *    `v1.<nonce>.<expiry>.<mac>`, the mac HMAC-SHA256(secret, the rest). The
 *    CLI mints it (it reads the secret as the same OS user); the server
 *    checks the mac in constant time and the expiry, and records the nonce
 *    as used, so a second use is refused. It is printed only on the one
 *    link line a person asked for, and never logged (the request log
 *    records the path, never the query).
 *  - The session: an opaque random id in the `den_session_<port>` cookie;
 *    the record lives in `<state dir>/web-sessions.json` (0600), keyed by
 *    HMAC(secret, id), so the file holds no cookie value and rotating the
 *    secret (`web logout --all`) ends every session at once.
 *  - Lifetime: none (Ward, 2026-11-06). A session ends only at sign-out,
 *    `web logout [<id>]`, or `web logout --all` (which rotates the secret).
 *    The 0.4.1-dev `web.session.idle` / `web.session.max` keys are ignored,
 *    with a warning at start.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { parseMachineName, parseSshUser } from "./cli-command.js";
import { getStateDir } from "./paths.js";
import { githubDisplayName } from "./web-owner.js";
import { writeFileAtomic } from "./atomic-write.js";

/** D16: how long a sign-in link lasts unless `web.login_link_ttl` says. */
export const LOGIN_CODE_TTL_MS = 5 * 60_000;
/** The longest `web.login_link_ttl` may be (and the most a code is believed). */
export const LOGIN_CODE_MAX_TTL_MS = 60 * 60_000;
/** The shortest `web.login_link_ttl` may be. */
export const LOGIN_CODE_MIN_TTL_MS = 30_000;
/** Clock skew allowed between the CLI that mints a code and the server. */
const LOGIN_CODE_SKEW_MS = 5_000;
const LOGIN_CONTEXT = "den-login-v1:";
const SESSION_CONTEXT = "den-session-v1:";
export const WEB_SESSIONS_FILE = "web-sessions.json";

/**
 * Issue 1300: held while a process other than the server changes the
 * sessions file (`web logout` with no server running). It holds the
 * holder's pid. A lock whose pid no longer runs is taken over.
 */
export const WEB_SESSIONS_LOCK = "web-sessions.lock";

/** Issue 1300: another running process holds the sessions lock. */
export class WebSessionsBusy extends Error {
  constructor(readonly holder: number) {
    super(
      `the sessions file is in use by another process${holder ? ` (pid ${holder})` : ""}; nothing was changed. Try again.`,
    );
    this.name = "WebSessionsBusy";
  }
}

/** Issue 1300: a lock with no pid in it this old was left by a crash. */
const LOCK_UNREAD_STALE_MS = 5_000;

function lockOlderThan(file: string, ms: number): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > ms;
  } catch {
    return true;
  }
}

/** Whether `pid` runs (EPERM: it runs, as another user). */
function pidRuns(pid: number): boolean {
  if (!(Number.isInteger(pid) && pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Issue 1300: the one session whose key starts with `prefix` (4 hex at
 * least). Throws when the prefix isn't one, or none or several match.
 */
export function sessionByPrefix(
  all: SessionView[],
  prefix: string,
): SessionView {
  const p = prefix.trim().toLowerCase();
  if (!/^[0-9a-f]{4,64}$/.test(p))
    throw new Error(
      `"${prefix}" is not a session id prefix (4 or more hex characters, as \`web sessions\` lists them)`,
    );
  const hits = all.filter((s) => s.key.startsWith(p));
  if (hits.length === 0) throw new Error(`No browser session starts with ${p}`);
  if (hits.length > 1)
    throw new Error(
      `${hits.length} browser sessions start with ${p}; give more of the id`,
    );
  return hits[0];
}
/**
 * lastSeenAt is written at most this often per session (so a page load
 * doesn't rewrite the file): `web sessions` shows it to the minute.
 */
export const SESSION_TOUCH_MS = 60_000;
const TOUCH_EVERY_MS = SESSION_TOUCH_MS;
const UA_MAX = 120;

/**
 * The cookie's Max-Age: the most a browser keeps one (RFC 6265bis caps it
 * at 400 days). The session itself never expires server-side.
 */
export const SESSION_COOKIE_MAX_AGE_S = 400 * 86_400;

/** The cookie's name: per port, so two distributions on one machine never share one. */
export function sessionCookieName(port: number): string {
  return `den_session_${port}`;
}

// ── The login code ─────────────────────────────────────────────────────────

function mac(secret: Buffer, body: string): Buffer {
  return createHmac("sha256", secret)
    .update(LOGIN_CONTEXT + body)
    .digest();
}

/** A fresh login code, valid for `ttlMs` (web.login_link_ttl) from `now`. */
export function mintLoginCode(
  secret: Buffer,
  now: number = Date.now(),
  ttlMs: number = LOGIN_CODE_TTL_MS,
): string {
  const nonce = randomBytes(16).toString("base64url");
  const body = `v1.${nonce}.${(now + ttlMs).toString(36)}`;
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

export type LoginCodeCheck =
  | { ok: true; nonce: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "bad_mac" | "expired" };

/**
 * Whether `code` is one this secret minted and still in its time (at most
 * LOGIN_CODE_MAX_TTL_MS: web.login_link_ttl's ceiling). The mac is
 * compared in constant time. Single use is the caller's (consumeCode).
 */
export function checkLoginCode(
  code: string,
  secret: Buffer,
  now: number = Date.now(),
): LoginCodeCheck {
  const m =
    /^(v1\.([A-Za-z0-9_-]{22})\.([0-9a-z]{1,11}))\.([A-Za-z0-9_-]{43})$/.exec(
      code,
    );
  if (!m) return { ok: false, reason: "malformed" };
  const given = Buffer.from(m[4], "base64url");
  const want = mac(secret, m[1]);
  if (given.length !== want.length || !timingSafeEqual(given, want))
    return { ok: false, reason: "bad_mac" };
  const expiresAt = parseInt(m[3], 36);
  if (
    !Number.isFinite(expiresAt) ||
    now >= expiresAt ||
    expiresAt - now > LOGIN_CODE_MAX_TTL_MS + LOGIN_CODE_SKEW_MS
  )
    return { ok: false, reason: "expired" };
  return { ok: true, nonce: m[2], expiresAt };
}

/** A login code's nonce, from its shape alone (unverified), or null. */
export function loginCodeNonce(code: string): string | null {
  const m = /^v1\.([A-Za-z0-9_-]{22})\.[0-9a-z]{1,11}\.[A-Za-z0-9_-]{43}$/.exec(
    code,
  );
  return m ? m[1] : null;
}

/**
 * Where a sign-in may send the browser: a same-origin relative path, else
 * `/`. `//evil`, `/\evil`, `http://evil`, a control character or a path back
 * to /auth all go to `/`.
 */
export function safeNext(raw: string | null | undefined): string {
  const v = String(raw ?? "");
  const control = [...v].some((c) => c.charCodeAt(0) < 0x20 || c === "\x7f");
  if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\") || control)
    return "/";
  let u: URL;
  try {
    u = new URL(v, "http://den.invalid");
  } catch {
    return "/";
  }
  if (u.origin !== "http://den.invalid") return "/";
  if (u.pathname === "/auth") return "/";
  return `${u.pathname}${u.search}${u.hash}`;
}

/** The sign-in link: `<origin>/auth?c=<code>&next=<path>`. */
export function loginLink(origin: string, code: string, next = "/"): string {
  const n = safeNext(next);
  return (
    `${origin.replace(/\/+$/, "")}/auth?c=${encodeURIComponent(code)}` +
    (n === "/" ? "" : `&next=${encodeURIComponent(n)}`)
  );
}

/** `http://localhost:<port>`: the canonical loopback origin (§2). */
export function localhostOrigin(port: number): string {
  // eslint-disable-next-line no-restricted-syntax -- a browser's origin (cookies are per name), not dialled by Den
  return `http://localhost:${port}`;
}

/**
 * An origin a person passed to `web login --origin`: http(s), a host, no
 * path, query or credentials. Null when it isn't one.
 */
export function parseOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname && u.pathname !== "/") return null;
  return u.origin;
}

// ── Remote-access config ───────────────────────────────────────────────────

export interface WebAuthConfig {
  /** `web.allow_plain_http_remote` (config/local/user.yml only). */
  allowPlainHttpRemote: boolean;
  /**
   * Config keys read and ignored, each with its file: the 0.4.1-dev
   * session lifetimes (`web.session.idle`, `web.session.max`), since a
   * session never expires. The server warns about each at start.
   */
  ignored: string[];
  /**
   * The distribution config's file when it sets
   * `web.allow_plain_http_remote`: ignored there (a per-machine choice,
   * never the distribution's), and warned about at start.
   */
  plainHttpInDistribution?: string;
  /**
   * `web.github_client_id` (SEC-2a): the GitHub App whose device flow signs
   * the owner in. user.yml over the distribution config; unset: the MO Den
   * app's (github-app.ts).
   */
  githubClientId?: string;
  /**
   * `web.edge_unattested` (SEC-2a, user.yml only): what an edge request
   * whose client Den can't place gets. `signin` (the default): it signs in;
   * `local`: it is treated as this machine (0.4.4's allow).
   */
  edgeUnattested: EdgeUnattested;
  /** The distribution config's file when it sets `web.edge_unattested`: ignored there. */
  edgeUnattestedInDistribution?: string;
  /**
   * `web.bridge_listen` (0.4.48; user.yml over the distribution's): on
   * Linux with an edge here, also listen on the Docker bridge's gateway
   * address, for the edge. `auto` (the default) or `off`.
   */
  bridgeListen: "auto" | "off";
  /** `web.bridge_probe_seconds`: how long the bridge probe waits (default 10). */
  bridgeProbeSeconds: number;
  /**
   * `web.owner_name_timeout_seconds` (issue 406): how long the start waits
   * for the owner's public GitHub profile (default 10).
   */
  ownerNameTimeoutSeconds: number;
  /**
   * `web.ready_probe_seconds` (den#143; user.yml over the distribution's):
   * how long one readiness probe of `web up` (and of every "is Den
   * running here" check) waits for the server's answer. Default 10: a busy
   * machine answers late, and a late answer is still a running server.
   */
  readyProbeSeconds: number;
  /**
   * `web.start_wait_seconds` (den#143): how long `web up` waits for a
   * server it started to be ready. Default 120. A server that exits stops
   * the wait at once.
   */
  startWaitSeconds: number;
  /**
   * Issue 819: `web.pair_requests_per_minute` (user.yml over the
   * distribution's): how many new-device requests one client address may
   * make a minute. Default 30.
   */
  pairRequestsPerMinute: number;
  /**
   * Issue 819: `web.approve_attempts` and `web.approve_window_seconds`: how
   * many wrong codes a signed-in browser may type within the window before
   * approving waits for it to pass. Defaults 10 and 30 s: short, so a
   * person mistyping is never held up for long.
   */
  approveAttempts: number;
  approveWindowSeconds: number;
  /**
   * `web.machine_name` (SEC-2a, user.yml only): the name the signed-out
   * page gives this machine ("runs on <name>"). Unset: the short hostname.
   */
  machineName?: string;
  /**
   * `web.ssh_user` (SEC-2a-UX; user.yml, else the distribution's): the
   * account the signed-out page's ssh link logs in as. Unset: the account
   * Den runs as. "": no account on the page.
   */
  sshUser?: string;
  /**
   * `web.owner_github` (D17, user.yml only): the GitHub login of the person
   * who runs this instance, recorded from `gh` at `web up` or `service
   * install`. With no owner linked, that login's GitHub sign-in, from any
   * machine, becomes the owner.
   */
  ownerGithub?: string;
  /**
   * `web.owner_github_name` (user.yml only): that person's GitHub display
   * name, kept with the login from the same `gh api user` (the account
   * entry on a browser on this machine). Unset: none known.
   */
  ownerGithubName?: string;
  /**
   * `web.allowed_github_org` (D17; the distribution config, or user.yml):
   * with no owner linked, a member of this GitHub org who proves they are
   * at this machine ("This is my computer") becomes the owner.
   */
  allowedGithubOrg?: string;
  /** The file `web.allowed_github_org` came from. */
  allowedGithubOrgFile?: string;
  /**
   * `web.login_link_ttl` (D16; user.yml over the distribution config): how
   * long a sign-in link lasts, in ms. Unset: LOGIN_CODE_TTL_MS (5 minutes).
   */
  loginLinkTtlMs: number;
  /**
   * Issue 810: `web.test_install: true`, from the distribution config only:
   * a person marks a test install by hand, and only then may live checks
   * sign in as the fixture person (fixture-person.ts). Never written by
   * Settings, `config` or any agent.
   */
  testInstall: boolean;
  /** `web.test_install` in user.yml: ignored there (warned at start). */
  testInstallInUser?: true;
  /**
   * Issue 1210: `web.fixture_person: { name, login }`, from the distribution
   * config only: an invented name and login the rail shows for the fixture
   * person on a test install. Never a real person's; never in the audit.
   */
  fixturePerson?: FixturePersonName;
  /** `web.fixture_person` ignored (in user.yml, or a wrong value), with why. */
  fixturePersonIgnored?: { file: string; why: string };
  /**
   * Issue 810: `web.fixture_session_minutes` (user.yml over the
   * distribution's): how long a fixture person's session lasts.
   */
  fixtureSessionMinutes: number;
  /**
   * Issue 796: `web.agent_view` (user.yml over the distribution's): an
   * agent may open a read-only view of this Den's pages (agent-view.ts).
   * On unless set to false.
   */
  agentView: boolean;
  /** Issue 796: `web.agent_view_minutes`: how long an agent's view lasts. */
  agentViewMinutes: number;
}

/** Issue 796: `web.agent_view_minutes`' default (agent-view.ts). */
export const AGENT_VIEW_MINUTES = 10;
/** Its bounds, in minutes. */
export const AGENT_VIEW_RANGE = { min: 1, max: 60 } as const;

/** Issue 810: `web.fixture_session_minutes`' default. */
export const FIXTURE_SESSION_MINUTES = 60;
/** Its bounds, in minutes. */
export const FIXTURE_SESSION_RANGE = { min: 1, max: 24 * 60 } as const;

/** Issue 1210: the fixture person's invented name and login. */
export interface FixturePersonName {
  name: string;
  login: string;
}

/** `web.fixture_person`'s name: at most this many characters. */
export const FIXTURE_PERSON_NAME_MAX = 64;

/**
 * Issue 1210: `web.fixture_person` from one file, or why it is ignored. A
 * wrong value never throws: on an install that isn't a test install it must
 * do nothing, so it is warned about at start instead.
 */
export function parseFixturePerson(
  v: unknown,
): { person: FixturePersonName } | { why: string } | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v))
    return { why: "must be a map with name and login" };
  const o = v as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  const login = typeof o.login === "string" ? o.login.trim() : "";
  if (!name) return { why: "needs a name" };
  if (name.length > FIXTURE_PERSON_NAME_MAX)
    return {
      why: `name must be at most ${FIXTURE_PERSON_NAME_MAX} characters`,
    };
  if (
    name.includes("@") ||
    [...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  )
    return { why: "name must be one line, with no @" };
  if (!login) return { why: "needs a login" };
  if (!GITHUB_NAME.test(login))
    return { why: "login must be letters, digits and dashes, at most 39" };
  return { person: { name, login } };
}

/** A GitHub login (or org name): letters, digits, single dashes, ≤ 39. */
const GITHUB_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** `web.owner_github` or `web.allowed_github_org`: a GitHub name, or unset. */
export function parseGithubName(
  v: unknown,
  key: string,
  file: string,
): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === "string" ? v.trim().replace(/^@/, "") : "";
  if (s === "" && typeof v === "string") return undefined;
  if (!GITHUB_NAME.test(s))
    throw new Error(
      `${key} (${file}) must be a GitHub name (letters, digits and dashes), got ${JSON.stringify(v)}`,
    );
  return s;
}

/**
 * `web.login_link_ttl`: `90s`, `5m`, `1h`, or a number of seconds, between
 * 30 s and 60 min. Unset: undefined. Throws naming the key otherwise.
 */
export function parseLoginLinkTtl(
  v: unknown,
  file: string,
): number | undefined {
  if (v === undefined || v === null) return undefined;
  const m =
    typeof v === "number"
      ? [String(v), String(v), "s"]
      : typeof v === "string"
        ? /^\s*(\d+)\s*(s|m|h)?\s*$/i.exec(v)
        : null;
  const ms = m
    ? Number(m[1]) *
      ({ s: 1000, m: 60_000, h: 3_600_000 } as Record<string, number>)[
        (m[2] ?? "s").toLowerCase()
      ]
    : NaN;
  if (
    !Number.isFinite(ms) ||
    ms < LOGIN_CODE_MIN_TTL_MS ||
    ms > LOGIN_CODE_MAX_TTL_MS
  )
    throw new Error(
      `web.login_link_ttl (${file}) must be a time between 30s and 60m (such as 5m), got ${JSON.stringify(v)}`,
    );
  return ms;
}

/** `web.edge_unattested`'s values. */
export type EdgeUnattested = "local" | "signin";

function readYaml(file: string): Record<string, unknown> {
  try {
    const v = yaml.parse(fs.readFileSync(file, "utf-8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

function webBlock(doc: Record<string, unknown>, file: string) {
  const w = doc.web;
  if (w === undefined || w === null) return {};
  if (typeof w !== "object" || Array.isArray(w))
    throw new Error(`web must be a map in ${file}`);
  return w as Record<string, unknown>;
}

/** `web.session`'s keys in one file, as `web.session.<key> (<file>)`. */
function ignoredSessionKeys(
  w: Record<string, unknown>,
  file: string,
): string[] {
  const s = w.session;
  if (s === undefined) return [];
  if (s === null || typeof s !== "object" || Array.isArray(s))
    return [`web.session (${file})`];
  const keys = Object.keys(s);
  return keys.length
    ? keys.map((k) => `web.session.${k} (${file})`)
    : [`web.session (${file})`];
}

/**
 * Issue 1210: doctor's line when web.fixture_person is set on an install
 * that isn't marked a test install (it does nothing there), or null.
 */
export function fixturePersonOffInstallWarning(
  cfg: WebAuthConfig,
): string | null {
  return cfg.fixturePerson && !cfg.testInstall
    ? "web.fixture_person is set, but this install isn't marked " +
        "web.test_install: true, so it does nothing here. Remove it, or " +
        "mark the test install by hand."
    : null;
}

/** The start-up warning for the ignored keys, or null when there are none. */
export function ignoredConfigWarning(cfg: WebAuthConfig): string | null {
  const lines: string[] = [];
  if (cfg.ignored.length)
    lines.push(
      `${cfg.ignored.join(", ")}: ignored. A browser session never expires; ` +
        "it ends at sign-out or `web logout`. Remove the key to silence this.",
    );
  if (cfg.edgeUnattestedInDistribution)
    lines.push(
      `web.edge_unattested (${cfg.edgeUnattestedInDistribution}): ignored. ` +
        "It is a choice for one machine, read only from config/local/user.yml; " +
        "move it there on the machine that needs it, and remove it here.",
    );
  if (cfg.testInstallInUser)
    lines.push(
      "web.test_install (config/local/user.yml): ignored. A test install is marked " +
        "by hand in the distribution config only; remove it here.",
    );
  if (cfg.fixturePersonIgnored)
    lines.push(
      `web.fixture_person (${cfg.fixturePersonIgnored.file}): ignored, ` +
        `${cfg.fixturePersonIgnored.why}. It is set by hand in the distribution ` +
        "config only, next to web.test_install.",
    );
  if (cfg.plainHttpInDistribution)
    lines.push(
      `web.allow_plain_http_remote (${cfg.plainHttpInDistribution}): ignored. ` +
        "It is a choice for one machine, read only from config/local/user.yml; " +
        "move it there on the machine that needs it, and remove it here.",
    );
  return lines.length ? lines.join("\n  ") : null;
}

/**
 * `web.allow_plain_http_remote` (user.yml only: a choice for this machine,
 * never the distribution's), and the ignored `web.session` keys of either
 * file. Throws naming the key when a value is wrong.
 */
export function readWebAuthConfig(
  root: string,
  configFile = path.join("config", "den.yml"),
): WebAuthConfig {
  const teamFile = path.join(root, configFile);
  const userFile = path.join(root, "config", "local", "user.yml");
  const team = webBlock(readYaml(teamFile), configFile);
  const user = webBlock(readYaml(userFile), "config/local/user.yml");
  const ignored = [
    ...ignoredSessionKeys(team, configFile),
    ...ignoredSessionKeys(user, "config/local/user.yml"),
  ];
  const plain = user.allow_plain_http_remote;
  if (plain !== undefined && typeof plain !== "boolean")
    throw new Error(
      `web.allow_plain_http_remote must be true or false, got ${JSON.stringify(plain)}`,
    );
  const unattested = user.edge_unattested;
  if (
    unattested !== undefined &&
    unattested !== "local" &&
    unattested !== "signin"
  )
    throw new Error(
      `web.edge_unattested must be local or signin, got ${JSON.stringify(unattested)}`,
    );
  const bridge = user.bridge_listen ?? team.bridge_listen;
  if (bridge !== undefined && bridge !== "auto" && bridge !== "off")
    throw new Error(
      `web.bridge_listen must be auto or off, got ${JSON.stringify(bridge)}`,
    );
  const probe = user.bridge_probe_seconds ?? team.bridge_probe_seconds;
  if (
    probe !== undefined &&
    (typeof probe !== "number" || !Number.isFinite(probe) || probe <= 0)
  )
    throw new Error(
      `web.bridge_probe_seconds must be a number of seconds above 0, got ${JSON.stringify(probe)}`,
    );
  const nameWait =
    user.owner_name_timeout_seconds ?? team.owner_name_timeout_seconds;
  if (
    nameWait !== undefined &&
    (typeof nameWait !== "number" ||
      !Number.isFinite(nameWait) ||
      nameWait <= 0)
  )
    throw new Error(
      `web.owner_name_timeout_seconds must be a number of seconds above 0, got ${JSON.stringify(nameWait)}`,
    );
  const readyProbe = waitSeconds(user, team, "ready_probe_seconds");
  const startWait = waitSeconds(user, team, "start_wait_seconds");
  const pairLimits = Object.fromEntries(
    Object.entries(PAIR_LIMITS).map(([k, l]) => {
      const v = user[k] ?? team[k];
      if (v === undefined || v === null) return [k, l.dflt];
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        (l.int && !Number.isInteger(v)) ||
        v < l.min ||
        v > l.max
      )
        throw new Error(
          `web.${k} must be a ${l.int ? "whole number" : "number"} from ${l.min} to ${l.max}, got ${JSON.stringify(v)}`,
        );
      return [k, v];
    }),
  ) as Record<keyof typeof PAIR_LIMITS, number>;
  const clientId =
    clientIdOf(user, "config/local/user.yml") ?? clientIdOf(team, configFile);
  const machineName = parseMachineName(user.machine_name);
  const sshUser =
    user.ssh_user !== undefined
      ? parseSshUser(user.ssh_user)
      : parseSshUser(team.ssh_user);
  const ownerGithub = parseGithubName(
    user.owner_github,
    "web.owner_github",
    "config/local/user.yml",
  );
  const ownerGithubName = githubDisplayName(user.owner_github_name);
  const userOrg = parseGithubName(
    user.allowed_github_org,
    "web.allowed_github_org",
    "config/local/user.yml",
  );
  const teamOrg = parseGithubName(
    team.allowed_github_org,
    "web.allowed_github_org",
    configFile,
  );
  const allowedGithubOrg = userOrg ?? teamOrg;
  const ttl =
    parseLoginLinkTtl(user.login_link_ttl, "config/local/user.yml") ??
    parseLoginLinkTtl(team.login_link_ttl, configFile);
  const testMark = team.test_install;
  if (
    testMark !== undefined &&
    testMark !== null &&
    typeof testMark !== "boolean"
  )
    throw new Error(
      `web.test_install (${configFile}) must be true or false, got ${JSON.stringify(testMark)}`,
    );
  const fxMin = user.fixture_session_minutes ?? team.fixture_session_minutes;
  if (
    fxMin !== undefined &&
    fxMin !== null &&
    (typeof fxMin !== "number" ||
      !Number.isInteger(fxMin) ||
      fxMin < FIXTURE_SESSION_RANGE.min ||
      fxMin > FIXTURE_SESSION_RANGE.max)
  )
    throw new Error(
      `web.fixture_session_minutes must be a whole number of minutes from ${FIXTURE_SESSION_RANGE.min} to ${FIXTURE_SESSION_RANGE.max}, got ${JSON.stringify(fxMin)}`,
    );
  const av = user.agent_view ?? team.agent_view;
  if (av !== undefined && av !== null && typeof av !== "boolean")
    throw new Error(
      `web.agent_view must be true or false, got ${JSON.stringify(av)}`,
    );
  const avMin = user.agent_view_minutes ?? team.agent_view_minutes;
  if (
    avMin !== undefined &&
    avMin !== null &&
    (typeof avMin !== "number" ||
      !Number.isInteger(avMin) ||
      avMin < AGENT_VIEW_RANGE.min ||
      avMin > AGENT_VIEW_RANGE.max)
  )
    throw new Error(
      `web.agent_view_minutes must be a whole number of minutes from ${AGENT_VIEW_RANGE.min} to ${AGENT_VIEW_RANGE.max}, got ${JSON.stringify(avMin)}`,
    );
  const fxUser = parseFixturePerson(user.fixture_person);
  const fxTeam = parseFixturePerson(team.fixture_person);
  const fixturePersonIgnored = fxUser
    ? {
        file: "config/local/user.yml",
        why: "a test install's settings are not read from this file",
      }
    : fxTeam && "why" in fxTeam
      ? { file: configFile, why: fxTeam.why }
      : undefined;
  return {
    testInstall: testMark === true,
    ...(fxTeam && "person" in fxTeam ? { fixturePerson: fxTeam.person } : {}),
    ...(fixturePersonIgnored ? { fixturePersonIgnored } : {}),
    agentView: av !== false,
    agentViewMinutes: typeof avMin === "number" ? avMin : AGENT_VIEW_MINUTES,
    fixtureSessionMinutes:
      typeof fxMin === "number" ? fxMin : FIXTURE_SESSION_MINUTES,
    ...(user.test_install !== undefined
      ? { testInstallInUser: true as const }
      : {}),
    ...(ownerGithub ? { ownerGithub } : {}),
    ...(ownerGithub && ownerGithubName ? { ownerGithubName } : {}),
    ...(allowedGithubOrg
      ? {
          allowedGithubOrg,
          allowedGithubOrgFile: userOrg ? "config/local/user.yml" : configFile,
        }
      : {}),
    loginLinkTtlMs: ttl ?? LOGIN_CODE_TTL_MS,
    ...(machineName ? { machineName } : {}),
    ...(sshUser !== undefined ? { sshUser } : {}),
    allowPlainHttpRemote: plain === true,
    ignored,
    edgeUnattested: unattested ?? "signin",
    bridgeListen: bridge ?? "auto",
    bridgeProbeSeconds: probe ?? 10,
    ownerNameTimeoutSeconds: nameWait ?? 10,
    readyProbeSeconds: readyProbe ?? WEB_READY_PROBE_SECONDS,
    startWaitSeconds: startWait ?? WEB_START_WAIT_SECONDS,
    pairRequestsPerMinute: pairLimits.pair_requests_per_minute,
    approveAttempts: pairLimits.approve_attempts,
    approveWindowSeconds: pairLimits.approve_window_seconds,
    ...(clientId !== undefined ? { githubClientId: clientId } : {}),
    ...(team.allow_plain_http_remote !== undefined
      ? { plainHttpInDistribution: configFile }
      : {}),
    ...(team.edge_unattested !== undefined
      ? { edgeUnattestedInDistribution: configFile }
      : {}),
  };
}

/**
 * Issue 819: the new-device limits (user.yml web.*, over the
 * distribution's): their ranges and permissive defaults.
 */
export const PAIR_LIMITS = {
  pair_requests_per_minute: { min: 1, max: 10_000, int: true, dflt: 30 },
  approve_attempts: { min: 1, max: 1000, int: true, dflt: 10 },
  approve_window_seconds: { min: 1, max: 3600, int: false, dflt: 30 },
} as const;

/** den#143: `web.ready_probe_seconds`'s default. */
export const WEB_READY_PROBE_SECONDS = 10;
/** den#143: `web.start_wait_seconds`'s default. */
export const WEB_START_WAIT_SECONDS = 120;
/** den#143: the readiness waits' range, in seconds. */
export const WEB_WAIT_RANGE = { min: 1, max: 3600 } as const;

/**
 * den#143: one of `web up`'s waits (user.yml over the distribution's), in
 * seconds, or unset. A wrong value throws, naming the key.
 */
function waitSeconds(
  user: Record<string, unknown>,
  team: Record<string, unknown>,
  key: "ready_probe_seconds" | "start_wait_seconds",
): number | undefined {
  const v = user[key] ?? team[key];
  if (v === undefined || v === null) return undefined;
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < WEB_WAIT_RANGE.min ||
    v > WEB_WAIT_RANGE.max
  )
    throw new Error(
      `web.${key} must be a number of seconds from ${WEB_WAIT_RANGE.min} to ${WEB_WAIT_RANGE.max}, got ${JSON.stringify(v)}`,
    );
  return v;
}

/** `web.github_client_id` in one file: a GitHub App client id, or unset. */
function clientIdOf(
  w: Record<string, unknown>,
  file: string,
): string | undefined {
  const v = w.github_client_id;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !/^[A-Za-z0-9._-]{0,64}$/.test(v.trim()))
    throw new Error(
      `web.github_client_id (${file}) must be a GitHub App client id (letters, digits, dots, dashes), got ${JSON.stringify(v)}`,
    );
  return v.trim();
}

// ── The approval key (0.4.15) ─────────────────────────────────────────────

/**
 * Why a cookie alone can't approve an agent's change: browsers send a
 * localhost cookie to every localhost port (cookies ignore ports), so a
 * dev server an agent runs on another port receives Den's session cookie,
 * and GET /api/session gives any cookie holder the session's CSRF token.
 * The approval key is a second secret only the signed-in page holds: it
 * comes in the sign-in's own answer (a 303's URL fragment, which never
 * reaches a server, or the sign-in poll's JSON), the page keeps it in its
 * localStorage (per origin, port included), and sends it as
 * X-Den-Approve-Key.
 */
export const APPROVE_KEY_HEADER = "x-den-approve-key";
/** The fragment parameter a sign-in's 303 carries it in. */
export const APPROVE_KEY_FRAGMENT = "ak";

export function approveKeyHash(key: string): string {
  return createHash("sha256").update(`den-approve-v1:${key}`).digest("hex");
}

/** Whether `given` is the key whose hash the session keeps (constant time). */
export function approveKeyMatches(
  storedHash: string | undefined,
  given: string | undefined | null,
): boolean {
  if (!storedHash || !given || !/^[A-Za-z0-9_-]{43}$/.test(given)) return false;
  const a = Buffer.from(approveKeyHash(given), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** `next` with the approval key in its fragment (a sign-in's 303). */
export function withApproveKey(next: string, key: string): string {
  return `${next.split("#")[0]}#${APPROVE_KEY_FRAGMENT}=${key}`;
}

// ── The session store ──────────────────────────────────────────────────────

/**
 * How a session signed in. "fixture": the fixture person (issue 810);
 * "agent-view": an agent's read-only view (issue 796). Neither is a person.
 */
export type SessionVia =
  | "github"
  | "link"
  | "code"
  | "claim"
  | "fixture"
  | "agent-view";

export interface SessionRecord {
  createdAt: number;
  lastSeenAt: number;
  userAgent: string;
  /** This session's CSRF token (X-Den-CSRF). */
  csrf: string;
  /** The Host it was issued on. */
  host: string;
  /**
   * How the sign-in reached Den (request-guard's via): a loopback name, the
   * edge, or a LAN name. Unset before 0.4.72: read from `host`.
   */
  reach?: "loopback" | "edge" | "lan";
  /**
   * Minted over https through the edge with its proof (its cookie is
   * `__Host-`). Once Den's own address is proven, only such a session
   * counts. Unset: minted elsewhere, or before 0.4.72.
   */
  secure?: true;
  /** SEC-2a: how it signed in: a GitHub sign-in, a one-time link, a code (pairing), or the install's setup link (claim, 0.4.15). Unset: a link (before 0.4.5). */
  via?: SessionVia;
  /**
   * Issue 796: an agent's view (via "agent-view"): the agent's actor and
   * its project. Never set on any other session.
   */
  agent?: string;
  agentWorkspace?: string;
  /**
   * Issue 810: a fixture session's key fingerprint (fixtureKeyFingerprint,
   * never the key). It stands only while that key is the current one.
   */
  fixtureKey?: string;
  /**
   * Issue 810: the person's link session that pressed Set up test person
   * on a test install: it doesn't make the install count as owned.
   */
  testOperator?: true;
  /** SEC-2a: the client's address when Den could attest it. */
  client?: string;
  /** SEC-2a: a GitHub sign-in's login (the account entry's "@login"). */
  login?: string;
  /** A GitHub sign-in's display name, from the same `/user` (the account entry's first line). */
  name?: string;
  /** SEC-2a: not yet greeted ("This device is signed in…", once). */
  welcome?: true;
  /**
   * 0.4.15: sha256 of this session's approval key (approvalKeyMatches).
   * The key itself is handed over once, at the end of the sign-in, and
   * never by GET /api/session. Unset: a session from before 0.4.15, which
   * must sign in again to approve.
   */
  approveKeyHash?: string;
}

interface StoreFile {
  v: 1;
  sessions: Record<string, SessionRecord>;
  /** sha256(nonce) → the code's expiry: codes already used. */
  usedCodes: Record<string, number>;
}

export interface SessionView extends SessionRecord {
  /** HMAC(secret, id), hex: the record's key (its prefix is what `web sessions` shows). */
  key: string;
}

/**
 * Issue 1295: why a browser session ended. Every end names one, and the
 * activity trail records it (sessionEndRow), so a session never ends
 * without a line saying why.
 */
export type SessionEndWhy =
  /** Its own sign-out. */
  | "signed-out"
  /** Revoked from linked devices (Settings, or `web logout <id>`). */
  | "revoked"
  /** Sign out everywhere (or `web logout` with no id). */
  | "signed-out-everywhere"
  /** Den's own https address now works: sign-in lives there. */
  | "address-proven"
  /** A test-person session reached its minutes (web.fixture_session_minutes). */
  | "fixture-expired"
  /** The test person was set up again: a new key. */
  | "fixture-key-changed"
  /** Test sign-in isn't allowed here any more (not a test install, no key). */
  | "fixture-not-allowed"
  /** An agent's view ended (its time, views off, or its token gone). */
  | "agent-view-ended";

const END_WORDS: Record<SessionEndWhy, string> = {
  "signed-out": "signed out",
  revoked: "revoked from linked devices",
  "signed-out-everywhere": "signed out everywhere",
  "address-proven": "Den's own address works now, so sign-in moved there",
  "fixture-expired":
    "the test person's sign-in reached its time limit (web.fixture_session_minutes)",
  "fixture-key-changed": "the test person was set up again",
  "fixture-not-allowed": "test sign-in isn't allowed here any more",
  "agent-view-ended": "the agent's view ended",
};

/**
 * Issue 1295: the activity-trail row for a session that ended: the id
 * `web sessions` shows (8 hex), whose it was, and why. Never the key,
 * the cookie or the CSRF value.
 */
export function sessionEndRow(
  s: SessionView,
  why: SessionEndWhy,
): { verb: "session-end"; detail: string; principal: string } {
  const kind =
    s.via === "fixture"
      ? "test person"
      : s.via === "agent-view"
        ? "agent view"
        : "browser";
  const principal =
    s.via === "fixture"
      ? "fixture:person"
      : s.via === "agent-view" && s.agent
        ? `agent:${s.agent}`
        : s.login
          ? `person:${s.login}`
          : "person";
  return {
    verb: "session-end",
    detail: `${sessionIdPrefix(s.key)} (${kind}) ended: ${END_WORDS[why]}`,
    principal,
  };
}

/** Issue 810: whether a fixture session made at `createdAt` is past its minutes. */
export function fixtureSessionPastTime(
  createdAt: number,
  now: number,
  minutes: number,
): boolean {
  return now - createdAt >= minutes * 60_000;
}

/**
 * Issue 1295: why a test-person session no longer stands, or null while
 * it does. `fingerprint` is the current key's (null: no key).
 */
export function fixtureSessionEndWhy(
  s: { createdAt: number; fixtureKey?: string },
  now: {
    testInstall: boolean;
    fingerprint: string | null;
    minutes: number;
    now: number;
  },
): SessionEndWhy | null {
  if (!now.testInstall || !now.fingerprint) return "fixture-not-allowed";
  if (!s.fixtureKey || s.fixtureKey !== now.fingerprint)
    return "fixture-key-changed";
  if (fixtureSessionPastTime(s.createdAt, now.now, now.minutes))
    return "fixture-expired";
  return null;
}

export function webSessionsPath(stateDir: string = getStateDir()): string {
  return path.join(stateDir, WEB_SESSIONS_FILE);
}

const empty = (): StoreFile => ({ v: 1, sessions: {}, usedCodes: {} });

/**
 * The browser sessions, server-side. The file is re-read when it changes
 * (the CLI edits it while the server is down), written atomically, 0600.
 */
export class WebSessionStore {
  private cache: { key: string; data: StoreFile } | null = null;
  private readonly stateDir: () => string;
  private readonly secret: () => Buffer | null;
  private readonly now: () => number;

  /** Issue 1295: told what ended and why, after each end. */
  private readonly onEnd?: (ended: SessionView[], why: SessionEndWhy) => void;

  constructor(opts: {
    stateDir?: () => string;
    secret: () => Buffer | null;
    now?: () => number;
    /** Issue 1295: told what ended and why (the activity trail). */
    onEnd?: (ended: SessionView[], why: SessionEndWhy) => void;
  }) {
    this.stateDir = opts.stateDir ?? getStateDir;
    this.secret = opts.secret;
    this.now = opts.now ?? Date.now;
    this.onEnd = opts.onEnd;
  }

  /** Issue 1295: tells onEnd; a listener's failure never undoes the end. */
  private told(ended: SessionView[], why: SessionEndWhy): void {
    if (!ended.length || !this.onEnd) return;
    try {
      this.onEnd(ended, why);
    } catch {
      /* the end stands */
    }
  }

  private file(): string {
    return webSessionsPath(this.stateDir());
  }

  private statKey(): string | null {
    try {
      const s = fs.statSync(this.file());
      return `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      return null;
    }
  }

  private load(): StoreFile {
    const key = this.statKey();
    if (key === null) return empty();
    if (this.cache?.key === key) return this.cache.data;
    let data = empty();
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.file(), "utf-8"),
      ) as Partial<StoreFile>;
      data = {
        v: 1,
        sessions:
          raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
        usedCodes:
          raw.usedCodes && typeof raw.usedCodes === "object"
            ? raw.usedCodes
            : {},
      };
    } catch {
      /* unreadable or malformed: no sessions */
    }
    this.cache = { key, data };
    return data;
  }

  private save(data: StoreFile): void {
    const dir = this.stateDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = this.file();
    writeFileAtomic(file, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    const key = this.statKey();
    this.cache = key ? { key, data } : null;
  }

  private keyOf(id: string): string | null {
    const secret = this.secret();
    if (!secret) return null;
    return createHmac("sha256", secret)
      .update(SESSION_CONTEXT + id)
      .digest("hex");
  }

  /** Drop used codes past their expiry (a session never expires). */
  private prune(data: StoreFile, now: number): boolean {
    let changed = false;
    for (const [k, exp] of Object.entries(data.usedCodes))
      if (exp <= now) {
        delete data.usedCodes[k];
        changed = true;
      }
    return changed;
  }

  /**
   * Record a login code's nonce as used. False when it was used already
   * (the code is refused).
   */
  consumeCode(nonce: string, expiresAt: number): boolean {
    const now = this.now();
    const data = structuredClone(this.load());
    this.prune(data, now);
    const h = createHash("sha256").update(nonce).digest("hex");
    if (data.usedCodes[h] !== undefined) return false;
    data.usedCodes[h] = expiresAt;
    this.save(data);
    return true;
  }

  /** A new session: its id (the cookie's value) and record. */
  create(meta: {
    userAgent?: string;
    host?: string;
    reach?: "loopback" | "edge" | "lan";
    secure?: boolean;
    via?: SessionVia;
    fixtureKey?: string;
    agent?: string;
    agentWorkspace?: string;
    client?: string;
    login?: string;
    name?: string;
  }): {
    id: string;
    session: SessionView;
    /** The approval key, for the sign-in's answer only (never stored). */
    approveKey: string;
  } {
    const id = randomBytes(32).toString("base64url");
    const approveKey = randomBytes(32).toString("base64url");
    const key = this.keyOf(id);
    if (!key) throw new Error("web.secret is missing: no session can be made");
    const now = this.now();
    const rec: SessionRecord = {
      createdAt: now,
      lastSeenAt: now,
      userAgent: String(meta.userAgent ?? "").slice(0, UA_MAX),
      csrf: randomBytes(32).toString("base64url"),
      host: String(meta.host ?? "")
        .toLowerCase()
        .slice(0, 255),
      ...(meta.reach ? { reach: meta.reach } : {}),
      ...(meta.secure ? { secure: true as const } : {}),
      ...(meta.via ? { via: meta.via } : {}),
      ...(meta.fixtureKey ? { fixtureKey: meta.fixtureKey } : {}),
      ...(meta.via === "agent-view" && meta.agent
        ? {
            agent: String(meta.agent).slice(0, 80),
            agentWorkspace: String(meta.agentWorkspace ?? "").slice(0, 64),
          }
        : {}),
      ...(meta.client ? { client: String(meta.client).slice(0, 64) } : {}),
      ...(meta.login ? { login: String(meta.login).slice(0, 64) } : {}),
      ...(meta.login && githubDisplayName(meta.name)
        ? { name: githubDisplayName(meta.name) }
        : {}),
      welcome: true,
      approveKeyHash: approveKeyHash(approveKey),
    };
    const data = structuredClone(this.load());
    this.prune(data, now);
    data.sessions[key] = rec;
    this.save(data);
    return { id, session: { key, ...rec }, approveKey };
  }

  /**
   * The session a cookie value names, its lastSeenAt slid forward
   * (written at most once a minute). Null when unknown, ended, or the
   * secret has rotated since.
   */
  lookup(id: string | undefined | null): SessionView | null {
    if (!id || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const key = this.keyOf(id);
    if (!key) return null;
    const data = this.load();
    const rec = data.sessions[key];
    if (!rec) return null;
    const now = this.now();
    if (now - rec.lastSeenAt >= TOUCH_EVERY_MS) {
      const next = structuredClone(data);
      next.sessions[key] = { ...rec, lastSeenAt: now };
      this.trySave(next);
      return { key, ...next.sessions[key] };
    }
    return { key, ...rec };
  }

  private trySave(data: StoreFile): void {
    try {
      this.save(data);
    } catch {
      /* a read-only state dir: the lookup still answers */
    }
  }

  /**
   * Whether this session is yet to be greeted, once: true the first time
   * after its sign-in, and never again (the flag is cleared).
   */
  takeWelcome(key: string): boolean {
    const data = this.load();
    if (!data.sessions[key]?.welcome) return false;
    const next = structuredClone(data);
    delete next.sessions[key].welcome;
    this.trySave(next);
    return true;
  }

  /**
   * Issue 810: mark a person's link session as the one that set up the
   * test person (SessionRecord.testOperator). False: no such session.
   */
  markTestOperator(key: string): boolean {
    const data = this.load();
    if (!data.sessions[key]) return false;
    const next = structuredClone(data);
    next.sessions[key].testOperator = true;
    this.save(next);
    return true;
  }

  /** Every session, newest first. */
  list(): SessionView[] {
    return Object.entries(this.load().sessions)
      .map(([key, r]) => ({ key, ...r }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** End the session with this key, saying why (issue 1295). */
  end(key: string, why: SessionEndWhy): boolean {
    const data = structuredClone(this.load());
    const r = data.sessions[key];
    if (!r) return false;
    delete data.sessions[key];
    this.save(data);
    this.told([{ key, ...r }], why);
    return true;
  }

  /** End every session `which` picks, in one write. Returns their keys. */
  endWhere(which: (s: SessionView) => boolean, why: SessionEndWhy): string[] {
    const data = structuredClone(this.load());
    const ended = Object.entries(data.sessions)
      .map(([key, r]) => ({ key, ...r }))
      .filter((v) => which(v));
    if (ended.length === 0) return [];
    for (const v of ended) delete data.sessions[v.key];
    this.save(data);
    this.told(ended, why);
    return ended.map((v) => v.key);
  }

  /**
   * End the one session whose key starts with `prefix` (4 hex at least).
   * Throws when none or several match.
   */
  endByPrefix(prefix: string, why: SessionEndWhy): SessionView {
    const hit = sessionByPrefix(this.list(), prefix);
    this.end(hit.key, why);
    return hit;
  }

  /** End every browser session; how many there were. */
  endAll(why: SessionEndWhy): number {
    const data = structuredClone(this.load());
    const ended = Object.entries(data.sessions).map(([key, r]) => ({
      key,
      ...r,
    }));
    data.sessions = {};
    this.save(data);
    this.told(ended, why);
    return ended.length;
  }

  /**
   * Issue 1300: for a process other than the server. Under the sessions
   * lock, re-reads the file and ends only the sessions `choose` names
   * from what is there now; every other session, one made a moment ago
   * included, is written back as it is. Throws WebSessionsBusy, changing
   * nothing, when another running process holds the lock.
   */
  endLocked(
    choose: (all: SessionView[]) => string[],
    why: SessionEndWhy,
  ): SessionView[] {
    const release = this.lock();
    try {
      // Never the copy read before the lock.
      this.cache = null;
      const data = structuredClone(this.load());
      const all = Object.entries(data.sessions).map(([key, r]) => ({
        key,
        ...r,
      }));
      const pick = new Set(choose(all));
      const ended = all.filter((v) => pick.has(v.key));
      if (ended.length === 0) return [];
      for (const v of ended) delete data.sessions[v.key];
      this.save(data);
      this.told(ended, why);
      return ended;
    } finally {
      release();
    }
  }

  /** Issue 1300: takes the sessions lock (O_EXCL); returns its release. */
  private lock(): () => void {
    const dir = this.stateDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, WEB_SESSIONS_LOCK);
    for (let tries = 0; ; tries++) {
      try {
        const fd = fs.openSync(file, "wx", 0o600);
        try {
          fs.writeSync(fd, `${process.pid}\n`);
        } finally {
          fs.closeSync(fd);
        }
        return () => {
          try {
            if (Number(fs.readFileSync(file, "utf-8").trim()) === process.pid)
              fs.unlinkSync(file);
          } catch {
            /* already gone */
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let holder = 0;
      try {
        holder = Number(fs.readFileSync(file, "utf-8").trim());
      } catch {
        /* gone meanwhile: try again */
      }
      // A holder that runs (not this process) keeps it; one try at a
      // takeover of a lock its holder left behind.
      if (holder && holder !== process.pid && pidRuns(holder))
        throw new WebSessionsBusy(holder);
      // No pid yet: a holder between making it and writing it, unless it
      // is older than that takes (one that died there).
      if (!holder && !lockOlderThan(file, LOCK_UNREAD_STALE_MS))
        throw new WebSessionsBusy(0);
      if (tries >= 1) throw new WebSessionsBusy(holder);
      try {
        fs.unlinkSync(file);
      } catch {
        /* someone else took it over */
      }
    }
  }
}

/** A session's id as `web sessions` shows it: the first 8 hex of its key. */
export function sessionIdPrefix(key: string): string {
  return key.slice(0, 8);
}

/**
 * A linked device's name from its User-Agent (SEC-2a: "Chrome on macOS"),
 * or "Unknown browser".
 */
export function deviceName(userAgent: string | undefined): string {
  const ua = String(userAgent ?? "");
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /(Chrome|CriOS)\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : /curl\//.test(ua)
            ? "curl"
            : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? (os ? `A browser on ${os}` : "Unknown browser");
}
