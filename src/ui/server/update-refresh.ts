/**
 * #390: after Den updates itself, restart each agent whose tools started
 * on the old Den, at its next idle, on the same conversation.
 *
 * An agent's Den tools (its MCP server) are a child of its session, so a
 * self-update, which restarts only the web server, leaves them on the old
 * code (#384). Den restarts those agents itself, through the same restart
 * as the Hub tools refresh and /api/agents/restart-stale
 * (agent-routes.ts restartForTools): an agent at its prompt now, a busy one
 * once its turn ends. A stopped one loads the new tools when it starts.
 *
 * Which agents: those whose session last started (resumedAt, else
 * startedAt) before the new engine was installed (its package.json's
 * mtime). Each is restarted once per update: the ids done are kept in
 * <state>/server-agent/update/refresh.json with the update (to and at), so
 * a second pass or a new Den process never restarts one twice.
 * server_agent.refresh_agents: false (user.yml) turns it off. The bell
 * says which agents were refreshed, once all are.
 */
import * as fs from "fs";
import * as path from "path";

export interface RefreshAgent {
  id: string;
  workspace: string;
  /** When its session (and so its Den tools) last started. */
  launchedAt: string;
}

export interface RefreshDeps {
  /** server_agent.refresh_agents, now. */
  on: () => boolean;
  /** Every agent Den has a record of. */
  agents: () => RefreshAgent[];
  /** When the running engine was installed (ms), or null: unknown. */
  installedAt: () => number | null;
  state: (a: RefreshAgent) => Promise<"missing" | "stopped" | "busy" | "idle">;
  /** Restart it on the same conversation; true: it restarted. */
  restart: (a: RefreshAgent) => Promise<boolean>;
  /** The bell: the agents refreshed for this update. */
  bell: (refreshed: RefreshAgent[], version: string) => void;
  /** The once-per-update record (refresh.json). */
  file: string;
  log?: (line: string) => void;
}

interface Done {
  to: string;
  at: string;
  ids: string[];
}

export class UpdateRefresh {
  private pending: RefreshAgent[] = [];
  private refreshed: RefreshAgent[] = [];
  private update: { to: string; at: string } | null = null;

  constructor(private readonly d: RefreshDeps) {}

  private readDone(): Done | null {
    try {
      const v = JSON.parse(fs.readFileSync(this.d.file, "utf8")) as Done;
      return typeof v?.to === "string" &&
        typeof v.at === "string" &&
        Array.isArray(v.ids)
        ? v
        : null;
    } catch {
      return null;
    }
  }

  private markDone(id: string): void {
    const u = this.update;
    if (!u) return;
    const prev = this.readDone();
    const ids =
      prev && prev.to === u.to && prev.at === u.at ? [...prev.ids] : [];
    if (!ids.includes(id)) ids.push(id);
    fs.mkdirSync(path.dirname(this.d.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.d.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...u, ids }) + "\n", {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.d.file);
  }

  /**
   * For a good update (its `to` and `at`): the agents to restart, those
   * whose tools started before the new engine was installed and that this
   * update hasn't restarted yet. None when the setting is off.
   */
  begin(update: { to: string; at: string }): RefreshAgent[] {
    this.update = update;
    this.pending = [];
    this.refreshed = [];
    if (!this.d.on()) return [];
    const installed = this.d.installedAt();
    if (installed === null) return [];
    const prev = this.readDone();
    const done =
      prev && prev.to === update.to && prev.at === update.at
        ? new Set(prev.ids)
        : new Set<string>();
    this.pending = this.d.agents().filter((a) => {
      const t = Date.parse(a.launchedAt);
      return Number.isFinite(t) && t < installed && !done.has(a.id);
    });
    return [...this.pending];
  }

  /**
   * One beat: each pending agent at its prompt is restarted (once, done
   * or not); a busy one waits for the next beat; one not running is left.
   * True when none is left; the bell then says who was refreshed.
   */
  async pump(): Promise<boolean> {
    if (!this.pending.length) return true;
    const left: RefreshAgent[] = [];
    for (const a of this.pending) {
      let s: Awaited<ReturnType<RefreshDeps["state"]>>;
      try {
        s = await this.d.state(a);
      } catch {
        s = "busy"; // can't tell now: the next beat asks again
      }
      if (s === "busy") {
        left.push(a);
        continue;
      }
      if (s !== "idle") continue; // not running: it starts on the new tools
      this.markDone(a.id);
      try {
        if (await this.d.restart(a)) this.refreshed.push(a);
      } catch (e) {
        this.d.log?.(
          `refresh after update: ${a.id} not restarted: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    this.pending = left;
    if (left.length) return false;
    if (this.refreshed.length && this.update)
      this.d.bell(this.refreshed, this.update.to);
    this.refreshed = [];
    return true;
  }
}

export interface AfterUpdateDeps {
  /** The version this Den runs. */
  version: string | null;
  /** The update record now (den-update.ts readUpdateState). */
  readState: () => { state: string; to: string; at: string } | null;
  /** How long a "watching" record is waited on for its verdict. */
  waitMs: number;
  refresh: Pick<UpdateRefresh, "begin" | "pump">;
  /** Between looks at a "watching" record (default 5 s). */
  pollMs?: number;
  /** Between beats while an agent is busy (default 2 s). */
  beatMs?: number;
  /** Told the agents to restart, once they are known. */
  onBegin?: (list: RefreshAgent[]) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * From the recorded update: when Den started on the version an update
 * went to, wait for the watch's verdict (at most `waitMs`); once it is
 * "good", restart the agents on the old tools (UpdateRefresh), beating
 * until each busy one has been idle once. Rolled back, another version's
 * record or no verdict in time: nothing. The agents asked for restart.
 */
export async function refreshAfterUpdate(
  d: AfterUpdateDeps,
): Promise<RefreshAgent[]> {
  const now = d.now ?? Date.now;
  const sleep =
    d.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        setTimeout(r, ms).unref();
      }));
  if (!d.version) return [];
  const until = now() + d.waitMs;
  let s = d.readState();
  while (s?.to === d.version && s.state === "watching" && now() < until) {
    await sleep(d.pollMs ?? 5_000);
    s = d.readState();
  }
  if (s?.to !== d.version || s.state !== "good") return [];
  const list = d.refresh.begin({ to: s.to, at: s.at });
  if (list.length) d.onBegin?.(list);
  while (!(await d.refresh.pump())) await sleep(d.beatMs ?? 2_000);
  return list;
}
