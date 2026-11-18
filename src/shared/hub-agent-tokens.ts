/**
 * Issue 249: each Hub-connected agent calls Hub with a token bound to it
 * on Hub, so Hub sees the agent as a verified actor (its approvals can
 * count). The install connects once; under that one grant Den asks Hub for
 * each agent's token with the install's own token, the first time the
 * agent calls Hub. Agents added later bind with no further click.
 *
 * Where the tokens are: the server's own store, one 0600 file per agent
 * under <state dir>/hub/agents (folder 0700), beside the install's own
 * token file. Never the agent's env, its files (agent-files/<id>), its MCP
 * config, a log, or an API answer: the proxy (hub-proxy-routes.ts) swaps
 * the agent's Den token for its Hub token on the way out.
 *
 * Who keeps the install token: the server agent and every call with no
 * agent. A Hub that doesn't give agent tokens (404 or 405) leaves every
 * agent on the install token, as before, and is asked again after
 * hub.agent_token_retry_seconds.
 *
 * Revoking: removing an agent revokes its token on Hub (unbind), and
 * Disconnect revokes them all (unbindAll) before the install's own. A
 * revoke Hub couldn't take is kept, marked, never used again, and tried
 * again at the next unbindAll.
 */
import * as fs from "fs";
import * as path from "path";
import { AGENT_ID_RE } from "./agents/records.js";
import { SERVER_AGENT_ID, isServerScope } from "./agents/server-agent.js";
import {
  HubCallError,
  hubMintAgentToken,
  hubRevokeAgentToken,
  readHubConfig,
  type HubConfig,
} from "./hub.js";
import { getStateDir } from "./paths.js";

/** One agent's Hub token, as the server keeps it. */
export interface AgentHubToken {
  agentId: string;
  /** The name Hub was given (display only on Hub). */
  agentName: string;
  /** The Hub that minted it: never sent to another. */
  hubUrl: string;
  /** Hub's id for it: what a revoke names. */
  tokenId: string;
  token: string;
  /** When Hub minted it (ISO 8601). */
  at: string;
  /** Removed here, but Hub couldn't revoke it yet: never used again. */
  revokePending?: true;
  /** Ids of tokens it replaced (rotation) that Hub hasn't revoked yet. */
  retire?: string[];
}

/** hub.agent_tokens, hub.agent_token_retry_seconds, hub.agent_token_max_age_days. */
export interface AgentHubTokenSettings {
  enabled: boolean;
  retrySeconds: number;
  /** 0: never too old. */
  maxAgeDays: number;
}

/** The server's folder of agent Hub tokens. */
export function agentHubTokenDir(stateDir: string): string {
  return path.join(stateDir, "hub", "agents");
}

function fileOf(stateDir: string, id: string): string | null {
  return AGENT_ID_RE.test(id)
    ? path.join(agentHubTokenDir(stateDir), `${id}.json`)
    : null;
}

/** Agent `id`'s kept Hub token, or null. */
export function readAgentHubToken(
  stateDir: string,
  id: string,
): AgentHubToken | null {
  const f = fileOf(stateDir, id);
  if (!f) return null;
  try {
    const v = JSON.parse(fs.readFileSync(f, "utf8")) as AgentHubToken | null;
    return v &&
      typeof v.token === "string" &&
      typeof v.tokenId === "string" &&
      typeof v.hubUrl === "string" &&
      v.agentId === id
      ? v
      : null;
  } catch {
    return null;
  }
}

/** Whether agent `id` calls Hub with its own token now. */
export function agentHubBound(stateDir: string, id: string): boolean {
  const t = readAgentHubToken(stateDir, id);
  return !!t && !t.revokePending;
}

function writeAgentHubToken(stateDir: string, t: AgentHubToken): void {
  const f = fileOf(stateDir, t.agentId);
  if (!f) throw new Error(`"${t.agentId}" is not an agent id`);
  const dir = path.dirname(f);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.chmodSync(path.dirname(dir), 0o700);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, f);
}

function dropAgentHubToken(stateDir: string, id: string): void {
  const f = fileOf(stateDir, id);
  if (f) fs.rmSync(f, { force: true });
}

/** Every kept agent token (any state). */
export function listAgentHubTokens(stateDir: string): AgentHubToken[] {
  let names: string[];
  try {
    names = fs.readdirSync(agentHubTokenDir(stateDir));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => readAgentHubToken(stateDir, n.slice(0, -".json".length)))
    .filter((t): t is AgentHubToken => t !== null);
}

/**
 * The name Hub is given: printable ASCII, spaces folded, at most 80
 * characters (Hub's rule); else the agent's id.
 */
export function hubAgentName(id: string, name: string): string {
  const n = name.replace(/\s+/g, " ").trim().slice(0, 80).trimEnd();
  return n && /^[\x20-\x7e]+$/.test(n) ? n : id;
}

/** The server agent and calls with no agent keep the install token. */
export function usesInstallToken(a: { id: string; workspace: string }) {
  return a.id === SERVER_AGENT_ID || isServerScope(a.workspace);
}

export interface HubAgentTokensDeps {
  stateDir: () => string;
  settings: () => AgentHubTokenSettings;
  now?: () => number;
  mint?: typeof hubMintAgentToken;
  revoke?: typeof hubRevokeAgentToken;
}

/** Hub as the caller has it now: its address and the install's token. */
export interface HubInstall {
  url: string;
  token: string;
}

export class HubAgentTokens {
  private readonly inflight = new Map<string, Promise<string | null>>();
  /** Hub said it has no agent grant: not asked again until `until`. */
  private notOffered: { url: string; until: number } | null = null;
  /** An agent whose mint (or revoke) failed: not asked again until then. */
  private readonly failedUntil = new Map<string, number>();

  constructor(private readonly deps: HubAgentTokensDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private revokeOne(hub: HubInstall, tokenId: string): Promise<boolean> {
    return (this.deps.revoke ?? hubRevokeAgentToken)(
      hub.url,
      hub.token,
      tokenId,
    );
  }

  /** Whether agent `id` calls Hub with its own token now. */
  bound(id: string): boolean {
    return agentHubBound(this.deps.stateDir(), id);
  }

  /**
   * The token agent `a` calls Hub with: its own (minted the first time,
   * rotated when older than hub.agent_token_max_age_days), or null for
   * the install's (the server agent, the setting off, a Hub without agent
   * tokens, or a first mint that failed). Never throws.
   */
  async tokenFor(
    hub: HubInstall,
    a: { id: string; name: string; workspace: string },
  ): Promise<string | null> {
    const s = this.deps.settings();
    if (!s.enabled || usesInstallToken(a) || !AGENT_ID_RE.test(a.id))
      return null;
    const going = this.inflight.get(a.id);
    if (going) return going;
    const p = this.resolve(hub, a, s).finally(() => this.inflight.delete(a.id));
    this.inflight.set(a.id, p);
    return p;
  }

  private tooOld(t: AgentHubToken, s: AgentHubTokenSettings): boolean {
    if (!(s.maxAgeDays > 0)) return false;
    const at = Date.parse(t.at);
    return Number.isFinite(at) && this.now() - at > s.maxAgeDays * 86_400_000;
  }

  private waiting(hub: HubInstall, id: string): boolean {
    const now = this.now();
    return (
      (this.notOffered?.url === hub.url && now < this.notOffered.until) ||
      (this.failedUntil.get(id) ?? 0) > now
    );
  }

  private wait(id: string, s: AgentHubTokenSettings): void {
    this.failedUntil.set(id, this.now() + s.retrySeconds * 1000);
  }

  private async resolve(
    hub: HubInstall,
    a: { id: string; name: string },
    s: AgentHubTokenSettings,
  ): Promise<string | null> {
    const stateDir = this.deps.stateDir();
    let cur = readAgentHubToken(stateDir, a.id);
    // Another Hub's: that Hub revoked it at its Disconnect.
    if (cur && cur.hubUrl !== hub.url) {
      dropAgentHubToken(stateDir, a.id);
      cur = null;
    }
    const usable = cur && !cur.revokePending ? cur : null;
    if (usable && !this.tooOld(usable, s)) {
      if (usable.retire?.length && !this.waiting(hub, a.id))
        await this.retire(hub, a.id, s);
      return usable.token;
    }
    if (this.waiting(hub, a.id)) return usable?.token ?? null;
    if (cur?.revokePending) {
      // A removed agent back (Undo): its old token goes first, never used.
      const gone = await this.revokeOne(hub, cur.tokenId).then(
        () => true,
        () => false,
      );
      if (!gone) {
        this.wait(a.id, s);
        return null;
      }
      dropAgentHubToken(stateDir, a.id);
    }
    // A first token, or rotation: mint the new one first. A mint that
    // fails keeps the old one in use, and is tried again after the wait.
    const name = hubAgentName(a.id, a.name);
    let g: { token: string; tokenId: string };
    try {
      g = await (this.deps.mint ?? hubMintAgentToken)(hub.url, hub.token, {
        id: a.id,
        name,
      });
    } catch (e) {
      const until = this.now() + s.retrySeconds * 1000;
      if (e instanceof HubCallError && (e.status === 404 || e.status === 405))
        this.notOffered = { url: hub.url, until };
      else this.failedUntil.set(a.id, until);
      return usable?.token ?? null;
    }
    // Swap it in, then revoke the old one by its id: from here on only
    // the new one goes out.
    const retire = usable ? [usable.tokenId, ...(usable.retire ?? [])] : [];
    writeAgentHubToken(stateDir, {
      agentId: a.id,
      agentName: name,
      hubUrl: hub.url,
      tokenId: g.tokenId,
      token: g.token,
      at: new Date(this.now()).toISOString(),
      ...(retire.length ? { retire } : {}),
    });
    this.failedUntil.delete(a.id);
    if (retire.length) await this.retire(hub, a.id, s);
    return g.token;
  }

  /** Revoke agent `id`'s replaced tokens; the ones Hub couldn't stay listed. */
  private async retire(
    hub: HubInstall,
    id: string,
    s: AgentHubTokenSettings,
  ): Promise<void> {
    const stateDir = this.deps.stateDir();
    const t = readAgentHubToken(stateDir, id);
    if (!t?.retire?.length) return;
    const left: string[] = [];
    for (const old of t.retire)
      await this.revokeOne(hub, old).catch(() => void left.push(old));
    const next: AgentHubToken = { ...(readAgentHubToken(stateDir, id) ?? t) };
    if (left.length) next.retire = left;
    else delete next.retire;
    writeAgentHubToken(stateDir, next);
    if (left.length) this.wait(id, s);
  }

  /** Hub no longer takes agent `id`'s token (a 401): forget it here. */
  rejected(id: string): void {
    const stateDir = this.deps.stateDir();
    const t = readAgentHubToken(stateDir, id);
    if (t && !t.revokePending && !t.retire?.length)
      dropAgentHubToken(stateDir, id);
    else if (t && !t.revokePending)
      // Its replaced tokens still wait to be revoked: keep their ids.
      writeAgentHubToken(stateDir, { ...t, revokePending: true });
  }

  /** Revoke `t` and its replaced tokens; whether `t` itself was revoked now. */
  private async revokeEvery(
    hub: HubInstall,
    t: AgentHubToken,
  ): Promise<{ revoked: boolean; failed: boolean }> {
    let failed = false;
    let revoked = false;
    for (const old of t.retire ?? [])
      await this.revokeOne(hub, old).catch(() => void (failed = true));
    try {
      revoked = await this.revokeOne(hub, t.tokenId);
    } catch {
      failed = true;
    }
    return { revoked, failed };
  }

  /**
   * Agent `id` is removed: revoke its token (and any it replaced) on Hub
   * and forget it here. `hub` null (not connected now) or Hub not
   * answering: kept, marked, never used, and revoked at the agent's next
   * call (an Undo) or the next unbindAll.
   */
  async unbind(
    hub: HubInstall | null,
    id: string,
  ): Promise<{ revoked: boolean; pending?: true }> {
    const stateDir = this.deps.stateDir();
    const t = readAgentHubToken(stateDir, id);
    this.failedUntil.delete(id);
    if (!t) return { revoked: false };
    if (hub && t.hubUrl === hub.url) {
      const r = await this.revokeEvery(hub, t);
      if (!r.failed) {
        dropAgentHubToken(stateDir, id);
        return { revoked: r.revoked };
      }
    }
    writeAgentHubToken(stateDir, { ...t, revokePending: true });
    return { revoked: false, pending: true };
  }

  /**
   * Disconnect: revoke every agent token this Hub minted and forget them
   * here. One Hub couldn't revoke stays (marked) unless `force`; another
   * Hub's are forgotten.
   */
  async unbindAll(
    hub: HubInstall,
    opts: { force?: boolean } = {},
  ): Promise<{ revoked: number; failed: number }> {
    const stateDir = this.deps.stateDir();
    let revoked = 0;
    let failed = 0;
    for (const t of listAgentHubTokens(stateDir)) {
      if (t.hubUrl !== hub.url) {
        dropAgentHubToken(stateDir, t.agentId);
        continue;
      }
      const r = await this.revokeEvery(hub, t);
      if (r.revoked) revoked += 1;
      if (!r.failed || opts.force) dropAgentHubToken(stateDir, t.agentId);
      else {
        failed += 1;
        writeAgentHubToken(stateDir, { ...t, revokePending: true });
      }
    }
    this.failedUntil.clear();
    this.notOffered = null;
    return { revoked, failed };
  }
}

/**
 * Issue 249: agent `id` is removed: when the server keeps a Hub token for
 * it, revoke that on Hub (the install's token, as `hub` reads it now) and
 * forget it here. Nothing kept: nothing is read and Hub hears nothing.
 */
export async function unbindAgentHubToken(
  stateDir: () => string,
  hub: () => Promise<HubInstall | null>,
  id: string,
): Promise<void> {
  if (!readAgentHubToken(stateDir(), id)) return;
  const h = await hub().catch(() => null);
  await new HubAgentTokens({
    stateDir,
    settings: () => AGENT_HUB_TOKEN_DEFAULTS,
  }).unbind(h ? { url: h.url, token: h.token } : null, id);
}

/** The defaults: on, ask again after 10 minutes, rotate every 30 days. */
export const AGENT_HUB_TOKEN_DEFAULTS: AgentHubTokenSettings = {
  enabled: true,
  retrySeconds: 600,
  maxAgeDays: 30,
};

/** The settings from hub.* as read (readHubConfig), defaults for the rest. */
export function agentHubTokenSettingsOf(
  c: Partial<
    Pick<
      HubConfig,
      "agentTokens" | "agentTokenRetrySeconds" | "agentTokenMaxAgeDays"
    >
  >,
): AgentHubTokenSettings {
  return {
    enabled: c.agentTokens ?? AGENT_HUB_TOKEN_DEFAULTS.enabled,
    retrySeconds:
      c.agentTokenRetrySeconds ?? AGENT_HUB_TOKEN_DEFAULTS.retrySeconds,
    maxAgeDays: c.agentTokenMaxAgeDays ?? AGENT_HUB_TOKEN_DEFAULTS.maxAgeDays,
  };
}

/** hub.agent_token* as configured now (a bad hub block: the defaults). */
export function agentHubTokenSettings(): AgentHubTokenSettings {
  try {
    const c = readHubConfig();
    if (c) return agentHubTokenSettingsOf(c);
  } catch {
    /* the defaults */
  }
  return AGENT_HUB_TOKEN_DEFAULTS;
}

let serverOne: HubAgentTokens | null = null;

/** The web server's one store of agent Hub tokens (its state dir). */
export function serverHubAgentTokens(): HubAgentTokens {
  return (serverOne ??= new HubAgentTokens({
    stateDir: () => getStateDir(),
    settings: agentHubTokenSettings,
  }));
}
