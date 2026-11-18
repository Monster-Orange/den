/**
 * Issue 193: an agent Den restarts with the same conversation (--resume)
 * keeps the tool list its client read when that conversation began: a
 * parameter Hub added since (hub_artifact_upload_part's base64) stays
 * unknown to it, though Den's /hub/mcp proxy serves Hub's live list.
 *
 * Den keeps, per agent, the conversation it saw and the shape of Hub's
 * tools/list then ({tool: {params, required}}, and its hash), in a state
 * file (mode 0600). When Hub's list differs, the agent gets one short note
 * on its next idle turn, written from the live list; then the stored list
 * is the live one, so the note is never repeated, even after a restart. A
 * new conversation records the current list and gets no note.
 *
 * Reopened (0.4.56): a runtime that reads its tool list once, at launch
 * (Claude Code), can't use a tool Hub added while it runs. Den also keeps
 * the list each agent's launch read. When that is older than Hub's, Den
 * restarts the agent at its next idle, on the same conversation, and
 * types nothing; its new launch reads Hub's list, and then the note is
 * true. One restart per new list per agent: a restart that fails, or comes
 * back on the old launch, gets the note that says a restart is needed
 * instead. So does every agent of a project with hub.tools_restart off.
 *
 * 0.4.57: only a launch records the list it read; a note never does. A
 * seen entry carries the time it was recorded. A launch Den never saw
 * (a state file from before 0.4.57) takes its seen list only when that was
 * recorded at or before the launch; otherwise its list is unknown, so it
 * restarts once at idle. A restart counts as tried for a list only once
 * it has succeeded or definitely failed: one refused while the agent is
 * still busy is tried again later.
 *
 * Hub and the agents are injected (tests use fakes); no timers of its own.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { noteHubResponse, withDenHandshake } from "./hub-compat.js";

/** Each Hub tool's parameters and the required ones, sorted. */
export type ToolShape = Record<
  string,
  { params: string[]; required: string[] }
>;

/** A tool or parameter name as Hub may send it: an identifier, bounded. */
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** The longest note typed into a pane. */
const NOTE_MAX = 1500;

const names = (v: unknown): string[] =>
  Array.isArray(v)
    ? [
        ...new Set(
          v.filter((x): x is string => typeof x === "string" && NAME.test(x)),
        ),
      ].sort()
    : [];

/** The shape of a tools/list's `tools` (anything else is left out). */
export function toolShape(list: unknown): ToolShape {
  const out: ToolShape = {};
  if (!Array.isArray(list)) return out;
  for (const t of list.slice(0, 500)) {
    if (!t || typeof t !== "object") continue;
    const name = (t as { name?: unknown }).name;
    if (typeof name !== "string" || !NAME.test(name)) continue;
    const s = (t as { inputSchema?: unknown }).inputSchema;
    const props =
      s && typeof s === "object"
        ? (s as { properties?: unknown }).properties
        : undefined;
    const params = names(
      props && typeof props === "object" ? Object.keys(props) : [],
    );
    const required = names(
      s && typeof s === "object"
        ? (s as { required?: unknown }).required
        : undefined,
    ).filter((r) => params.includes(r));
    out[name] = { params, required };
  }
  return out;
}

/** A stable hash of a shape (order-free). */
export function toolsHash(s: ToolShape): string {
  const canon = Object.keys(s)
    .sort()
    .map((k) => [k, s[k].params, s[k].required]);
  return createHash("sha256")
    .update(JSON.stringify(canon))
    .digest("hex")
    .slice(0, 32);
}

/**
 * How a note ends. `loaded`: the agent's tool list has Hub's current one
 * (its launch read it, or its runtime reloads in place). `restart`: it
 * doesn't, so the note never says it can use them.
 */
export const NOTE_END = {
  loaded: "Your tool list has Hub's current tools now.",
  restart:
    "Your tool list is still the one you started with, so you can't use these yet. A restart loads them and keeps this conversation: ask your person to press Restart on you in Den.",
} as const;

/** The note for an agent whose conversation began on `was`; null when nothing changed. */
export function toolsChangeNote(
  was: ToolShape,
  now: ToolShape,
  end: keyof typeof NOTE_END = "loaded",
): string | null {
  const parts: string[] = [];
  for (const name of Object.keys(now).sort()) {
    const n = now[name];
    const w = was[name];
    if (!w) {
      parts.push(`new tool ${name}`);
      continue;
    }
    const bits: string[] = [];
    const added = n.params.filter((p) => !w.params.includes(p));
    if (added.length) bits.push(`new parameters ${added.join(", ")}`);
    const gone = w.params.filter((p) => !n.params.includes(p));
    if (gone.length) bits.push(`${gone.join(", ")} removed`);
    const optional = w.required.filter(
      (p) => n.params.includes(p) && !n.required.includes(p),
    );
    if (optional.length) bits.push(`${optional.join(", ")} no longer required`);
    const nowReq = n.required.filter(
      (p) => w.params.includes(p) && !w.required.includes(p),
    );
    if (nowReq.length) bits.push(`${nowReq.join(", ")} now required`);
    if (bits.length) parts.push(`${name}: ${bits.join("; ")}`);
  }
  for (const name of Object.keys(was).sort())
    if (!now[name]) parts.push(`${name} was removed`);
  if (!parts.length) return null;
  let list = parts.join("; ");
  if (list.length > NOTE_MAX) list = `${list.slice(0, NOTE_MAX)}…`;
  return `Hub's tools changed since this conversation started: ${list}. ${NOTE_END[end]}`;
}

type FetchFn = typeof fetch;

/** One JSON-RPC message out of an MCP answer: JSON, or SSE's data lines. */
async function rpcAnswer(res: Response, id: number): Promise<unknown> {
  const text = (await res.text()).slice(0, 4 * 1024 * 1024);
  const type = res.headers.get("content-type") ?? "";
  const bodies: string[] = [];
  if (type.includes("text/event-stream")) {
    for (const ev of text.split(/\r?\n\r?\n/)) {
      const data = ev
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) bodies.push(data);
    }
  } else bodies.push(text);
  for (const b of bodies) {
    let m: unknown;
    try {
      m = JSON.parse(b);
    } catch {
      continue;
    }
    for (const one of Array.isArray(m) ? m : [m]) {
      const o = one as { id?: unknown; result?: unknown; error?: unknown };
      if (o && o.id === id) {
        if (o.error) throw new Error("Hub's MCP answered an error");
        return o.result;
      }
    }
  }
  throw new Error("Hub's MCP gave no answer");
}

/**
 * Hub's tools/list as Den itself reads it, with the install's token:
 * initialize, initialized, then tools/list (every page), carrying Hub's
 * Mcp-Session-Id when it gives one. Throws when Hub doesn't answer.
 */
export async function fetchHubTools(
  mcpUrl: string,
  token: string,
  opts: { fetch?: FetchFn; timeoutMs?: number } = {},
): Promise<unknown[]> {
  const f = opts.fetch ?? fetch;
  let session: string | null = null;
  let version = "2025-06-18";
  let seq = 0;
  const post = async (method: string, params: unknown, notify = false) => {
    const id = ++seq;
    let res: Response;
    try {
      res = await f(mcpUrl, {
        method: "POST",
        // Issue 521: the version handshake, Den's values.
        headers: withDenHandshake({
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(session ? { "Mcp-Session-Id": session } : {}),
          ...(seq > 1 ? { "Mcp-Protocol-Version": version } : {}),
        }),
        body: JSON.stringify({
          jsonrpc: "2.0",
          method,
          ...(params === undefined ? {} : { params }),
          ...(notify ? {} : { id }),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
    } catch (e) {
      throw new Error(
        `Hub could not be reached: ${(e as Error)?.message ?? e}`,
      );
    }
    noteHubResponse(mcpUrl, res);
    session = res.headers.get("mcp-session-id") ?? session;
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`Hub answered ${res.status}`);
    }
    if (notify) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return rpcAnswer(res, id);
  };
  const init = (await post("initialize", {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: "den-tools-check", version: "1" },
  })) as { protocolVersion?: unknown } | undefined;
  if (typeof init?.protocolVersion === "string") version = init.protocolVersion;
  await post("notifications/initialized", undefined, true);
  const tools: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = (await post("tools/list", cursor ? { cursor } : {})) as
      | { tools?: unknown; nextCursor?: unknown }
      | undefined;
    if (Array.isArray(r?.tools)) tools.push(...r.tools);
    cursor = typeof r?.nextCursor === "string" ? r.nextCursor : undefined;
    if (!cursor) break;
  }
  return tools;
}

type AgentState = "missing" | "stopped" | "busy" | "idle";

export interface HubToolsWatchDeps {
  /** Hub's tools/list now; throws when Hub doesn't answer; null: no Hub here. */
  fetchTools(): Promise<unknown[] | null>;
  /** This install's agents: `conv` names the conversation (null: none yet). */
  agents(): { id: string; conv: string | null; launchedAt: string }[];
  /** busy: mid-turn, or Den can't tell (never typed into then). */
  state(id: string): Promise<AgentState>;
  type(id: string, text: string): Promise<boolean>;
  /**
   * Whether the agent's runtime reloads its MCP tool list while it runs
   * (Runtime.reloadsToolsInPlace). False: the list its launch read stays.
   */
  reloadsInPlace(id: string): boolean;
  /**
   * Restart it at its next idle, on the same conversation, so its launch
   * reads Hub's list (Den's own action). Settles when done; throws when not.
   */
  restart(id: string): Promise<unknown>;
  /** hub.tools_restart for its project (default: on). Off: the note only. */
  restartOn?(id: string): boolean;
  /** The state file (mode 0600). */
  file: string;
  log?: (line: string) => void;
}

interface Seen {
  conv: string;
  hash: string;
  tools: ToolShape;
  /** When it was recorded (0.4.57; absent: before, so unknown). */
  at?: string;
}

/**
 * A list hash no list has: a launch whose list Den can't know (and its
 * seen entry then), so it counts as older than Hub's.
 */
const UNKNOWN = "unknown";

/** The state file's version: 2 since 0.4.57 (seen entries carry `at`). */
const STATE_V = 2;

/** `at` is a time at or before `than` (both ISO; unparseable: no). */
const atOrBefore = (at: string | undefined, than: string): boolean => {
  const a = at ? Date.parse(at) : NaN;
  const b = Date.parse(than);
  return Number.isFinite(a) && Number.isFinite(b) && a <= b;
};

/** An agent's launch, and the hash of Hub's list it read (absent: unknown). */
interface Launch {
  at: string;
  hash?: string;
}

const now = () => new Date().toISOString();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

export class HubToolsWatch {
  private live: { hash: string; tools: ToolShape } | null = null;
  private seen: Record<string, Seen> = {};
  /** Each agent's launch as last seen: a new one wants a fresh list. */
  private readonly launches = new Map<string, Launch>();
  /** The list hash each agent was restarted for: one restart per list. */
  private tried: Record<string, string> = {};
  /** Restarts under way. */
  private readonly running = new Map<string, Promise<void>>();
  private checking: Promise<void> | null = null;
  private lastSaid = "";

  constructor(private readonly d: HubToolsWatchDeps) {
    try {
      const raw = JSON.parse(fs.readFileSync(d.file, "utf8")) as {
        v?: unknown;
        agents?: Record<string, Seen>;
        launches?: Record<string, Launch>;
        tried?: Record<string, string>;
      };
      if (isRecord(raw?.agents)) this.seen = raw.agents;
      // 0.4.56's launches may hold a list a note recorded, and its tried a
      // restart that never came back: neither is trusted (issue 193).
      if (raw?.v !== STATE_V) return;
      if (isRecord(raw?.launches))
        for (const [id, l] of Object.entries(raw.launches))
          if (isRecord(l) && typeof l.at === "string")
            this.launches.set(id, {
              at: l.at,
              ...(typeof l.hash === "string" ? { hash: l.hash } : {}),
            });
      if (isRecord(raw?.tried))
        for (const [id, h] of Object.entries(raw.tried))
          if (typeof h === "string") this.tried[id] = h;
    } catch {
      /* none yet, or unreadable: start empty */
    }
  }

  /** The agents Den is restarting to load Hub's tools (their rows say so). */
  restarting(): string[] {
    return [...this.running.keys()];
  }

  /** Restarts under way, settled (tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  /** Read Hub's list now (one read at a time; it serves every agent). */
  check(): Promise<void> {
    this.checking ??= (async () => {
      try {
        const list = await this.d.fetchTools();
        if (list === null) return;
        const tools = toolShape(list);
        this.live = { hash: toolsHash(tools), tools };
        this.lastSaid = "";
      } catch (e) {
        // Once per different reason, not every check.
        const why = `Hub's tools not checked: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
        if (why !== this.lastSaid) this.d.log?.(why);
        this.lastSaid = why;
      }
    })().finally(() => (this.checking = null));
    return this.checking;
  }

  /**
   * One pass: record new conversations; restart an idle agent whose launch
   * read an older list than Hub's (when its runtime doesn't reload); tell
   * idle agents what changed once their tool list has it.
   */
  async pump(): Promise<void> {
    const agents = this.d.agents().filter((a) => a.conv);
    let dirty = false;
    // A started or resumed agent: read Hub's list first (once for all).
    const launched = agents.filter(
      (a) => this.launches.get(a.id)?.at !== a.launchedAt,
    );
    if (launched.length) {
      await this.check();
      for (const a of launched) {
        const prev = this.launches.get(a.id);
        const s = this.seen[a.id];
        let hash = this.live?.hash;
        // A launch Den never saw, on a conversation it knew (a state file
        // from before 0.4.57): it read the seen list only when that was
        // recorded at or before it. Else unknown: older than Hub's.
        if (!prev && s?.conv === a.conv && !this.d.reloadsInPlace(a.id)) {
          if (atOrBefore(s.at, a.launchedAt)) hash = s.hash;
          else {
            hash = UNKNOWN;
            this.seen[a.id] = { ...s, hash: UNKNOWN };
          }
        }
        this.launches.set(a.id, {
          at: a.launchedAt,
          ...(hash ? { hash } : {}),
        });
      }
      dirty = true;
    }
    const live = this.live;
    if (!live) return; // nothing known yet: nothing to save
    const ids = new Set(agents.map((a) => a.id));
    for (const id of new Set([
      ...Object.keys(this.seen),
      ...this.launches.keys(),
      ...Object.keys(this.tried),
    ]))
      if (!ids.has(id)) {
        delete this.seen[id];
        delete this.tried[id];
        this.launches.delete(id);
        dirty = true;
      }
    for (const a of agents) {
      const s = this.seen[a.id];
      if (!s || s.conv !== a.conv) {
        this.seen[a.id] = { conv: a.conv!, ...live, at: now() };
        dirty = true;
        continue;
      }
      if (s.hash === live.hash || this.running.has(a.id)) continue;
      // Hub's list as its tool list has it: its launch's (unknown: Hub's).
      const loaded =
        this.d.reloadsInPlace(a.id) ||
        (this.launches.get(a.id)?.hash ?? live.hash) === live.hash;
      const restartOn = this.d.restartOn?.(a.id) ?? true;
      if (!loaded && restartOn && this.tried[a.id] !== live.hash) {
        if ((await this.d.state(a.id).catch(() => "busy")) !== "idle") continue;
        this.restartFor(a.id, live.hash);
        continue;
      }
      const end = loaded ? "loaded" : "restart";
      // Told before 0.4.57 what changed, but its list was unknown: no
      // list to compare, so the note says only how it ends.
      const note =
        toolsChangeNote(s.tools, live.tools, end) ??
        (s.hash === UNKNOWN
          ? `Hub's tools changed since this conversation started. ${NOTE_END[end]}`
          : null);
      if (note) {
        if ((await this.d.state(a.id).catch(() => "busy")) !== "idle") continue;
        if (!(await this.d.type(a.id, note).catch(() => false))) continue;
        this.d.log?.(
          `agent ${a.id}: told Hub's tools changed${loaded ? "" : " (a restart loads them)"}`,
        );
      }
      // Seen, never launched: a note records no launch's list.
      this.seen[a.id] = { conv: a.conv!, ...live, at: now() };
      dirty = true;
    }
    if (dirty) this.persist();
  }

  /**
   * Den restarts agent `id` (same conversation) to load Hub's list `hash`.
   * Tried for it once the restart succeeded or definitely failed; refused
   * as still busy (its turn, or another change to it), tried again later.
   */
  private restartFor(id: string, hash: string): void {
    this.d.log?.(`agent ${id}: restarting to load Hub's tools`);
    const p = (async () => {
      try {
        await this.d.restart(id);
        this.tried[id] = hash;
      } catch (e) {
        const again = (e as { code?: unknown })?.code === "still_busy";
        if (!again) this.tried[id] = hash;
        this.d.log?.(
          `agent ${id}: not restarted for Hub's tools${again ? " yet (tried again later)" : ""}: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        );
      }
      this.persist();
    })().finally(() => this.running.delete(id));
    this.running.set(id, p);
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.d.file), { recursive: true });
      const tmp = `${this.d.file}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          v: STATE_V,
          agents: this.seen,
          launches: Object.fromEntries(this.launches),
          tried: this.tried,
        }),
        { mode: 0o600 },
      );
      fs.renameSync(tmp, this.d.file);
    } catch (e) {
      this.d.log?.(
        `Hub's tools: state not saved: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      );
    }
  }
}
