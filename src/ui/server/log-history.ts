/**
 * Log history: full container/daemon log history, paged backwards.
 *
 * Docker retains the complete log of a running container (json-file driver),
 * but `docker logs --until <ts> --tail N` returns nothing (docker applies
 * --tail BEFORE the time filter), so timestamp cursors can't page backwards.
 * Instead: history-before-now is APPEND-ONLY, so the first request snapshots
 * `docker logs --timestamps` to a file once per container instance, and pages
 * are served from that file by BYTE-OFFSET cursors — exact, immutable, and
 * O(chunk) per page. Host-run services page their den daemon log file
 * directly (also append-only).
 *
 * Future-proofing: the API cursor is an OPAQUE STRING. Local sources encode a
 * byte offset; a cloudwatch source can later encode a filter-log-events
 * backward token without any client change. `resolveHistorySource` is the
 * single extension point per env.
 */

import * as fs from "fs";
import * as path from "path";
import { execFile, spawnSync } from "child_process";

import { findServiceContainer } from "../../shared/environment-manager/service-container.js";
import {
  resolveService,
  hasRunningOpctlContainers,
} from "../../shared/environment-manager/service-runner.js";
import { checkServiceHealth } from "../../shared/environment-manager/health.js";
import { getServiceLogPath } from "../../shared/process/spawn-streaming.js";
import { readManifest } from "../../shared/manifest/read-manifest.js";
import type { Environment, LogSource } from "../../shared/types/index.js";
import { getStateDir } from "../../shared/paths.js";

const HISTORY_DIR = path.join(getStateDir(), "history");

// ── Source resolution ─────────────────────────────────────────────────────────

export type HistorySource =
  | { kind: "docker"; container: string }
  | { kind: "file"; path: string }
  | { kind: "unsupported"; reason: string };

/**
 * Repo/service names as they appear in catalogs and manifests: must start
 * alphanumeric (rejects ".", "..", dotfiles) with no path separators. This is
 * the security boundary for every history/search entry point — these values
 * reach `getServiceLogPath` (which mkdirs and opens files) and docker CLIs.
 */
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isSafeServiceName(name: string): boolean {
  return SAFE_NAME_RE.test(name);
}

/**
 * Extract a docker `--filter key=value` from a manifest logs shell command
 * (every fleet manifest resolves its container via `docker ps --filter …`).
 * Returns the filter argument (e.g. "name=shop-postgres") or null.
 */
export function parseManifestDockerFilter(cmd: string): string | null {
  const m = cmd.match(/--filter[= ]['"]?((?:name|publish|expose)=[^'"\s]+)/);
  return m ? m[1] : null;
}

/**
 * Resolve where a service's log HISTORY lives. Local env only in v1 —
 * non-local envs return `unsupported` (cloudwatch backward paging is a
 * follow-up that plugs in here).
 */
export function resolveHistorySource(
  repoName: string,
  svcName: string,
  env: string,
): HistorySource {
  // Security boundary: these names flow into filesystem paths
  // (getServiceLogPath mkdirs + reads `<repo>/<service>.log`) and docker
  // invocations. Reject anything that isn't a plain catalog-style name.
  if (!isSafeServiceName(repoName) || !isSafeServiceName(svcName)) {
    return { kind: "unsupported", reason: "invalid repo/service name" };
  }

  if (env !== "local") {
    return {
      kind: "unsupported",
      reason: `history for env "${env}" is not supported yet (local only)`,
    };
  }

  const resolved =
    resolveService(`${repoName}/${svcName}`) ?? resolveService(repoName);
  const repoPath = resolved?.repoPath;

  // 1. The service's container: its compose stack's, else opctl's
  //    conventional one (opctl_<base>_<hash>).
  const conventional = findServiceContainer(repoName, repoPath, svcName);
  if (conventional) return { kind: "docker", container: conventional };

  // 2. Container named by the manifest log command's docker ps filter.
  const manifest = repoPath ? readManifest(repoPath) : null;
  const logSource = manifest?.services?.[svcName]?.logs?.["local"] as
    | LogSource
    | undefined;
  if (logSource?.type === "shell" && logSource.cmd) {
    const filter = parseManifestDockerFilter(logSource.cmd);
    if (filter) {
      const out = spawnSync(
        "docker",
        ["ps", "--filter", filter, "--format", "{{.Names}}"],
        { encoding: "utf-8", timeout: 5_000 },
      );
      const name = out.stdout?.split("\n").map((l) => l.trim())[0];
      if (name) return { kind: "docker", container: name };
    }
  }

  // 3. Host-run process — the den daemon log file holds history since
  //    process start.
  const daemonPath = getServiceLogPath(repoName, svcName);
  if (fs.existsSync(daemonPath)) return { kind: "file", path: daemonPath };

  return {
    kind: "unsupported",
    reason: `no running container or daemon log found for ${repoName}/${svcName}`,
  };
}

// ── Snapshots ─────────────────────────────────────────────────────────────────

/**
 * Materialize the immutable history file for a source. Docker: one-time
 * `docker logs --timestamps` dump per container instance (backward pages are
 * immutable, so an existing snapshot is never stale — new lines belong to the
 * live tail stream). File sources ARE their own snapshot (append-only).
 */
export function ensureSnapshot(source: HistorySource): string | null {
  if (source.kind === "file") return source.path;
  if (source.kind !== "docker") return null;

  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const snapPath = path.join(HISTORY_DIR, `${source.container}.log`);
  if (fs.existsSync(snapPath)) return snapPath;

  const tmp = `${snapPath}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    // stdout straight to the file — a multi-GB log must never transit a
    // JS string buffer.
    const res = spawnSync(
      "docker",
      ["logs", "--timestamps", source.container],
      { stdio: ["ignore", fd, fd], timeout: 120_000 },
    );
    if (res.status !== 0) {
      fs.rmSync(tmp, { force: true });
      return null;
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, snapPath);
  return snapPath;
}

/**
 * Drop snapshots whose container no longer exists (their docker history is
 * gone with the container; the snapshot is orphaned disk). Call at web-server
 * startup, like pruneDeadDaemons().
 */
export function pruneDeadSnapshots(): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(HISTORY_DIR);
  } catch {
    return 0;
  }
  const out = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  if (out.status !== 0) return 0; // docker unavailable — keep everything
  const alive = new Set(
    (out.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  for (const entry of entries) {
    if (!entry.endsWith(".log")) continue;
    if (!alive.has(entry.slice(0, -4))) {
      try {
        fs.rmSync(path.join(HISTORY_DIR, entry), { force: true });
        removed++;
      } catch {
        /* best effort */
      }
    }
  }
  return removed;
}

// ── Byte-offset backward paging ───────────────────────────────────────────────

export interface HistoryPage {
  /** Lines in file order (oldest first). */
  lines: string[];
  /** Opaque cursor for the NEXT (older) page — byte offset of lines[0]. */
  cursor: string;
  /** True when lines[0] is the first line of the file. */
  atStart: boolean;
}

const DEFAULT_BLOCK = 256 * 1024;

/** Safety valve for pathological single-line files (no newlines for GBs). */
const MAX_CARRY = 64 * 1024 * 1024;

/**
 * Read up to `limit` lines ENDING just before byte offset `cursor`
 * (cursor null/"" = end of file). Reads backwards in bounded blocks —
 * O(returned bytes), no full-file scan, no shell.
 *
 * Cursor contract: the returned cursor is the byte offset of the FIRST
 * returned line; passing it back returns the lines immediately before it.
 * Offsets into an append-only file are immutable, so pages never shift.
 */
export function readPageBefore(
  filePath: string,
  cursor: string | null,
  limit: number,
  blockSize: number = DEFAULT_BLOCK,
): HistoryPage {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const end = cursor ? Math.min(parseInt(cursor, 10) || 0, size) : size;
    if (end <= 0 || limit <= 0)
      return { lines: [], cursor: "0", atStart: true };

    // The region [0, end) ends with the terminator of its last line (except
    // possibly at EOF with no trailing newline). Work with the region's
    // CONTENT — exclude that trailing newline so split() yields real lines.
    const lastByte = Buffer.alloc(1);
    fs.readSync(fd, lastByte, 0, 1, end - 1);
    const logicalEnd = lastByte[0] === 0x0a ? end - 1 : end;
    if (logicalEnd <= 0) return { lines: [], cursor: "0", atStart: true };

    // Read backwards until the buffer holds at least `limit` newlines
    // (⇒ limit+1 segments, first possibly partial) or we reach byte 0.
    let pos = logicalEnd;
    let carry = Buffer.alloc(0);
    let newlines = 0;
    while (pos > 0 && newlines < limit && carry.length < MAX_CARRY) {
      const readStart = Math.max(0, pos - blockSize);
      const buf = Buffer.alloc(pos - readStart);
      fs.readSync(fd, buf, 0, buf.length, readStart);
      carry = Buffer.concat([buf, carry]);
      pos = readStart;
      newlines = 0;
      for (const b of carry) if (b === 0x0a) newlines++;
    }

    // NB: byte math below must run on the RAW segments — \r stripping for
    // display happens at the end so cursors stay exact.
    const segs = carry.toString("utf-8").split("\n");
    let lines: string[];
    if (pos === 0 && segs.length <= limit) {
      lines = segs; // whole remaining region fits
    } else if (pos > 0 && segs.length <= limit) {
      // MAX_CARRY tripped inside one enormous line: represent it truncated
      // and jump the cursor to the read boundary so paging stays monotonic.
      return {
        lines: [
          "… [oversized line truncated by history pager] …",
          ...segs.slice(1).map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)),
        ],
        cursor: String(pos),
        atStart: false,
      };
    } else {
      // Last `limit` segments are guaranteed-complete lines; segs[0] may be a
      // partial line cut at a block boundary and is discarded implicitly.
      lines = segs.slice(-limit);
    }
    const startOffset =
      logicalEnd - Buffer.byteLength(lines.join("\n"), "utf-8");
    return {
      // CRLF sources (docker preserves container \r\n) — strip for display
      // AFTER the byte math; live-tail lines are \r-free, so this keeps the
      // client's seam dedupe exact.
      lines: lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)),
      cursor: String(startOffset),
      atStart: startOffset === 0,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ── Cross-system history search ───────────────────────────────────────────────

export interface SearchMatch {
  /** RFC3339 timestamp when the source has one (docker --timestamps). */
  ts: string | null;
  line: string;
  /** Surrounding context lines (already timestamp-stripped like `line`). */
  context: string[];
}

export interface SystemSearchResult {
  system: string;
  matches: SearchMatch[];
  truncated: boolean;
  error?: string;
  /** True when the system was excluded because it is not running. */
  skipped?: boolean;
}

const TS_PREFIX = /^(\d{4}-\d{2}-\d{2}T\S+Z)\s?/;

function splitTs(raw: string): { ts: string | null; line: string } {
  const m = raw.match(TS_PREFIX);
  return m
    ? { ts: m[1], line: raw.slice(m[0].length) }
    : { ts: null, line: raw };
}

/**
 * Parse `grep -n -C k` output (`N:line` matches, `N-line` context, `--`
 * group separators) into structured matches.
 */
export function parseGrepOutput(
  out: string,
  maxMatches: number,
): { matches: SearchMatch[]; truncated: boolean } {
  const matches: SearchMatch[] = [];
  let current: SearchMatch | null = null;
  let truncated = false;
  for (let raw of out.split("\n")) {
    // CRLF logs: `.` doesn't match \r in JS regexes, so strip it first.
    if (raw.endsWith("\r")) raw = raw.slice(0, -1);
    if (!raw || raw === "--") {
      current = null;
      continue;
    }
    const m = raw.match(/^(\d+)([:-])(.*)$/);
    if (!m) continue;
    const [, , sep, rest] = m;
    const { ts, line } = splitTs(rest);
    if (sep === ":") {
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      current = { ts, line, context: [] };
      matches.push(current);
    } else if (current) {
      current.context.push(line);
    } else if (matches.length < maxMatches) {
      // Leading context before the first match of a group.
      current = null;
    }
  }
  return { matches, truncated };
}

const MAX_MATCHES_PER_SYSTEM = 200;

/**
 * Search one system's FULL history (snapshot / daemon file) for a
 * case-insensitive fixed string. Bounded output.
 */
export async function searchSystemHistory(
  system: { repo: string; service: string },
  q: string,
  env: string,
): Promise<SystemSearchResult> {
  const label = `${system.repo}/${system.service}`;
  const source = resolveHistorySource(system.repo, system.service, env);
  if (source.kind === "unsupported") {
    return {
      system: label,
      matches: [],
      truncated: false,
      error: source.reason,
    };
  }

  // Search covers RUNNING systems only. Docker sources are running by
  // construction (`docker ps` lists live containers). File sources leak in
  // stopped systems — their daemon log survives the process — so gate them
  // on actual run-state (same test as the workspace down-skip: opctl
  // containers, or a healthy probe for host-run processes).
  if (source.kind === "file") {
    const resolved =
      resolveService(`${system.repo}/${system.service}`) ??
      resolveService(system.repo);
    const running =
      resolved !== null &&
      (hasRunningOpctlContainers(resolved) ||
        (await checkServiceHealth(resolved, env as Environment)).health ===
          "ok");
    if (!running) {
      return { system: label, matches: [], truncated: false, skipped: true };
    }
  }

  const file = ensureSnapshot(source);
  if (!file) {
    return {
      system: label,
      matches: [],
      truncated: false,
      error: "could not snapshot container log",
    };
  }

  return new Promise((resolve) => {
    // -m bounds matching lines server-side; +context stays small. 10 MB
    // buffer is far above 200 matches × context.
    execFile(
      "grep",
      [
        "-inF",
        "-m",
        String(MAX_MATCHES_PER_SYSTEM + 1),
        "-C",
        "2",
        "--",
        q,
        file,
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => {
        // grep exit 1 = no matches; treat other failures as empty-with-error.
        if (err && (err as { code?: number }).code !== 1 && !stdout) {
          resolve({
            system: label,
            matches: [],
            truncated: false,
            error: err.message.slice(0, 200),
          });
          return;
        }
        const { matches, truncated } = parseGrepOutput(
          stdout ?? "",
          MAX_MATCHES_PER_SYSTEM,
        );
        resolve({ system: label, matches, truncated });
      },
    );
  });
}
