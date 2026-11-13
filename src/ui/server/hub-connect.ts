/**
 * HUB-1.7: Connect to Hub. A person connects this install from Settings ›
 * Agents › Hub; nobody copies a token or edits config.
 *
 *   1. POST /api/hub/connect { url? }  (signed in, CSRF): a PKCE verifier
 *      and a single-use state are made and kept here (10 min); the answer
 *      is Hub's /connect URL, and the page goes there.
 *   2. Hub signs the person in; they pick a company and approve. Hub sends
 *      the browser to <this Den>/hub/callback?code&state (or error=…).
 *   3. GET /hub/callback (sign-in free: the session cookie is SameSite
 *      Strict, so a redirect from Hub doesn't carry it; the single-use state
 *      and the verifier only this server holds are what protect it) trades
 *      the code for the install's token server to server (POST
 *      /connect/token), stores the token and points hub.token at it, then
 *      answers a page that moves on to Settings by script, a same-site
 *      navigation that carries the cookie again.
 *   4. POST /api/hub/disconnect revokes the token on Hub, then removes it
 *      here and clears hub.token.
 *
 * Where the token goes (SEC-0: the install's, never Den's): the install's
 * own secrets store when it keeps secrets (1Password, Doppler: a new item
 * or key, like the saved admin password), else a file Den keeps for this
 * install, <state dir>/hub/token (mode 600, its folder 700). Either way the
 * value travels on stdin or into the file, never in argv, and never to the
 * browser, a log or an API answer.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readWebUrl } from "../../shared/web-url.js";
import {
  hubExchange,
  HubCallError,
  hubRevoke,
  hubUrlProblem,
  newHubState,
  newPkce,
  readHubConfig,
  readHubToken,
  type HubConfig,
  type HubGrant,
} from "../../shared/hub.js";
import { readUserConfig, writeUserConfig } from "../../shared/den-config.js";
import { readEdgeConfig, readWebPort } from "../../shared/edge/config.js";
import { webRouteHosts } from "../../shared/edge/render.js";
import { getStateDir } from "../../shared/paths.js";
import { envKey, product } from "../../shared/product.js";
import {
  getSecretsProvider,
  readSecretsConfig,
  secretsStatus,
  type SecretRef,
} from "../../shared/secrets/index.js";

/** How long a started connect waits for Hub to send the person back. */
export const CONNECT_TTL_MS = 10 * 60_000;
/** At most this many connects waiting at once (oldest dropped first). */
const MAX_PENDING = 16;

interface Pending {
  verifier: string;
  hubUrl: string;
  redirectUri: string;
  at: number;
}

/** What hub.token becomes after a connect: a store ref, or a file source. */
export type StoredToken =
  | { kind: "ref"; ref: Partial<SecretRef>; where: string }
  | { kind: "file"; source: string; where: string };

export interface HubConnectDeps {
  now: () => number;
  /** hub.* as configured now (a distribution may preset hub.url). */
  config: () => HubConfig | null;
  exchange: typeof hubExchange;
  revoke: typeof hubRevoke;
  /** Keep the token for this install; what hub.token should say. */
  store: (token: string) => Promise<StoredToken>;
  /** Remove a token Connect stored (best effort). */
  forget: (cfg: HubConfig) => Promise<void>;
  readToken: (cfg: HubConfig) => Promise<string | null>;
  readUser: () => Record<string, unknown>;
  writeUser: (u: Record<string, unknown>) => void;
  /** This install's label on Hub (1–40 characters). */
  installLabel: () => string;
  /**
   * This Den's https edge address, when it has one (Connect's den_url:
   * where Hub links back to it when the browser came over loopback).
   */
  denUrl?: () => string | undefined;
}

/** A `<name>.localhost` host: this machine (RFC 6761). */
export const isDotLocalhost = (host: string) =>
  host.toLowerCase().endsWith(".localhost");

/**
 * `u` as an origin Hub takes for den_url, else null: plain (no user, path,
 * query or hash), and https or http to a `<name>.localhost`.
 */
export function denUrlOrigin(u: string): string | null {
  let x: URL;
  try {
    x = new URL(u);
  } catch {
    return null;
  }
  if (
    !(
      x.protocol === "https:" ||
      (x.protocol === "http:" && isDotLocalhost(x.hostname))
    ) ||
    x.username ||
    x.password ||
    (x.pathname !== "/" && x.pathname !== "") ||
    x.search ||
    x.hash
  )
    return null;
  return x.origin;
}

/** Of edge addresses, the den_url to send: https first, else a .localhost one. */
export function pickDenUrl(urls: readonly string[]): string | undefined {
  const all = urls.map((u) => denUrlOrigin(u)).filter((o): o is string => !!o);
  return all.find((o) => o.startsWith("https:")) ?? all[0];
}

/** This server's edge address for den_url (pickDenUrl of its edge routes). */
export function edgeDenUrl(
  port = Number(process.env.PORT) || 0,
): string | undefined {
  try {
    const ports = new Set([readWebPort(), ...(port ? [port] : [])]);
    return pickDenUrl(webRouteHosts(readEdgeConfig(), ports).map((r) => r.url));
  } catch {
    /* no edge config: none */
  }
  return undefined;
}

/** `<cli> on <machine>`: how Hub lists this install (Hub's label rule). */
export function defaultInstallLabel(
  cli = product().cli,
  host = os.hostname(),
): string {
  const machine = host.split(".")[0] || "this machine";
  // Hub's rule: 1–40 of [A-Za-z0-9 ._-], starting with a letter or digit.
  const label = `${cli} on ${machine}`
    .replace(/[^A-Za-z0-9 ._-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 40)
    .trimEnd();
  return label || "den";
}

/** The file Den keeps an install's Hub token in, when its store can't. */
export function hubTokenFile(stateDir = getStateDir()): string {
  return path.join(stateDir, "hub", "token");
}

/** Write the token to its 0600 file (folder 0700), replacing any old one. */
function writeTokenFile(file: string, token: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

/**
 * The install's store, when it keeps secrets: a 1Password item or a Doppler
 * key, named from the distribution (never Den's own vault). Null for env
 * (gone at restart) and none, and for a backend nobody chose.
 */
export function storeRefFor(backend: string): Partial<SecretRef> | null {
  switch (backend) {
    case "1password":
      return { item: `${product().title} Hub token`, field: "token" };
    case "doppler":
      return { key: envKey("HUB_TOKEN") };
    default:
      return null;
  }
}

async function defaultStore(token: string): Promise<StoredToken> {
  const st = secretsStatus(readSecretsConfig(), process.env);
  const ref =
    !st.implicit && st.detect.available ? storeRefFor(st.backend) : null;
  if (ref) {
    const full: SecretRef = {
      vault: ref.vault ?? "",
      item: ref.item ?? "",
      field: ref.field ?? ref.key ?? "",
      ...(ref.key ? { key: ref.key } : {}),
    };
    try {
      await getSecretsProvider().set(full, token);
      return {
        kind: "ref",
        ref,
        where: ref.item
          ? `${st.label}: ${ref.item}`
          : `${st.label}: ${ref.key}`,
      };
    } catch {
      // The store refused (signed out, locked): keep it in the file instead.
    }
  }
  const file = hubTokenFile();
  writeTokenFile(file, token);
  return { kind: "file", source: `file:${file}`, where: file };
}

async function defaultForget(cfg: HubConfig): Promise<void> {
  if (cfg.tokenSource?.kind === "file") {
    // Only the file Connect made: never a path a distribution chose.
    if (path.resolve(cfg.tokenSource.path) === path.resolve(hubTokenFile()))
      fs.rmSync(hubTokenFile(), { force: true });
    return;
  }
  if (cfg.tokenRef) {
    // Stores have no delete here: blank the value (the token is revoked).
    const st = secretsStatus(readSecretsConfig(), process.env);
    const ours = storeRefFor(st.backend);
    const same =
      !!ours &&
      (ours.item
        ? cfg.tokenRef.item === ours.item
        : cfg.tokenRef.key === ours.key);
    if (same)
      await getSecretsProvider()
        .set(cfg.tokenRef, " ")
        .catch(() => undefined);
  }
}

export function defaultHubConnectDeps(): HubConnectDeps {
  return {
    now: () => Date.now(),
    config: () => {
      try {
        return readHubConfig();
      } catch {
        return null;
      }
    },
    exchange: hubExchange,
    revoke: hubRevoke,
    store: defaultStore,
    forget: defaultForget,
    readToken: (c) => readHubToken(c),
    readUser: () => readUserConfig() as Record<string, unknown>,
    writeUser: (u) => writeUserConfig(u as never),
    installLabel: () => defaultInstallLabel(),
    // D80: the install's address, as Hub takes it (https, or a .localhost).
    denUrl: () => {
      const w = readWebUrl();
      return (w && denUrlOrigin(w.url)) || undefined;
    },
  };
}

/** An origin Hub will send the person back to: https, or loopback http (incl. *.localhost). */
export function callbackOriginProblem(origin: string): string | null {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return "this page's address isn't one Hub can send you back to";
  }
  // Loopback: localhost, 127.0.0.1, and any <name>.localhost (RFC 6761:
  // it never leaves this machine, and browsers count it a secure context),
  // which is how an edge on this machine is often reached over http.
  const h = u.hostname.toLowerCase();
  const loop = h === "localhost" || h === "127.0.0.1" || isDotLocalhost(h);
  if (u.protocol === "https:" || (u.protocol === "http:" && loop)) return null;
  return `Hub can only send you back to https or to this machine (localhost or a .localhost name); open ${product().title} over https (its edge address) or on this machine, then Connect`;
}

export type ConnectResult =
  | { ok: true; team?: string; where: string }
  | { ok: false; reason: "denied" | "expired" | "failed"; message: string };

export class HubConnect {
  private readonly pending = new Map<string, Pending>();
  constructor(readonly deps: HubConnectDeps = defaultHubConnectDeps()) {}

  private sweep(): void {
    const now = this.deps.now();
    for (const [k, v] of this.pending)
      if (now - v.at > CONNECT_TTL_MS) this.pending.delete(k);
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  /**
   * Step 1: where to send the browser. `origin` is this Den as the browser
   * sees it (the request's checked Origin); `url` a Hub the person typed,
   * else hub.url.
   */
  start(
    origin: string,
    url?: unknown,
  ): { ok: true; location: string } | { ok: false; error: string } {
    const typed = typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
    const hubUrl = typed || this.deps.config()?.url || "";
    if (!hubUrl) return { ok: false, error: "type Hub's address first" };
    const bad = hubUrlProblem(hubUrl);
    if (bad)
      return { ok: false, error: bad.replace("hub.url", "Hub's address") };
    const badOrigin = callbackOriginProblem(origin);
    if (badOrigin) return { ok: false, error: badOrigin };
    this.sweep();
    const state = newHubState();
    const { verifier, challenge } = newPkce();
    const redirectUri = `${new URL(origin).origin}/hub/callback`;
    this.pending.set(state, {
      verifier,
      hubUrl,
      redirectUri,
      at: this.deps.now(),
    });
    const q = new URLSearchParams({
      install: this.deps.installLabel(),
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    // Hub takes only a plain https or <name>.localhost address (anything
    // else is a 400), and uses it only when redirect_uri is loopback. A
    // reconnect sends it again.
    const denUrl = denUrlOrigin(this.deps.denUrl?.() ?? "");
    if (denUrl) q.set("den_url", denUrl);
    return { ok: true, location: `${hubUrl}/connect?${q}` };
  }

  /**
   * Steps 2–3: Hub sent the person back. The state is used once, whatever
   * happens. On success the token is stored and hub.* written to user.yml.
   * The result names what happened in words (never the token or the code).
   */
  async finish(q: URLSearchParams): Promise<ConnectResult> {
    const r = await this.finishOnce(q);
    this.last = {
      ok: r.ok,
      message: r.ok
        ? `Connected to Hub${r.team ? ` (${r.team})` : ""}.`
        : r.message,
      at: this.deps.now(),
    };
    return r;
  }

  /**
   * What the last Connect came to, in words, read once (Settings shows it
   * after Hub's redirect; the callback page only flashes by). Never the
   * token or the code.
   */
  lastResult(): { ok: boolean; message: string } | null {
    const l = this.last;
    this.last = null;
    if (!l || this.deps.now() - l.at > CONNECT_TTL_MS) return null;
    return { ok: l.ok, message: l.message };
  }

  private last: { ok: boolean; message: string; at: number } | null = null;

  private async finishOnce(q: URLSearchParams): Promise<ConnectResult> {
    const state = q.get("state") ?? "";
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || this.deps.now() - p.at > CONNECT_TTL_MS)
      return {
        ok: false,
        reason: "expired",
        message: "That connect link is used or too old: press Connect again.",
      };
    if (q.get("error"))
      return {
        ok: false,
        reason: "denied",
        message:
          q.get("error") === "access_denied"
            ? "Not connected: the request was declined on Hub."
            : "Not connected: Hub didn't finish the connect.",
      };
    const code = q.get("code") ?? "";
    if (!code)
      return { ok: false, reason: "failed", message: "Hub sent no code back." };
    let grant: HubGrant;
    try {
      grant = await this.deps.exchange(p.hubUrl, {
        code,
        redirectUri: p.redirectUri,
        verifier: p.verifier,
      });
    } catch (e) {
      const m =
        e instanceof HubCallError &&
        e.kind === "refused" &&
        e.code === "invalid_grant"
          ? "Hub didn't accept the code (used, expired or for another address): press Connect again."
          : `Hub didn't give a token: ${(e as Error).message}`;
      return { ok: false, reason: "failed", message: m };
    }
    const hubUrl =
      grant.hubUrl && !hubUrlProblem(grant.hubUrl) ? grant.hubUrl : p.hubUrl;
    let stored: StoredToken;
    try {
      stored = await this.deps.store(grant.token);
    } catch (e) {
      // Don't leave a live token nobody can find: revoke it.
      await this.deps.revoke(hubUrl, grant.token).catch(() => undefined);
      return {
        ok: false,
        reason: "failed",
        message: `Connected, but the token couldn't be kept here (${(e as Error).message}); it was revoked. Press Connect again.`,
      };
    }
    const user = this.deps.readUser();
    const hub = {
      ...((user.hub as Record<string, unknown> | undefined) ?? {}),
    };
    hub.url = hubUrl;
    hub.token = stored.kind === "ref" ? stored.ref : stored.source;
    if (grant.mcpUrl && !hubUrlProblem(grant.mcpUrl))
      hub.mcp_url = grant.mcpUrl;
    else delete hub.mcp_url;
    this.deps.writeUser({ ...user, hub });
    return {
      ok: true,
      ...(grant.company?.name ? { team: grant.company.name } : {}),
      where: stored.where,
    };
  }

  /**
   * Step 4: revoke on Hub, then remove it here and clear hub.token (hub.url
   * stays, so Connect is one click). Hub unreachable: nothing is removed,
   * so it can be tried again; `force` removes it here anyway and says Hub
   * still has it.
   */
  async disconnect(
    force = false,
  ): Promise<
    | { ok: true; revoked: boolean; message: string }
    | { ok: false; error: string }
  > {
    const cfg = this.deps.config();
    if (!cfg || (!cfg.tokenRef && !cfg.tokenSource))
      return { ok: true, revoked: false, message: "Not connected." };
    const token = await this.deps.readToken(cfg);
    let revoked = false;
    let note = "";
    if (token) {
      try {
        revoked = await this.deps.revoke(cfg.url, token);
        if (!revoked) note = " Hub had already revoked it.";
      } catch (e) {
        if (!force)
          return {
            ok: false,
            error: `Hub couldn't revoke the token (${(e as Error).message}). Nothing was removed. Try again, or remove it here anyway.`,
          };
        note =
          " Hub couldn't be reached, so the token still works there until an admin revokes this install.";
      }
    }
    await this.deps.forget(cfg).catch(() => undefined);
    const user = this.deps.readUser();
    const hub = {
      ...((user.hub as Record<string, unknown> | undefined) ?? {}),
    };
    delete hub.token;
    delete hub.mcp_url;
    if (Object.keys(hub).length) user.hub = hub;
    else delete user.hub;
    this.deps.writeUser(user);
    return {
      ok: true,
      revoked,
      message: `Disconnected.${revoked ? " Hub revoked this install's token." : ""}${note}`,
    };
  }
}

/** The page /hub/callback answers: it moves on to Settings by script. */
export function callbackPage(
  title: string,
  result: { ok: boolean; message: string; reason?: string },
): string {
  const next = `/settings?hub=${result.ok ? "connected" : (result.reason ?? "failed")}#agents.hub`;
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)}: Hub</title></head><body style="font:15px system-ui,sans-serif;margin:2rem;max-width:40rem"><p data-hub-result="${result.ok ? "connected" : (result.reason ?? "failed")}">${esc(result.message)}</p><p><a href="${next}">Back to Settings</a></p><script>location.replace(${JSON.stringify(next)})</script></body></html>`;
}
