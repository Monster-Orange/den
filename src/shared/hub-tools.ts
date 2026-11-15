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
 * Hub and the agents are injected (tests use fakes); no timers of its own.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

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

/** The note for an agent whose conversation began on `was`; null when nothing changed. */
export function toolsChangeNote(was: ToolShape, now: ToolShape): string | null {
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
  return `Hub's tools changed since this conversation started: ${list}. You can call them with the new parameters now.`;
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
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(session ? { "Mcp-Session-Id": session } : {}),
          ...(seq > 1 ? { "Mcp-Protocol-Version": version } : {}),
        },
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
  /** The state file (mode 0600). */
  file: string;
  log?: (line: string) => void;
}

interface Seen {
  conv: string;
  hash: string;
  tools: ToolShape;
}

export class HubToolsWatch {
  private live: { hash: string; tools: ToolShape } | null = null;
  private seen: Record<string, Seen> = {};
  /** Each agent's launch as last seen: a new one wants a fresh list. */
  private readonly launches = new Map<string, string>();
  private checking: Promise<void> | null = null;
  private lastSaid = "";

  constructor(private readonly d: HubToolsWatchDeps) {
    try {
      const raw = JSON.parse(fs.readFileSync(d.file, "utf8")) as {
        agents?: Record<string, Seen>;
      };
      if (raw?.agents && typeof raw.agents === "object") this.seen = raw.agents;
    } catch {
      /* none yet, or unreadable: start empty */
    }
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

  /** One pass: record new conversations; tell idle agents what changed. */
  async pump(): Promise<void> {
    const agents = this.d.agents().filter((a) => a.conv);
    // A started or resumed agent: read Hub's list first (once for all).
    if (agents.some((a) => this.launches.get(a.id) !== a.launchedAt)) {
      for (const a of agents) this.launches.set(a.id, a.launchedAt);
      await this.check();
    }
    const live = this.live;
    if (!live) return;
    let dirty = false;
    const ids = new Set(agents.map((a) => a.id));
    for (const id of Object.keys(this.seen))
      if (!ids.has(id)) {
        delete this.seen[id];
        this.launches.delete(id);
        dirty = true;
      }
    for (const a of agents) {
      const s = this.seen[a.id];
      if (!s || s.conv !== a.conv) {
        this.seen[a.id] = { conv: a.conv!, ...live };
        dirty = true;
        continue;
      }
      if (s.hash === live.hash) continue;
      const note = toolsChangeNote(s.tools, live.tools);
      if (note) {
        if ((await this.d.state(a.id).catch(() => "busy")) !== "idle") continue;
        if (!(await this.d.type(a.id, note).catch(() => false))) continue;
        this.d.log?.(`agent ${a.id}: told Hub's tools changed`);
      }
      this.seen[a.id] = { conv: a.conv!, ...live };
      dirty = true;
    }
    if (dirty) this.persist();
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.d.file), { recursive: true });
      const tmp = `${this.d.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, agents: this.seen }), {
        mode: 0o600,
      });
      fs.renameSync(tmp, this.d.file);
    } catch (e) {
      this.d.log?.(
        `Hub's tools: state not saved: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      );
    }
  }
}
