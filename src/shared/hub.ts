/**
 * HUB-1.5: Den Hub for every agent Den launches.
 *
 *   hub:
 *     url: https://hub.example.com       # the Hub's base URL
 *     token: { item: …, field: … }        # a secret ref (or the name of a
 *                                         # secrets.refs entry), resolved
 *                                         # from this install's own store
 *
 * Read from the org config, then config/local/user.yml (user wins). SEC-0:
 * the token is the install's, from the install's secrets backend; Den
 * never assumes a vault, item or field of its own. With no hub.url,
 * nothing changes and nothing is shown.
 *
 * Every agent gets Hub's MCP server (Streamable HTTP at `<url>/mcp`, with
 * `Authorization: Bearer <token>`) and plain headers naming who calls:
 * X-Den-Agent, X-Den-Session, X-Den-Workspace, X-Den-Repos and (H5)
 * X-Den-Project, the Hub project the person linked this project to, or
 * `none`. Hub picks the company from the token and files by that project,
 * never by a guess. The token is never logged,
 * never in a page or an API answer: only in the agent's own 0600 MCP file.
 */
import * as crypto from "crypto";
import { readDenConfig, readUserConfig, type DenConfig } from "./den-config.js";
import { readHubProjectChoices } from "./hub-project-link.js";
import {
  getSecretsProvider,
  namedSecretRef,
  readSecretsConfig,
  type SecretRef,
  type SecretsConfig,
  type SecretsProvider,
} from "./secrets/index.js";
import {
  describeOpTokenSource,
  parseOpTokenSource,
  readOpToken,
  type OpTokenSource,
} from "./secrets/op-token.js";

/** The server's name in an agent's MCP config. */
export const HUB_SERVER = "hub";

/** The line every agent's prompt gets when Hub is set (generic). */
export const HUB_PROMPT_LINE =
  "You can search Hub and publish docs and mocks there with the hub_* tools; your team and project are set from this Den install.";

export interface HubConfig {
  /** The base URL, no trailing slash. */
  url: string;
  /** The token's ref in this install's store, or null when none is set. */
  tokenRef: SecretRef | null;
  /**
   * HUB-1.7: or a token source, `file:<path>` (mode 600), `keychain:<service>`
   * or `env:<VAR>`: where Connect keeps a token when the install's store
   * can't, or a distribution's own choice.
   */
  tokenSource?: OpTokenSource;
  /** Where the ref came from, for messages (never the value). */
  tokenFrom: string;
  /** HUB-1.7: Hub's MCP endpoint, as Hub gave it (default `<url>/mcp`). */
  mcpUrl: string;
  /**
   * hub.allow_tools (default true): agents use Hub's tools without asking.
   * Off, they ask like any tool. An install's own deny rule still wins.
   */
  allowTools: boolean;
  /**
   * D41 hub.inbox_on_stop (default "nudge"): an agent about to stop is
   * asked once to call hub_inbox when more Hub comments wait on it.
   */
  inboxOnStop: "nudge" | "off";
  /**
   * H5 hub.sync_check_seconds (default 30, at least 5): how often Den
   * checks whether its project list changed, to send it to Hub.
   */
  syncCheckSeconds: number;
  /**
   * 0.4.40 hub.delivery_heartbeat_seconds (default 15, at least 5): how
   * often Den tells Hub an agent is still working on a comment.
   */
  deliveryHeartbeatSeconds: number;
  /**
   * 0.4.40 hub.delivery_poll_seconds (default 30, at least 5): how often
   * Den reads Hub's list of comments when Hub has no stream.
   */
  deliveryPollSeconds: number;
}

type RawHub =
  | {
      url?: unknown;
      token?: unknown;
      allow_tools?: unknown;
      mcp_url?: unknown;
      inbox_on_stop?: unknown;
      sync_check_seconds?: unknown;
      delivery_heartbeat_seconds?: unknown;
      delivery_poll_seconds?: unknown;
    }
  | undefined;

function rawHub(den: unknown, user: unknown): RawHub {
  const d = (den as { hub?: RawHub } | null)?.hub ?? {};
  const u = (user as { hub?: RawHub } | null)?.hub ?? {};
  return { ...d, ...u };
}

/** A URL Den will send a token to: https, or http to this machine. */
export function hubUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `hub.url is not a URL: ${url}`;
  }
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    return `hub.url must be https (http only to this machine): ${url}`;
  return null;
}

/**
 * hub.* (org config, then user.yml), or null without hub.url. A bad value
 * throws naming its key.
 */
export function readHubConfig(
  den: DenConfig | Record<string, unknown> = readDenConfig(),
  user: Record<string, unknown> = readUserConfig() as Record<string, unknown>,
  secrets: () => SecretsConfig = readSecretsConfig,
): HubConfig | null {
  const h = rawHub(den, user);
  if (h?.url === undefined || h.url === null || h.url === "") return null;
  if (typeof h.url !== "string") throw new Error("hub.url must be a string");
  const url = h.url.trim().replace(/\/+$/, "");
  const bad = hubUrlProblem(url);
  if (bad) throw new Error(bad);
  const t = h.token;
  let tokenRef: SecretRef | null = null;
  let tokenFrom = "hub.token";
  let tokenSource: OpTokenSource | undefined;
  if (typeof t === "string" && /^(keychain|file|env):/.test(t.trim())) {
    tokenSource = parseOpTokenSource(t.trim(), "hub.token");
    tokenFrom = `hub.token (${describeOpTokenSource(tokenSource)})`;
  } else if (typeof t === "string" && t.trim()) {
    // The name of a secrets.refs entry.
    tokenFrom = `secrets.refs.${t.trim()}`;
    tokenRef = namedSecretRef(t.trim(), secrets());
  } else if (t && typeof t === "object") {
    const r = t as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const ref: SecretRef = {
      vault: s(r.vault),
      item: s(r.item),
      field: s(r.field) || s(r.key),
    };
    if (s(r.key)) ref.key = s(r.key);
    tokenRef = ref.item || ref.key || ref.field ? ref : null;
  } else if (t !== undefined && t !== null)
    throw new Error(
      "hub.token must be a secret ref ({ item, field } or { key }), the name of a secrets.refs entry, or file:<path> / keychain:<service> / env:<VAR>",
    );
  const at = h.allow_tools;
  if (at !== undefined && at !== null && typeof at !== "boolean")
    throw new Error("hub.allow_tools must be true or false");
  let mcpUrl = `${url}/mcp`;
  if (h.mcp_url !== undefined && h.mcp_url !== null && h.mcp_url !== "") {
    if (typeof h.mcp_url !== "string")
      throw new Error("hub.mcp_url must be a string");
    const m = h.mcp_url.trim();
    const badMcp = hubUrlProblem(m);
    if (badMcp) throw new Error(badMcp.replace("hub.url", "hub.mcp_url"));
    mcpUrl = m;
  }
  const ios = h.inbox_on_stop;
  if (ios !== undefined && ios !== null && ios !== "nudge" && ios !== "off")
    throw new Error('hub.inbox_on_stop must be "nudge" or "off"');
  const scs = h.sync_check_seconds;
  if (
    scs !== undefined &&
    scs !== null &&
    !(typeof scs === "number" && Number.isFinite(scs) && scs >= 5)
  )
    throw new Error("hub.sync_check_seconds must be a number, at least 5");
  const secs = (v: unknown, key: string, dflt: number): number => {
    if (v === undefined || v === null) return dflt;
    if (typeof v === "number" && Number.isFinite(v) && v >= 5) return v;
    throw new Error(`hub.${key} must be a number, at least 5`);
  };
  const beat = secs(
    h.delivery_heartbeat_seconds,
    "delivery_heartbeat_seconds",
    15,
  );
  const poll = secs(h.delivery_poll_seconds, "delivery_poll_seconds", 30);
  return {
    url,
    tokenRef,
    ...(tokenSource ? { tokenSource } : {}),
    tokenFrom,
    mcpUrl,
    allowTools: at !== false,
    inboxOnStop: ios === "off" ? "off" : "nudge",
    syncCheckSeconds: typeof scs === "number" ? scs : 30,
    deliveryHeartbeatSeconds: beat,
    deliveryPollSeconds: poll,
  };
}

/**
 * Apply a POSTed `hub_allow_tools` to user.yml's hub block (in place): a
 * boolean sets hub.allow_tools, null clears it (back to the default, on).
 */
export function patchHubAllowTools(
  user: Record<string, unknown>,
  v: unknown,
): { ok: true } | { ok: false; error: string } {
  if (v !== null && typeof v !== "boolean")
    return { ok: false, error: "hub_allow_tools must be true, false or null" };
  const hub = { ...((user.hub as Record<string, unknown> | undefined) ?? {}) };
  if (v === null) delete hub.allow_tools;
  else hub.allow_tools = v;
  if (Object.keys(hub).length) user.hub = hub;
  else delete user.hub;
  return { ok: true };
}

/** The token from this install's store, or null (none set, or unreadable). */
export async function readHubToken(
  cfg: HubConfig,
  provider: () => SecretsProvider = getSecretsProvider,
): Promise<string | null> {
  if (cfg.tokenSource) {
    const r = await readOpToken(cfg.tokenSource).catch(() => null);
    return r?.ok && r.token.trim() ? r.token.trim() : null;
  }
  if (!cfg.tokenRef) return null;
  try {
    const v = await provider().tryGet(cfg.tokenRef);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/** Who calls, as Hub reads it: plain names, never a secret. */
export interface HubCaller {
  /** The display name: Hub shows the latest one. */
  agent: string;
  /** HUB-1.7: the agent's stable id: Hub keys attribution on it. */
  agentId?: string;
  session: string;
  workspace: string;
  repos: string[];
  /**
   * H5: the Hub project the person linked this project to (proj_…); null
   * or missing: not linked, sent as `none` (Hub files it in Unfiled).
   */
  project?: string | null;
}

/** A header value: one line, printable, bounded. */
const headerSafe = (v: string) => v.replace(/[^\x20-\x7e]/g, "?").slice(0, 512);

export function hubHeaders(
  token: string,
  who: HubCaller,
): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "X-Den-Agent": headerSafe(who.agent),
    ...(who.agentId ? { "X-Den-Agent-Id": headerSafe(who.agentId) } : {}),
    "X-Den-Session": headerSafe(who.session),
    "X-Den-Workspace": headerSafe(who.workspace),
    "X-Den-Repos": headerSafe(who.repos.join(",")),
    "X-Den-Project": headerSafe(who.project || "none"),
  };
}

/** owner/repo from a catalog entry: its gh slug, else its git remote. */
export function ownerRepo(
  entry: { gh?: string; remote?: string } | undefined,
): string | null {
  if (entry?.gh && /^[^/\s]+\/[^/\s]+$/.test(entry.gh)) return entry.gh;
  const r = entry?.remote?.trim();
  if (!r) return null;
  const m = /[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(r);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** HUB-1.7: who this install is, as Hub's GET /connect/whoami says. */
export interface HubWhoami {
  /** The install's label (Hub's `install`). */
  install?: string;
  role?: string;
  /** The person who connected it. */
  login?: string;
  /**
   * 0.4.40: that person's Hub id (whoami's `person.id`), so Den can tell a
   * comment from the agent's own person; Den falls back to the login.
   */
  personId?: string;
  company?: { slug?: string; name?: string; url?: string };
  /** Hub's MCP endpoint; opaque. */
  mcpUrl?: string;
  /** Threads on Hub waiting on the person (the rail's badge). */
  unread?: number;
}

/**
 * Why a call to Hub failed: `rejected` (401: the token isn't accepted:
 * connect again), `forbidden` (403: Hub's own words; ask an admin, never
 * retry), `refused` (another 4xx with Hub's error code), `unreachable`.
 * The message never carries the token.
 */
export class HubCallError extends Error {
  constructor(
    readonly kind: "rejected" | "forbidden" | "refused" | "unreachable",
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type HubState =
  | "connected"
  | "no_token"
  | "rejected"
  | "forbidden"
  | "unreachable"
  | "bad_config";

export type HubStatus =
  | { configured: false }
  | {
      configured: true;
      url: string;
      connected: boolean;
      /** HUB-1.7: what Settings shows and offers (Connect, Reconnect, …). */
      state: HubState;
      /** hub.allow_tools: agents use Hub's tools without asking. */
      allowTools?: boolean;
      /** The company's name (Hub's company.name). */
      team?: string;
      /** Its page on Hub, for the deep link. */
      teamUrl?: string;
      /** This install's label on Hub. */
      label?: string;
      role?: string;
      login?: string;
      /** Hub threads waiting on the person (whoami's unread). */
      unread?: number;
      /** Why it isn't connected, in words (never the token). */
      problem?: string;
    };

type FetchFn = typeof fetch;
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** One JSON call to Hub, bounded; its answer, or a HubCallError. */
async function hubCall(
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number; fetch?: FetchFn },
): Promise<Record<string, unknown>> {
  const timeout = opts.timeoutMs ?? 5000;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    throw new HubCallError(
      "unreachable",
      name === "TimeoutError" || name === "AbortError"
        ? `Hub did not answer in ${timeout} ms`
        : `Hub could not be reached: ${(e as Error)?.message ?? e}`,
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const v = (await res.json()) as unknown;
    if (v && typeof v === "object") body = v as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (res.ok) return body;
  const said =
    str(body.error_description) ?? str(body.message) ?? str(body.error);
  if (res.status === 401)
    throw new HubCallError(
      "rejected",
      "Hub doesn't accept this install's token (revoked, or replaced by a newer connect): connect again",
      str(body.error),
    );
  if (res.status === 403)
    throw new HubCallError(
      "forbidden",
      `${said ?? "Hub refused this install"}: ask an admin of the company on Hub`,
      str(body.error),
    );
  if (res.status >= 400 && res.status < 500)
    throw new HubCallError(
      "refused",
      `Hub refused it (${res.status}${said ? `: ${said}` : ""})`,
      str(body.error),
    );
  throw new HubCallError(
    "unreachable",
    `Hub answered ${res.status}${said ? `: ${said}` : ""}`,
  );
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Ask Hub who this install is: GET <url>/connect/whoami with the token. */
export async function hubWhoami(
  url: string,
  token: string,
  opts: { timeoutMs?: number; fetch?: FetchFn } = {},
): Promise<HubWhoami> {
  const b = await hubCall(
    `${url}/connect/whoami`,
    {
      method: "GET",
      headers: { ...bearer(token), Accept: "application/json" },
    },
    opts,
  );
  const c = (b.company ?? {}) as Record<string, unknown>;
  const company = {
    ...(str(c.slug) ? { slug: str(c.slug)! } : {}),
    ...(str(c.name) ? { name: str(c.name)! } : {}),
    ...(str(c.url) ? { url: str(c.url)! } : {}),
  };
  return {
    ...(str(b.install) ? { install: str(b.install)! } : {}),
    ...(str(b.role) ? { role: str(b.role)! } : {}),
    ...(str(b.login) ? { login: str(b.login)! } : {}),
    ...(str((b.person as Record<string, unknown> | undefined)?.id)
      ? { personId: str((b.person as Record<string, unknown>).id)! }
      : {}),
    ...(Object.keys(company).length ? { company } : {}),
    ...(str(b.mcp_url) ? { mcpUrl: str(b.mcp_url)! } : {}),
    ...(typeof b.unread === "number" &&
    Number.isInteger(b.unread) &&
    b.unread >= 0
      ? { unread: Math.min(b.unread, 1_000_000) }
      : {}),
  };
}

/**
 * H5: the Hub projects of this install's company, and Hub's suggestions
 * for project `workspace` (the same repo, then the same name): GET
 * <url>/api/projects/suggest. Hub records nothing; the person picks.
 */
export async function hubProjectChoices(
  url: string,
  token: string,
  ask: { workspace: string; repos: string[] },
  opts: { timeoutMs?: number; fetch?: FetchFn } = {},
): Promise<ReturnType<typeof readHubProjectChoices>> {
  const q = new URLSearchParams({
    workspace: ask.workspace,
    repos: ask.repos.join(","),
  });
  const b = await hubCall(
    `${url}/api/projects/suggest?${q}`,
    {
      method: "GET",
      headers: { ...bearer(token), Accept: "application/json" },
    },
    opts,
  );
  return readHubProjectChoices(b);
}

/**
 * H5: tell Hub this install's full project list: PUT
 * <url>/api/installs/self/projects (GITHUB-COVERAGE / H5 sync). The raw
 * answer; hub-project-sync reads it.
 */
export async function hubPutProjects(
  url: string,
  token: string,
  body: unknown,
  opts: { timeoutMs?: number; fetch?: FetchFn } = {},
): Promise<Record<string, unknown>> {
  return hubCall(
    `${url}/api/installs/self/projects`,
    {
      method: "PUT",
      headers: {
        ...bearer(token),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    { timeoutMs: 10_000, ...opts },
  );
}

/** How much of each GitHub org Den Hub's App can read: GET <url>/api/installs/self/github. */
export async function hubGithubCoverage(
  url: string,
  token: string,
  opts: { timeoutMs?: number; fetch?: FetchFn } = {},
): Promise<Record<string, unknown>> {
  return hubCall(
    `${url}/api/installs/self/github`,
    {
      method: "GET",
      headers: { ...bearer(token), Accept: "application/json" },
    },
    opts,
  );
}

/**
 * 0.4.40: deliveries after `after` (uuidv7, time-ordered), at most 50:
 * GET <url>/api/installs/self/deliveries, the stream's fallback.
 */
export async function hubListDeliveries(
  url: string,
  token: string,
  after: string | null,
  opts: { timeoutMs?: number; fetch?: FetchFn } = {},
): Promise<unknown[]> {
  const q = new URLSearchParams({ limit: "50" });
  if (after) q.set("after", after);
  const b = await hubCall(
    `${url}/api/installs/self/deliveries?${q}`,
    {
      method: "GET",
      headers: { ...bearer(token), Accept: "application/json" },
    },
    { timeoutMs: 10_000, ...opts },
  );
  const list = b.deliveries ?? b.items;
  return Array.isArray(list) ? list.slice(0, 50) : [];
}

/** 0.4.40: a delivery's state: POST <url>/api/installs/self/deliveries/<id>/ack. */
export async function hubAckDelivery(
  url: string,
  token: string,
  id: string,
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; fetch?: FetchFn } = {},
): Promise<Record<string, unknown>> {
  return hubCall(
    `${url}/api/installs/self/deliveries/${encodeURIComponent(id)}/ack`,
    {
      method: "POST",
      headers: {
        ...bearer(token),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    opts,
  );
}

/**
 * 0.4.40: open the delivery stream (SSE), from Last-Event-ID when given.
 * The response, or a HubCallError (401 rejected, 403 forbidden, 404 and
 * other 4xx refused: this Hub has no stream yet). No timeout on the body:
 * the caller aborts with `signal`.
 */
export async function hubOpenDeliveryStream(
  url: string,
  token: string,
  lastId: string | null,
  opts: { signal?: AbortSignal; fetch?: FetchFn; connectMs?: number } = {},
): Promise<Response> {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  opts.signal?.addEventListener("abort", stop, { once: true });
  const t = setTimeout(stop, opts.connectMs ?? 10_000);
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(
      `${url}/api/installs/self/deliveries/stream`,
      {
        method: "GET",
        headers: {
          ...bearer(token),
          Accept: "text/event-stream",
          ...(lastId ? { "Last-Event-ID": lastId } : {}),
        },
        redirect: "error",
        signal: ctl.signal,
      },
    );
  } catch (e) {
    throw new HubCallError(
      "unreachable",
      `Hub could not be reached: ${(e as Error)?.message ?? e}`,
    );
  } finally {
    clearTimeout(t);
  }
  if (res.status === 401)
    throw new HubCallError("rejected", "Hub did not accept the token");
  if (res.status === 403)
    throw new HubCallError("forbidden", "Hub refused the delivery stream");
  if (!res.ok || !res.body)
    throw new HubCallError(
      res.status >= 500 ? "unreachable" : "refused",
      `Hub answered ${res.status} for the delivery stream`,
      String(res.status),
    );
  return res;
}

/** What POST /connect/token gives: the token, and where Hub is. */
export interface HubGrant {
  token: string;
  install?: string;
  role?: string;
  company?: { slug?: string; name?: string; url?: string };
  /** Hub's canonical origin: kept as hub.url. */
  hubUrl?: string;
  mcpUrl?: string;
}

/** Trade the one-time code for the install's token, server to server. */
export async function hubExchange(
  url: string,
  grant: { code: string; redirectUri: string; verifier: string },
  opts: { timeoutMs?: number; fetch?: FetchFn } = {},
): Promise<HubGrant> {
  const b = await hubCall(
    `${url}/connect/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code: grant.code,
        redirect_uri: grant.redirectUri,
        code_verifier: grant.verifier,
      }),
    },
    { timeoutMs: 15_000, ...opts },
  );
  const token = str(b.token);
  if (!token || !/^\S{8,}$/.test(token))
    throw new HubCallError("refused", "Hub's answer had no token");
  const c = (b.company ?? {}) as Record<string, unknown>;
  return {
    token,
    ...(str(b.install) ? { install: str(b.install)! } : {}),
    ...(str(b.role) ? { role: str(b.role)! } : {}),
    company: {
      ...(str(c.slug) ? { slug: str(c.slug)! } : {}),
      ...(str(c.name) ? { name: str(c.name)! } : {}),
      ...(str(c.url) ? { url: str(c.url)! } : {}),
    },
    ...(str(b.hub_url) ? { hubUrl: str(b.hub_url)!.replace(/\/+$/, "") } : {}),
    ...(str(b.mcp_url) ? { mcpUrl: str(b.mcp_url)! } : {}),
  };
}

/**
 * Revoke the install's token on Hub: POST <url>/connect/revoke with it.
 * True when Hub revoked it now, false when it was already dead (401).
 */
export async function hubRevoke(
  url: string,
  token: string,
  opts: { timeoutMs?: number; fetch?: FetchFn } = {},
): Promise<boolean> {
  try {
    await hubCall(
      `${url}/connect/revoke`,
      {
        method: "POST",
        headers: { ...bearer(token), Accept: "application/json" },
      },
      opts,
    );
    return true;
  } catch (e) {
    if (e instanceof HubCallError && e.kind === "rejected") return false;
    throw e;
  }
}

/** base64url without padding. */
const b64url = (b: Buffer) =>
  b
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** PKCE (S256): a fresh verifier and its challenge. */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

/** An opaque, single-use state value. */
export const newHubState = () => b64url(crypto.randomBytes(24));

/** A message that is safe to show: the token, if it slipped in, cut out. */
export function scrubToken(msg: string, token: string | null): string {
  return token ? msg.split(token).join("[token]") : msg;
}

/** Settings › Hub and doctor: set, connected, and to whom. */
export async function hubStatus(
  deps: {
    config?: () => HubConfig | null;
    token?: (c: HubConfig) => Promise<string | null>;
    whoami?: (url: string, token: string) => Promise<HubWhoami>;
  } = {},
): Promise<HubStatus> {
  let cfg: HubConfig | null;
  try {
    cfg = (deps.config ?? (() => readHubConfig()))();
  } catch (e) {
    return {
      configured: true,
      url: "",
      connected: false,
      state: "bad_config",
      problem: (e as Error).message,
    };
  }
  if (!cfg) return { configured: false };
  const base = {
    configured: true as const,
    url: cfg.url,
    allowTools: cfg.allowTools,
  };
  if (!cfg.tokenRef && !cfg.tokenSource)
    return {
      ...base,
      connected: false,
      state: "no_token",
      problem:
        cfg.tokenFrom === "hub.token"
          ? "not connected yet: Connect signs you in to Hub and sets this install up"
          : `hub.token names ${cfg.tokenFrom}, which is not set for this install's secrets backend`,
    };
  const token = await (deps.token ?? ((c) => readHubToken(c)))(cfg);
  if (!token)
    return {
      ...base,
      connected: false,
      state: "no_token",
      problem: `${cfg.tokenFrom} could not be read from this install's secrets store`,
    };
  try {
    const who = await (deps.whoami ?? ((u, t) => hubWhoami(u, t)))(
      cfg.url,
      token,
    );
    return {
      ...base,
      connected: true,
      state: "connected",
      ...(who.company?.name ? { team: who.company.name } : {}),
      ...(who.company?.url ? { teamUrl: who.company.url } : {}),
      ...(who.install ? { label: who.install } : {}),
      ...(who.role ? { role: who.role } : {}),
      ...(who.login ? { login: who.login } : {}),
      ...(who.unread !== undefined ? { unread: who.unread } : {}),
    };
  } catch (e) {
    const kind = e instanceof HubCallError ? e.kind : "unreachable";
    return {
      ...base,
      connected: false,
      state:
        kind === "rejected"
          ? "rejected"
          : kind === "forbidden"
            ? "forbidden"
            : "unreachable",
      // A HubCallError's words stand on their own; anything else is
      // something that kept Hub from answering.
      problem: scrubToken(
        e instanceof HubCallError
          ? e.message
          : `Hub did not answer: ${(e as Error)?.message ?? e}`,
        token,
      ),
    };
  }
}
