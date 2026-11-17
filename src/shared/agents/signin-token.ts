/**
 * Issue 163 (b): the agents' sign-in when Den runs as the always-on
 * service (LaunchDaemons that outlive a logout).
 *
 * A LaunchDaemon started after a logout can't be assumed to reach the
 * desktop login keychain, and the CLI's interactive sign-in expires on
 * its own. So agents started under the always-on service sign in with
 * the CLI's long-lived token instead (den-claude: `claude setup-token`,
 * read by Claude Code from CLAUDE_CODE_OAUTH_TOKEN).
 *
 *   - The person makes it once, outside Den, and gives it to
 *     `<cli> agents token set` (stdin or a hidden prompt, never argv).
 *   - It is kept in the install's configured secrets store (SEC-0: never a
 *     store of Den's own), under the named ref `secrets.refs.agent_signin_token`.
 *     A distribution's ref wins; without one, a backend that keeps secrets
 *     (1Password, Doppler) gets a new item, and the ref goes into the
 *     person's user.yml, as the saved sudo password does (LK-4).
 *   - Only when an agent starts under the always-on service is it read,
 *     and it goes into that agent's environment only: never argv, a log,
 *     a record, an answer or an error.
 *   - When it was set (not the token) is kept in the state dir, so doctor
 *     and Settings can say how old it is.
 *
 * Which agents get it (agentSignInMode): the web job's plist under mode
 * always carries DEN_AGENT_SIGNIN=token, and the host job file
 * (`sessions-host-job.json`) names mode always, so a start from a terminal
 * gets it too: the agent runs in the daemon's host either way.
 */
import * as fs from "fs";
import * as path from "path";
import {
  getSecretsProvider,
  namedSecretRef,
  notConfiguredMessage,
  readSecretsConfig,
  secretsStatus,
  SecretsNotConfiguredError,
  type SecretRef,
  type SecretsConfig,
  type SecretsProvider,
  type SecretsProviderName,
} from "../secrets/index.js";
import {
  readDenConfig,
  readUserConfig,
  writeUserConfig,
  type UserConfig,
} from "../den-config.js";
import { envKey, product } from "../product.js";

/** The named ref under `secrets.refs`. */
export const AGENT_TOKEN_REF_NAME = "agent_signin_token";

/** Set in the always-on jobs' env (install.sh): agents sign in with the token. */
export const SIGNIN_ENV = "DEN_AGENT_SIGNIN";

/** The host job file `service install` writes (service-command.ts). */
export const HOST_JOB_FILE = "sessions-host-job.json";

/** When the token was set (never the token): `<stateDir>/<this>`. */
export const TOKEN_META_FILE = "agent-signin-token.json";

/**
 * Left by `agents token clear` when the ref stays (a ref the config names):
 * the value is gone, so no token is set until the next set.
 */
export const TOKEN_CLEARED_FILE = "agent-signin-token-cleared.json";

/** agents.signin_token_warn_days: how old a token is before doctor warns. */
export const DEFAULT_TOKEN_WARN_DAYS = 330;

/** How the person makes the token (den-claude's CLI). */
export const TOKEN_MAKE_HINT = "claude setup-token";

export type SignInMode = "token" | "desktop";

/**
 * "token" when agents started now run under the always-on service: this
 * process's env says so (the web job's plist), or the host job file names
 * mode always (a start from a terminal, into the daemon's host).
 */
export function agentSignInMode(
  env: NodeJS.ProcessEnv,
  stateDir: string,
): SignInMode {
  const v = env[SIGNIN_ENV];
  if (v === "token") return "token";
  if (v === "desktop") return "desktop";
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(stateDir, HOST_JOB_FILE), "utf-8"),
    ) as { mode?: unknown };
    return j.mode === "always" ? "token" : "desktop";
  } catch {
    return "desktop";
  }
}

/**
 * The configured ref, or null. The distribution's own ref wins over one in
 * user.yml.
 */
export function agentTokenRef(
  cfg: () => SecretsConfig = readSecretsConfig,
  team: () => SecretsConfig["refs"] = () => readDenConfig().secrets?.refs,
): SecretRef | null {
  try {
    const c = cfg();
    let t: SecretsConfig["refs"];
    try {
      t = team();
    } catch {
      t = undefined;
    }
    const fromTeam = t?.[AGENT_TOKEN_REF_NAME]
      ? namedSecretRef(AGENT_TOKEN_REF_NAME, {
          ...c,
          refs: { [AGENT_TOKEN_REF_NAME]: t[AGENT_TOKEN_REF_NAME] },
        })
      : null;
    return fromTeam ?? namedSecretRef(AGENT_TOKEN_REF_NAME, c);
  } catch {
    return null;
  }
}

/**
 * Where a token set with no configured ref goes, for a backend that keeps
 * it: a new 1Password item, or a Doppler key. Null for env (process memory
 * only: a daemon never sees it) and none.
 */
export function newAgentTokenRef(
  backend: SecretsProviderName,
): Partial<SecretRef> | null {
  switch (backend) {
    case "1password":
      return {
        item: `${product().title} agent sign-in`,
        field: "password",
      };
    case "doppler":
      return { key: envKey("AGENT_SIGNIN_TOKEN") };
    default:
      return null;
  }
}

/** Why a value can't be a token, or null. Never echoes it. */
export function tokenShapeError(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "no token given";
  if (/\s/.test(t)) return "a token is one word: it has blanks or line breaks";
  if (t.length < 16) return "too short to be a token";
  if (t.length > 4096) return "too long to be a token";
  return null;
}

/** Text with every copy of `secret` replaced, and no command line. */
export function withoutSecret(text: string, secret: string): string {
  const s = String(text)
    .split("\n")
    .filter((l) => !/^Command failed:/.test(l))
    .join(" ");
  return (secret ? s.split(secret).join("***") : s).trim();
}

export interface TokenMeta {
  setAt: string;
  /** The backend label it went to ("1Password"). */
  store?: string;
}

export function readTokenMeta(stateDir: string): TokenMeta | null {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(stateDir, TOKEN_META_FILE), "utf-8"),
    ) as Partial<TokenMeta>;
    return typeof j.setAt === "string" && !isNaN(Date.parse(j.setAt))
      ? { setAt: j.setAt, ...(j.store ? { store: String(j.store) } : {}) }
      : null;
  } catch {
    return null;
  }
}

function writeTokenMeta(stateDir: string, meta: TokenMeta): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(stateDir, TOKEN_META_FILE),
    JSON.stringify(meta) + "\n",
    { mode: 0o600 },
  );
}

/** agents.signin_token_warn_days (user.yml, 330): a permissive default. */
export function tokenWarnDays(read: () => UserConfig = readUserConfig): number {
  try {
    const v = Number(
      (read().agents as Record<string, unknown> | undefined)
        ?.signin_token_warn_days,
    );
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_TOKEN_WARN_DAYS;
  } catch {
    return DEFAULT_TOKEN_WARN_DAYS;
  }
}

export interface TokenStoreDeps {
  provider?: () => SecretsProvider;
  ref?: () => SecretRef | null;
  status?: () => ReturnType<typeof secretsStatus>;
  /** Write the new ref to user.yml (default: writeUserConfig). */
  saveRef?: (ref: Partial<SecretRef>) => void;
  stateDir: string;
  now?: () => Date;
  /**
   * The save runs inside Den's own running process (Settings). The env
   * backend keeps the value only in the process that sets it, so anywhere
   * else (the CLI) it is refused.
   */
  inDen?: boolean;
}

/** `agents token set` (or any save outside Den's process) with env. */
export const ENV_SET_OUTSIDE_DEN =
  "with secrets.provider env the token lives only in Den's running process; set it in Settings, or use 1password or doppler";

export class EnvOutsideDenError extends Error {
  readonly code = "env_outside_den";
  constructor() {
    super(ENV_SET_OUTSIDE_DEN);
    this.name = "EnvOutsideDenError";
  }
}

/**
 * At Den's start, with the env backend: the value Settings kept lived in
 * the process that just ended, so Den's record of it is stale unless the
 * value is in this process's environment (set by whoever started Den).
 * Removes the stale record; true when it did. Never reads the value.
 */
export function dropStaleEnvTokenRecord(d: {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  ref?: () => SecretRef | null;
  status?: () => ReturnType<typeof secretsStatus>;
}): boolean {
  const env = d.env ?? process.env;
  const st = (
    d.status ?? (() => secretsStatus(undefined, env, { detect: false }))
  )();
  if (st.backend !== "env") return false;
  const file = path.join(d.stateDir, TOKEN_META_FILE);
  if (!fs.existsSync(file)) return false;
  const key = (d.ref ?? (() => agentTokenRef()))()?.key;
  if (key && env[key] !== undefined && env[key] !== "") return false;
  fs.rmSync(file, { force: true });
  return true;
}

/**
 * Save (or replace) the token in the configured store. With no ref and a
 * backend that keeps secrets, it creates the item and then writes the ref
 * to user.yml; a failed save writes nothing. Throws on store errors, never
 * with the token in the message.
 */
export async function saveAgentToken(
  token: string,
  d: TokenStoreDeps,
): Promise<{ ref: "configured" | "created"; store: string }> {
  const bad = tokenShapeError(token);
  if (bad) throw new Error(bad);
  const value = token.trim();
  const st = (d.status ?? (() => secretsStatus()))();
  if (st.backend === "none") throw new NoSecretsStoreError();
  const provider = (d.provider ?? getSecretsProvider)();
  let ref = (d.ref ?? (() => agentTokenRef()))();
  let created: Partial<SecretRef> | null = null;
  if (!ref) {
    const fresh =
      !st.implicit && st.detect.available ? newAgentTokenRef(st.backend) : null;
    ref = fresh
      ? namedSecretRef(
          AGENT_TOKEN_REF_NAME,
          { refs: { [AGENT_TOKEN_REF_NAME]: fresh } },
          st.backend,
        )
      : null;
    if (!fresh || !ref)
      throw new SecretsNotConfiguredError(
        st.backend === "env"
          ? `the env secrets backend keeps nothing a daemon can read: choose 1password or doppler (secrets.provider), or set secrets.refs.${AGENT_TOKEN_REF_NAME} in ${product().configFile}`
          : notConfiguredMessage(AGENT_TOKEN_REF_NAME),
      );
    created = fresh;
  }
  if (st.backend === "env" && !d.inDen) throw new EnvOutsideDenError();
  try {
    await provider.set(ref, value);
  } catch (err) {
    throw new Error(
      withoutSecret(String((err as Error)?.message ?? err), value) ||
        "the secrets store refused it",
    );
  }
  if (created) {
    const save =
      d.saveRef ??
      ((r: Partial<SecretRef>) => {
        const user = readUserConfig();
        const secrets = user.secrets ?? {};
        writeUserConfig({
          ...user,
          secrets: {
            ...secrets,
            refs: { ...secrets.refs, [AGENT_TOKEN_REF_NAME]: r },
          },
        });
      });
    save(created);
  }
  writeTokenMeta(d.stateDir, {
    setAt: (d.now ?? (() => new Date()))().toISOString(),
    store: st.label,
  });
  fs.rmSync(path.join(d.stateDir, TOKEN_CLEARED_FILE), { force: true });
  return { ref: created ? "created" : "configured", store: st.label };
}

export interface TokenClearDeps extends Omit<
  TokenStoreDeps,
  "saveRef" | "now"
> {
  /** The process env (the env backend's value lives there). */
  env?: NodeJS.ProcessEnv;
  /** user.yml's secrets.refs.agent_signin_token (default: read it). */
  userRef?: () => Partial<SecretRef> | undefined;
  /** Remove it from user.yml (default: writeUserConfig). */
  dropRef?: () => void;
}

export type TokenClearResult =
  | { cleared: false }
  | {
      cleared: true;
      store: string;
      /** item: Den's own 1Password item; deleted: the field or secret; process: env only. */
      how: "item" | "deleted" | "process";
      /** The ref Den wrote to user.yml is gone too. */
      refDropped: boolean;
      /** env: the value was in this process (the web server) and is gone. */
      inProcess?: boolean;
    };

/**
 * `agents token clear`: removes the token the way set stored it. A ref Den
 * made (its own 1Password item, or its Doppler key, written to user.yml)
 * goes with it: the item or secret is deleted and the ref dropped. A ref the
 * config names stays, its field or secret deleted. The env backend only
 * ever had it in this process. Never reads or prints the value.
 */
export async function clearAgentToken(
  d: TokenClearDeps,
): Promise<TokenClearResult> {
  const st = (d.status ?? (() => secretsStatus()))();
  if (st.backend === "none") throw new NoSecretsStoreError();
  const ref = (d.ref ?? (() => agentTokenRef()))();
  const forget = () => {
    fs.rmSync(path.join(d.stateDir, TOKEN_META_FILE), { force: true });
  };
  if (st.backend === "env") {
    // Den's record (the meta file) and, in the web server, the value in its
    // process: a new CLI process has only the record.
    const env = d.env ?? process.env;
    const key = ref?.key;
    const hadRecord = fs.existsSync(path.join(d.stateDir, TOKEN_META_FILE));
    const inProcess = !!key && env[key] !== undefined;
    forget();
    if (inProcess) delete env[key!];
    if (!hadRecord && !inProcess) return { cleared: false };
    return {
      cleared: true,
      store: st.label,
      how: "process",
      inProcess,
      refDropped: false,
    };
  }
  if (!ref) {
    forget();
    return { cleared: false };
  }
  const provider = (d.provider ?? getSecretsProvider)();
  if (!provider.delete)
    throw new Error(`${st.label} can't remove a secret from here`);
  const userRef = (
    d.userRef ?? (() => readUserConfig().secrets?.refs?.[AGENT_TOKEN_REF_NAME])
  )();
  const fresh = newAgentTokenRef(st.backend);
  const madeByDen =
    !!userRef &&
    !!fresh &&
    Object.entries(fresh).every(
      ([k, v]) => (userRef as Record<string, unknown>)[k] === v,
    ) &&
    Object.entries(fresh).every(
      ([k, v]) => (ref as unknown as Record<string, unknown>)[k] === v,
    );
  try {
    await provider.delete(ref, {
      wholeItem: madeByDen && st.backend === "1password",
    });
  } catch (err) {
    throw new Error(
      String((err as Error)?.message ?? err).trim() ||
        "the secrets store refused it",
    );
  }
  forget();
  if (madeByDen) {
    (
      d.dropRef ??
      (() => {
        const user = readUserConfig();
        const refs = { ...(user.secrets?.refs ?? {}) };
        delete refs[AGENT_TOKEN_REF_NAME];
        writeUserConfig({ ...user, secrets: { ...user.secrets, refs } });
      })
    )();
  } else {
    fs.mkdirSync(d.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(d.stateDir, TOKEN_CLEARED_FILE),
      JSON.stringify({ clearedAt: new Date().toISOString() }) + "\n",
      { mode: 0o600 },
    );
  }
  return {
    cleared: true,
    store: st.label,
    how: madeByDen && st.backend === "1password" ? "item" : "deleted",
    refDropped: madeByDen,
  };
}

/** The token from the store, or null with why (never the token). */
export async function readAgentToken(
  d: Omit<TokenStoreDeps, "stateDir" | "saveRef" | "now">,
): Promise<{ token: string | null; reason?: string }> {
  const ref = (d.ref ?? (() => agentTokenRef()))();
  if (!ref) return { token: null, reason: "not set" };
  const provider = (d.provider ?? getSecretsProvider)();
  try {
    if (provider.tryGetWithReason) {
      const r = await provider.tryGetWithReason(ref);
      return r.value
        ? { token: r.value }
        : { token: null, reason: r.reason ?? "not in the store" };
    }
    const v = await provider.tryGet(ref);
    return v ? { token: v } : { token: null, reason: "not in the store" };
  } catch {
    return { token: null, reason: "the store could not be read" };
  }
}

/** The code a person-facing answer carries when there is no store. */
export const NO_SECRETS_STORE = "no_secrets_store";

/** Plain words for it: a config gap, not a server error. */
export const NO_STORE_MESSAGE =
  "this install has no secrets store, so the sign-in token can't be kept: set secrets.provider to 1password or doppler";

/** secrets.provider is none: nothing can keep the token. */
export class NoSecretsStoreError extends Error {
  readonly code = NO_SECRETS_STORE;
  constructor() {
    super(NO_STORE_MESSAGE);
    this.name = "NoSecretsStoreError";
  }
}

/** `agents token status` with no token, not under the always-on service. */
export const NO_TOKEN_NOT_NEEDED =
  "no sign-in token set; needed only under Keep agents running after logout";

/** The same, on an install with no secrets store: that comes first. */
export const NO_TOKEN_NO_STORE =
  "no sign-in token set, and this install has no secrets store: set secrets.provider to 1password or doppler first; the token is needed only under Keep agents running after logout";

/** The env backend's value lives in the web server's process only. */
export const PROCESS_LOCAL_NOTE = "process-local: kept only until Den restarts";

export interface TokenStatus {
  /** Agents started now sign in with the token (the always-on service). */
  mode: SignInMode;
  /** A ref is configured (or was created). */
  configured: boolean;
  /** When it was set (ISO), from the state dir; null when unknown. */
  setAt: string | null;
  /** Whole days since it was set; null when unknown. */
  ageDays: number | null;
  /** Older than agents.signin_token_warn_days. */
  old: boolean;
  warnDays: number;
  /** The store's name people see ("1Password"). */
  store: string;
  /** Read from the store now (only when asked: doctor). */
  stored?: boolean;
  /** Why it isn't stored, in plain words (never the token). */
  reason?: string;
  /** No secrets store (secrets.provider none): nothing can keep it. */
  noStore?: boolean;
  /**
   * The env backend: the value lives only in the web server's process, so
   * Den's record of the set (the meta file) is what status reads.
   */
  processLocal?: boolean;
  /**
   * The store's own credential (1Password's service-account token) is
   * referenced as `keychain:`, which the always-on service may not reach.
   */
  credInKeychain?: boolean;
}

/** What doctor and the sign-in row say when credInKeychain. */
export const CRED_KEYCHAIN_WARNING =
  "the store's credential is in the login keychain, which the always-on service may not reach; use file: or env: (see docs/always-on-gate.md)";

/**
 * The token's state, for doctor and Settings: from the config and the state
 * dir alone, unless `probe` (then the store is read: doctor).
 */
export async function agentTokenStatus(
  d: TokenStatusDeps,
): Promise<TokenStatus> {
  const out = agentTokenStatusNow(d);
  // The env backend: Den's record is the truth (agentTokenStatusNow).
  if (out.processLocal) return out;
  const ref = out.configured ? (d.ref ?? (() => agentTokenRef()))() : null;
  if (d.probe && ref) {
    const r = await readAgentToken({ ref: () => ref, provider: d.provider });
    out.stored = !!r.token;
    if (!r.token && r.reason) out.reason = r.reason;
  } else if (d.probe) {
    out.stored = false;
    out.reason = "not set";
  }
  return out;
}

export interface TokenStatusDeps {
  env: NodeJS.ProcessEnv;
  stateDir: string;
  probe?: boolean;
  ref?: () => SecretRef | null;
  provider?: () => SecretsProvider;
  status?: () => ReturnType<typeof secretsStatus>;
  warnDays?: () => number;
  now?: () => Date;
  /**
   * Where the store's own credential comes from, as configured
   * (`secrets.onepassword.token`: keychain:, file: or env:). Read from the
   * config only; nothing is read from the keychain.
   */
  credSource?: () => string | undefined;
}

/** The token's state from the config and the state dir alone (a page view). */
export function agentTokenStatusNow(d: TokenStatusDeps): TokenStatus {
  const ref = (d.ref ?? (() => agentTokenRef()))();
  const meta = readTokenMeta(d.stateDir);
  const warnDays = (d.warnDays ?? (() => tokenWarnDays()))();
  const now = (d.now ?? (() => new Date()))().getTime();
  const ageDays = meta
    ? Math.max(0, Math.floor((now - Date.parse(meta.setAt)) / 86_400_000))
    : null;
  let store = "";
  let backend = "";
  try {
    const st = (
      d.status ?? (() => secretsStatus(undefined, d.env, { detect: false }))
    )();
    store = st.label;
    backend = st.backend;
  } catch {
    store = "";
  }
  let cred: string | undefined;
  try {
    cred = (
      d.credSource ??
      (() => readSecretsConfig().onepassword?.token ?? undefined)
    )();
  } catch {
    cred = undefined;
  }
  const credInKeychain =
    backend === "1password" &&
    typeof cred === "string" &&
    cred.trim().startsWith("keychain:");
  const out: TokenStatus = {
    mode: agentSignInMode(d.env, d.stateDir),
    configured:
      !!ref && !fs.existsSync(path.join(d.stateDir, TOKEN_CLEARED_FILE)),
    setAt: meta?.setAt ?? null,
    ageDays,
    old: ageDays !== null && ageDays >= warnDays,
    warnDays,
    store,
    noStore: backend === "none",
    ...(backend === "env" ? { processLocal: true, stored: meta !== null } : {}),
    credInKeychain,
  };
  return out;
}

/**
 * One plain line for doctor, Settings and a start: what the person must
 * know, or null when there is nothing to say (desktop sign-in).
 */
export function tokenStatusLine(
  st: TokenStatus,
  cli: string,
  localDate: (iso: string) => string = (iso) => iso.slice(0, 10),
): { status: "ok" | "warn"; text: string } {
  const l = tokenLine(st, cli, localDate);
  return st.credInKeychain
    ? { status: "warn", text: `${l.text}. Also, ${CRED_KEYCHAIN_WARNING}` }
    : l;
}

function tokenLine(
  st: TokenStatus,
  cli: string,
  localDate: (iso: string) => string,
): { status: "ok" | "warn"; text: string } {
  const fix = `make one with ${TOKEN_MAKE_HINT}, then ${cli} agents token set`;
  // Not under the always-on service: agents sign in from the desktop login,
  // so no token is nothing to warn about.
  if ((!st.configured || st.stored === false) && st.mode !== "token")
    return {
      status: "ok",
      text: st.noStore ? NO_TOKEN_NO_STORE : NO_TOKEN_NOT_NEEDED,
    };
  if (!st.configured || st.stored === false)
    return {
      status: "warn",
      text:
        `Keep agents running after logout is on, but no sign-in token is configured: ` +
        `agents will not be able to sign in after logout. ` +
        (st.noStore
          ? `This install has no secrets store: set secrets.provider to 1password or doppler first, then ${fix}`
          : `${fix[0]!.toUpperCase()}${fix.slice(1)}`) +
        (st.reason && st.reason !== "not set" ? ` (${st.reason})` : ""),
    };
  if (st.old)
    return {
      status: "warn",
      text: `the agents' sign-in token was set ${st.ageDays} days ago${st.store ? ` (in ${st.store})` : ""}; it lasts about a year: ${fix}`,
    };
  return {
    status: "ok",
    text: st.setAt
      ? `agents sign in with the token set ${localDate(st.setAt)}${st.store ? ` (in ${st.store})` : ""}${st.processLocal ? ` (${PROCESS_LOCAL_NOTE})` : ""}`
      : `agents sign in with the token in ${st.store || "the secrets store"} (when it was set is not known)`,
  };
}
