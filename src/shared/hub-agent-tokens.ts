/**
 *
 *
 *
 *
 *
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";
import { AGENT_ID_RE, readRecord } from "./agents/records.js";
import { recordUnrevoked } from "./hub-binding.js";
import { SERVER_AGENT_ID, isServerScope } from "./agents/server-agent.js";
import {
  HubCallError,
  hubMintAgentToken,
  hubRevokeAgentToken,
  readHubConfig,
  type HubConfig,
} from "./hub.js";
import { getStateDir } from "./paths.js";
import { createHash } from "crypto";
import {
  bestEffort,
  RECONNECT_CODES,
  INSTALL_TOKEN_REQUIRED,
  agentsNotCovered,
  markAgentsNotCovered,
} from "./hub-agent-grant.js";

export interface AgentHubToken {
  agentId: string;
  agentName: string;
  hubUrl: string;
  tokenId: string;
  token: string;
  at: string;
  revokePending?: true;
  /**
   */
  recordId?: string;
}

export interface AgentHubTokenSettings {
  enabled: boolean;
  retrySeconds: number;
  maxAgeDays: number;
  revokeRetrySeconds?: number;
}

export function agentHubTokenDir(stateDir: string): string {
  return path.join(stateDir, "hub", "agents");
}

function fileOf(stateDir: string, id: string): string | null {
  return AGENT_ID_RE.test(id)
    ? path.join(agentHubTokenDir(stateDir), `${id}.json`)
    : null;
}

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
  writeFileAtomic(f, JSON.stringify(t) + "\n", { mode: 0o600 });
}

function dropAgentHubToken(stateDir: string, id: string): void {
  const f = fileOf(stateDir, id);
  if (f) fs.rmSync(f, { force: true });
}

export interface AgentTokenProblem {
  agentId: string;
  what: "mint" | "store" | "revoke" | "rejected";
  status?: number;
  code?: string;
  detail: string;
  at: string;
}

const problemFile = (stateDir: string) =>
  path.join(stateDir, "hub", "agent-token-problems.json");

export function readAgentTokenProblems(stateDir: string): AgentTokenProblem[] {
  try {
    const v = JSON.parse(
      fs.readFileSync(problemFile(stateDir), "utf8"),
    ) as Record<string, AgentTokenProblem> | null;
    return v && typeof v === "object"
      ? Object.values(v).filter(
          (p): p is AgentTokenProblem =>
            !!p &&
            typeof p.agentId === "string" &&
            typeof p.detail === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function noteAgentTokenProblem(
  stateDir: string,
  id: string,
  p: Omit<AgentTokenProblem, "agentId" | "at"> | null,
  at: string,
): void {
  try {
    const f = problemFile(stateDir);
    let all: Record<string, AgentTokenProblem> = {};
    try {
      all = JSON.parse(fs.readFileSync(f, "utf8")) ?? {};
    } catch {
      if (!p) return;
    }
    if (p) all[id] = { agentId: id, at, ...p };
    else if (id in all) delete all[id];
    else return;
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    writeFileAtomic(f, JSON.stringify(all) + "\n", { mode: 0o600 });
  } catch {
    return;
  }
}

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
 */
export function hubAgentName(id: string, name: string): string {
  const n = name.replace(/\s+/g, " ").trim().slice(0, 80).trimEnd();
  return n && /^[\x20-\x7e]+$/.test(n) ? n : id;
}

export function usesInstallToken(a: { id: string; workspace: string }) {
  return a.id === SERVER_AGENT_ID || isServerScope(a.workspace);
}

export interface HubAgentTokensDeps {
  stateDir: () => string;
  settings: () => AgentHubTokenSettings;
  now?: () => number;
  mint?: typeof hubMintAgentToken;
  revoke?: typeof hubRevokeAgentToken;
  onNotCovered?: (url: string) => void;
  log?: (line: string) => void;
  /**
   */
  unrevoked?: (u: { url: string; why: string; token: string }) => void;
  /**
   */
  agentExists?: (id: string) => boolean;
  /**
   */
  recordIdOf?: (id: string) => string | undefined;
}

export interface HubInstall {
  url: string;
  token: string;
}

export class HubAgentTokens {
  private readonly inflight = new Map<string, Promise<string | null>>();
  private notOffered: { url: string; until: number } | null = null;
  private readonly failedUntil = new Map<string, number>();
  /**
   */
  private readonly notInstall = new Set<string>();

  constructor(private readonly deps: HubAgentTokensDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private handedToUnrevoked(url: string, t: AgentHubToken): boolean {
    if (!this.deps.unrevoked) return false;
    try {
      this.deps.unrevoked({
        url,
        why: `agent ${t.agentId}'s Hub token ${t.tokenId}: Hub couldn't revoke it at a forced disconnect`,
        token: t.token,
      });
      dropAgentHubToken(this.deps.stateDir(), t.agentId);
      this.problem(t.agentId, null);
      return true;
    } catch {
      return false;
    }
  }

  private log(line: string): void {
    try {
      (this.deps.log ?? ((l: string) => console.error(`[hub] ${l}`)))(
        `issue 249: ${line}`,
      );
    } catch {
      return;
    }
  }

  private problem(
    id: string,
    p: Omit<AgentTokenProblem, "agentId" | "at"> | null,
  ): void {
    noteAgentTokenProblem(
      this.deps.stateDir(),
      id,
      p,
      new Date(this.now()).toISOString(),
    );
  }

  /**
   */
  private keepPending(
    url: string,
    agentId: string,
    agentName: string,
    t: { tokenId: string; token: string; at?: string },
    reason: string,
  ): void {
    try {
      writeAgentHubToken(this.deps.stateDir(), {
        agentId,
        agentName,
        hubUrl: url,
        tokenId: t.tokenId,
        token: t.token,
        at: t.at ?? new Date(this.now()).toISOString(),
        revokePending: true,
      });
    } catch (e) {
      this.log(
        `couldn't keep agent ${agentId}'s Hub token ${t.tokenId} to revoke later: ${(e as Error)?.message ?? e}`,
      );
    }
    this.problem(agentId, {
      what: "revoke",
      detail: `Hub couldn't revoke its token ${t.tokenId} (${reason}): kept, never used, tried again until Hub takes it`,
    });
  }

  private revokeOne(hub: HubInstall, tokenId: string): Promise<boolean> {
    return (this.deps.revoke ?? hubRevokeAgentToken)(
      hub.url,
      hub.token,
      tokenId,
    );
  }

  /**
   */
  private orphaned(t: AgentHubToken): boolean {
    try {
      if (this.deps.agentExists && !this.deps.agentExists(t.agentId))
        return true;
      return (
        !!this.deps.recordIdOf &&
        (t.recordId ?? undefined) !== this.deps.recordIdOf(t.agentId)
      );
    } catch {
      return false;
    }
  }

  private waitsRevoke(t: AgentHubToken): boolean {
    return !!t.revokePending || this.orphaned(t);
  }

  hasWaiting(): boolean {
    return listAgentHubTokens(this.deps.stateDir()).some((t) =>
      this.waitsRevoke(t),
    );
  }

  private recordIdNow(id: string): string | undefined {
    try {
      return this.deps.recordIdOf?.(id);
    } catch {
      return undefined;
    }
  }

  bound(id: string): boolean {
    return agentHubBound(this.deps.stateDir(), id);
  }

  /**
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

  private installKey(hub: HubInstall): string {
    return `${hub.url} ${createHash("sha256").update(hub.token).digest("hex")}`;
  }

  private held(hub: HubInstall): boolean {
    return (
      agentsNotCovered(this.deps.stateDir(), hub.url) ||
      this.notInstall.has(this.installKey(hub))
    );
  }

  private waiting(hub: HubInstall, id: string): boolean {
    const now = this.now();
    return (
      this.held(hub) ||
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
    if (cur && cur.hubUrl !== hub.url) {
      dropAgentHubToken(stateDir, a.id);
      cur = null;
    }
    if (cur && !cur.revokePending && this.orphaned(cur)) {
      this.log(
        `agent ${a.id}'s Hub token ${cur.tokenId} was minted for an earlier agent of that id: revoking it, never used`,
      );
      cur = { ...cur, revokePending: true };
      const pending = cur;
      bestEffort(() => writeAgentHubToken(stateDir, pending));
    }
    const usable = cur && !cur.revokePending ? cur : null;
    if (usable && !this.tooOld(usable, s)) return usable.token;
    if (this.waiting(hub, a.id)) return usable?.token ?? null;
    if (cur?.revokePending) {
      const gone = await this.revokeOne(hub, cur.tokenId).then(
        () => true,
        () => false,
      );
      this.log(
        `${gone ? "revoked" : "couldn't revoke"} agent ${a.id}'s Hub token ${cur.tokenId} (reason: undo, or an earlier agent of that id)`,
      );
      if (!gone) {
        this.wait(a.id, s);
        return null;
      }
      dropAgentHubToken(stateDir, a.id);
    }
    const name = hubAgentName(a.id, a.name);
    const rid = this.recordIdNow(a.id);
    let g: { token: string; tokenId: string };
    try {
      g = await (this.deps.mint ?? hubMintAgentToken)(hub.url, hub.token, {
        id: a.id,
        name,
      });
    } catch (e) {
      const until = this.now() + s.retrySeconds * 1000;
      const code = e instanceof HubCallError ? e.code : undefined;
      this.problem(a.id, {
        what: "mint",
        ...(hubStatusOf(e) !== undefined ? { status: hubStatusOf(e) } : {}),
        ...(code ? { code } : {}),
        detail: `Hub didn't mint its token (${mintFailure(e)})`,
      });
      if (code !== INSTALL_TOKEN_REQUIRED)
        this.log(
          `Hub didn't mint agent ${a.id}'s token (${mintFailure(e)})${usable ? ": it keeps its current token" : ": it uses the install's token"}`,
        );
      if (code && RECONNECT_CODES.includes(code)) {
        markAgentsNotCovered(stateDir, hub.url);
        bestEffort(() => this.deps.onNotCovered?.(hub.url));
      } else if (code === INSTALL_TOKEN_REQUIRED) {
        this.notInstall.add(this.installKey(hub));
        this.log(
          `Hub refused an agent-token mint for agent ${a.id} (status 403, error install_token_required): Den sent an agent's token, not the install's. No more mints with that token.`,
        );
      } else if (
        e instanceof HubCallError &&
        (e.status === 404 || e.status === 405)
      )
        this.notOffered = { url: hub.url, until };
      else this.failedUntil.set(a.id, until);
      return usable?.token ?? null;
    }
    try {
      writeAgentHubToken(stateDir, {
        agentId: a.id,
        agentName: name,
        hubUrl: hub.url,
        tokenId: g.tokenId,
        token: g.token,
        at: new Date(this.now()).toISOString(),
        ...(rid ? { recordId: rid } : {}),
      });
    } catch (e) {
      this.log(
        `Hub minted agent ${a.id}'s token ${g.tokenId}, but Den couldn't store it under ${agentHubTokenDir(stateDir)}: ${(e as Error)?.message ?? e}`,
      );
      this.problem(a.id, {
        what: "store",
        detail: `Hub minted its token ${g.tokenId}, but Den couldn't store it: ${(e as Error)?.message ?? e}`,
      });
      this.failedUntil.set(a.id, this.now() + s.retrySeconds * 1000);
      return usable?.token ?? null;
    }
    if (this.deps.agentExists && !this.deps.agentExists(a.id)) {
      dropAgentHubToken(stateDir, a.id);
      const gone = await this.revokeOne(hub, g.tokenId).then(
        () => true,
        () => false,
      );
      this.log(
        `${gone ? "revoked" : "couldn't revoke"} agent ${a.id}'s new Hub token ${g.tokenId} (reason: agent removed during its mint)`,
      );
      if (!gone)
        this.keepPending(hub.url, a.id, name, g, "removed during its mint");
      return null;
    }
    this.problem(a.id, null);
    this.log(
      `${usable ? "rotated" : "minted"} agent ${a.id}'s Hub token ${g.tokenId}: stored under ${agentHubTokenDir(stateDir)}`,
    );
    this.failedUntil.delete(a.id);
    return g.token;
  }

  rejected(id: string): void {
    const stateDir = this.deps.stateDir();
    const t = readAgentHubToken(stateDir, id);
    if (t && !t.revokePending) {
      dropAgentHubToken(stateDir, id);
      this.failedUntil.set(
        id,
        this.now() + this.deps.settings().retrySeconds * 1000,
      );
      this.log(
        `Hub answered 401 to agent ${id}'s token ${t.tokenId}: dropped here, a new one is minted after the retry wait`,
      );
      this.problem(id, {
        what: "rejected",
        status: 401,
        detail: `Hub answered 401 to its token ${t.tokenId} (Den didn't revoke it): a new one is minted after the retry wait`,
      });
    }
  }

  private async revokeEvery(
    hub: HubInstall,
    t: AgentHubToken,
  ): Promise<{ revoked: boolean; failed: boolean }> {
    try {
      return { revoked: await this.revokeOne(hub, t.tokenId), failed: false };
    } catch {
      return { revoked: false, failed: true };
    }
  }

  /**
   */
  async unbind(
    hub: HubInstall | null,
    id: string,
    reason = "agent removed",
  ): Promise<{ revoked: boolean; pending?: true }> {
    const stateDir = this.deps.stateDir();
    const t = readAgentHubToken(stateDir, id);
    this.failedUntil.delete(id);
    if (!t) return { revoked: false };
    if (hub && t.hubUrl === hub.url) {
      const r = await this.revokeEvery(hub, t);
      this.log(
        `${r.failed ? "couldn't revoke" : "revoked"} agent ${id}'s Hub token ${t.tokenId} (reason: ${reason})${r.failed ? ": kept, never used, tried again later" : ""}`,
      );
      this.problem(
        id,
        r.failed
          ? {
              what: "revoke",
              detail: `Hub couldn't revoke its token ${t.tokenId} (${reason}): kept, never used, tried again later`,
            }
          : null,
      );
      if (!r.failed) {
        dropAgentHubToken(stateDir, id);
        return { revoked: r.revoked };
      }
    }
    writeAgentHubToken(stateDir, { ...t, revokePending: true });
    return { revoked: false, pending: true };
  }

  /**
   */
  async retryPending(
    hub: HubInstall,
  ): Promise<{ revoked: number; failed: number }> {
    const stateDir = this.deps.stateDir();
    let revoked = 0;
    let failed = 0;
    for (const t of listAgentHubTokens(stateDir)) {
      if (!this.waitsRevoke(t) || t.hubUrl !== hub.url) continue;
      const orphan = !t.revokePending;
      if (orphan)
        bestEffort(() =>
          writeAgentHubToken(stateDir, { ...t, revokePending: true }),
        );
      const r = await this.revokeEvery(hub, t);
      if (r.failed) {
        failed += 1;
        if (orphan)
          this.problem(t.agentId, {
            what: "revoke",
            detail: `its token ${t.tokenId} outlived its agent record: never used, tried again until Hub takes it`,
          });
        continue;
      }
      revoked += 1;
      dropAgentHubToken(stateDir, t.agentId);
      this.problem(t.agentId, null);
      this.log(
        `revoked agent ${t.agentId}'s Hub token ${t.tokenId} (reason: ${orphan ? "it outlived its agent record" : "a revoke left waiting, tried again"})`,
      );
    }
    return { revoked, failed };
  }

  /**
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
      this.log(
        `${r.failed ? "couldn't revoke" : "revoked"} agent ${t.agentId}'s Hub token ${t.tokenId} (reason: disconnect)`,
      );
      if (r.revoked) revoked += 1;
      if (!r.failed) dropAgentHubToken(stateDir, t.agentId);
      else {
        failed += 1;
        if (opts.force && this.handedToUnrevoked(hub.url, t)) continue;
        this.keepPending(hub.url, t.agentId, t.agentName, t, "disconnect");
      }
    }
    this.failedUntil.clear();
    this.notOffered = null;
    this.notInstall.clear();
    return { revoked, failed };
  }
}

function hubStatusOf(e: unknown): number | undefined {
  if (!(e instanceof HubCallError)) return undefined;
  return (
    e.status ??
    (e.kind === "rejected" ? 401 : e.kind === "forbidden" ? 403 : undefined)
  );
}

function mintFailure(e: unknown): string {
  if (!(e instanceof HubCallError))
    return `error: ${(e as Error)?.message ?? String(e)}`;
  const status = hubStatusOf(e);
  return status === undefined
    ? `no answer: ${e.message}`
    : `status ${status}, error ${e.code ?? "none"}`;
}

/**
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

/**
 */
export function noteHubUnbindFailed(
  stateDir: string,
  id: string,
  e: unknown,
  log: (line: string) => void = (l) => console.error(`[hub] ${l}`),
): void {
  try {
    const t = readAgentHubToken(stateDir, id);
    if (!t) return;
    const why = String((e as Error)?.message ?? e).slice(0, 200);
    log(
      `issue 249: couldn't unbind removed agent ${id}'s Hub token ${t.tokenId} (${why}): never used, revoked when Hub answers`,
    );
    noteAgentTokenProblem(
      stateDir,
      id,
      {
        what: "revoke",
        detail: `its agent was removed, but Den couldn't unbind its token ${t.tokenId} (${why}): never used, tried again until Hub takes it`,
      },
      new Date().toISOString(),
    );
  } catch {
    return;
  }
}

export const AGENT_HUB_TOKEN_DEFAULTS: AgentHubTokenSettings = {
  enabled: true,
  retrySeconds: 600,
  maxAgeDays: 30,
  revokeRetrySeconds: 600,
};

export function agentHubTokenSettingsOf(
  c: Partial<
    Pick<
      HubConfig,
      | "agentTokens"
      | "agentTokenRetrySeconds"
      | "agentTokenMaxAgeDays"
      | "agentTokenRevokeRetrySeconds"
    >
  >,
): AgentHubTokenSettings {
  return {
    enabled: c.agentTokens ?? AGENT_HUB_TOKEN_DEFAULTS.enabled,
    retrySeconds:
      c.agentTokenRetrySeconds ?? AGENT_HUB_TOKEN_DEFAULTS.retrySeconds,
    maxAgeDays: c.agentTokenMaxAgeDays ?? AGENT_HUB_TOKEN_DEFAULTS.maxAgeDays,
    revokeRetrySeconds:
      c.agentTokenRevokeRetrySeconds ??
      AGENT_HUB_TOKEN_DEFAULTS.revokeRetrySeconds,
  };
}

export function agentHubTokenSettings(): AgentHubTokenSettings {
  try {
    const c = readHubConfig();
    if (c) return agentHubTokenSettingsOf(c);
  } catch {
    return AGENT_HUB_TOKEN_DEFAULTS;
  }
  return AGENT_HUB_TOKEN_DEFAULTS;
}

let serverOne: HubAgentTokens | null = null;
let serverNotCovered: ((url: string) => void) | null = null;

/**
 */
export function serverHubAgentTokens(
  onNotCovered?: (url: string) => void,
): HubAgentTokens {
  if (onNotCovered) serverNotCovered = onNotCovered;
  return (serverOne ??= new HubAgentTokens({
    stateDir: () => getStateDir(),
    settings: agentHubTokenSettings,
    onNotCovered: (url) => serverNotCovered?.(url),
    unrevoked: (u) => void recordUnrevoked(getStateDir(), u),
    agentExists: (id) => {
      try {
        return !!readRecord(getStateDir(), id);
      } catch {
        return true;
      }
    },
    recordIdOf: (id) => readRecord(getStateDir(), id)?.recordId,
  }));
}

let revokeTimer: NodeJS.Timeout | null = null;

/**
 */
export function startAgentTokenRevokeRetry(
  hub: () => Promise<HubInstall | null>,
  log: (line: string) => void = () => {},
): void {
  if (revokeTimer) return;
  const store = serverHubAgentTokens();
  let busy = false;
  let last = 0;
  const beat = () => {
    const every =
      (agentHubTokenSettings().revokeRetrySeconds ??
        AGENT_HUB_TOKEN_DEFAULTS.revokeRetrySeconds!) * 1000;
    if (busy || (last && Date.now() - last < every)) return;
    if (!store.hasWaiting()) {
      last = Date.now();
      return;
    }
    busy = true;
    last = Date.now();
    hub()
      .then((h) => (h ? store.retryPending(h) : null))
      .catch((e) =>
        log(
          `issue 249: retrying waiting revokes: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        ),
      )
      .finally(() => (busy = false));
  };
  beat();
  revokeTimer = setInterval(beat, 5000);
  revokeTimer.unref();
}
