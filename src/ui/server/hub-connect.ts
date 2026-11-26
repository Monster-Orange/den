/**
 * HUB-1.7: Connect to Hub. A person connects this install from Settings ›
 * Hub; nobody copies a token or edits config.
 *
 *   1. POST /api/hub/connect { url? }  (signed in, CSRF): a PKCE verifier
 *      and a single-use state are made and kept here (10 min); the answer
 *      is Hub's /connect URL, and the page goes there.
 *   2. Hub signs the person in; they pick a company and approve. Hub sends
 *      the browser to <this Den>/hub/callback?code&state (or error=…).
 *   3. GET /hub/callback (sign-in free: a redirect from Hub may arrive
 *      without the session; the single-use state and the verifier only
 *      this server holds are what protect it) trades
 *      the code for the install's token server to server (POST
 *      /connect/token), stores the token and points hub.token at it, then
 *      answers a page that moves on to Settings by script, a same-site
 *      navigation that carries the cookie again.
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
  forgetHubToken,
  type HubConfig,
  type HubGrant,
  type HubTokenRotation,
} from "../../shared/hub.js";
import { recordAction } from "./audit.js";
import {
  AGENT_GRANT_NOTE_SUBJECT,
  bestEffort,
  clearAgentsNotCovered,
} from "../../shared/hub-agent-grant.js";
import { readUserConfig, writeUserConfig } from "../../shared/den-config.js";
import { readEdgeConfig, readWebPort } from "../../shared/edge/config.js";
import { webRouteHosts } from "../../shared/edge/render.js";
import { getStateDir } from "../../shared/paths.js";
import {
  hubOrigin,
  readHubBinding,
  recordUnrevoked,
} from "../../shared/hub-binding.js";
import { readWorkspacesFile } from "../../shared/environment-manager/workspaces.js";
import { emptyProjectTest } from "../../shared/empty-project.js";
import { listRecords } from "../../shared/agents/records.js";
import { projectRepos } from "../../shared/project-repos.js";
import { workspaceDisplayName } from "../../shared/workspace-name.js";
import {
  parseHubProjectLink,
  setHubProject,
  type HubProjectLink,
} from "../../shared/hub-project-link.js";
import {
  parseGrantReview,
  reviewParam,
  type FallbackCode,
  type GrantReview,
  type GrantSkip,
  type ReviewProject,
} from "../../shared/hub-connect-review-grant.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import { envKey, product } from "../../shared/product.js";
import {
  getSecretsProvider,
  readSecretsConfig,
  secretsStatus,
  type SecretRef,
} from "../../shared/secrets/index.js";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { isRepoName } from "../../shared/repo-name.js";
import {
  endHubSwitch,
  hubSwitchDeps,
  liveHubSwitch,
  switchDays,
} from "./hub-switch.js";

/** How long a started connect waits for Hub to send the person back. */
export const CONNECT_TTL_MS = 10 * 60_000;
/** At most this many connects waiting at once (oldest dropped first). */
const MAX_PENDING = 16;

interface Pending {
  verifier: string;
  hubUrl: string;
  redirectUri: string;
  at: number;
  /**
   * Issue 648: the projects sent to Hub's page (their hash and keys), or
   * why none were (then issue 646's flow); absent: nothing to link.
   */
  review?:
    | { hash: string; keys: string[] }
    | { why: string; code: FallbackCode };
  switching?: true;
}

const sameHub = (a: string, b: string): boolean => {
  const x = hubOrigin(a);
  return !!x && x === hubOrigin(b);
};

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
  /**
   * Issue 646 (the approved mock, shape B): once connected, nothing is
   * linked yet. Count the projects Connect's review proposes a Hub project
   * (or a create) for, and put them in the bell; the person links them all
   * with Connect and link all in Settings › Hub. Absent: none.
   */
  reviewAfter?: () => Promise<{ review: number } | { cannot: true }>;
  /**
   * Issue 726: Connect named the Hub and its company: bind this install's
   * Hub state to them (another Hub or company archives the old state and
   * unlinks the projects, before the review offers them again).
   */
  rebind?: (url: string, company: string | undefined) => Promise<unknown>;
  tellDenUrl?: (hubUrl: string, token: string) => Promise<unknown>;
  /**
   * Issue 726: a forced disconnect Hub couldn't hear: keep it on record
   * (doctor lists it; each start tries the revoke again).
   */
  unrevoked?: (u: { url: string; why: string; token: string }) => void;
  unbindAgents?: (
    hub: { url: string; token: string },
    force: boolean,
  ) => Promise<{ revoked: number; failed: number }>;
  agentGrantSettled?: () => void;
  /**
   * Issue 646: this Den's projects' repos (owner/repo), sent to Hub's
   * Connect page so Hub ranks the person's companies by them.
   */
  repos?: () => string[];
  /**
   * Issue 648: the projects Hub's Connect page links or creates in the one
   * approval (key, name, repos); the catch-all and the server scope never.
   */
  reviewProjects?: () => ReviewProject[];
  /** Issue 648: store a link Hub made in that approval. */
  linkProject?: (ws: string, link: HubProjectLink, by: string) => void;
  /**
   * Issue 648: project `ws`'s link as written (any Hub), or null. Connect
   * fills only a project with none, or confirms the same id; another link
   * waits for the person's review.
   */
  linkOf?: (ws: string) => HubProjectLink | null;
  /** Issue 648: the origin hub/bound.json names now (after the rebind). */
  boundOrigin?: () => string | null;
  hubSwitch?: () => { to: string; from: string } | null;
  switched?: (r: { ok: boolean; why?: string }) => void;
}

/** Issue 646: at most this many repos go to Hub's Connect page. */
export const CONNECT_REPOS_MAX = 50;

/**
 * Issue 646: every project's repos, lower case, once each, in project
 * order (the server agent's scope never): what Connect sends Hub.
 */
export function connectRepos(
  projects: readonly string[],
  reposOf: (ws: string) => string[],
  isServer: (ws: string) => boolean = () => false,
): string[] {
  const out = new Set<string>();
  for (const ws of projects) {
    if (isServer(ws)) continue;
    for (const r of reposOf(ws)) {
      const x = r.toLowerCase();
      if (isRepoName(x)) out.add(x);
    }
  }
  return [...out];
}

function defaultReviewProjects(): ReviewProject[] {
  const file = readWorkspacesFile();
  // Issue 1334: an empty project never goes to Hub's review page.
  const isEmpty = emptyProjectTest(
    () => file,
    () => listRecords(getStateDir()),
  );
  return Object.keys(file.workspaces ?? {})
    .sort()
    .filter((ws) => !isServerScope(ws))
    .map((ws) => ({
      key: ws,
      name: workspaceDisplayName(ws, file.workspaces[ws]),
      repos: connectRepos([ws], projectRepos),
      ...(isEmpty(ws) ? { empty: true } : {}),
    }));
}

function defaultRepos(): string[] {
  return connectRepos(
    Object.keys(readWorkspacesFile().workspaces ?? {}).sort(),
    projectRepos,
    isServerScope,
  );
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
  writeFileAtomic(file, `${token}\n`, { mode: 0o600 });
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

/** Connect's own store item for this backend, when `cfg` points at it. */
function isOwnStoreRef(cfg: HubConfig): boolean {
  if (!cfg.tokenRef) return false;
  const st = secretsStatus(readSecretsConfig(), process.env);
  const ours = storeRefFor(st.backend);
  return (
    !!ours &&
    (ours.item
      ? cfg.tokenRef.item === ours.item
      : cfg.tokenRef.key === ours.key)
  );
}

/** Connect's own file, when `cfg` points at it (never a distribution's path). */
function isOwnFile(cfg: HubConfig, file = hubTokenFile()): boolean {
  return (
    cfg.tokenSource?.kind === "file" &&
    path.resolve(cfg.tokenSource.path) === path.resolve(file)
  );
}

/**
 * #71: Den rewrites only the Hub token Connect stored (its file, or its
 * item in the install's store). A secret ref, file, keychain entry or env
 * var a distribution chose is never written: Settings says to reconnect.
 */
export function hubTokenRotation(
  deps: {
    file?: string;
    setRef?: (ref: SecretRef, v: string) => Promise<void>;
    record?: HubTokenRotation["record"];
  } = {},
): HubTokenRotation {
  const file = deps.file ?? hubTokenFile();
  return {
    owns: (cfg) => isOwnFile(cfg, file) || isOwnStoreRef(cfg),
    write: async (cfg, token) => {
      if (isOwnFile(cfg, file)) return writeTokenFile(file, token);
      if (cfg.tokenRef && isOwnStoreRef(cfg))
        return (deps.setRef ?? ((r, v) => getSecretsProvider().set(r, v)))(
          cfg.tokenRef,
          token,
        );
      throw new Error("not a token Den stored");
    },
    record:
      deps.record ??
      ((detail, refused) =>
        recordAction(null, {
          verb: "hub-token",
          detail,
          ...(refused ? { outcome: "refused" as const, reason: refused } : {}),
        })),
  };
}

async function defaultForget(cfg: HubConfig): Promise<void> {
  if (cfg.tokenSource?.kind === "file") {
    // Only the file Connect made: never a path a distribution chose.
    if (isOwnFile(cfg)) fs.rmSync(hubTokenFile(), { force: true });
    return;
  }
  // Stores have no delete here: blank the value (the token is revoked).
  if (cfg.tokenRef && isOwnStoreRef(cfg))
    await getSecretsProvider()
      .set(cfg.tokenRef, " ")
      .catch(() => undefined);
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
    reviewAfter: async () =>
      (await import("./hub-connect-review.js")).defaultReviewAfter(),
    rebind: async (url, company) => {
      const m = await import("./hub-change.js");
      return m.noteHub(await m.defaultHubChangeDeps(), { url, company });
    },
    tellDenUrl: async (url, token) => {
      const w = readWebUrl();
      if (!w?.url) return;
      const [{ tellHubDenUrl }, { hubPutDenUrl }] = await Promise.all([
        import("../../shared/hub-den-url.js"),
        import("../../shared/hub.js"),
      ]);
      await tellHubDenUrl(w.url, {
        hub: async () => ({ url, token }),
        put: hubPutDenUrl,
        stateDir: getStateDir(),
      });
    },
    unrevoked: (u) => void recordUnrevoked(getStateDir(), u),
    agentGrantSettled: () => {
      bestEffort(() => clearAgentsNotCovered(getStateDir()));
      void import("./notification-service.js")
        .then((m) =>
          m
            .notificationDeps()
            .store.remove((n) => n.subject === AGENT_GRANT_NOTE_SUBJECT),
        )
        .catch(() => undefined);
    },
    unbindAgents: async (hub, force) =>
      (await import("../../shared/hub-agent-tokens.js"))
        .serverHubAgentTokens()
        .unbindAll(hub, { force }),
    repos: defaultRepos,
    reviewProjects: defaultReviewProjects,
    linkProject: (ws, link, by) => setHubProject(ws, link, by),
    linkOf: (ws) =>
      parseHubProjectLink(readWorkspacesFile().workspaces[ws]?.hub_project),
    boundOrigin: () => readHubBinding(getStateDir())?.origin ?? null,
    hubSwitch: () =>
      liveHubSwitch({
        stateDir: getStateDir(),
        days: switchDays((readUserConfig() as Record<string, unknown>).hub),
      }),
    switched: (r) =>
      void hubSwitchDeps()
        .then((d) => endHubSwitch(d, r))
        .catch(() => undefined),
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

/** Issue 648: why the one approval's links fell back to issue 646's flow. */
type GrantFallback = {
  ok: false;
  why: string;
  code: FallbackCode;
  quiet?: boolean;
};

export type ConnectResult =
  | {
      ok: true;
      team?: string;
      where: string;
      /** Issue 648: what Hub's one approval did with the projects. */
      review?: GrantReview | GrantFallback;
    }
  | { ok: false; reason: "denied" | "expired" | "failed"; message: string };

/**
 * What Connect came to, as data: Settings words it in the page's language
 * (en/es/ja), never the server. `grant` is issue 648's one approval: the
 * links stored, how many Hub created, the projects left out (each one's
 * key, why, and Hub's detail, shown as escaped text), or the fallback's
 * code. `review` is issue 646's: how many projects wait for the person.
 */
export interface ConnectWords {
  team?: string;
  grant?:
    | { linked: number; created: number; skipped: GrantSkip[] }
    | { fallback: FallbackCode };
  review?: { n: number } | { cannot: true };
}

function grantData(
  r: GrantReview | GrantFallback,
): ConnectWords["grant"] | undefined {
  if (!r.ok) return "quiet" in r && r.quiet ? undefined : { fallback: r.code };
  return {
    linked: r.links.length,
    created: r.links.filter((l) => l.how === "created").length,
    skipped: r.skipped,
  };
}

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
    opts: { switch?: boolean } = {},
  ): { ok: true; location: string } | { ok: false; error: string } {
    const typed = typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
    let sw: { to: string } | null = null;
    try {
      sw = opts.switch ? (this.deps.hubSwitch?.() ?? null) : null;
    } catch {
      sw = null;
    }
    const hubUrl = typed || sw?.to || this.deps.config()?.url || "";
    if (!hubUrl) return { ok: false, error: "type Hub's address first" };
    const bad = hubUrlProblem(hubUrl);
    if (bad)
      return { ok: false, error: bad.replace("hub.url", "Hub's address") };
    const badOrigin = callbackOriginProblem(origin);
    if (badOrigin) return { ok: false, error: badOrigin };
    this.sweep();
    const state = newHubState();
    const { verifier, challenge } = newPkce();
    let projectsParam = "";
    const redirectUri = `${new URL(origin).origin}/hub/callback`;
    // Issue 648: the projects, for Hub's page to link or create in the
    // one approval. Never stops Connect: a cap passed means 646's flow.
    let review: Pending["review"];
    try {
      const list = this.deps.reviewProjects?.() ?? [];
      const r = reviewParam(list);
      review = r.ok
        ? { hash: r.hash, keys: r.keys }
        : list.length
          ? {
              why: `Connect couldn't send the projects to Hub (${r.why})`,
              code: r.code,
            }
          : undefined;
      if (r.ok) projectsParam = r.param;
    } catch {
      review = undefined;
    }
    this.pending.set(state, {
      verifier,
      hubUrl,
      redirectUri,
      at: this.deps.now(),
      ...(review ? { review } : {}),
      ...(sw && sameHub(sw.to, hubUrl) ? { switching: true as const } : {}),
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
    q.set("agents", "yes");
    // Issue 646: the projects' repos, so Hub ranks the person's companies
    // (its own session; an older Hub ignores it). Never stops Connect.
    let repos: string[] = [];
    try {
      repos = connectRepos(["all"], () => this.deps.repos?.() ?? []);
    } catch {
      repos = [];
    }
    if (repos.length)
      q.set("repos", repos.slice(0, CONNECT_REPOS_MAX).join(","));
    if (projectsParam) {
      q.set("review", "1");
      q.set("projects", projectsParam);
    }
    return { ok: true, location: `${hubUrl}/connect?${q}` };
  }

  /**
   * Steps 2–3: Hub sent the person back. The state is used once, whatever
   * happens. On success the token is stored and hub.* written to user.yml.
   * The result names what happened in words (never the token or the code).
   */
  async finish(q: URLSearchParams): Promise<ConnectResult> {
    const switching = !!this.pending.get(q.get("state") ?? "")?.switching;
    const r = await this.finishOnce(q);
    if (switching)
      this.deps.switched?.(r.ok ? { ok: true } : { ok: false, why: r.message });
    // `message` is the plain English line for logs and older pages; the
    // page words `words` itself (issue 648, en/es/ja).
    const message = r.ok
      ? `Connected to Hub${r.team ? ` (${r.team})` : ""}.`
      : r.message;
    let words: ConnectWords | undefined;
    if (r.ok) {
      words = r.team ? { team: r.team } : {};
      const grant = r.review ? grantData(r.review) : undefined;
      if (grant) words.grant = grant;
      // Issue 646: the projects wait for the review. It never fails Connect.
      if (this.deps.reviewAfter) {
        const l = await this.deps
          .reviewAfter()
          .catch(() => ({ cannot: true }) as const);
        words.review = "cannot" in l ? { cannot: true } : { n: l.review };
      }
    }
    this.last = {
      ok: r.ok,
      message,
      ...(words ? { words } : {}),
      at: this.deps.now(),
    };
    return r;
  }

  /**
   * What the last Connect came to, in words, read once (Settings shows it
   * after Hub's redirect; the callback page only flashes by). Never the
   * token or the code.
   */
  lastResult(): {
    ok: boolean;
    message: string;
    words?: ConnectWords;
  } | null {
    const l = this.last;
    this.last = null;
    if (!l || this.deps.now() - l.at > CONNECT_TTL_MS) return null;
    return {
      ok: l.ok,
      message: l.message,
      ...(l.words ? { words: l.words } : {}),
    };
  }

  private last: {
    ok: boolean;
    message: string;
    words?: ConnectWords;
    at: number;
  } | null = null;

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
    const ownName = (u: string | undefined) =>
      !!u && !hubUrlProblem(u) && (!p.switching || sameHub(u, p.hubUrl));
    const hubUrl = ownName(grant.hubUrl) ? grant.hubUrl! : p.hubUrl;
    // Issue 726: connected before (to another Hub, or for another company
    // on this one): the old token is read now (the new one may take its
    // file or item) and revoked on its Hub after, so a token for a company
    // this install left never stays valid there.
    const before = this.deps.config();
    const leaving =
      before && (before.tokenRef || before.tokenSource) ? before : null;
    const read = leaving
      ? await this.deps.readToken(leaving).catch(() => null)
      : null;
    const oldToken = read && read !== grant.token ? read : null;
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
    if (ownName(grant.mcpUrl)) hub.mcp_url = grant.mcpUrl;
    else delete hub.mcp_url;
    this.deps.writeUser({ ...user, hub });
    this.deps.agentGrantSettled?.();
    // 0.4.47: the token Den keeps in memory is the old one: read anew.
    forgetHubToken(undefined, Date.now(), { now: true });
    if (leaving && oldToken)
      await this.deps.revoke(leaving.url, oldToken).catch((e: unknown) => {
        try {
          this.deps.unrevoked?.({
            url: leaving.url,
            why: (e as Error).message,
            token: oldToken,
          });
        } catch {
          /* best effort */
        }
      });
    // Issue 726: another Hub or company: the old one's state goes first.
    const company = grant.company?.slug || grant.company?.name || undefined;
    let rebound = true;
    if (this.deps.rebind)
      rebound = await this.deps.rebind(hubUrl, company).then(
        () => true,
        () => false,
      );
    if (this.deps.tellDenUrl)
      void this.deps.tellDenUrl(hubUrl, grant.token).catch(() => undefined);
    // Issue 648: the links Hub's one approval made. Written only when the
    // rebind resolved and hub/bound.json names this Hub, each stamped with
    // it (else a new company's ids would count as the old Hub's). Only a
    // project with no link, or linked to the same Hub project, is filled:
    // another link waits for the person's review.
    let review: Extract<ConnectResult, { ok: true }>["review"];
    if (p.review && "why" in p.review)
      review = { ok: false, why: p.review.why, code: p.review.code };
    else if (p.review) {
      const origin = hubOrigin(hubUrl);
      let bound: string | null = null;
      try {
        bound = this.deps.boundOrigin?.() ?? origin;
      } catch {
        bound = null;
      }
      const parsed = parseGrantReview(grant.review, p.review);
      if (parsed.ok && (!rebound || !bound || hubOrigin(bound) !== origin))
        review = {
          ok: false,
          why: "Den couldn't move its Hub records to this Hub",
          code: "rebind",
        };
      else if (!parsed.ok) review = parsed;
      else {
        const links: typeof parsed.links = [];
        const skipped = [...parsed.skipped];
        for (const l of parsed.links) {
          let had: HubProjectLink | null = null;
          try {
            had = this.deps.linkOf?.(l.key) ?? null;
          } catch {
            // Can't tell what it's linked to: never write over it (fail closed).
            skipped.push({ key: l.key, why: "failed" });
            continue;
          }
          if (had && had.id !== l.project.id) {
            skipped.push({ key: l.key, why: "person" });
            continue;
          }
          try {
            this.deps.linkProject?.(
              l.key,
              {
                ...l.project,
                hub: { origin, ...(company ? { company } : {}) },
              },
              `Connect, Hub's one approval (${l.how})`,
            );
            links.push(l);
          } catch {
            // One project's write never stops Connect: it waits for the review.
            skipped.push({ key: l.key, why: "failed" });
          }
        }
        review = { ok: true, links, skipped };
      }
    }
    return {
      ok: true,
      ...(grant.company?.name ? { team: grant.company.name } : {}),
      where: stored.where,
      ...(review ? { review } : {}),
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
    let agents = 0;
    if (token && this.deps.unbindAgents) {
      const a = await this.deps
        .unbindAgents({ url: cfg.url, token }, force)
        .catch(() => ({ revoked: 0, failed: 1 }));
      if (a.failed && !force)
        return {
          ok: false,
          error: `Hub couldn't revoke ${a.failed === 1 ? "1 agent's Hub token" : `${a.failed} agents' Hub tokens`}. Nothing was removed. Try again, or remove it here anyway.`,
        };
      if (a.failed)
        note += ` Hub couldn't revoke ${a.failed === 1 ? "1 agent's token" : `${a.failed} agents' tokens`}: ${a.failed === 1 ? "it works" : "they work"} there until an admin revokes this install.`;
      agents = a.revoked;
    }
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
        // Issue 726: doctor lists it, and each start tries again.
        try {
          this.deps.unrevoked?.({
            url: cfg.url,
            why: (e as Error).message,
            token,
          });
        } catch {
          /* the record is best effort: the message still says so */
        }
      }
    }
    await this.deps.forget(cfg).catch(() => undefined);
    forgetHubToken(undefined, Date.now(), { now: true });
    const user = this.deps.readUser();
    const hub = {
      ...((user.hub as Record<string, unknown> | undefined) ?? {}),
    };
    delete hub.token;
    delete hub.mcp_url;
    if (Object.keys(hub).length) user.hub = hub;
    else delete user.hub;
    this.deps.writeUser(user);
    this.deps.agentGrantSettled?.();
    return {
      ok: true,
      revoked,
      message: `Disconnected.${revoked ? ` Hub revoked this install's token${agents ? ` and ${agents === 1 ? "1 agent's token" : `${agents} agents' tokens`}` : ""}.` : ""}${note}`,
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
