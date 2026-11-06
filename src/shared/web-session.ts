/**
 * SEC-1b (SEC-1 spec §2): the browser's sign-in.
 *
 *  - The login code: one-time, valid for 60 s, derived from web.secret.
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
import { getStateDir } from "./paths.js";

export const LOGIN_CODE_TTL_MS = 60_000;
/** Clock skew allowed between the CLI that mints a code and the server. */
const LOGIN_CODE_SKEW_MS = 5_000;
const LOGIN_CONTEXT = "den-login-v1:";
const SESSION_CONTEXT = "den-session-v1:";
export const WEB_SESSIONS_FILE = "web-sessions.json";
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

/** A fresh login code, valid for 60 s from `now`. */
export function mintLoginCode(
  secret: Buffer,
  now: number = Date.now(),
): string {
  const nonce = randomBytes(16).toString("base64url");
  const body = `v1.${nonce}.${(now + LOGIN_CODE_TTL_MS).toString(36)}`;
  return `${body}.${mac(secret, body).toString("base64url")}`;
}

export type LoginCodeCheck =
  | { ok: true; nonce: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "bad_mac" | "expired" };

/**
 * Whether `code` is one this secret minted and still in its 60 s. The mac is
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
    expiresAt - now > LOGIN_CODE_TTL_MS + LOGIN_CODE_SKEW_MS
  )
    return { ok: false, reason: "expired" };
  return { ok: true, nonce: m[2], expiresAt };
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
}

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

/** The start-up warning for the ignored keys, or null when there are none. */
export function ignoredConfigWarning(cfg: WebAuthConfig): string | null {
  const lines: string[] = [];
  if (cfg.ignored.length)
    lines.push(
      `${cfg.ignored.join(", ")}: ignored. A browser session never expires; ` +
        "it ends at sign-out or `web logout`. Remove the key to silence this.",
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
  return {
    allowPlainHttpRemote: plain === true,
    ignored,
    ...(team.allow_plain_http_remote !== undefined
      ? { plainHttpInDistribution: configFile }
      : {}),
  };
}

// ── The session store ──────────────────────────────────────────────────────

export interface SessionRecord {
  createdAt: number;
  lastSeenAt: number;
  userAgent: string;
  /** This session's CSRF token (X-Den-CSRF). */
  csrf: string;
  /** The Host it was issued on. */
  host: string;
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

  constructor(opts: {
    stateDir?: () => string;
    secret: () => Buffer | null;
    now?: () => number;
  }) {
    this.stateDir = opts.stateDir ?? getStateDir;
    this.secret = opts.secret;
    this.now = opts.now ?? Date.now;
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
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
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
  create(meta: { userAgent?: string; host?: string }): {
    id: string;
    session: SessionView;
  } {
    const id = randomBytes(32).toString("base64url");
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
    };
    const data = structuredClone(this.load());
    this.prune(data, now);
    data.sessions[key] = rec;
    this.save(data);
    return { id, session: { key, ...rec } };
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

  /** Every session, newest first. */
  list(): SessionView[] {
    return Object.entries(this.load().sessions)
      .map(([key, r]) => ({ key, ...r }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** End the session with this key. */
  end(key: string): boolean {
    const data = structuredClone(this.load());
    if (!data.sessions[key]) return false;
    delete data.sessions[key];
    this.save(data);
    return true;
  }

  /**
   * End the one session whose key starts with `prefix` (4 hex at least).
   * Throws when none or several match.
   */
  endByPrefix(prefix: string): SessionView {
    const p = prefix.trim().toLowerCase();
    if (!/^[0-9a-f]{4,64}$/.test(p))
      throw new Error(
        `"${prefix}" is not a session id prefix (4 or more hex characters, as \`web sessions\` lists them)`,
      );
    const hits = this.list().filter((s) => s.key.startsWith(p));
    if (hits.length === 0)
      throw new Error(`No browser session starts with ${p}`);
    if (hits.length > 1)
      throw new Error(
        `${hits.length} browser sessions start with ${p}; give more of the id`,
      );
    this.end(hits[0].key);
    return hits[0];
  }

  /** End every browser session; how many there were. */
  endAll(): number {
    const data = structuredClone(this.load());
    const n = Object.keys(data.sessions).length;
    data.sessions = {};
    this.save(data);
    return n;
  }
}

/** A session's id as `web sessions` shows it: the first 8 hex of its key. */
export function sessionIdPrefix(key: string): string {
  return key.slice(0, 8);
}
