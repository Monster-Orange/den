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
import { execFile, spawn } from "child_process";
import { createHash } from "crypto";
import { encodeCursor, type Page, type PageAsk } from "./paging.js";

import { findServiceContainerAsync } from "../../shared/environment-manager/service-container.js";
import { hasRunningOpctlContainers } from "../../shared/environment-manager/service-runner.js";
import { resolveServiceInProjects } from "../../shared/environment-manager/service-in-projects.js";
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
  | { kind: "unsupported"; reason: string; t?: ReasonWords };

/**
 * A reason as a catalog key and its vars (issue 171): the Logs page shows
 * the catalog's words in its language; `reason`/`error` stay English for
 * the CLI and agents.
 */
export interface ReasonWords {
  key: string;
  vars?: Record<string, string>;
}

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

const COMPOSE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

function shellWords(cmd: string): string[] | null {
  const words: string[] = [];
  let cur: string | null = null;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur = (cur ?? "") + c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur ??= "";
    } else if (/\s/.test(c)) {
      if (cur !== null) words.push(cur);
      cur = null;
    } else if (";|&<>()`".includes(c)) {
      if (cur !== null) words.push(cur);
      cur = null;
      words.push("\0");
    } else {
      cur = (cur ?? "") + c;
    }
  }
  if (quote) return null;
  if (cur !== null) words.push(cur);
  return words;
}

const COMPOSE_GLOBAL_WITH_VALUE = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--project-directory",
  "--env-file",
  "--profile",
  "--ansi",
  "--progress",
  "--parallel",
]);
const COMPOSE_LOGS_WITH_VALUE = new Set([
  "-n",
  "--tail",
  "--since",
  "--until",
  "--index",
]);

function optionValue(
  words: string[],
  i: number,
  withValue: Set<string>,
): { name: string; value: string | null; next: number } | null {
  const w = words[i];
  if (!w.startsWith("-") || w === "-" || w === "--") return null;
  const eq = w.indexOf("=");
  if (eq > 0)
    return { name: w.slice(0, eq), value: w.slice(eq + 1), next: i + 1 };
  if (withValue.has(w))
    return { name: w, value: words[i + 1] ?? null, next: i + 2 };
  return { name: w, value: null, next: i + 1 };
}

export function composeProjectName(dir: string): string {
  return path
    .basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[_-]+/, "");
}

export function parseManifestComposeLogs(
  cmd: string,
  cwd: string,
): { project: string; service: string } | null {
  const words = shellWords(cmd);
  if (!words) return null;
  const env: Record<string, string> = {};
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
    const eq = words[i].indexOf("=");
    env[words[i].slice(0, eq)] = words[i].slice(eq + 1);
    i++;
  }
  if (words[i] === "docker" && words[i + 1] === "compose") i += 2;
  else if (words[i] === "docker-compose") i += 1;
  else return null;
  let project: string | null = null;
  let projectDir: string | null = null;
  let firstFile: string | null = null;
  while (i < words.length && words[i] !== "logs") {
    const o = optionValue(words, i, COMPOSE_GLOBAL_WITH_VALUE);
    if (!o) return null;
    if (COMPOSE_GLOBAL_WITH_VALUE.has(o.name) && o.value === null) return null;
    if (o.name === "-p" || o.name === "--project-name") project = o.value;
    else if (o.name === "--project-directory") projectDir = o.value;
    else if ((o.name === "-f" || o.name === "--file") && firstFile === null)
      firstFile = o.value;
    i = o.next;
  }
  if (words[i] !== "logs") return null;
  i++;
  const services: string[] = [];
  let operands = false;
  while (i < words.length && words[i] !== "\0") {
    if (!operands && words[i] === "--") {
      operands = true;
      i++;
      continue;
    }
    const o = operands ? null : optionValue(words, i, COMPOSE_LOGS_WITH_VALUE);
    if (o) {
      i = o.next;
      continue;
    }
    services.push(words[i]);
    i++;
  }
  if (services.length !== 1) return null;
  project ??=
    env.COMPOSE_PROJECT_NAME ??
    composeProjectName(
      path.resolve(
        cwd,
        projectDir ?? (firstFile ? path.dirname(firstFile) : "."),
      ),
    );
  const service = services[0];
  if (!COMPOSE_NAME_RE.test(project) || !COMPOSE_NAME_RE.test(service))
    return null;
  return { project, service };
}

function firstDockerName(...filters: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      [
        "ps",
        ...filters.flatMap((f) => ["--filter", f]),
        "--format",
        "{{.Names}}",
      ],
      { encoding: "utf-8", timeout: 5_000 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(
          (stdout ?? "")
            .split("\n")
            .map((l) => l.trim())
            .find(Boolean) ?? null,
        );
      },
    );
  });
}

/**
 * Resolve where a service's log HISTORY lives. Local env only in v1 —
 * non-local envs return `unsupported` (cloudwatch backward paging is a
 * follow-up that plugs in here).
 */
export async function resolveHistorySource(
  repoName: string,
  svcName: string,
  env: string,
  workspace?: string | null,
): Promise<HistorySource> {
  // Security boundary: these names flow into filesystem paths
  // (getServiceLogPath mkdirs + reads `<repo>/<service>.log`) and docker
  // invocations. Reject anything that isn't a plain catalog-style name.
  if (!isSafeServiceName(repoName) || !isSafeServiceName(svcName)) {
    return {
      kind: "unsupported",
      reason: "invalid repo/service name",
      t: { key: "lg.why.badName" },
    };
  }

  if (env !== "local") {
    return {
      kind: "unsupported",
      reason: `history for env "${env}" is not supported yet (local only)`,
      t: { key: "lg.why.notLocal", vars: { env } },
    };
  }

  // Issue 235: any project's service, not only the focused one's.
  const found = resolveServiceInProjects(
    [`${repoName}/${svcName}`, repoName],
    workspace,
  );
  if (found.error)
    return {
      kind: "unsupported",
      reason: found.error,
      t: { key: "lg.why.noProject", vars: { name: `${repoName}/${svcName}` } },
    };
  const repoPath = found.resolved?.repoPath;

  // 1. The service's container: its compose stack's, else opctl's
  //    conventional one (opctl_<base>_<hash>).
  const conventional = await findServiceContainerAsync(
    repoName,
    repoPath,
    svcName,
  );
  if (conventional) return { kind: "docker", container: conventional };

  // 2. Container named by the manifest log command's docker ps filter.
  const manifest = repoPath ? readManifest(repoPath) : null;
  const logSource = manifest?.services?.[svcName]?.logs?.["local"] as
    | LogSource
    | undefined;
  if (logSource?.type === "shell" && logSource.cmd) {
    const filter = parseManifestDockerFilter(logSource.cmd);
    if (filter) {
      // Async: a slow docker must not hold up the rest of the server.
      const name = await firstDockerName(filter);
      if (name) return { kind: "docker", container: name };
    }
    const compose = repoPath
      ? parseManifestComposeLogs(logSource.cmd, repoPath)
      : null;
    if (compose) {
      const name = await firstDockerName(
        `label=com.docker.compose.project=${compose.project}`,
        `label=com.docker.compose.service=${compose.service}`,
      );
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
    t: { key: "lg.why.noSource", vars: { name: `${repoName}/${svcName}` } },
  };
}

// ── Snapshots ─────────────────────────────────────────────────────────────────

/**
 * Materialize the immutable history file for a source. Docker: one-time
 * `docker logs --timestamps` dump per container instance (backward pages are
 * immutable, so an existing snapshot is never stale — new lines belong to the
 * live tail stream). File sources ARE their own snapshot (append-only).
 */
export async function ensureSnapshot(
  source: HistorySource,
): Promise<string | null> {
  if (source.kind === "file") return source.path;
  if (source.kind !== "docker") return null;

  const snapPath = path.join(HISTORY_DIR, `${source.container}.log`);
  if (fs.existsSync(snapPath)) return snapPath;
  // Two requests for the same container share one dump.
  const running = snapshotsInFlight.get(snapPath);
  if (running) return running;
  const made = dumpDockerLogs(source.container, snapPath).finally(() =>
    snapshotsInFlight.delete(snapPath),
  );
  snapshotsInFlight.set(snapPath, made);
  return made;
}

const snapshotsInFlight = new Map<string, Promise<string | null>>();

/**
 * `docker logs --timestamps` streamed straight into a temp file, then renamed
 * into place. Async: a large log takes as long as it takes without holding
 * up the rest of the server (issue 131).
 */
function dumpDockerLogs(
  container: string,
  snapPath: string,
): Promise<string | null> {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const tmp = `${snapPath}.tmp`;
  // stdout straight to the file — a multi-GB log must never transit a
  // JS string buffer.
  const fd = fs.openSync(tmp, "w");
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      // In a child's event handler: a throw here would take the server down.
      try {
        fs.closeSync(fd);
        if (ok) {
          fs.renameSync(tmp, snapPath);
          return resolve(snapPath);
        }
      } catch {
        /* fall through: no snapshot */
      }
      fs.rmSync(tmp, { force: true });
      resolve(null);
    };
    const child = spawn("docker", ["logs", "--timestamps", container], {
      stdio: ["ignore", fd, fd],
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

/**
 * Drop snapshots whose container no longer exists (their docker history is
 * gone with the container; the snapshot is orphaned disk). Keeps one written
 * since the prune began (its container restarted), and one it can't stat.
 */
export async function pruneDeadSnapshots(): Promise<number> {
  let removed = 0;
  const began = Date.now();
  let entries: string[];
  try {
    entries = fs.readdirSync(HISTORY_DIR);
  } catch {
    return 0;
  }
  const names = await new Promise<string | null>((resolve) =>
    execFile(
      "docker",
      ["ps", "-a", "--format", "{{.Names}}"],
      { encoding: "utf-8", timeout: 10_000 },
      (err, stdout) => resolve(err ? null : (stdout ?? "")),
    ),
  );
  if (names === null) return 0; // docker unavailable — keep everything
  const alive = new Set(
    names
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  for (const entry of entries) {
    if (!entry.endsWith(".log")) continue;
    if (!alive.has(entry.slice(0, -4))) {
      const file = path.join(HISTORY_DIR, entry);
      try {
        if (!(fs.statSync(file).mtimeMs < began)) continue;
      } catch {
        continue;
      }
      try {
        fs.rmSync(file, { force: true });
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
  n?: number;
}

export interface SystemSearchResult {
  system: string;
  matches: SearchMatch[];
  truncated: boolean;
  error?: string;
  /** The error as catalog words, when Den knows it (issue 171). */
  t?: ReasonWords;
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
  base?: number,
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
    const [, num, sep, rest] = m;
    const { ts, line } = splitTs(rest);
    if (sep === ":") {
      if (matches.length >= maxMatches) {
        truncated = true;
        break;
      }
      current =
        base === undefined
          ? { ts, line, context: [] }
          : { ts, line, context: [], n: base + Number(num) };
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
  workspace?: string | null,
  page?: { from: number; max: number },
): Promise<SystemSearchResult> {
  const label = `${system.repo}/${system.service}`;
  const source = await resolveHistorySource(
    system.repo,
    system.service,
    env,
    workspace,
  );
  if (source.kind === "unsupported") {
    return {
      system: label,
      matches: [],
      truncated: false,
      error: source.reason,
      ...(source.t ? { t: source.t } : {}),
    };
  }

  // Search covers RUNNING systems only. Docker sources are running by
  // construction (`docker ps` lists live containers). File sources leak in
  // stopped systems — their daemon log survives the process — so gate them
  // on actual run-state (same test as the workspace down-skip: opctl
  // containers, or a healthy probe for host-run processes).
  if (source.kind === "file") {
    const { resolved } = resolveServiceInProjects(
      [`${system.repo}/${system.service}`, system.repo],
      workspace,
    );
    const running =
      resolved !== null &&
      (hasRunningOpctlContainers(resolved) ||
        (await checkServiceHealth(resolved, env as Environment)).health ===
          "ok");
    if (!running) {
      return { system: label, matches: [], truncated: false, skipped: true };
    }
  }

  const file = await ensureSnapshot(source);
  if (!file) {
    return {
      system: label,
      matches: [],
      truncated: false,
      error: "could not snapshot container log",
      t: { key: "lg.why.noSnapshot" },
    };
  }

  if (page) return grepFrom(label, file, q, page);
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

function grepFrom(
  system: string,
  file: string,
  q: string,
  page: { from: number; max: number },
): Promise<SystemSearchResult> {
  return new Promise((resolve) => {
    const tail = spawn("tail", ["-n", `+${page.from}`, file], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const grep = spawn(
      "grep",
      ["-inF", "-m", String(page.max), "-C", "2", "--", q],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let out = "";
    let failed: string | null = null;
    const stop = () => {
      tail.kill();
      grep.kill();
    };
    const timer = setTimeout(() => {
      failed = "search timed out";
      stop();
    }, 30_000);
    tail.on("error", (e) => {
      failed = e.message;
      grep.kill();
    });
    grep.stdin.on("error", () => undefined);
    tail.stdout.on("error", () => undefined);
    tail.stdout.pipe(grep.stdin);
    grep.stdout.setEncoding("utf8");
    grep.stdout.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > 10 * 1024 * 1024) {
        failed = "search output too large";
        stop();
      }
    });
    grep.on("error", (e) => {
      failed = e.message;
    });
    grep.on("close", (code) => {
      clearTimeout(timer);
      tail.kill();
      if (failed || (code !== 0 && code !== 1 && !out)) {
        resolve({
          system,
          matches: [],
          truncated: false,
          error: (failed ?? `grep exited ${code}`).slice(0, 200),
        });
        return;
      }
      const { matches, truncated } = parseGrepOutput(
        out,
        page.max,
        page.from - 1,
      );
      resolve({ system, matches, truncated });
    });
  });
}

export interface SearchPageMatch extends SearchMatch {
  system: string;
  n: number;
}

export interface SearchPageSystem {
  system: string;
  error?: string;
  t?: ReasonWords;
  skipped?: boolean;
  more?: boolean;
}

export interface SearchPage extends Page<SearchPageMatch> {
  forwardOnly: true;
  q: string;
  systems: SearchPageSystem[];
}

export const SEARCH_LIST = "logs.search";

type Target = { repo: string; service: string };

const labelOf = (t: Target) => `${t.repo}/${t.service}`;

const labelsOf = (targets: Target[]) =>
  [...new Set(targets.map(labelOf))].sort();

export function searchCursorHash(
  q: string,
  env: string,
  workspace: string | null | undefined,
  targets: Target[],
): string {
  return createHash("sha256")
    .update(JSON.stringify([q, env, workspace ?? "", labelsOf(targets)]))
    .digest("base64url")
    .slice(0, 16);
}

export function searchOffsets(
  after: PageAsk["after"],
  hash: string,
  targets: Target[],
): Record<string, number> | null {
  if (!after) return {};
  const key = Array.isArray(after.key) ? after.key : [after.key];
  if (key.length !== 1 || key[0] !== hash) return null;
  const labels = labelsOf(targets);
  const parts = after.id.split(",");
  if (parts.length !== labels.length) return null;
  const out: Record<string, number> = {};
  for (let i = 0; i < labels.length; i++) {
    if (!/^(-1|\d{1,12})$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n !== 0) out[labels[i]] = n;
  }
  return out;
}

function searchCursor(
  hash: string,
  targets: Target[],
  o: Record<string, number>,
): string {
  return encodeCursor(SEARCH_LIST, {
    key: [hash],
    id: labelsOf(targets)
      .map((l) => String(o[l] ?? 0))
      .join(","),
  });
}

const pageKey = (m: SearchPageMatch): [string, string, number] => [
  m.ts ?? "",
  m.system,
  m.n,
];

function before(a: SearchPageMatch, b: SearchPageMatch): boolean {
  const [at, as, an] = pageKey(a);
  const [bt, bs, bn] = pageKey(b);
  if (at !== bt) return at < bt;
  if (as !== bs) return as < bs;
  return an < bn;
}

export async function searchHistoryPage(
  targets: Target[],
  q: string,
  env: string,
  workspace: string | null | undefined,
  opts: { limit: number; offsets: Record<string, number> },
): Promise<SearchPage> {
  const limit = Math.max(1, Math.floor(opts.limit));
  const hash = searchCursorHash(q, env, workspace, targets);
  const offsets = opts.offsets;
  const seen = new Set<string>();
  const live = targets.filter((t) => {
    const l = labelOf(t);
    if (seen.has(l) || offsets[l] === -1) return false;
    seen.add(l);
    return true;
  });
  const found = await Promise.all(
    live.map((t) =>
      searchSystemHistory(t, q, env, workspace, {
        from: (offsets[labelOf(t)] ?? 0) + 1,
        max: limit + 1,
      }),
    ),
  );
  const systems: SearchPageSystem[] = [];
  const queues: { system: string; items: SearchPageMatch[]; at: number }[] = [];
  for (const r of found) {
    if (r.error || r.skipped) {
      systems.push({
        system: r.system,
        ...(r.error ? { error: r.error } : {}),
        ...(r.t ? { t: r.t } : {}),
        ...(r.skipped ? { skipped: true } : {}),
      });
      continue;
    }
    queues.push({
      system: r.system,
      items: r.matches.map((m) => ({ ...m, system: r.system, n: m.n ?? 0 })),
      at: 0,
    });
  }
  const matches: SearchPageMatch[] = [];
  while (matches.length < limit) {
    let pick: (typeof queues)[number] | null = null;
    for (const qu of queues) {
      const m = qu.items[qu.at];
      if (m && (!pick || before(m, pick.items[pick.at]))) pick = qu;
    }
    if (!pick) break;
    matches.push(pick.items[pick.at++]);
  }
  const o: Record<string, number> = { ...offsets };
  let more = false;
  for (const qu of queues) {
    const left = qu.at < qu.items.length;
    if (left) more = true;
    if (!left && qu.items.length <= limit) o[qu.system] = -1;
    else if (qu.at > 0) o[qu.system] = qu.items[qu.at - 1].n;
    systems.push({ system: qu.system, more: o[qu.system] !== -1 });
  }
  for (const l of labelsOf(targets))
    if (offsets[l] === -1) systems.push({ system: l, more: false });
  return {
    q,
    items: matches,
    next: more ? searchCursor(hash, targets, o) : null,
    prev: null,
    forwardOnly: true,
    systems,
  };
}

/** `tail -F -n <lines> <file>` as an argument list (no command line). */
export function tailArgv(file: string, lines: number): [string, string[]] {
  return ["tail", ["-F", "-n", String(lines), file]];
}
