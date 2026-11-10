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
 * X-Den-Agent, X-Den-Session, X-Den-Workspace, X-Den-Repos. Hub picks the
 * team (from the token) and the project (from the repos, then the
 * workspace's name, then the team's default). The token is never logged,
 * never in a page or an API answer: only in the agent's own 0600 MCP file.
 */
import { readDenConfig, readUserConfig, type DenConfig } from "./den-config.js";
import {
  getSecretsProvider,
  namedSecretRef,
  readSecretsConfig,
  type SecretRef,
  type SecretsConfig,
  type SecretsProvider,
} from "./secrets/index.js";

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
  /** Where the ref came from, for messages (never the value). */
  tokenFrom: string;
  /**
   * hub.allow_tools (default true): agents use Hub's tools without asking.
   * Off, they ask like any tool. An install's own deny rule still wins.
   */
  allowTools: boolean;
}

type RawHub =
  | { url?: unknown; token?: unknown; allow_tools?: unknown }
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
  if (typeof t === "string" && t.trim()) {
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
      "hub.token must be a secret ref ({ item, field } or { key }) or the name of a secrets.refs entry",
    );
  const at = h.allow_tools;
  if (at !== undefined && at !== null && typeof at !== "boolean")
    throw new Error("hub.allow_tools must be true or false");
  return { url, tokenRef, tokenFrom, allowTools: at !== false };
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
  agent: string;
  session: string;
  workspace: string;
  repos: string[];
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
    "X-Den-Session": headerSafe(who.session),
    "X-Den-Workspace": headerSafe(who.workspace),
    "X-Den-Repos": headerSafe(who.repos.join(",")),
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

export interface HubWhoami {
  team?: string;
  label?: string;
}

export type HubStatus =
  | { configured: false }
  | {
      configured: true;
      url: string;
      connected: boolean;
      /** hub.allow_tools: agents use Hub's tools without asking. */
      allowTools?: boolean;
      team?: string;
      label?: string;
      /** Why it isn't connected, in words (never the token). */
      problem?: string;
    };

/** The first object in a tool result: structured content, else JSON text. */
function resultObject(r: unknown): Record<string, unknown> | null {
  const o = r as {
    structuredContent?: unknown;
    content?: { type?: string; text?: string }[];
  };
  if (o?.structuredContent && typeof o.structuredContent === "object")
    return o.structuredContent as Record<string, unknown>;
  for (const c of o?.content ?? [])
    if (c?.type === "text" && c.text)
      try {
        const v = JSON.parse(c.text) as unknown;
        if (v && typeof v === "object") return v as Record<string, unknown>;
      } catch {
        /* not JSON */
      }
  return null;
}

/**
 * Ask Hub who this install is: its whoami tool (the first tool whose name
 * ends in "whoami"), over Streamable HTTP with the token. Bounded by
 * `timeoutMs`; a failure is said in words, without the token.
 */
export async function hubWhoami(
  url: string,
  token: string,
  opts: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<HubWhoami> {
  // Loaded here: only Settings › Hub and doctor ask Hub anything.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const client = new Client({ name: "den", version: "1" });
  const timeout = opts.timeoutMs ?? 5000;
  let timer: NodeJS.Timeout | undefined;
  const bounded = <T>(p: Promise<T>) =>
    Promise.race([
      p,
      new Promise<never>((_r, rej) => {
        timer = setTimeout(
          () => rej(new Error(`Hub did not answer in ${timeout} ms`)),
          timeout,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  try {
    await bounded(client.connect(transport));
    const tools = await bounded(client.listTools());
    const who = tools.tools.find((t) => /whoami$/.test(t.name));
    if (!who) return {};
    const r = resultObject(
      await bounded(client.callTool({ name: who.name, arguments: {} })),
    );
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    return {
      ...(str(r?.team ?? (r?.team_name as unknown))
        ? { team: str(r?.team ?? r?.team_name)! }
        : {}),
      ...(str(r?.label ?? r?.install ?? r?.install_label)
        ? { label: str(r?.label ?? r?.install ?? r?.install_label)! }
        : {}),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

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
      problem: (e as Error).message,
    };
  }
  if (!cfg) return { configured: false };
  if (!cfg.tokenRef)
    return {
      configured: true,
      url: cfg.url,
      allowTools: cfg.allowTools,
      connected: false,
      problem:
        cfg.tokenFrom === "hub.token"
          ? "no hub.token: set it to the install token's secret ref (Hub › Settings › Den installs makes one)"
          : `hub.token names ${cfg.tokenFrom}, which is not set for this install's secrets backend`,
    };
  const token = await (deps.token ?? ((c) => readHubToken(c)))(cfg);
  if (!token)
    return {
      configured: true,
      url: cfg.url,
      allowTools: cfg.allowTools,
      connected: false,
      problem: `${cfg.tokenFrom} could not be read from this install's secrets store`,
    };
  try {
    const who = await (deps.whoami ?? ((u, t) => hubWhoami(u, t)))(
      cfg.url,
      token,
    );
    return {
      configured: true,
      url: cfg.url,
      allowTools: cfg.allowTools,
      connected: true,
      ...who,
    };
  } catch (e) {
    return {
      configured: true,
      url: cfg.url,
      allowTools: cfg.allowTools,
      connected: false,
      problem: scrubToken(`Hub did not answer: ${(e as Error).message}`, token),
    };
  }
}
