/**
 * Issue 339 (slice 2 of issue 163's always-on accounts design): for each
 * vendor (a runtime whose catalog entry has sign-in data, issue 338), a
 * list of accounts the agents can sign in with after logout.
 *
 *   - An account is an id ("1", "2", ...), an optional name (shown as
 *     "Account A", "Account B" unless the person names it), and a sign-in
 *     token. The person can change the order.
 *   - Each token is its own named ref under `secrets.refs`, so its own item
 *     in the install's own secrets store (SEC-0: never a store of Den's own):
 *     account one keeps the ref that exists today (agentTokenRefName), any
 *     other is `<that>__<id>`. A token is never shown again once it is set.
 *   - The list and when each token was set (never a token) are kept in the
 *     state dir (ACCOUNTS_FILE). With no file, the list is account one
 *     alone: the single token that exists today, so an install with one
 *     account behaves exactly as before and nothing is written on upgrade.
 *     Account one's set time stays where it always was (TOKEN_META_FILE)
 *     for Claude Code.
 *   - No email appears in an item name, a ref, a log or the UI: items are
 *     named by the runtime and the account's number, and a name with "@"
 *     is refused.
 *
 * Until slice 3 picks an account per agent, agents get the first account's
 * token, in the person's order (firstAccountRefName).
 */
import * as fs from "fs";
import * as path from "path";
import type { SecretRef, SecretsProviderName } from "../secrets/index.js";
import { envKey, product } from "../product.js";
import { getRuntime } from "./runtimes.js";
import { accountNameOf } from "./catalog.js";
import {
  AGENT_TOKEN_REF_NAME,
  agentTokenRef,
  agentTokenRefName,
  clearAgentToken,
  newAgentTokenRef,
  readTokenMeta,
  saveAgentToken,
  TOKEN_CLEARED_FILE,
  type TokenClearDeps,
  type TokenClearResult,
  type TokenMeta,
  type TokenStoreDeps,
} from "./signin-token.js";
import { writeFileAtomic } from "../atomic-write.js";
import { readStateJson } from "../state-backup.js";

/** The list, per runtime (never a token): `<stateDir>/<this>`. */
export const ACCOUNTS_FILE = "agent-signin-accounts.json";

/** The longest name a person may give an account. */
export const ACCOUNT_NAME_MAX = 40;

export interface SignInAccount {
  /** "1", "2", ...: never reused within a runtime. */
  id: string;
  /** The person's name for it; unset: "Account A" etc. */
  name?: string;
  /** When its token was set (not account one of Claude Code: the meta file). */
  setAt?: string;
  /** The store's name people see ("1Password"). */
  store?: string;
  /** Removed from the store, the ref kept (a ref the config names). */
  cleared?: boolean;
}

interface RuntimeAccounts {
  accounts: SignInAccount[];
  /** The next id to give. */
  next: number;
}

interface AccountsFile {
  runtimes: Record<string, RuntimeAccounts>;
}

/** Thrown for a request the person must change (a usage error). */
export class AccountsError extends Error {
  readonly code = "accounts";
  constructor(message: string) {
    super(message);
    this.name = "AccountsError";
  }
}

/** The runtimes with sign-in data (issue 338): those have accounts. */
export function signInRuntime(runtimeId: string): {
  id: string;
  name: string;
  account: string;
  env: string;
} {
  const rt = getRuntime(runtimeId);
  if (!rt) throw new AccountsError(`no runtime "${runtimeId}"`);
  if (!rt.signInTokenEnv)
    throw new AccountsError(
      `${rt.catalog?.name ?? runtimeId} has no sign-in data (agents.runtime_catalog, signIn), so Den keeps no ${vendorName(runtimeId)} accounts`,
    );
  return {
    id: runtimeId,
    name: rt.catalog?.name ?? runtimeId,
    /** Whose account it is ("Claude"): vendorName. */
    account: vendorName(runtimeId),
    env: rt.signInTokenEnv,
  };
}

function file(stateDir: string): string {
  return path.join(stateDir, ACCOUNTS_FILE);
}

function readFile(stateDir: string): AccountsFile {
  try {
    const r = readStateJson(stateDir, file(stateDir));
    if (!r.ok) return { runtimes: {} };
    const j = (r.value ?? {}) as {
      runtimes?: unknown;
    };
    const out: AccountsFile = { runtimes: {} };
    if (j && typeof j.runtimes === "object" && j.runtimes)
      for (const [id, v] of Object.entries(
        j.runtimes as Record<string, unknown>,
      )) {
        const r = v as { accounts?: unknown; next?: unknown };
        if (!Array.isArray(r?.accounts)) continue;
        const accounts = (r.accounts as unknown[])
          .map(cleanAccount)
          .filter((a): a is SignInAccount => !!a);
        if (!accounts.length) continue;
        const top = Math.max(...accounts.map((a) => Number(a.id)));
        const next = Number(r.next);
        out.runtimes[id] = {
          accounts,
          next: Number.isInteger(next) && next > top ? next : top + 1,
        };
      }
    return out;
  } catch {
    return { runtimes: {} };
  }
}

function cleanAccount(v: unknown): SignInAccount | null {
  const a = v as Record<string, unknown> | null;
  if (!a || typeof a.id !== "string" || !/^[1-9][0-9]{0,5}$/.test(a.id))
    return null;
  const out: SignInAccount = { id: a.id };
  if (typeof a.name === "string" && !nameError(a.name)) out.name = a.name;
  if (typeof a.setAt === "string" && !isNaN(Date.parse(a.setAt)))
    out.setAt = a.setAt;
  if (typeof a.store === "string") out.store = a.store;
  if (a.cleared === true) out.cleared = true;
  return out;
}

function writeFile(stateDir: string, f: AccountsFile): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const dest = file(stateDir);
  writeFileAtomic(dest, JSON.stringify(f, null, 2) + "\n", { mode: 0o600 });
}

/** The runtime's accounts, in the person's order. */
export function listAccounts(
  stateDir: string,
  runtimeId: string,
): SignInAccount[] {
  return (
    readFile(stateDir).runtimes[runtimeId]?.accounts ?? [{ id: "1" }]
  ).map((a) => ({ ...a }));
}

function current(f: AccountsFile, runtimeId: string): RuntimeAccounts {
  return (f.runtimes[runtimeId] ??= { accounts: [{ id: "1" }], next: 2 });
}

/** Why a name can't be an account's, or null. */
export function nameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "a name is not blank";
  if (n.length > ACCOUNT_NAME_MAX)
    return `a name is at most ${ACCOUNT_NAME_MAX} characters`;
  // No email anywhere Den keeps or shows (issue 339).
  if (n.includes("@")) return "a name is not an email: no @";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n)) return "a name is one line of text";
  return null;
}

/** "A" for "1", ... "Z", then "27": "Claude account A". */
export function defaultLetter(id: string): string {
  const n = Number(id);
  return n >= 1 && n <= 26 ? String.fromCharCode(64 + n) : id;
}

/**
 * Whose account it is, in the vendor's words ("Claude"): the catalog's
 * accountName, else the runtime's name (issue 339). An account is the
 * vendor's, not the CLI's.
 */
export function vendorName(runtimeId: string): string {
  const c = getRuntime(runtimeId)?.catalog;
  return c ? accountNameOf(c) : runtimeId;
}

/**
 * What people see: the name, or "<vendor> account A". A vendor's own
 * account is the vendor's word, never a person (words.js, 2026-11-17).
 */
export function accountLabel(
  a: Pick<SignInAccount, "id" | "name">,
  vendor: string,
): string {
  return a.name && !a.name.includes("@")
    ? a.name
    : `${vendor} account ${defaultLetter(a.id)}`;
}

/** The account's named ref under secrets.refs. */
export function accountRefName(runtimeId: string, accountId: string): string {
  const base = agentTokenRefName(runtimeId);
  return accountId === "1" ? base : `${base}__${accountId}`;
}

/**
 * Where a token set with no configured ref goes: account one of Claude
 * Code keeps the item it always had; every other account its own, named
 * by the runtime and the account's number (never a name or an email).
 */
export function newAccountRef(
  runtimeId: string,
  accountId: string,
  backend: SecretsProviderName,
): Partial<SecretRef> | null {
  if (runtimeId === "den-claude" && accountId === "1")
    return newAgentTokenRef(backend);
  const which = accountId === "1" ? runtimeId : `${runtimeId}, ${accountId}`;
  switch (backend) {
    case "1password":
      return {
        item: `${product().title} agent sign-in (${which})`,
        field: "password",
      };
    case "doppler":
      return {
        key: envKey(
          `AGENT_SIGNIN_TOKEN_${runtimeId}${accountId === "1" ? "" : `_${accountId}`}`
            .replace(/[^A-Za-z0-9]/g, "_")
            .toUpperCase(),
        ),
      };
    default:
      return null;
  }
}

/** Find an account by id, its letter ("B") or its name; or throw. */
export function findAccount(
  stateDir: string,
  runtimeId: string,
  which: string,
): SignInAccount {
  const list = listAccounts(stateDir, runtimeId);
  const vendor = vendorName(runtimeId);
  const w = which.trim();
  const hit =
    list.find((a) => a.id === w) ??
    list.find((a) => a.name !== undefined && a.name === w) ??
    list.find(
      (a) =>
        a.name === undefined &&
        (defaultLetter(a.id).toLowerCase() === w.toLowerCase() ||
          accountLabel(a, vendor).toLowerCase() === w.toLowerCase()),
    );
  if (!hit)
    throw new AccountsError(
      `no ${vendor} account "${w}" (${list.map((a) => `${a.id} ${accountLabel(a, vendor)}`).join(", ")})`,
    );
  return hit;
}

/** Add an account at the end of the order. */
export function addAccount(
  stateDir: string,
  runtimeId: string,
  name?: string,
): SignInAccount {
  signInRuntime(runtimeId);
  if (name !== undefined) {
    const bad = nameError(name);
    if (bad) throw new AccountsError(bad);
  }
  const f = readFile(stateDir);
  const r = current(f, runtimeId);
  const a: SignInAccount = { id: String(r.next) };
  if (name !== undefined) a.name = name.trim();
  r.accounts.push(a);
  r.next += 1;
  writeFile(stateDir, f);
  return { ...a };
}

/** Set the order: every account's id, once each. */
export function setAccountOrder(
  stateDir: string,
  runtimeId: string,
  ids: readonly string[],
): SignInAccount[] {
  const f = readFile(stateDir);
  const r = current(f, runtimeId);
  const have = r.accounts.map((a) => a.id);
  if (
    ids.length !== have.length ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => have.includes(id))
  )
    throw new AccountsError(
      `the order names every ${vendorName(runtimeId)} account once: ${have.join(" ")}`,
    );
  r.accounts = ids.map((id) => r.accounts.find((a) => a.id === id)!);
  writeFile(stateDir, f);
  return listAccounts(stateDir, runtimeId);
}

/** The ref agents read now: the first account's (slice 3 picks per agent). */
export function firstAccountRefName(
  stateDir: string,
  runtimeId: string,
): string {
  return accountRefName(runtimeId, listAccounts(stateDir, runtimeId)[0]!.id);
}

/** The first account, for the words a start says when it has no token. */
export function firstAccount(
  stateDir: string,
  runtimeId: string,
): SignInAccount {
  return listAccounts(stateDir, runtimeId)[0]!;
}

/** Account one of Claude Code keeps today's records (TOKEN_META_FILE). */
function legacy(runtimeId: string, accountId: string): boolean {
  return (
    accountId === "1" &&
    accountRefName(runtimeId, accountId) === AGENT_TOKEN_REF_NAME
  );
}

function patchAccount(
  stateDir: string,
  runtimeId: string,
  accountId: string,
  patch: (a: SignInAccount) => void,
): void {
  const f = readFile(stateDir);
  const a = current(f, runtimeId).accounts.find((x) => x.id === accountId);
  if (!a) return;
  patch(a);
  writeFile(stateDir, f);
}

export interface AccountTokenDeps extends Omit<
  TokenStoreDeps,
  "refName" | "fresh" | "recordSet" | "saveRef"
> {
  runtimeId: string;
  accountId: string;
  /** Write a new ref to user.yml under its name (default: saveAgentToken's). */
  saveRefAs?: (name: string, ref: Partial<SecretRef>) => void;
}

/**
 * Save (or replace) an account's token, as its own item. Throws on store
 * errors, never with the token in the message.
 */
export async function saveAccountToken(
  token: string,
  d: AccountTokenDeps,
): Promise<{ ref: "configured" | "created"; store: string }> {
  signInRuntime(d.runtimeId);
  const acct = findAccount(d.stateDir, d.runtimeId, d.accountId);
  const name = accountRefName(d.runtimeId, acct.id);
  const isLegacy = legacy(d.runtimeId, acct.id);
  const saveRefAs = d.saveRefAs;
  return saveAgentToken(token, {
    ...d,
    refName: name,
    fresh: (b) => newAccountRef(d.runtimeId, acct.id, b),
    ...(saveRefAs ? { saveRef: (r) => saveRefAs(name, r) } : {}),
    ...(isLegacy
      ? {}
      : {
          recordSet: (m: TokenMeta) =>
            patchAccount(d.stateDir, d.runtimeId, acct.id, (a) => {
              a.setAt = m.setAt;
              if (m.store) a.store = m.store;
              delete a.cleared;
            }),
        }),
  });
}

export interface AccountRemoveDeps extends Omit<
  TokenClearDeps,
  "refName" | "fresh" | "record"
> {
  runtimeId: string;
  accountId: string;
}

/**
 * Remove an account: its token leaves the store the way it was kept
 * (clearAgentToken), then the account leaves the list. With none left the
 * list is account one alone again, with no token.
 */
export async function removeAccount(
  d: AccountRemoveDeps,
): Promise<{ removed: SignInAccount; cleared: TokenClearResult }> {
  signInRuntime(d.runtimeId);
  const acct = findAccount(d.stateDir, d.runtimeId, d.accountId);
  const name = accountRefName(d.runtimeId, acct.id);
  const cleared = await clearAgentToken({
    ...d,
    refName: name,
    fresh: (b) => newAccountRef(d.runtimeId, acct.id, b),
    ...(legacy(d.runtimeId, acct.id)
      ? {}
      : {
          record: {
            has: () => !!acct.setAt,
            forget: () => {},
            markCleared: () => {},
          },
        }),
  });
  const f = readFile(d.stateDir);
  const r = current(f, d.runtimeId);
  r.accounts = r.accounts.filter((a) => a.id !== acct.id);
  if (!r.accounts.length) delete f.runtimes[d.runtimeId];
  writeFile(d.stateDir, f);
  return { removed: acct, cleared };
}

export interface AccountView {
  id: string;
  /** The person's name, or null: "Account <letter>" in the reader's words. */
  name: string | null;
  letter: string;
  /** What the CLI prints ("Account A"). */
  label: string;
  /** A token is configured for it (not removed). */
  configured: boolean;
  /** When it was set (ISO), or null when unknown. */
  setAt: string | null;
  store: string | null;
  /** The account agents get now (the first in the order). */
  first: boolean;
}

/**
 * The runtime's accounts for the CLI and Settings (never a token): read
 * from the config and the state dir only, nothing from the store.
 */
export function accountsView(
  stateDir: string,
  runtimeId: string,
  ref: (name: string) => SecretRef | null = (name) =>
    agentTokenRef(undefined, undefined, name),
): AccountView[] {
  return listAccounts(stateDir, runtimeId).map((a, i) => {
    const name = accountRefName(runtimeId, a.id);
    const isLegacy = legacy(runtimeId, a.id);
    const meta = isLegacy ? readTokenMeta(stateDir) : null;
    const cleared = isLegacy
      ? fs.existsSync(path.join(stateDir, TOKEN_CLEARED_FILE))
      : a.cleared === true;
    let has = false;
    try {
      has = !!ref(name);
    } catch {
      has = false;
    }
    return {
      id: a.id,
      name: a.name ?? null,
      letter: defaultLetter(a.id),
      label: accountLabel(a, vendorName(runtimeId)),
      configured: has && !cleared,
      setAt: (isLegacy ? meta?.setAt : a.setAt) ?? null,
      store: (isLegacy ? meta?.store : a.store) ?? null,
      first: i === 0,
    };
  });
}

/**
 * Issue 340 (slice 3): where the sign-in an agent starts on can come from,
 * besides Den's own order. A source (slice 6) knows which of Den's sign-ins
 * (by id) belongs to a folder, and which one is active now. Null: it has
 * no answer. A source that throws has none either.
 */
export interface AccountSource {
  forFolder(runtimeId: string, folder: string): string | null;
  active(runtimeId: string): string | null;
}

/** Which step chose it. */
export type PickFrom = "folder" | "active" | "order";

export interface PickedAccount {
  account: SignInAccount;
  /** What people see (accountLabel): never an email. */
  label: string;
  token: string;
  from: PickFrom;
}

/** A sign-in that was tried and passed over, and why (never a token). */
export interface PickMiss {
  id: string;
  label: string;
  /** "capped", or the store's reason ("not set", "not in the store"). */
  reason: string;
}

export interface PickDeps {
  stateDir: string;
  runtimeId: string;
  /** The agent's folder, for the source's mapping. */
  folder?: string;
  /** Read one sign-in's token by its ref name (readAgentToken's answer). */
  read: (refName: string) => Promise<{ token: string | null; reason?: string }>;
  /** Slice 6: the sign-in source, when one is set. */
  source?: AccountSource | null;
  /** Slice 4: a sign-in that hit its usage cap (default: none is). */
  capped?: (runtimeId: string, accountId: string) => boolean;
}

/**
 * Issue 340: the sign-in an agent starts on, with its token:
 *   1. the one the source maps to the agent's folder, if Den has its token;
 *   2. otherwise the one the source reports active;
 *   3. otherwise the first in Den's own order.
 * A capped one is skipped at every step (and not read). Each sign-in is
 * read at most once. With none, `picked` is null and `misses` says why for
 * every sign-in, in Den's order.
 */
export async function pickAccount(
  d: PickDeps,
): Promise<{ picked: PickedAccount | null; misses: PickMiss[] }> {
  const list = listAccounts(d.stateDir, d.runtimeId);
  const why = new Map<string, string>();
  const ask = (fn: () => string | null): string | null => {
    try {
      const id = fn();
      return typeof id === "string" ? id : null;
    } catch {
      return null;
    }
  };
  const tryOne = async (
    id: string | null,
    from: PickFrom,
  ): Promise<PickedAccount | null> => {
    const a = id === null ? undefined : list.find((x) => x.id === id);
    if (!a || why.has(a.id)) return null;
    if (d.capped?.(d.runtimeId, a.id)) {
      why.set(a.id, "capped");
      return null;
    }
    const r = await d.read(accountRefName(d.runtimeId, a.id));
    if (r.token)
      return {
        account: { ...a },
        label: accountLabel(a, vendorName(d.runtimeId)),
        token: r.token,
        from,
      };
    why.set(a.id, r.reason ?? "not in the store");
    return null;
  };
  const src = d.source;
  let picked: PickedAccount | null = null;
  if (src && d.folder !== undefined) {
    const folder = d.folder;
    picked = await tryOne(
      ask(() => src.forFolder(d.runtimeId, folder)),
      "folder",
    );
  }
  if (!picked && src)
    picked = await tryOne(
      ask(() => src.active(d.runtimeId)),
      "active",
    );
  for (const a of list) {
    if (picked) break;
    picked = await tryOne(a.id, "order");
  }
  const misses = list
    .filter((a) => why.has(a.id))
    .map((a) => ({
      id: a.id,
      label: accountLabel(a, vendorName(d.runtimeId)),
      reason: why.get(a.id)!,
    }));
  return { picked, misses };
}

/** Issue 340: one vendor's pick, for doctor (never a token). */
export interface SignInPick {
  runtime: string;
  vendor: string;
  /** How many accounts the vendor has. */
  count: number;
  /** The account a start would run on now; null: none has a token. */
  picked: { id: string; label: string } | null;
  misses: PickMiss[];
}

/**
 * Issue 340: for doctor, each vendor's pick (the runtimes with sign-in data
 * among `runtimeIds`), read as a start with no folder would.
 */
export async function signInPicks(
  d: Omit<PickDeps, "runtimeId" | "folder"> & { runtimeIds: string[] },
): Promise<SignInPick[]> {
  const out: SignInPick[] = [];
  for (const runtime of d.runtimeIds) {
    if (!getRuntime(runtime)?.signInTokenEnv) continue;
    const { picked, misses } = await pickAccount({ ...d, runtimeId: runtime });
    out.push({
      runtime,
      vendor: vendorName(runtime),
      count: listAccounts(d.stateDir, runtime).length,
      picked: picked ? { id: picked.account.id, label: picked.label } : null,
      misses,
    });
  }
  return out;
}
