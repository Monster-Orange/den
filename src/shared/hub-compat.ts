/**
 * Issue 521 (HUB-VER): the version handshake between Den and Hub.
 *
 * Den sends three headers on every call to Hub, connect included:
 *   - X-Den-Version: Den's exact version (package.json).
 *   - X-Den-Protocol: a whole number, raised only when a request or reply
 *     shape changes incompatibly.
 *   - X-Den-Capabilities: DEN_CAPABILITIES, lowercase, sorted, comma
 *     separated, no spaces.
 * Den's own values always win: a copy a caller (or an agent, through the
 * proxy) set is dropped first.
 *
 * Hub answers with X-Hub-Version, X-Hub-Protocol and X-Hub-Compat (ok,
 * degraded or unsupported) with X-Hub-Compat-Reason. Den keeps the latest
 * answer per Hub (its origin) in <state>/hub/compat.json, so the server,
 * doctor and a restart all see it. `unsupported` means Den sends Hub reads
 * only: a write is refused, with Hub's reason, before any of it is sent.
 * A Hub that sends no X-Hub-Compat is "not reported", never an error.
 *
 * Den branches on capabilities, never on version arithmetic: Hub's
 * version is kept to show, not to compare.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { engineVersion, getStateDir } from "./paths.js";

/** Raised only when a request or reply shape changes incompatibly. */
export const DEN_PROTOCOL = 1;

/**
 * What this Den does with Hub, as Hub reads it. Each name is lowercase;
 * the header sends them sorted. Add a name when Den gains the behaviour,
 * remove it when Den drops it.
 */
export const DEN_CAPABILITIES: readonly string[] = [
  // Honours X-Hub-Compat: unsupported: reads only, writes refused before they are sent.
  "compat.readonly",
  // Connects with the one-time code and PKCE (S256) at POST /connect/token.
  "connect.pkce",
  // Takes a token Hub rotates on whoami (?rotate=true) and confirms it.
  "connect.rotate",
  // Acks each delivery: queued, working, done, failed or refused.
  "deliveries.ack",
  // Reads the delivery stream (SSE, Last-Event-ID), with the list as its fallback.
  "deliveries.stream",
  // Reads what waits on one agent at GET /api/inbox (X-Den-Agent-Id).
  "inbox",
  // Passes agents' calls (MCP and Hub's agent paths) with the caller headers Den sets.
  "mcp.proxy",
  // Rereads Hub's tools/list and tells or restarts agents when it changes.
  "mcp.tools.watch",
  // Reads the install owner's notifications and marks them read.
  "notifications",
  // Asks Hub for a new project as a held change an owner decides (POST /api/projects/plan).
  "projects.plan",
  // Sends the install's project map (PUT /api/installs/self/projects).
  "projects.sync",
];

export const HANDSHAKE_HEADERS = [
  "X-Den-Version",
  "X-Den-Protocol",
  "X-Den-Capabilities",
] as const;

/** Den's exact version, as the header sends it. */
export function denVersion(): string {
  return engineVersion() ?? "0.0.0-unknown";
}

/** The capabilities as X-Den-Capabilities sends them. */
export function denCapabilities(): string {
  return [...new Set(DEN_CAPABILITIES.map((c) => c.toLowerCase()))]
    .sort()
    .join(",");
}

/** The three headers, Den's values. */
export function denHandshakeHeaders(): Record<string, string> {
  return {
    "X-Den-Version": denVersion(),
    "X-Den-Protocol": String(DEN_PROTOCOL),
    "X-Den-Capabilities": denCapabilities(),
  };
}

const HANDSHAKE_LC = new Set(HANDSHAKE_HEADERS.map((h) => h.toLowerCase()));

/** `h` with any copy of the three dropped (any case), then Den's own. */
export function withDenHandshake<T extends string | string[]>(
  h: Record<string, T> | undefined,
): Record<string, T | string> {
  const out: Record<string, T | string> = {};
  for (const [k, v] of Object.entries(h ?? {}))
    if (!HANDSHAKE_LC.has(k.toLowerCase())) out[k] = v;
  return Object.assign(out, denHandshakeHeaders());
}

export type HubCompatState = "ok" | "degraded" | "unsupported" | "not_reported";

/** Hub's latest answer about this Den. */
export interface HubCompat {
  state: HubCompatState;
  /** X-Hub-Compat-Reason, Hub's words: plain text, bounded. */
  reason?: string;
  hubVersion?: string;
  hubProtocol?: number;
  /** When Den read it (UTC ISO). */
  at: string;
}

/** Plain text: control characters out (intentional), trimmed, bounded. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const plain = (v: string | null | undefined, max: number) =>
  typeof v === "string" ? v.replace(CONTROL, " ").trim().slice(0, max) : "";

/** Hub's answer read from its response headers. */
export function readHubCompat(
  get: (name: string) => string | null | undefined,
  now: () => Date = () => new Date(),
): HubCompat {
  const raw = plain(get("x-hub-compat"), 32).toLowerCase();
  const state: HubCompatState =
    raw === "ok" || raw === "degraded" || raw === "unsupported"
      ? raw
      : "not_reported";
  const reason = plain(get("x-hub-compat-reason"), 300);
  const version = plain(get("x-hub-version"), 64);
  const proto = plain(get("x-hub-protocol"), 12);
  return {
    state,
    ...(reason && state !== "not_reported" ? { reason } : {}),
    ...(version ? { hubVersion: version } : {}),
    ...(/^\d{1,9}$/.test(proto) ? { hubProtocol: Number(proto) } : {}),
    at: now().toISOString(),
  };
}

/** A Hub's key: its origin (scheme, host, port). */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const compatFile = () => path.join(getStateDir(), "hub", "compat.json");

let cache: {
  file: string;
  mtimeMs: number;
  map: Record<string, HubCompat>;
} | null = null;

function load(): Record<string, HubCompat> {
  const file = compatFile();
  let mtimeMs = -1;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (cache && cache.file === file && cache.mtimeMs === mtimeMs)
    return cache.map;
  let map: Record<string, HubCompat> = {};
  if (mtimeMs >= 0)
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
      if (v && typeof v === "object") map = v as Record<string, HubCompat>;
    } catch {
      map = {};
    }
  cache = { file, mtimeMs, map };
  return map;
}

const same = (a: HubCompat | undefined, b: HubCompat) =>
  !!a &&
  a.state === b.state &&
  a.reason === b.reason &&
  a.hubVersion === b.hubVersion &&
  a.hubProtocol === b.hubProtocol;

/**
 * Keep Hub's latest answer for the Hub at `url`. Written only when it
 * changes; a Hub that never reported anything leaves no file.
 */
export function noteHubCompat(url: string, c: HubCompat): void {
  const key = originOf(url);
  if (!key) return;
  const map = load();
  const was = map[key];
  if (same(was, c)) return;
  if (!was && c.state === "not_reported" && !c.hubVersion) return;
  const next = { ...map, [key]: c };
  const file = compatFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(tmp, file);
    cache = { file, mtimeMs: fs.statSync(file).mtimeMs, map: next };
  } catch {
    // Kept for this process at least; the next answer tries again.
    cache = { file, mtimeMs: -2, map: next };
  }
}

/** Record Hub's answer from a fetch Response (or anything with headers.get). */
export function noteHubResponse(
  url: string,
  res: { headers: { get(name: string): string | null } },
): HubCompat {
  const c = readHubCompat((n) => res.headers.get(n));
  noteHubCompat(url, c);
  return c;
}

/** Hub's latest answer for the Hub at `url`, or null when none is kept. */
export function hubCompatFor(url: string): HubCompat | null {
  const key = originOf(url);
  return key ? (load()[key] ?? null) : null;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Why Den won't send this call to the Hub at `url`, or null when it may.
 * Only an unsupported Hub refuses, and only writes. Connect's own calls
 * (/connect/*) always go, so a person can reconnect or disconnect.
 */
export function hubWriteRefusal(url: string, method: string): string | null {
  if (READ_METHODS.has(method.toUpperCase())) return null;
  try {
    if (new URL(url).pathname.startsWith("/connect/")) return null;
  } catch {
    return null;
  }
  const c = hubCompatFor(url);
  if (c?.state !== "unsupported") return null;
  return unsupportedMessage(c);
}

/** The words for a write Den refused because Hub doesn't support this Den. */
export function unsupportedMessage(c: HubCompat): string {
  return `Hub doesn't support this Den (${denVersion()})${c.reason ? `: ${c.reason}` : ""}. Den sends Hub reads only until Den or Hub is updated; nothing was written.`;
}

/** JSON-RPC methods that only read. */
const MCP_READS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
]);

/** A Hub tool whose name says it only reads. */
const READ_TOOL =
  /^hub_(whoami|search|get|list|read|fetch|find|status|inbox|pull|show|view)(_|$)/;

/** Whether an MCP body (one message or a batch) only reads. */
export function mcpBodyReadsOnly(body: string): boolean {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    return false;
  }
  const msgs = Array.isArray(v) ? v : [v];
  if (!msgs.length) return false;
  return msgs.every((m) => {
    if (!m || typeof m !== "object") return false;
    const o = m as { method?: unknown; params?: { name?: unknown } };
    // A reply (no method) or a notification from the client writes nothing.
    if (o.method === undefined) return true;
    if (typeof o.method !== "string") return false;
    if (o.method.startsWith("notifications/")) return true;
    if (MCP_READS.has(o.method)) return true;
    return (
      o.method === "tools/call" &&
      typeof o.params?.name === "string" &&
      READ_TOOL.test(o.params.name)
    );
  });
}
