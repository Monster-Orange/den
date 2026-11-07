/**
 * Shared health-check primitives.
 *
 * Single source of truth for HTTP and shell pings — used by both the web
 * server's /api/health endpoint and the CLI's status command.
 */

import { rollupRepo, type RepoRollup } from "../health/rollup.js";
import { hasRuntime, repoKind } from "../repo-kind.js";
import * as https from "https";
import * as tls from "tls";
import { readEdgeConfig } from "../edge/config.js";
import {
  composeHealth,
  composeHealthTarget,
  containerHealth,
  type ComposeHealthTarget,
  type ComposeVerdict,
  type ContainerHealthTarget,
} from "../stacks/compose-health.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as dns from "dns";
import { spawn } from "child_process";
import {
  HEALTH_CHECK_TIMEOUT_MS,
  HOSTED_HEALTH_CHECK_TIMEOUT_MS,
  CLI_SPAWN_TIMEOUT_MS,
} from "../constants.js";
import { readManifest } from "../manifest/read-manifest.js";
import {
  expectMatches,
  resolveHealthCheck,
  type Expect,
  type Placement,
} from "../manifest/placement.js";
import { readCatalog } from "./catalog.js";
import {
  getActiveWorkspace,
  getFocusedWorkspaceName,
  listWorkspaceServices,
  readManifestAnyBranch,
} from "./workspaces.js";
import type {
  ResolvedService,
  ServiceCatalog,
  ServiceHealthConfig,
  WorkspaceConfig,
} from "../types/index.js";
import type { Environment } from "../types/index.js";

import { product } from "../product.js";
export interface PingResult {
  /**
   * true: the check answered healthy. false: it COMPLETED and failed. null:
   * it did not complete or could not tell (no answer within its budget, its
   * process could not start, or it reported its state unknown). Only false
   * is down.
   */
  ok: boolean | null;
  /** With ok null: the check gave no answer within its budget. */
  pending?: boolean;
  status?: number;
  error?: string;
  /**
   * MCP-2.4: the check answered with a redirect (3xx, `status`): where it
   * points, as a path for the same origin, else origin + path (the query
   * and fragment are dropped: they can carry tokens). A redirect is not
   * down and not up (ok null): the service answered, and the check was
   * sent elsewhere.
   */
  redirect?: string;
}

export interface ServiceHealthResult {
  address: string;
  repoName: string;
  subsystem: string;
  repoPath: string;
  mode: "dev-managed" | "managed";
  branch: string | null;
  /**
   * "pending": a check ran but gave no verdict (no answer in time, or it
   * could not tell). Unlike "unknown" (no check configured) it is not a
   * reason to proceed; unlike "error" it is not down.
   */
  health: "ok" | "error" | "unknown" | "pending";
  healthDetail?: string;
  /** Where the service runs for the env checked (R13). */
  runs?: Placement["runs"];
  target?: Placement["target"];
  /** A repo row's rollup of every service (rollupRepoHealth). */
  rollup?: RepoRollup;
  /**
   * The workspaces checked that define this service, when more than one
   * was (checkCatalogHealth's `workspaces`): a shared service, listed once.
   */
  workspaces?: string[];
}

// ── Name resolution ───────────────────────────────────────────────────────────
// Health checks resolve names with c-ares and connect by IP instead of letting
// fetch() call getaddrinfo.
//
// getaddrinfo runs on the 4-thread libuv pool and its requests are
// UNCANCELLABLE — aborting the fetch does not cancel the lookup. One slow
// resolver episode strands a lookup on every pool thread, and every later
// lookup in the process then queues behind them forever while each poll adds
// ~21 more. Observed in the long-lived web server: 84k pending
// GetAddrInfoReqWrap, ~1 GB RSS, and every HTTP check reporting a false
// "timeout" while the very same service answered by IP in 11ms. Only a restart
// cleared it, and it re-wedged within 16 minutes. c-ares runs on the event
// loop, honours its own timeout, and cannot wedge the pool.
//
// Bare names (shop-api) resolve through opctl's per-service /etc/resolver
// files. c-ares must be pointed at that resolver explicitly because, unlike
// getaddrinfo, it does not read /etc/resolver. Aiming there also skips those
// files' `nameserver 8.8.8.8` fallback, so a missed lookup can no longer hang
// on Google trying to resolve a private name.
//
// Deliberately NOT cached: opctl containers take dynamic IPs (no IPAMConfig),
// so a restarted service can move. Resolution costs ~0ms, so every check
// re-resolves and DNS stays authoritative — strictly fresher than getaddrinfo,
// whose answers the OS caches for the record TTL (60s here).
const DNS_TIMEOUT_MS = 1_500;
const LOCAL_RESOLVER = "127.0.0.1";

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

let _bareResolver: dns.Resolver | null = null;
let _systemResolver: dns.Resolver | null = null;

function resolverFor(hostname: string): dns.Resolver {
  // Bare names are opctl's and live on the local resolver; dotted names are
  // real domains and use the system's configured servers.
  if (!hostname.includes(".")) {
    if (!_bareResolver) {
      _bareResolver = new dns.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
      _bareResolver.setServers([LOCAL_RESOLVER]);
    }
    return _bareResolver;
  }
  if (!_systemResolver) {
    _systemResolver = new dns.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  }
  return _systemResolver;
}

/**
 * Test seam. Unit tests mock `fetch` and assert on the URL it receives; without
 * this they would perform real DNS and assert against whatever IP this machine
 * happens to hand out. Inject an identity resolver to keep them hermetic.
 */
let _resolveHost: (hostname: string) => Promise<string | null> =
  resolveHostViaCares;
export function __setResolveHostForTests(
  fn: ((hostname: string) => Promise<string | null>) | null,
): void {
  _resolveHost = fn ?? resolveHostViaCares;
}

/** Resolve to an IPv4 address via c-ares. null = could not resolve. */
function resolveHostViaCares(hostname: string): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    // Backstop: c-ares' own timeout should fire first, but a health check must
    // never wait on resolution longer than its own budget.
    const guard = setTimeout(() => done(null), DNS_TIMEOUT_MS + 250);
    try {
      resolverFor(hostname).resolve4(hostname, (err, addrs) => {
        clearTimeout(guard);
        done(err || !addrs || addrs.length === 0 ? null : addrs[0]);
      });
    } catch {
      clearTimeout(guard);
      done(null);
    }
  });
}

/** `localhost` and `*.localhost` are this machine (RFC 6761); else c-ares. */
async function resolveName(host: string): Promise<string | null> {
  if (host === "localhost" || host.endsWith(".localhost")) return "127.0.0.1";
  return _resolveHost(host);
}

/**
 * Extra CAs trusted by HTTPS checks: the edge's own CA (its routes are signed
 * by it), read once. Test seam: __setExtraCaForTests.
 */
let _extraCa: string[] | null = null;
function extraCa(): string[] {
  if (_extraCa) return _extraCa;
  _extraCa = [];
  try {
    // The edge's own CA, and the CA it was pointed at (`edge.tls.ca`, formerly
    // `edge.caroot`, e.g. the laptop's mkcert CA that signs the projects'
    // certificates).
    const cfg = readEdgeConfig();
    const pems = [path.join(cfg.stateDir, "ca", "rootCA.pem")];
    const ca = cfg.tls.strategy === "none" ? null : cfg.tls.ca;
    if (ca) pems.push(path.join(ca, "rootCA.pem"));
    for (const pem of pems)
      if (fs.existsSync(pem)) _extraCa.push(fs.readFileSync(pem, "utf-8"));
  } catch {
    /* no edge config — public roots only */
  }
  return _extraCa;
}
export function __setExtraCaForTests(pems: string[] | null): void {
  _extraCa = pems;
}

/**
 * One TLS context with the public roots plus extraCa(), built once. Passing
 * `ca` per request made Node parse ~150 root certificates on every HTTPS
 * health check, synchronously: tens of ms per check, per poll.
 */
/** Build the HTTPS checks' trust context now (web server startup). */
export function prewarmHealthTls(): void {
  trustContext();
}

let _trust: {
  ca: string[];
  context: tls.SecureContext;
  agent: https.Agent;
} | null = null;
function trustContext(): { context: tls.SecureContext; agent: https.Agent } {
  const extra = extraCa();
  if (_trust?.ca !== extra) {
    _trust?.agent.destroy();
    _trust = {
      ca: extra,
      context: tls.createSecureContext({
        ca: [...tls.rootCertificates, ...extra],
      }),
      agent: new https.Agent({ keepAlive: false }),
    };
  }
  return _trust;
}

/**
 * The body a reverse proxy sends for a host it has no route for: Traefik's
 * default 404 (Go's http.NotFound). Behind a shared edge a stopped service
 * answers with this instead of refusing the connection, so a 4xx-means-up
 * rule would show it healthy. A service's own 404 carries its own body.
 */
const EDGE_NO_ROUTE_BODY = "404 page not found";

/** Up: 2xx, or a 4xx from the service itself (auth/route proves it answers). */
function statusOk(status: number, body404?: string): boolean {
  if (status === 404 && body404?.trim() === EDGE_NO_ROUTE_BODY) return false;
  return status < 300 || (status >= 400 && status < 500);
}

/** A 3xx: the check was sent elsewhere (redirect: "manual"). */
export function isRedirect(status: number | undefined): boolean {
  return status !== undefined && status >= 300 && status < 400;
}

/**
 * Where a redirect points, for a health row: a path when it stays on the
 * checked URL's origin, else origin + path. Never the query or fragment
 * (a login redirect's `?next=` or `state=` can carry a token).
 */
export function redirectTarget(
  location: string | null | undefined,
  from: string,
): string {
  if (!location) return "(no Location header)";
  try {
    const to = new URL(location, from);
    const base = new URL(from);
    return to.origin === base.origin
      ? to.pathname
      : `${to.origin}${to.pathname}`;
  } catch {
    return "(unreadable Location header)";
  }
}

/** The PingResult for a 3xx: not down, not up, and where it points. */
function redirectResult(
  status: number,
  location: string | null | undefined,
  from: string,
): PingResult {
  return { ok: null, status, redirect: redirectTarget(location, from) };
}

/** The PingResult for `status`, naming an edge 404 as "no route". */
function statusResult(status: number, body404?: string): PingResult {
  const ok = statusOk(status, body404);
  return ok || status !== 404
    ? { ok, status }
    : { ok, status, error: "no route (edge 404)" };
}

/**
 * HTTPS check. Connects to the c-ares-resolved IP (see above) but keeps the
 * hostname for SNI and certificate verification; rewriting the URL to the IP,
 * as plain HTTP does, makes every TLS check fail.
 */
async function pingHttps(parsed: URL, timeoutMs: number): Promise<PingResult> {
  const host = parsed.hostname;
  let ip = host;
  if (!isIpLiteral(host)) {
    const r = await resolveName(host);
    if (!r) return { ok: false, error: "dns" };
    ip = r;
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: PingResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const req = https.request(
      parsed,
      {
        method: "GET",
        servername: isIpLiteral(host) ? undefined : host,
        // tls.connect's option, passed through by the agent (not in the
        // https.RequestOptions type).
        ...({ secureContext: trustContext().context } as https.RequestOptions),
        // Its own agent: a socket kept alive under one trust set must never
        // be reused for a check under another.
        agent: trustContext().agent,
        lookup: (_h, opts, cb) => {
          // Node may ask for all addresses (autoSelectFamily).
          if ((opts as { all?: boolean }).all)
            (
              cb as unknown as (
                e: null,
                a: { address: string; family: number }[],
              ) => void
            )(null, [{ address: ip, family: ip.includes(":") ? 6 : 4 }]);
          else cb(null, ip, ip.includes(":") ? 6 : 4);
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (isRedirect(status)) {
          res.resume(); // discard the body
          const loc = res.headers.location;
          done(redirectResult(status, loc, parsed.toString()));
          return;
        }
        if (status !== 404) {
          res.resume(); // discard the body
          done({ ok: statusOk(status), status });
          return;
        }
        // A 404: read a little of the body to tell the edge's own "no
        // route" from the service's 404.
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (body.length < 64) body += c;
          if (body.length >= 64) res.destroy();
        });
        const finish = () => done(statusResult(status, body));
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done({ ok: false, error: "timeout" });
    }, timeoutMs);
    req.on("error", (e) =>
      done({ ok: false, error: e.message || "unreachable" }),
    );
    req.end();
  });
}

// ── Ping primitives ───────────────────────────────────────────────────────────

async function pingOnce(
  url: string,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
): Promise<PingResult> {
  let target = url;
  let hostHeader: string | undefined;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (parsed.protocol === "https:") return await pingHttps(parsed, timeoutMs);
    if (host !== "localhost" && !isIpLiteral(host)) {
      const ip = await resolveName(host);
      // A name that will not resolve is down — say so in 1ms instead of
      // burning the full timeout and calling it "timeout", which read as a
      // slow service when it was really a missing DNS record.
      if (!ip) return { ok: false, error: "dns" };
      hostHeader = parsed.host; // name[:port] — preserves vhost routing
      parsed.hostname = ip;
      target = parsed.toString();
    }
  } catch {
    /* unparseable URL — leave it alone and let fetch report the failure */
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      signal: controller.signal,
      redirect: "manual",
      ...(hostHeader ? { headers: { Host: hostHeader } } : {}),
    });
    clearTimeout(timer);
    // 2xx = healthy. 4xx = healthy (service is up; auth/route 4xx still proves it's responding).
    // 3xx = a redirect (MCP-2.4): ok null, with its status and target. With
    // redirect:"manual" a redirect means "go verify somewhere else", so it
    // is never green: that guards against hostname-to-AWS-ALB resolution
    // (e.g. VPN / /etc/hosts) returning 301 on port 80 for services that
    // actually run on a different port (the old `< 500` check showed those
    // green). It is not down either: something answered, and a login
    // redirect (302 → /login) is how a healthy app answers a bare GET.
    // 5xx = unhealthy (service errored).
    // A 404 may be the edge's own "no route" (see EDGE_NO_ROUTE_BODY): read
    // a little of it. Otherwise discard the body: only the status matters,
    // and unconsumed bodies pin sockets in the long-lived web server.
    if (isRedirect(res.status)) {
      void res.body?.cancel().catch(() => {});
      return redirectResult(res.status, res.headers?.get("location"), url);
    }
    if (res.status === 404) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 64);
      } catch {
        /* unreadable body: judge by the status alone */
      }
      return statusResult(res.status, body);
    }
    void res.body?.cancel().catch(() => {});
    return { ok: statusOk(res.status), status: res.status };
  } catch (e: unknown) {
    clearTimeout(timer);
    const err = e as Error;
    return {
      ok: false,
      error:
        err.name === "AbortError" ? "timeout" : err.message || "unreachable",
    };
  }
}

/**
 * Ping an HTTP/HTTPS URL. For Docker-style hostnames (no dots, not localhost)
 * automatically retries against localhost on the same port as a fallback —
 * these hostnames only resolve inside Docker itself.
 */
/** Fast timeout for the localhost fallback ping — localhost should respond in ms. */
const LOCALHOST_FALLBACK_TIMEOUT_MS = 1_500;

export async function pingHttp(
  url: string,
  timeoutMs: number = HEALTH_CHECK_TIMEOUT_MS,
  expect?: Expect,
): Promise<PingResult> {
  // A remote target's probe (target.url): up only on the expected codes, and
  // never a localhost fallback (it is not on this machine).
  if (expect !== undefined) {
    const r = await pingOnce(url, timeoutMs);
    if (r.status === undefined) return r;
    if (expectMatches(r.status, expect)) return { ok: true, status: r.status };
    // A redirect the manifest does not list as up is still a redirect, not
    // down (MCP-2.4): a production app answering 302 → /login is serving.
    if (r.redirect !== undefined) return r;
    return { ok: false, status: r.status };
  }
  const result = await pingOnce(url, timeoutMs);
  // A redirect answered: no localhost fallback (that is for a name that
  // could not be reached at all).
  if (result.ok === false) {
    // Fall back to localhost for Docker-style hostnames regardless of how the
    // first ping failed. Timeouts on the primary are legitimate candidates for
    // retry: on macOS, VPN/`/etc/hosts` can resolve a Docker hostname to an
    // AWS ALB on the wrong port, which hangs until abort — skipping the retry
    // showed the service red even when the local container was up. We use a
    // short timeout for the fallback since localhost should respond in ms.
    try {
      const parsed = new URL(url);
      // NO fallback for default-port-80 URLs: opctl DNS resolves bare names
      // (http://<repo>/healthz) on the host directly, so a network failure
      // there means the service is genuinely down — and localhost:80 belongs
      // to whichever OTHER container happens to publish host port 80 (e.g.
      // shop-web), which both spams that service's logs with foreign
      // /healthz probes every poll and risks reporting the wrong service.
      const explicitPort = parsed.port !== "" && parsed.port !== "80";
      if (
        explicitPort &&
        parsed.hostname !== "localhost" &&
        !parsed.hostname.includes(".")
      ) {
        // Rewrite only the hostname so the port, path and query are preserved
        // (string-concatenating protocol+port dropped /healthz and emitted a
        // stray trailing colon for default-port URLs like http://shop-api/healthz).
        parsed.hostname = "localhost";
        const fb = await pingOnce(
          parsed.toString(),
          LOCALHOST_FALLBACK_TIMEOUT_MS,
        );
        // On the fallback, only 2xx proves the service is up: localhost:<port>
        // may be a DIFFERENT service, and a 4xx from a stranger (which counts
        // as "up" on a direct ping) must not green-light this one.
        if (fb.ok && fb.status !== undefined && fb.status >= 400) {
          return {
            ok: false,
            status: fb.status,
            error: "fallback got non-2xx",
          };
        }
        return fb;
      }
    } catch {
      /* ignore */
    }
  }
  return result;
}

/**
 * Run a shell command health check. Exit code 0 = ok.
 * Pass extraEnv for AWS profile vars etc.
 *
 * `cwd` must be the service's repo path: health commands in .den.yml are
 * repo-relative (e.g. `./scripts/orchestration/health.sh ddb`). Without it the
 * relative path resolves against den's own directory and the shell exits 127
 * (command not found) — which is exactly how a service whose local resources
 * moved to infra-stack shows up red even when it's healthy.
 */
export async function pingShell(
  cmd: string,
  extraEnv: Record<string, string> = {},
  cwd?: string,
  opts: {
    /** The answer budget (default CLI_SPAWN_TIMEOUT_MS). */
    timeoutMs?: number;
  } = {},
): Promise<PingResult> {
  // Bounded concurrency: a health cycle starts every check at once, and a
  // distribution's shell checks are processes. Queued checks start their
  // budget when they start, not while they wait.
  const release = await shellSlots.acquire();
  try {
    return await runShellCheck(cmd, extraEnv, cwd, opts);
  } finally {
    release();
  }
}

/** A counting semaphore. */
class Slots {
  private free: number;
  private waiting: (() => void)[] = [];
  constructor(readonly size: number) {
    this.free = size;
  }
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((r) => this.waiting.push(r));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    };
  }
}

/** Shell checks running at once: max(2, cpus/2). */
export const SHELL_CHECK_CONCURRENCY = Math.max(
  2,
  Math.floor(os.cpus().length / 2),
);
const shellSlots = new Slots(SHELL_CHECK_CONCURRENCY);

function runShellCheck(
  cmd: string,
  extraEnv: Record<string, string>,
  cwd: string | undefined,
  opts: { timeoutMs?: number },
): Promise<PingResult> {
  const budget = opts.timeoutMs ?? CLI_SPAWN_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: PingResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(guard);
      resolve(r);
    };
    // A check that has not answered is not a failed check: past the budget
    // it is pending (ok null), never down. Under load a CLI-based check
    // (`<cli> stack health`, a full tsx start) can need longer than the
    // budget on a cold poll, and calling that "down" painted healthy stacks
    // red until the next poll.
    const noAnswer = (): PingResult => ({
      ok: null,
      pending: true,
      error: `no answer within ${Math.round(budget / 1000)}s`,
    });
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, [], {
        shell: true,
        env: { ...process.env, ...extraEnv },
        cwd,
        // Output is never read: piped stdio would block a chatty script once
        // the 64KB buffer fills, and 'close' would wait on grandchildren
        // holding the pipes open. Nothing consumes it — don't create it.
        stdio: "ignore",
      });
    } catch (err) {
      resolve({ ok: null, error: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      settle(noAnswer());
      proc.kill("SIGTERM");
    }, budget);
    // 'exit', NOT 'close': close waits for stdio to drain, which a killed
    // shell's surviving grandchildren can hold open forever — one wedged
    // health check then hangs every /api/health poll for good. The guard
    // timer backstops even a kill that never lands.
    const guard = setTimeout(() => settle(noAnswer()), budget + 1_000);
    proc.on("exit", (code, signal) => {
      if (code === 0) return settle({ ok: true });
      // Killed (by the budget above, or from outside): it never answered.
      if (code === null)
        return settle({ ...noAnswer(), error: `killed (${signal})` });
      settle({ ok: false, error: `exit ${code}` });
    });
    // The check could not be started (e.g. EAGAIN under load): no verdict.
    proc.on("error", (err) => settle({ ok: null, error: err.message }));
  });
}

// ── Timeouts: pending first, down when repeated ─────────────────────────────
// A check that gets no answer within its budget (an HTTP timeout, a shell
// check past CLI_SPAWN_TIMEOUT_MS) has not completed: one such cycle is
// pending, not down. A cold first probe on a loaded machine (cold docker, a
// tsx-started `stack health`, cold TLS) can miss the budget while the service
// is fine, and reporting that as down painted healthy repos red until the
// next poll. Two consecutive timeouts are down: a hung service still shows.
// The web health row counts cycles (TimeoutStreaks); a one-shot caller
// (`<cli> status`, checkServiceHealth) re-probes once at once instead, so
// both say the same thing about the same service.

/** Whether a ping got no answer within its budget. */
export function timedOut(r: PingResult): boolean {
  return r.pending === true || (r.ok === false && r.error === "timeout");
}

/** A timeout's verdict: pending on its first cycle, down on a repeat. */
function timeoutVerdict(r: PingResult, repeated: boolean): PingResult {
  const error = r.error ?? "timeout";
  return repeated
    ? { ok: false, error: `${error} (twice in a row)` }
    : { ok: null, pending: true, error };
}

/** Consecutive timed-out cycles per check, for a caller that polls. */
export class TimeoutStreaks {
  private streak = new Map<string, number>();
  /** `r` as this cycle's verdict for check `key`. */
  judge(key: string, r: PingResult): PingResult {
    if (!timedOut(r)) {
      this.streak.delete(key);
      return r;
    }
    const n = (this.streak.get(key) ?? 0) + 1;
    this.streak.set(key, n);
    return timeoutVerdict(r, n >= 2);
  }
}

/** Probe once; on a timeout, probe again at once: down only if it times out twice. */
export async function pingTwiceOnTimeout(
  probe: () => Promise<PingResult>,
): Promise<PingResult> {
  const first = await probe();
  if (!timedOut(first)) return first;
  const second = await probe();
  return timedOut(second) ? timeoutVerdict(second, true) : second;
}

/**
 * Run a shell health check. Den's own compose check (the `<cli> stack
 * health` command it generates, `compose.cmd`) is answered in-process from
 * the shared docker listing: no CLI process per check. Any other command
 * (a distribution's own) runs as a shell command.
 */
export async function pingShellCheck(
  cmd: string,
  extraEnv: Record<string, string>,
  cwd: string | undefined,
  compose: ComposeHealthTarget | null,
): Promise<PingResult> {
  if (!compose || cmd !== compose.cmd) return pingShell(cmd, extraEnv, cwd);
  return verdictPing(await composeHealth(compose));
}

/**
 * A compose or container verdict as a ping. One conversion for both, so a
 * docker that could not be asked reads the same: `ok: null`, pending (and so
 * down on a repeat) only when the listing ran past its budget.
 */
function verdictPing(v: ComposeVerdict): PingResult {
  if (v.ok === true) return { ok: true };
  if (v.ok === false) return { ok: false, error: v.detail };
  return { ok: null, error: v.detail, ...(v.pending ? { pending: true } : {}) };
}

/**
 * Run a `type: container` check: answered in-process from the shared docker
 * listing (the one Den's compose checks use), never a docker call of its own.
 */
export async function pingContainerCheck(
  target: ContainerHealthTarget,
): Promise<PingResult> {
  return verdictPing(await containerHealth(target));
}

/** The container a `type: container` health config names. */
export function containerTarget(
  h: Extract<ServiceHealthConfig, { type: "container" }>,
): ContainerHealthTarget {
  return h.container_name !== undefined
    ? { container_name: h.container_name }
    : { project: h.project, service: h.service };
}

/** A health row whose check answered with a redirect (see checkService). */
export function isRedirectDetail(detail: string | undefined): boolean {
  return /^redirect \d{3} → /.test(detail ?? "");
}

/** A ping result as a ServiceHealthResult health state. */
export function healthState(r: PingResult): ServiceHealthResult["health"] {
  // A redirect is a verdict of its own (MCP-2.4): not down, and not a check
  // still waiting to answer. "unknown", like an unchecked service, so a
  // caller waiting for health proceeds instead of waiting it out.
  if (r.ok === null && r.redirect !== undefined) return "unknown";
  return r.ok === true ? "ok" : r.ok === false ? "error" : "pending";
}

// ── Per-service health check ──────────────────────────────────────────────────

/**
 * Check health for a single resolved service (reads its manifest).
 * `env` defaults to "local".
 */
export async function checkServiceHealth(
  resolved: ResolvedService,
  env: Environment = "local",
): Promise<ServiceHealthResult> {
  const base: ServiceHealthResult = {
    address: resolved.address,
    repoName: resolved.repoName,
    subsystem: resolved.subsystem,
    repoPath: resolved.repoPath,
    mode: resolved.mode,
    branch: resolved.branch,
    health: "unknown",
  };

  if (!fs.existsSync(resolved.repoPath)) {
    return {
      ...base,
      health: "error",
      healthDetail: `repo path does not exist — run ${product().cli} setup`,
    };
  }

  const manifest = readManifest(resolved.repoPath);
  if (!manifest) {
    return {
      ...base,
      health: "unknown",
      healthDetail: `no ${product().manifestYml}`,
    };
  }

  const compose =
    env === "local"
      ? composeHealthTarget(
          manifest,
          resolved.subsystem,
          resolved.repoName,
          getFocusedWorkspaceName() ?? "default",
        )
      : null;
  const plan = resolveHealthCheck(
    manifest,
    resolved.subsystem,
    env,
    compose?.cmd ?? null,
  );
  const placed: Pick<ServiceHealthResult, "runs" | "target"> = {
    runs: plan.placement.runs,
    target: plan.placement.target,
  };
  const healthCfg = plan.check;
  if (!healthCfg) {
    if (plan.placement.runs === "remote")
      return {
        ...base,
        ...placed,
        health: "unknown",
        healthDetail: "no health check configured",
      };
    // Conventional local discovery: opctl exposes each system on the host at
    // http://<repo> (port 80), and stack services serve /healthz. When the
    // PRIMARY service (entrypoint, or a repo's only service) declares no local
    // health check, probe the convention — a repo like jobs-runtime serves
    // /healthz without listing it in the manifest. Success → "ok"; failure
    // stays "unknown" (we can't distinguish "down" from "no endpoint").
    const serviceKeys = Object.keys(manifest.services ?? {});
    const isPrimary = manifest.entrypoint
      ? resolved.subsystem === manifest.entrypoint
      : serviceKeys.length === 1;
    if (env === "local" && isPrimary) {
      const conventional = `http://${resolved.repoName}/healthz`;
      const probe = await pingHttp(conventional);
      // Convention-GUESSED endpoint: only 2xx proves this service answered.
      // pingHttp counts 4xx as ok (right for DECLARED endpoints, where 401/403
      // still prove the service is up) — but on the bare port-80 convention,
      // host DNS may hand the request to a different container or an ALB, and
      // a stranger's 404 must not report "ok" (it would feed up's skip-healthy
      // decision and skip starting a genuinely-down service).
      if (probe.ok && probe.status !== undefined && probe.status < 300) {
        return {
          ...base,
          ...placed,
          health: "ok",
          healthDetail: `conventional ${conventional}`,
        };
      }
    }
    return {
      ...base,
      ...placed,
      health: "unknown",
      healthDetail: "no health check configured",
    };
  }

  const result = await pingTwiceOnTimeout(() =>
    healthCfg.type === "shell"
      ? pingShellCheck(healthCfg.cmd, {}, resolved.repoPath, compose)
      : healthCfg.type === "container"
        ? pingContainerCheck(containerTarget(healthCfg))
        : pingHttp(
            healthCfg.url,
            env === "local" && plan.placement.runs !== "remote"
              ? HEALTH_CHECK_TIMEOUT_MS
              : HOSTED_HEALTH_CHECK_TIMEOUT_MS,
            plan.expect,
          ),
  );

  return {
    ...base,
    ...placed,
    health: healthState(result),
    healthDetail:
      (result.redirect !== undefined
        ? `redirect ${result.status} → ${result.redirect}`
        : undefined) ??
      result.error ??
      (!result.ok && result.status !== undefined
        ? `http ${result.status}`
        : undefined),
  };
}

// ── Catalog-wide health scan ──────────────────────────────────────────────────

/**
 * Check health for every service visible in the active workspace.
 * Uses listWorkspaceServices (which expands mono-repo entries and resolves
 * paths from workspace entries) so CLI and server stay consistent.
 *
 * Falls back to iterating the catalog directly when no workspace is active
 * (e.g. first-run before any workspace is configured).
 */
export async function checkCatalogHealth(
  catalog: ServiceCatalog = readCatalog(),
  env: Environment = "local",
  /**
   * The workspaces to check (focus first), e.g. the view scope's. Default:
   * the focused one. A service several define is checked once, from the
   * first, with `workspaces` naming every one.
   */
  workspaces?: { name: string; config: WorkspaceConfig }[],
): Promise<ServiceHealthResult[]> {
  const ws = getActiveWorkspace();
  const list = workspaces ?? (ws ? [ws] : []);
  const byAddress = new Map<string, ResolvedService>();
  const owners = new Map<string, string[]>();
  for (const w of list)
    for (const r of listWorkspaceServices(w.config, catalog, w.name)) {
      // Modules and libraries have no runtime, so no health of their own.
      if (!hasRuntime(repoKind(r.repoPath))) continue;
      if (!byAddress.has(r.address)) byAddress.set(r.address, r);
      const o = owners.get(r.address) ?? [];
      if (!o.includes(w.name)) owners.set(r.address, [...o, w.name]);
    }

  return Promise.all(
    [...byAddress.values()].map(async (r) => {
      const h = await checkServiceHealth(r, env);
      return workspaces ? { ...h, workspaces: owners.get(r.address) } : h;
    }),
  );
}

/**
 * One row per repo, its health rolled up from every service's check by the
 * rule the web UI's header row and graph use (src/shared/health/rollup.ts):
 * down when the entry service (the manifest `entrypoint`) is down, degraded
 * when another checked service is, healthy when something is checked and
 * nothing fails, unknown when nothing is checked. Unchecked services never
 * count (0.3.0-dev.10).
 *
 * The repo row is the entry service's row under the repo name, with
 * `rollup` set; its `health` is "error" for down or degraded. A remote
 * service keeps its own row too (R13). Single-service repos keep their row.
 */
export function rollupRepoHealth(
  results: ServiceHealthResult[],
  getEntrypoint: (repoName: string, repoPath: string) => string | undefined = (
    repoName,
    repoPath,
  ) => readManifestAnyBranch(repoName, repoPath)?.entrypoint ?? undefined,
): ServiceHealthResult[] {
  // Group by repo, preserving first-seen order.
  const groups = new Map<string, ServiceHealthResult[]>();
  for (const r of results) {
    const g = groups.get(r.repoName);
    if (g) g.push(r);
    else groups.set(r.repoName, [r]);
  }

  const out: ServiceHealthResult[] = [];
  for (const [repoName, rows] of groups) {
    const entrypoint =
      rows.length > 1 ? getEntrypoint(repoName, rows[0].repoPath) : undefined;
    const rollup = rollupRepo(
      repoName,
      rows.map((r) => ({
        service: r.subsystem,
        ok: r.health === "ok" ? true : r.health === "error" ? false : null,
        isEntrypoint: !!entrypoint && r.subsystem === entrypoint,
        redirect: isRedirectDetail(r.healthDetail),
      })),
    );
    const lead =
      rows.find((r) => r.subsystem === rollup.entry) ??
      rows.find((r) => r.health === "error") ??
      rows[0];
    out.push({
      ...lead,
      address: rows.length > 1 ? repoName : lead.address,
      health:
        rollup.state === "ok"
          ? "ok"
          : rollup.state === "unknown"
            ? "unknown"
            : "error",
      rollup,
    });
    // A remote service is not a sidecar: it keeps its own row (R13).
    if (rows.length > 1)
      out.push(...rows.filter((r) => r !== lead && r.runs === "remote"));
  }
  return out;
}

/**
 * Order health rows to match the derived graph's top-down flow — entry repo
 * first, foundation last (e.g. shop-web … infra-stack), the same direction the
 * web graph uses. Pass the repo-name order (typically `orderForDown(graph)`).
 *
 * Stable within a repo, so a multi-service repo's subsystems stay grouped in
 * their original sub-order. Rows whose repo isn't in the graph sort to the end,
 * preserving their relative order.
 */
export function sortByRepoOrder(
  results: ServiceHealthResult[],
  order: string[],
): ServiceHealthResult[] {
  const rank = new Map(order.map((repo, i) => [repo, i]));
  return results
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const ra = rank.get(a.r.repoName) ?? Number.POSITIVE_INFINITY;
      const rb = rank.get(b.r.repoName) ?? Number.POSITIVE_INFINITY;
      return ra - rb || a.i - b.i;
    })
    .map((x) => x.r);
}
