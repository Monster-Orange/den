/**
 * H5 project sync: Den tells Hub this install's full project list (PUT
 * /api/installs/self/projects), so Hub knows each project's repos and the
 * Hub project it's linked to, and says back which repos Den Hub's GitHub
 * App can't see yet (`uncovered`). The complete list every time; the
 * server agent's scope is never in it.
 *
 * Sent at start, on connect, and whenever the list changes (checked
 * cheaply), retried with backoff on a network failure, never blocking the
 * change that caused it. A 400 from Hub isn't retried until the list
 * changes.
 *
 * Every URL Hub gives for the person to open is kept only when it's https
 * on github.com: anything else is dropped and never shown as a link.
 */
import { SERVER_SCOPE } from "./agents/server-agent.js";
import { parseHubProjectLink } from "./hub-project-link.js";
import type { WorkspacesFile } from "./types/index.js";
import { workspaceDisplayName } from "./workspace-name.js";

/** Hub's limits: more is a 400 with no change. */
export const SYNC_MAX_PROJECTS = 500;
export const SYNC_MAX_REPOS = 50;
const REPO_RE = /^[a-z0-9_.-]{1,100}\/[a-z0-9_.-]{1,100}$/;
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** A URL the person may be sent to: https on github.com, nothing else. */
export function githubUrlOk(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 2048) return false;
  try {
    const x = new URL(u);
    return (
      x.protocol === "https:" &&
      x.hostname === "github.com" &&
      x.port === "" &&
      !x.username &&
      !x.password
    );
  } catch {
    return false;
  }
}

/** An agent, as Hub routes comments and mentions to it (MENTION-DELIVERY-API §1). */
export interface SyncAgent {
  agent: string;
  name: string;
  /** `<project>/<agent>`. */
  handle: string;
}

export interface SyncProject {
  workspace: string;
  name: string;
  repos: string[];
  hub_project: string | null;
  agents: SyncAgent[];
}

/** A project's agents from their records: id, the name people see, the handle. */
export function syncAgents(
  records: {
    id: string;
    workspace: string;
    displayName?: string;
    persona?: string;
  }[],
): Map<string, SyncAgent[]> {
  const out = new Map<string, SyncAgent[]>();
  for (const r of [...records].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!r.workspace || r.workspace === SERVER_SCOPE) continue;
    const name = (r.displayName || r.persona || r.id).slice(0, 200);
    const list = out.get(r.workspace) ?? [];
    list.push({ agent: r.id, name, handle: `${r.workspace}/${r.id}` });
    out.set(r.workspace, list);
  }
  return out;
}

/** The list Den sends: every project but the server agent's, keys sorted. */
export function projectList(
  file: WorkspacesFile,
  reposOf: (ws: string) => string[],
  agentsOf: (ws: string) => SyncAgent[] = () => [],
): SyncProject[] {
  return Object.keys(file.workspaces ?? {})
    .filter((ws) => ws !== SERVER_SCOPE)
    .sort()
    .slice(0, SYNC_MAX_PROJECTS)
    .map((ws) => {
      const cfg = file.workspaces[ws];
      const repos = [
        ...new Set(
          reposOf(ws)
            .map((r) => r.toLowerCase())
            .filter((r) => REPO_RE.test(r)),
        ),
      ].slice(0, SYNC_MAX_REPOS);
      return {
        workspace: ws,
        name: workspaceDisplayName(ws, cfg).slice(0, 200),
        repos,
        hub_project: parseHubProjectLink(cfg?.hub_project)?.id ?? null,
        agents: agentsOf(ws),
      };
    });
}

export interface Uncovered {
  workspace: string;
  repo: string;
  org: string;
  /** Where the person gives Den Hub access; only when it's a github.com https URL. */
  installUrl?: string;
}

const plain = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").slice(0, max) : "";

/** Hub's sync answer, read defensively. */
export function readSyncReply(body: unknown): {
  setups: number;
  errors: { workspace: string; error: string }[];
  uncovered: Uncovered[];
} {
  const b = (body ?? {}) as Record<string, unknown>;
  const errors = (Array.isArray(b.errors) ? b.errors : []).flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const workspace = plain(o.workspace, 64);
    const error = plain(o.error, 300);
    return workspace && error ? [{ workspace, error }] : [];
  });
  const uncovered = (Array.isArray(b.uncovered) ? b.uncovered : []).flatMap(
    (x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      const workspace = plain(o.workspace, 64);
      const repo = plain(o.repo, 201).toLowerCase();
      const org = plain(o.org, 39);
      if (!workspace || !REPO_RE.test(repo) || !ORG_RE.test(org)) return [];
      return [
        {
          workspace,
          repo,
          org,
          ...(githubUrlOk(o.install_url) ? { installUrl: o.install_url } : {}),
        },
      ];
    },
  );
  const setups =
    typeof b.setups === "number" && Number.isInteger(b.setups) && b.setups >= 0
      ? b.setups
      : 0;
  return { setups, errors, uncovered };
}

export type OrgAccess = "all" | "some" | "none";
export interface OrgCoverage {
  org: string;
  access: OrgAccess;
  covered: number;
  total: number;
  installUrl?: string;
  manageUrl?: string;
}

const count = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0
    ? Math.min(v, 100_000)
    : 0;

/** GET /api/installs/self/github, read defensively. */
export function readCoverage(body: unknown): OrgCoverage[] {
  const b = (body ?? {}) as Record<string, unknown>;
  return (Array.isArray(b.orgs) ? b.orgs : []).flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const org = plain(o.org, 39);
    const access = o.access;
    if (!ORG_RE.test(org)) return [];
    if (access !== "all" && access !== "some" && access !== "none") return [];
    return [
      {
        org,
        access,
        covered: count(o.covered),
        total: count(o.total),
        ...(githubUrlOk(o.install_url) ? { installUrl: o.install_url } : {}),
        ...(githubUrlOk(o.manage_url) ? { manageUrl: o.manage_url } : {}),
      },
    ];
  });
}

export interface SyncResult {
  at: string;
  ok: boolean;
  setups: number;
  errors: { workspace: string; error: string }[];
  uncovered: Uncovered[];
  /** Why the last send failed, in words. */
  problem?: string;
}

export interface ProjectSyncDeps {
  /** The list to send now. */
  list: () => SyncProject[];
  /**
   * Send it; Hub's raw answer, or null when Hub isn't set up or connected
   * here (nothing to do, no retry). Throws on failure; an error with
   * `kind: "refused"` (Hub's 400) isn't retried until the list changes.
   */
  send: (projects: SyncProject[]) => Promise<Record<string, unknown> | null>;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  debounceMs?: number;
  firstRetryMs?: number;
  maxRetryMs?: number;
}

/** The sync loop: one send at a time; the latest list always wins. */
export class ProjectSync {
  private timer: unknown = null;
  private sending = false;
  private again = false;
  private failures = 0;
  /** A retry after a failure is pending: check() leaves its timer alone. */
  private backoff = false;
  private sentKey: string | null = null;
  private refusedKey: string | null = null;
  private result: SyncResult | null = null;

  constructor(private readonly deps: ProjectSyncDeps) {}

  /** The last answer (or failure), for Settings, doctor and the project header. */
  last(): SyncResult | null {
    return this.result;
  }

  /** Repos Hub can't see in project `ws`, from the last answer. */
  uncoveredFor(ws: string): Uncovered[] {
    return (this.result?.uncovered ?? []).filter((u) => u.workspace === ws);
  }

  /** Send soon, even when the list is unchanged (start, connect, coming back from an install). */
  request(): void {
    this.sentKey = null;
    this.refusedKey = null;
    this.schedule(this.deps.debounceMs ?? 1500);
  }

  /** Send now and wait for Hub's answer (the person came back from an install). */
  async now(): Promise<SyncResult | null> {
    this.stop();
    this.sentKey = null;
    this.refusedKey = null;
    await this.run();
    return this.result;
  }

  /** Send soon only when the list differs from the last one Hub took. */
  check(): void {
    // the 0.4.39 gate: the periodic check replaced the longer retry timer, so
    // a Hub that can't be reached was tried every 30 s, never backing off.
    // The retry sends the list as it is then.
    if (this.backoff) return;
    const key = JSON.stringify(this.safeList());
    if (key === this.sentKey || key === this.refusedKey) return;
    this.schedule(this.deps.debounceMs ?? 1500);
  }

  /** Stop any pending send (server shutdown, tests). */
  stop(): void {
    this.backoff = false;
    if (this.timer !== null)
      (this.deps.clearTimer ?? clearTimeout)(this.timer as never);
    this.timer = null;
  }

  private safeList(): SyncProject[] {
    try {
      return this.deps.list();
    } catch {
      return [];
    }
  }

  private schedule(ms: number, backoff = false): void {
    this.stop();
    this.backoff = backoff;
    this.timer = (this.deps.setTimer ?? ((f, m) => setTimeout(f, m).unref()))(
      () => {
        this.timer = null;
        this.backoff = false;
        void this.run();
      },
      ms,
    );
  }

  /** One send now; resolves when it's done (tests call it directly). */
  async run(): Promise<void> {
    if (this.sending) {
      this.again = true;
      return;
    }
    this.sending = true;
    const now = () => (this.deps.now ?? (() => new Date()))().toISOString();
    const list = this.safeList();
    const key = JSON.stringify(list);
    try {
      const body = await this.deps.send(list);
      this.failures = 0;
      if (body) {
        this.sentKey = key;
        this.result = { at: now(), ok: true, ...readSyncReply(body) };
      }
    } catch (e) {
      const refused = (e as { kind?: string })?.kind === "refused";
      const problem = String((e as Error)?.message ?? e).slice(0, 300);
      this.result = {
        at: now(),
        ok: false,
        setups: 0,
        errors: [],
        uncovered: this.result?.uncovered ?? [],
        problem,
      };
      if (refused) this.refusedKey = key;
      else {
        this.failures++;
        const first = this.deps.firstRetryMs ?? 5000;
        const max = this.deps.maxRetryMs ?? 5 * 60_000;
        this.schedule(Math.min(max, first * 2 ** (this.failures - 1)), true);
      }
    } finally {
      this.sending = false;
      if (this.again) {
        this.again = false;
        this.check();
      }
    }
  }
}
