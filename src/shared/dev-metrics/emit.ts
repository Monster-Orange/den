/**
 * Dev-tooling telemetry emitter (native TypeScript).
 *
 * Den is a native consumer of common-iac's dev-metrics pipeline (like stack's
 * Go `internal/devmetrics`): it emits the SAME telemetry contract in-process
 * rather than shelling out to the vendored Python/bash emitters — see
 * common-iac docs/guides/dev-metrics/README.md, "Appendix: per-tool
 * differentiation".
 *
 * Contract (kept byte-compatible with dev_metrics.py — pinned by
 * dev-metrics.emit.test.ts against golden envelopes captured via
 * DEV_METRICS_ENVELOPE_OUT):
 *   1. ALWAYS append one compact JSON line to <repoRoot>/.dev-metrics/events.jsonl.
 *   2. THEN, only when the engineer opted in, best-effort ship to Sentry
 *      (Tier-1 -> log item, Tier-2 -> event item).
 *
 * Local only by default (den#2): nothing leaves the machine unless
 * config/local/user.yml says `metrics: { share: true }` (the boolean, nothing
 * else). A DSN, in the env or a synced dev-metrics.config, is where to send
 * once opted in; on its own it never sends.
 *
 * Guarantees: never throws, never blocks the caller (the Sentry ship is
 * fire-and-forget, bounded to ~2s). CI=true / DEV_METRICS_DISABLED=1 suppress
 * shipping but still buffer the JSONL locally.
 *
 * Tool differentiation: den emits `devtool.den.<event>` with a `tool=den`
 * attribute. Per the appendix, event names are FIXED (`devtool.den.invocation`
 * / `.failed`) and dimensions (command, surface, duration_ms, exit) ride as
 * attributes — never per-command event names.
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawn } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as yaml from "yaml";
import { getDistRoot } from "../paths.js";

import { product } from "../product.js";
const SERVICE = "dev-tooling";
const ENVIRONMENT = "dev-tooling";

/**
 * Alertable events, hardcoded identically to dev_metrics.py's TIER2_EVENTS
 * (v5.0.2). Keep in lockstep with common-iac — a divergence breaks the `tier`
 * field's byte-compatibility. `devtool.den.*` are deliberately absent, so
 * they ship as Tier-1 logs until common-iac adds them to its allowlist.
 */
const TIER2_EVENTS = new Set<string>([
  "devtool.pin.drift_detected",
  "devtool.install_fix.ran",
  "devtool.file_link.leaked",
  "devtool.setup.failed",
  "devtool.install.failed",
]);

const GIT_TIMEOUT_MS = 2000;
const SHIP_TIMEOUT_MS = 2000;

// ── helpers ───────────────────────────────────────────────────────────────────

function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function repoRoot(): string {
  return process.env.DEV_METRICS_REPO_ROOT || getDistRoot();
}

/** Stable-per-process common fields (repo/user never change); branch/sha re-read cheaply. */
let _stable: { root: string; repo: string; user: string; pins: string } | null =
  null;

function stableFields(root: string): {
  repo: string;
  user: string;
  pins: string;
} {
  if (_stable && _stable.root === root) return _stable;
  const user =
    git(["config", "user.name"], root) || process.env.USER || "unknown";
  let pins = "";
  try {
    const data = fs.readFileSync(path.join(root, "api-dependencies.yml"));
    // sha256[:12] — matches dev_metrics.py _pins_fingerprint.
    pins = createHash("sha256").update(data).digest("hex").slice(0, 12);
  } catch {
    pins = "";
  }
  _stable = { root, repo: path.basename(root), user, pins };
  return _stable;
}

function commonFields(event: string, root: string): Record<string, string> {
  const { repo, user, pins } = stableFields(root);
  return {
    event,
    tier: TIER2_EVENTS.has(event) ? "event" : "log",
    service: SERVICE,
    environment: ENVIRONMENT,
    repo,
    user,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    sha: git(["rev-parse", "--short", "HEAD"], root),
    pins,
  };
}

function isoNoMillis(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function suppressShip(): boolean {
  return process.env.CI === "true" || process.env.DEV_METRICS_DISABLED === "1";
}

/**
 * The opt-in (den#2): `metrics.share` is exactly `true` in the engineer's
 * config/local/user.yml under the repo root. Read on each ship, so turning
 * it off takes effect at once; any error reads as "not opted in".
 */
export function shareOptedIn(root: string = repoRoot()): boolean {
  try {
    const raw = fs.readFileSync(
      path.join(root, "config", "local", "user.yml"),
      "utf-8",
    );
    const doc = yaml.parse(raw) as unknown;
    if (!doc || typeof doc !== "object") return false;
    const m = (doc as { metrics?: unknown }).metrics;
    return (
      !!m && typeof m === "object" && (m as { share?: unknown }).share === true
    );
  } catch {
    return false;
  }
}

function resolveDsn(root: string): string {
  const env = process.env.DEV_METRICS_SENTRY_DSN;
  if (env) return env;
  try {
    const cfg = fs.readFileSync(
      path.join(
        root,
        ".stack",
        "common-iac",
        "scripts",
        "lib",
        "dev-metrics.config",
      ),
      "utf-8",
    );
    for (const line of cfg.split("\n")) {
      if (line.startsWith("DEV_METRICS_SENTRY_DSN=")) {
        return line
          .slice("DEV_METRICS_SENTRY_DSN=".length)
          .trim()
          .replace(/^"|"$/g, "");
      }
    }
  } catch {
    /* not synced */
  }
  return "";
}

function parseDsn(
  dsn: string,
): { scheme: string; host: string; key: string; projectId: string } | null {
  const m = dsn.match(/^(https?):\/\/([^@]+)@([^/]+)\/(.+)$/);
  if (!m) return null;
  const [, scheme, key, host, projectId] = m;
  if (!scheme || !host || !key || !projectId) return null;
  return { scheme, host, key, projectId };
}

// ── envelope builder (pure; byte-compatible with dev_metrics.py _build_envelope)

/**
 * Build the Sentry envelope text for one record. `record` is the shipped object
 * (JSONL object minus `ts`), `epoch` is integer seconds, `id` is a 32-char hex.
 * Exported so the byte-compat test can replay a golden record's epoch/id.
 */
export function buildEnvelope(
  record: Record<string, string>,
  epoch: number,
  id: string,
): string {
  if (record.tier === "event") {
    const body = {
      event_id: id,
      timestamp: epoch,
      platform: "other",
      logger: "dev-tooling",
      level: "warning",
      message: record.event,
      environment: ENVIRONMENT,
      tags: { ...record },
    };
    const payload = JSON.stringify(body);
    const itemHeader = JSON.stringify({
      type: "event",
      content_type: "application/json",
      length: Buffer.byteLength(payload, "utf8"),
    });
    const envHeader = JSON.stringify({ event_id: id });
    return `${envHeader}\n${itemHeader}\n${payload}\n`;
  }

  const attributes: Record<string, { value: string | number; type: string }> =
    {};
  for (const [k, v] of Object.entries(record)) {
    attributes[k] = { value: v, type: "string" };
  }
  attributes["sentry.severity_number"] = { value: 9, type: "integer" };
  attributes["sentry.severity_text"] = { value: "info", type: "string" };
  const logRecord = {
    timestamp: epoch,
    trace_id: id,
    level: "info",
    body: record.event,
    attributes,
  };
  const payload = JSON.stringify({ version: 2, items: [logRecord] });
  const itemHeader = JSON.stringify({
    type: "log",
    content_type: "application/vnd.sentry.items.log+json",
    item_count: 1,
    length: Buffer.byteLength(payload, "utf8"),
  });
  return `{}\n${itemHeader}\n${payload}\n`;
}

/**
 * Send from a short-lived detached process instead of this one. The CLI
 * records its run in the `exit` handler, where an async fetch never runs;
 * a detached sender outlives the CLI and gives up after SHIP_TIMEOUT_MS.
 * The long-lived server keeps the in-process fetch.
 */
let shipDetached = false;
export function shipFromDetachedSender(): void {
  shipDetached = true;
}

const SENDER = `fetch(process.env.DM_URL,{method:"POST",headers:{"Content-Type":"application/x-sentry-envelope","X-Sentry-Auth":process.env.DM_AUTH},body:process.env.DM_BODY,signal:AbortSignal.timeout(${SHIP_TIMEOUT_MS})}).catch(()=>{}).finally(()=>process.exit(0))`;

function sendDetached(url: string, auth: string, body: string): void {
  try {
    spawn(process.execPath, ["-e", SENDER], {
      detached: true,
      stdio: "ignore",
      // Only what the sender needs: none of the caller's environment.
      env: { DM_URL: url, DM_AUTH: auth, DM_BODY: body },
    }).unref();
  } catch {
    /* fail-open: the JSONL line is already buffered */
  }
}

function ship(
  record: Record<string, string>,
  epoch: number,
  root: string,
): void {
  if (!shareOptedIn(root)) return;
  const dsn = resolveDsn(root);
  if (!dsn) return;
  const parsed = parseDsn(dsn);
  if (!parsed) return;
  const envelope = buildEnvelope(record, epoch, randomUUID().replace(/-/g, ""));

  // Test/inspection seam — capture the envelope instead of shipping.
  const capture = process.env.DEV_METRICS_ENVELOPE_OUT;
  if (capture) {
    try {
      fs.appendFileSync(capture, envelope);
    } catch {
      /* fail-open */
    }
    return;
  }

  const url = `${parsed.scheme}://${parsed.host}/api/${parsed.projectId}/envelope/`;
  const auth = `Sentry sentry_key=${parsed.key}, sentry_version=7, sentry_client=dev-metrics-${product().cli}/1.0`;
  if (shipDetached) return sendDetached(url, auth, envelope);
  // Fire-and-forget: never awaited, so the caller never blocks. Bounded by a 2s
  // abort so a hung ingest can't leak a pending request in the long-lived server.
  void fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth": auth,
    },
    body: envelope,
    signal: AbortSignal.timeout(SHIP_TIMEOUT_MS),
  })
    // Discard the body. The status is never read, and an unconsumed body keeps
    // the connection checked out of undici's pool in this long-lived server —
    // one leak per emitted event. Same reason health.ts cancels its bodies.
    .then((res) => res.body?.cancel())
    .catch(() => {
      /* fail-open: offline / bad DSN / timeout → drop, JSONL already buffered */
    });
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Record one telemetry event. Never throws, never blocks. Extra fields are
 * stringified (matching dev_metrics.py); pass only PII-safe values — registered
 * command names, flag names (not values), error classes (not messages).
 */
export function record(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  try {
    if (!event) return;
    const root = repoRoot();
    const epoch = Math.floor(Date.now() / 1000);

    const obj: Record<string, string> = { ts: isoNoMillis() };
    Object.assign(obj, commonFields(event, root));
    for (const [k, v] of Object.entries(fields)) {
      obj[k] = v == null ? "" : String(v);
    }

    try {
      const dir = path.join(root, ".dev-metrics");
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(
        path.join(dir, "events.jsonl"),
        JSON.stringify(obj) + "\n",
      );
    } catch {
      /* non-writable dir → fail-open */
    }

    if (suppressShip()) return;
    // The JSONL object doubles as the Sentry attribute/tag set, minus `ts`.
    const { ts: _ts, ...shipObj } = obj;
    void _ts;
    ship(shipObj, epoch, root);
  } catch {
    /* Fail-open: telemetry must never break a caller. */
  }
}

/** Den's fixed tool id — event-name namespace segment AND `tool` attribute. */
export const TOOL = `${product().cli}`;

export type Surface = "cli" | "ux";

/**
 * Record one `devtool.den.invocation` (Tier-1). One per user-initiated run.
 * `command` MUST be a registered command/action name (never raw argv).
 */
export function recordInvocation(opts: {
  command: string;
  surface: Surface;
  durationMs?: number;
  exit?: number;
  extra?: Record<string, string | number | boolean | null | undefined>;
}): void {
  record(`devtool.${product().name}.invocation`, {
    tool: TOOL,
    command: opts.command,
    surface: opts.surface,
    duration_ms: opts.durationMs,
    exit: opts.exit,
    ...opts.extra,
  });
}

/**
 * Record one `devtool.den.failed`. Ships Tier-1 today (add to common-iac's
 * TIER2 allowlist to make it alertable). `reason` MUST be an error *class*, not
 * a message.
 */
export function recordFailure(opts: {
  command: string;
  surface: Surface;
  reason: string;
  durationMs?: number;
  extra?: Record<string, string | number | boolean | null | undefined>;
}): void {
  record(`devtool.${product().name}.failed`, {
    tool: TOOL,
    command: opts.command,
    surface: opts.surface,
    reason: opts.reason,
    duration_ms: opts.durationMs,
    ...opts.extra,
  });
}

/** Start a timer; returns a fn giving elapsed whole milliseconds. */
export function startTimer(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}
