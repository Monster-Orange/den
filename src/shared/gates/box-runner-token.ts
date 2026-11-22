/**
 * Issue 921, clause 4: a box runner's registration token, minted from the
 * project's GitHub App, in memory only.
 *
 *   1. The App's id and private key are read through Den's secrets layer
 *      (the active provider: 1Password, Doppler or env), from the item the
 *      project's `box_runner_app` setting names. Den never assumes a vault
 *      or item of its own (SEC-0).
 *   2. A short JWT signed with that key finds the repo's installation and
 *      mints an installation token scoped to that one repo, with runner
 *      admin (administration: write) only.
 *   3. The installation token mints the runner registration token, which
 *      goes to the caller (the box runner reads it on stdin) and nowhere
 *      else: never written, logged or put in an error.
 *
 * Any part missing, unreadable or refused fails closed, naming the part
 * (doctor shows it), never a value. GitHub's own error text is left out.
 */
import { createPrivateKey, createSign, type KeyObject } from "crypto";
import type { SecretRef, SecretsProvider } from "../secrets/types.js";

/** The project's `box_runner_app` setting: where the App's secrets are. */
export interface BoxRunnerAppSetting {
  vault: string;
  item: string;
  /** The item's field with the App's numeric id (default "app_id"). */
  app_id_field?: string;
  /** The item's field with the App's PEM private key (default "private_key"). */
  private_key_field?: string;
}

export interface BoxRunnerAppRefs {
  appId: SecretRef;
  privateKey: SecretRef;
}

/** Kept in memory only; handed to the box runner and dropped. */
export interface BoxRunnerToken {
  value: string;
  expiresAt: string;
}

export type BoxRunnerTokenPart =
  | "repo"
  | "app-id"
  | "private-key"
  | "installation"
  | "installation-token"
  | "registration-token";

export type BoxRunnerTokenResult =
  | { ok: true; token: BoxRunnerToken }
  | { ok: false; part: BoxRunnerTokenPart; error: string };

export interface BoxRunnerTokenDeps {
  /** The active secrets provider (getSecretsProvider()); reason when it has one. */
  provider: Partial<Pick<SecretsProvider, "tryGet" | "tryGetWithReason">>;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** GitHub's API root (GitHub Enterprise Server sets its own). */
  api?: string;
}

const NAME = /^[^\0\n\r]{1,200}$/;
const FIELD = /^[A-Za-z0-9_.-]{1,64}$/;
const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;
const APP_ID = /^[0-9]{1,12}$/;

/** The two refs the setting names, or null when the setting is malformed. */
export function boxRunnerAppRefs(raw: unknown): BoxRunnerAppRefs | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const vault = s(o.vault);
  const item = s(o.item);
  const idField = o.app_id_field === undefined ? "app_id" : s(o.app_id_field);
  const keyField =
    o.private_key_field === undefined ? "private_key" : s(o.private_key_field);
  if (!NAME.test(vault) || !NAME.test(item)) return null;
  if (!FIELD.test(idField) || !FIELD.test(keyField)) return null;
  return {
    appId: { vault, item, field: idField },
    privateKey: { vault, item, field: keyField },
  };
}

const fail = (
  part: BoxRunnerTokenPart,
  error: string,
): BoxRunnerTokenResult => ({ ok: false, part, error });

const b64u = (v: string | Buffer) => Buffer.from(v).toString("base64url");

/** An App JWT: issued a minute back (clock skew), good for nine minutes. */
function appJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64u(
    JSON.stringify({ iss: appId, iat: now - 60, exp: now + 9 * 60 }),
  );
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key);
  return `${head}.${body}.${b64u(sig)}`;
}

/** A read through the provider: the reason it gives, never a value. */
async function read(
  deps: BoxRunnerTokenDeps,
  ref: SecretRef,
): Promise<{ value: string | null; reason: string }> {
  try {
    const p = deps.provider;
    if (p.tryGetWithReason) {
      const r = await p.tryGetWithReason(ref);
      return { value: r.value, reason: r.reason ?? "not found" };
    }
    const value = p.tryGet ? await p.tryGet(ref) : null;
    return { value, reason: "not found" };
  } catch {
    return { value: null, reason: "the secrets provider failed" };
  }
}

/**
 * The registration token for `repo`'s runners, or which part failed. The
 * refs come from {@link boxRunnerAppRefs}.
 */
export async function mintBoxRunnerToken(
  repo: string,
  refs: BoxRunnerAppRefs,
  deps: BoxRunnerTokenDeps,
): Promise<BoxRunnerTokenResult> {
  const m = REPO.exec(repo);
  if (!m) return fail("repo", `"${repo.slice(0, 80)}" is not owner/name`);
  const [, owner, name] = m;
  const where = (r: SecretRef) => `${r.vault} / ${r.item} / ${r.field}`;

  const id = await read(deps, refs.appId);
  if (id.value === null)
    return fail("app-id", `${where(refs.appId)}: ${id.reason}`);
  const appId = id.value.trim();
  if (!APP_ID.test(appId))
    return fail("app-id", `${where(refs.appId)} is not a GitHub App id`);

  const pem = await read(deps, refs.privateKey);
  if (pem.value === null)
    return fail("private-key", `${where(refs.privateKey)}: ${pem.reason}`);
  let key: KeyObject;
  try {
    key = createPrivateKey(pem.value);
    if (key.asymmetricKeyType !== "rsa") throw new Error();
  } catch {
    return fail(
      "private-key",
      `${where(refs.privateKey)} is not a GitHub App private key (PEM, RSA)`,
    );
  }

  const fetch = deps.fetch ?? globalThis.fetch;
  const api = (deps.api ?? "https://api.github.com").replace(/\/+$/, "");
  const jwt = appJwt(appId, key, (deps.now ?? Date.now)());
  const call = async (
    part: BoxRunnerTokenPart,
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
  ): Promise<{ ok: true; json: Record<string, unknown> } | BoxRunnerTokenResult> => {
    let res: Response;
    try {
      res = await fetch(`${api}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${bearer}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // The error's own text is left out: it may carry the request.
      return fail(part, `GitHub couldn't be reached (${method} ${path})`);
    }
    if (!res.ok)
      return fail(part, `GitHub answered ${res.status} (${method} ${path})`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!json || typeof json !== "object")
      return fail(part, `GitHub's answer wasn't JSON (${method} ${path})`);
    return { ok: true, json: json as Record<string, unknown> };
  };

  const inst = await call(
    "installation",
    "GET",
    `/repos/${owner}/${name}/installation`,
    jwt,
  );
  if (!("json" in inst)) return inst;
  const installId = inst.json.id;
  if (typeof installId !== "number" || !Number.isSafeInteger(installId))
    return fail("installation", `the App isn't installed on ${repo}`);

  const access = await call(
    "installation-token",
    "POST",
    `/app/installations/${installId}/access_tokens`,
    jwt,
    { repositories: [name], permissions: { administration: "write" } },
  );
  if (!("json" in access)) return access;
  const installToken = access.json.token;
  if (typeof installToken !== "string" || !installToken)
    return fail("installation-token", "GitHub gave no installation token");

  const reg = await call(
    "registration-token",
    "POST",
    `/repos/${owner}/${name}/actions/runners/registration-token`,
    installToken,
  );
  if (!("json" in reg)) return reg;
  const value = reg.json.token;
  const expiresAt = reg.json.expires_at;
  if (typeof value !== "string" || !value || typeof expiresAt !== "string")
    return fail("registration-token", "GitHub gave no registration token");
  return { ok: true, token: { value, expiresAt } };
}
