/**
 * One shared GitHub-status watcher for the whole install, in the web server.
 *
 * Agents used to run `gh pr checks N --watch` or `gh run watch M` each, on
 * one shared GitHub account, and together spent its 5000 calls an hour.
 * Instead an agent asks Den (MCP github_watch) to watch a pull request's
 * checks or a workflow run, and Den tells it once, in its session, when
 * they finish.
 *
 * The loop (tick):
 *  - groups the watches by repo, and asks GitHub at most once per repo per
 *    tick: one head watched in the repo, that head's check runs; several,
 *    the repo's recent workflow runs (one list for every head), then the
 *    check runs of a head whose runs all finished, one head a tick;
 *  - waits github.watch_interval_seconds, doubled while nothing changes,
 *    up to github.watch_max_interval_seconds; back to the start on a change
 *    or a new watch;
 *  - reads X-RateLimit-Remaining and X-RateLimit-Reset on every answer:
 *    under github.api_budget_floor it asks nothing until the reset, says so
 *    in each watch's note, and refuses new watches;
 *  - honours Retry-After, and a 403 or 429 secondary limit (a minute at
 *    least, and the interval doubles).
 *
 * A finished watch is told to its agent once (the relayed-message path,
 * hub-delivery-service relayMessage: typed at its prompt, held while it
 * works), with the counts of passed, failed and skipped checks and each
 * failure's name and URL. A pull request is watched at the head it had when
 * asked: a new push needs a new watch.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { embedDelivery, type Delivery } from "../hub-delivery.js";
import type { GithubWatchSettings } from "./settings.js";
import type { GhGet, GhResponse } from "./gh-http.js";
import { WATCH_REPOS_SETTING } from "./watch-repos.js";
import { writeFileAtomic } from "../atomic-write.js";

export interface GithubWatchDeps {
  /** GitHub's REST API (gh api -i); tests pass a fake. */
  get: GhGet;
  /** user.yml github.*, read each time (Settings change it live). */
  settings: () => GithubWatchSettings;
  /** Hold a line for the agent, typed at its prompt; false when not ready. */
  relay: (dv: Delivery) => Promise<boolean>;
  now?: () => number;
  /** Where the watches are kept across a restart. */
  file?: string;
  /** Where doctor reads the status line from. */
  statusFile?: string;
  log?: (line: string) => void;
}

export interface WatchAsk {
  agent: string;
  project: string;
  repo: string;
  pr?: number;
  run?: number;
  /** The repos (owner/name) of the agent's projects: its scope. */
  allowedRepos: readonly string[];
}

export interface CheckCounts {
  pass: number;
  fail: number;
  skip: number;
  pending: number;
}

export interface WatchView {
  id: string;
  repo: string;
  pr?: number;
  run?: number;
  head: string | null;
  /** waiting (no checks yet), running, paused (Den's budget) or done. */
  state: "waiting" | "running" | "paused" | "done";
  note: string;
  checks?: CheckCounts;
  failed?: { name: string; url: string }[];
  /** Done and told to the agent. */
  delivered: boolean;
  createdAt: string;
}

export type CreateResult =
  | { ok: true; watch: WatchView; intervalSeconds: number }
  | {
      ok: false;
      code: "bad_request" | "scope" | "too_many" | "budget_low" | "not_found";
      error: string;
      watch?: undefined;
    };

export interface WatchStatus {
  at: string;
  remaining: number | null;
  limit: number | null;
  resetAt: string | null;
  active: number;
  intervalSeconds: number;
  pausedUntil: string | null;
  pausedWhy: PauseWhy | null;
}

type PauseWhy = "budget" | "retry" | "secondary";
type Phase = "waiting" | "running" | "ready" | "done";

interface Watch {
  id: string;
  agent: string;
  project: string;
  repo: string;
  kind: "pr" | "run";
  number: number;
  head?: string;
  /** A run's check suite: its jobs among the head's check runs. */
  suite?: number;
  createdAt: number;
  phase: Phase;
  note: string;
  print: string;
  checks?: CheckCounts;
  failed?: { name: string; url: string }[];
  /** When its head's check runs were last asked for (several heads). */
  checkedAt?: number;
  doneAt?: number;
  text?: string;
  delivered?: boolean;
}

interface Call {
  path: string;
  kind: "resolve" | "list" | "checks";
  watch?: Watch;
  head?: string;
}

/** owner/name; never a `.` or `..` segment (github-service.ts SLUG_RE). */
const REPO_RE = /^(?!\.{1,2}\/)[A-Za-z0-9._-]+\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
/** A head with no check at all this long after the ask is done: none ran. */
const NO_CHECKS_MS = 30 * 60_000;
/** A secondary limit with no Retry-After: GitHub says wait a minute. */
const SECONDARY_WAIT_MS = 60_000;
/** A told watch stays listed this long. */
const DONE_KEEP_MS = 60 * 60_000;
/** The run list reaches back this far before the oldest watch. */
const RUNS_LOOKBACK_MS = 24 * 3600_000;

const PASS = new Set(["success"]);
const SKIP = new Set(["skipped", "neutral"]);

const iso = (ms: number) => new Date(ms).toISOString();
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const asNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const asStr = (v: unknown): string =>
  typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);

export class GithubWatcher {
  private watches: Watch[] = [];
  private interval: number;
  private next = 0;
  private remaining: number | null = null;
  private limit: number | null = null;
  private resetAt: number | null = null;
  private pause: { until: number; why: PauseWhy } | null = null;
  /** Per repo: the last call was a head's check runs (several heads). */
  private lastChecks = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly d: GithubWatchDeps) {
    this.now = d.now ?? Date.now;
    this.interval = d.settings().intervalSeconds;
    this.load();
  }

  get intervalSeconds(): number {
    return this.interval;
  }

  /** When the next look is due (ms). */
  get nextAt(): number {
    return this.next;
  }

  // ── Asks ────────────────────────────────────────────────────────────────

  async create(a: WatchAsk): Promise<CreateResult> {
    const s = this.d.settings();
    const now = this.now();
    const bad = (error: string): CreateResult => ({
      ok: false,
      code: "bad_request",
      error,
    });
    const isNum = (v: unknown) =>
      typeof v === "number" && Number.isSafeInteger(v) && v > 0;
    if (typeof a.repo !== "string" || !REPO_RE.test(a.repo))
      return bad("repo: a GitHub repo, owner/name");
    if (isNum(a.pr) === isNum(a.run))
      return bad(
        "give pr (a pull request's number) or run (a workflow run's id), one of them",
      );
    const allowed = a.allowedRepos.find(
      (r) => r.toLowerCase() === a.repo.toLowerCase(),
    );
    if (!allowed)
      return {
        ok: false,
        code: "scope",
        // Issue 1270: name the setting, and that it grants no new access.
        error: `${a.repo} isn't a repo of your project or on its ${WATCH_REPOS_SETTING} list; you watch those only (${a.allowedRepos.join(", ") || "none"}). A person can add a repo to ${WATCH_REPOS_SETTING}, read-only: it grants no new access, and only lets the watcher read what Den's GitHub sign-in can already read.`,
      };
    const kind: Watch["kind"] = isNum(a.pr) ? "pr" : "run";
    const number = (kind === "pr" ? a.pr : a.run) as number;
    const same = this.watches.find(
      (w) =>
        w.agent === a.agent &&
        w.repo.toLowerCase() === allowed.toLowerCase() &&
        w.kind === kind &&
        w.number === number &&
        w.phase !== "done",
    );
    if (same)
      return {
        ok: true,
        watch: this.view(same),
        intervalSeconds: this.interval,
      };
    const active = this.watches.filter((w) => w.phase !== "done").length;
    if (active >= s.watchesMax)
      return {
        ok: false,
        code: "too_many",
        error: `Den watches at most ${s.watchesMax} at once (github.watches_max), and ${active} are open. Cancel one you no longer need with github_watch_cancel, or wait for one to finish.`,
      };
    const low = this.budgetLow(now, s);
    if (low)
      return {
        ok: false,
        code: "budget_low",
        error: `GitHub's API budget is low: ${this.remaining} calls left this hour, under Den's floor of ${s.budgetFloor} (github.api_budget_floor). Den watches nothing new until GitHub's reset at ${iso(low)}. Ask again after it; don't poll GitHub yourself meanwhile.`,
      };
    const w: Watch = {
      id: `gw-${crypto.randomBytes(4).toString("hex")}`,
      agent: a.agent,
      project: a.project,
      repo: allowed,
      kind,
      number,
      createdAt: now,
      phase: "waiting",
      note: "Den looks at it on its next round.",
      print: "",
    };
    // The first look, now: the head (and a run's state), so the answer
    // says where it stands. Not while GitHub asked Den to wait.
    if (!this.paused(now)) {
      const r = await this.d.get(this.resolvePath(w));
      const limited = this.noteRate(r, now);
      if (!limited) {
        if (r.status === 404)
          return {
            ok: false,
            code: "not_found",
            error: `GitHub has no ${kind === "pr" ? `pull request ${number}` : `workflow run ${number}`} in ${allowed}, or Den's GitHub sign-in can't see it.`,
          };
        if (r.status === 200) this.applyResolve(w, r.body);
        else
          w.note = `GitHub didn't answer (${this.why(r)}); Den tries again on its next round.`;
      }
    }
    this.watches.push(w);
    // A new watch is a change: the pace starts again.
    this.interval = s.intervalSeconds;
    this.next = Math.min(this.next, now + this.interval * 1000);
    this.save();
    this.writeStatus(now);
    return { ok: true, watch: this.view(w), intervalSeconds: this.interval };
  }

  list(agent: string): WatchView[] {
    this.prune(this.now());
    return this.watches
      .filter((w) => w.agent === agent)
      .map((w) => this.view(w));
  }

  cancel(
    agent: string,
    id: string,
  ): { ok: true; id: string } | { ok: false; error: string } {
    const i = this.watches.findIndex((w) => w.id === id && w.agent === agent);
    if (i < 0)
      return {
        ok: false,
        error: `no watch ${id} of yours; github_watch_list lists them.`,
      };
    this.watches.splice(i, 1);
    this.save();
    this.writeStatus(this.now());
    return { ok: true, id };
  }

  status(): WatchStatus {
    const now = this.now();
    const p = this.paused(now);
    return {
      at: iso(now),
      remaining: this.remaining,
      limit: this.limit,
      resetAt: this.resetAt === null ? null : iso(this.resetAt),
      active: this.watches.filter((w) => w.phase !== "done").length,
      intervalSeconds: this.interval,
      pausedUntil: p ? iso(p.until) : null,
      pausedWhy: p ? p.why : null,
    };
  }

  // ── The loop ────────────────────────────────────────────────────────────

  /** One round: at most one GitHub call per repo, when it is due. */
  async tick(): Promise<void> {
    const now = this.now();
    this.prune(now);
    // Nothing to watch: no GitHub call and no file write (an idle install
    // never touches its state files).
    if (!this.watches.some((w) => w.phase !== "done")) return;
    if (this.paused(now)) return this.writeStatus(now);
    this.pause = null;
    if (now < this.next) return;
    const s = this.d.settings();
    const groups = new Map<string, Watch[]>();
    for (const w of this.watches) {
      if (w.phase === "done") continue;
      const k = w.repo.toLowerCase();
      groups.set(k, [...(groups.get(k) ?? []), w]);
    }
    let changed = false;
    let limited = false;
    for (const [key, ws] of groups) {
      const call = this.plan(key, ws, now);
      let r: GhResponse;
      try {
        r = await this.d.get(call.path);
      } catch (e) {
        r = { status: 0, headers: {}, body: null, error: String(e) };
      }
      if (this.noteRate(r, now)) {
        limited = true;
        break;
      }
      if (r.status !== 200 && !(call.kind === "resolve" && r.status === 404)) {
        for (const w of ws)
          w.note = `GitHub didn't answer (${this.why(r)}); Den tries again on its next round.`;
        continue;
      }
      if (this.apply(call, ws, r, now)) changed = true;
      if (this.paused(now)) break; // under the floor: nothing more this hour
    }
    const lo = s.intervalSeconds;
    const hi = Math.max(lo, s.maxIntervalSeconds);
    this.interval = changed
      ? lo
      : Math.min(hi, Math.max(lo, this.interval * 2));
    this.next = now + this.interval * 1000;
    const p = this.paused(now);
    if (p) this.next = Math.max(this.next, p.until);
    if (limited) this.d.log?.(`github watch: paused until ${iso(this.next)}`);
    this.save();
    this.writeStatus(now);
  }

  /** Tell each finished watch's agent, once. */
  async deliver(): Promise<void> {
    let told = false;
    for (const w of this.watches) {
      if (w.phase !== "done" || w.delivered || !w.text) continue;
      let ok = false;
      try {
        ok = await this.d.relay(
          embedDelivery({
            id: `github-watch-${w.id}`,
            agent: w.agent,
            project: w.project,
            origin: "Den GitHub watch",
            text: w.text,
            at: w.doneAt ?? this.now(),
          }),
        );
      } catch {
        ok = false;
      }
      if (ok) {
        w.delivered = true;
        told = true;
      }
    }
    if (told) this.save();
  }

  // ── What to ask ─────────────────────────────────────────────────────────

  private resolvePath(w: Watch): string {
    return w.kind === "pr"
      ? `repos/${w.repo}/pulls/${w.number}`
      : `repos/${w.repo}/actions/runs/${w.number}`;
  }

  private checksPath(repo: string, head: string): string {
    return `repos/${repo}/commits/${head}/check-runs?per_page=100&filter=latest`;
  }

  /** The one call for a repo this round. */
  private plan(key: string, ws: Watch[], now: number): Call {
    const unresolved = ws.find((w) => !w.head);
    if (unresolved)
      return {
        path: this.resolvePath(unresolved),
        kind: "resolve",
        watch: unresolved,
      };
    const repo = ws[0].repo;
    const heads = [...new Set(ws.map((w) => w.head!))];
    if (heads.length === 1) {
      this.lastChecks.delete(key);
      return {
        path: this.checksPath(repo, heads[0]),
        kind: "checks",
        head: heads[0],
      };
    }
    // A head waiting with no run this long: its check runs settle it.
    for (const w of ws)
      if (w.phase === "waiting" && now - w.createdAt >= NO_CHECKS_MS)
        w.phase = "ready";
    const ready = ws
      .filter((w) => w.phase === "ready")
      .sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0));
    const allReady = ready.length === ws.length;
    if (ready.length && (allReady || !this.lastChecks.has(key))) {
      this.lastChecks.add(key);
      const head = ready[0].head!;
      for (const w of ws) if (w.head === head) w.checkedAt = now;
      return { path: this.checksPath(repo, head), kind: "checks", head };
    }
    this.lastChecks.delete(key);
    const since = Math.min(...ws.map((w) => w.createdAt)) - RUNS_LOOKBACK_MS;
    return {
      path: `repos/${repo}/actions/runs?per_page=100&created=${encodeURIComponent(`>=${iso(since).slice(0, 19)}Z`)}`,
      kind: "list",
    };
  }

  // ── What GitHub said ────────────────────────────────────────────────────

  /** Applies an answer; true when something changed. */
  private apply(call: Call, ws: Watch[], r: GhResponse, now: number): boolean {
    if (call.kind === "resolve") {
      const w = call.watch!;
      if (r.status === 404) {
        this.finish(w, now, {
          note: `GitHub has no ${this.what(w)} (or Den's sign-in can't see it).`,
          text: `Den: GitHub watch ${w.id} ended: GitHub has no ${this.what(w)}, or Den's GitHub sign-in can't see it.`,
        });
        return true;
      }
      const before = w.head;
      this.applyResolve(w, r.body);
      return w.head !== before;
    }
    if (call.kind === "list") return this.applyRuns(ws, r.body);
    return this.applyChecks(
      ws.filter((w) => w.head === call.head),
      r.body,
      now,
    );
  }

  private applyResolve(w: Watch, body: unknown): void {
    if (!isObj(body)) return;
    if (w.kind === "pr") {
      const sha = isObj(body.head) ? asStr(body.head.sha) : "";
      if (/^[0-9a-f]{7,64}$/i.test(sha)) w.head = sha;
      w.note = w.head
        ? `Watching the checks on head ${w.head.slice(0, 7)}.`
        : w.note;
      return;
    }
    const sha = asStr(body.head_sha);
    if (/^[0-9a-f]{7,64}$/i.test(sha)) w.head = sha;
    w.suite = asNum(body.check_suite_id) ?? w.suite;
    const st = asStr(body.status);
    w.phase = st === "completed" ? "ready" : "running";
    w.note = `The run is ${st || "known"}.`;
  }

  private applyRuns(ws: Watch[], body: unknown): boolean {
    const runs = (
      isObj(body) && Array.isArray(body.workflow_runs) ? body.workflow_runs : []
    ).filter(isObj);
    let changed = false;
    for (const w of ws) {
      const mine =
        w.kind === "run"
          ? runs.filter((r) => r.id === w.number)
          : runs.filter((r) => r.head_sha === w.head);
      if (!mine.length) continue;
      if (w.kind === "run") w.suite = asNum(mine[0].check_suite_id) ?? w.suite;
      const print = JSON.stringify(
        mine
          .map((r) => [asNum(r.id), asStr(r.status), asStr(r.conclusion)])
          .sort(),
      );
      if (print !== w.print) changed = true;
      w.print = print;
      const open = mine.filter((r) => r.status !== "completed").length;
      w.phase = open ? "running" : "ready";
      w.note = open
        ? `${open} of ${mine.length} workflow runs still going.`
        : "Its workflow runs finished; Den reads the checks next.";
    }
    return changed;
  }

  private applyChecks(ws: Watch[], body: unknown, now: number): boolean {
    const all = (
      isObj(body) && Array.isArray(body.check_runs) ? body.check_runs : []
    ).filter(isObj);
    let changed = false;
    for (const w of ws) {
      const cs =
        w.kind === "run" && w.suite !== undefined
          ? all.filter(
              (c) => isObj(c.check_suite) && c.check_suite.id === w.suite,
            )
          : all;
      const print = JSON.stringify(
        cs
          .map((c) => [asNum(c.id), asStr(c.status), asStr(c.conclusion)])
          .sort(),
      );
      if (print !== w.print) changed = true;
      w.print = print;
      if (!cs.length) {
        if (now - w.createdAt >= NO_CHECKS_MS) {
          this.finish(w, now, {
            note: "No checks ran.",
            text: `Den: GitHub watch ${w.id} finished: ${this.what(w)} (head ${w.head!.slice(0, 7)}) has no checks: none started within ${NO_CHECKS_MS / 60_000} minutes.`,
          });
          changed = true;
        } else {
          w.phase = "waiting";
          w.note = `No checks on head ${w.head!.slice(0, 7)} yet.`;
        }
        continue;
      }
      const counts: CheckCounts = { pass: 0, fail: 0, skip: 0, pending: 0 };
      const failed: { name: string; url: string }[] = [];
      for (const c of cs) {
        const concl = asStr(c.conclusion);
        if (c.status !== "completed") counts.pending++;
        else if (PASS.has(concl)) counts.pass++;
        else if (SKIP.has(concl) || !concl) counts.skip++;
        else {
          counts.fail++;
          failed.push({
            name: asStr(c.name) || `check ${asNum(c.id) ?? "?"}`,
            url: asStr(c.html_url) || asStr(c.details_url),
          });
        }
      }
      w.checks = counts;
      w.failed = failed;
      if (counts.pending) {
        w.phase = "running";
        w.note = `${counts.pending} of ${cs.length} checks still going.`;
        continue;
      }
      const sum = `${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`;
      this.finish(w, now, {
        note: `Finished: ${sum}.`,
        text:
          `Den: GitHub watch ${w.id} finished: ${this.what(w)} (head ${w.head!.slice(0, 7)}): ${sum}.` +
          (failed.length
            ? ` Failed: ${failed.map((f) => `${f.name} (${f.url})`).join("; ")}.`
            : " All passed."),
      });
      changed = true;
    }
    return changed;
  }

  private finish(
    w: Watch,
    now: number,
    o: { note: string; text: string },
  ): void {
    w.phase = "done";
    w.doneAt = now;
    w.note = o.note;
    w.text = o.text.replace(/[\r\n]+/g, " ");
  }

  // ── The budget ──────────────────────────────────────────────────────────

  /**
   * Reads the rate-limit headers; true when this answer is a limit (a 403
   * or 429 with Retry-After, the hour's calls spent, or a secondary limit).
   * Under the floor, pauses until the reset (the answer itself still counts).
   */
  private noteRate(r: GhResponse, now: number): boolean {
    const h = r.headers ?? {};
    const rem = Number(h["x-ratelimit-remaining"]);
    const lim = Number(h["x-ratelimit-limit"]);
    const reset = Number(h["x-ratelimit-reset"]);
    if (h["x-ratelimit-remaining"] !== undefined && Number.isFinite(rem))
      this.remaining = rem;
    if (h["x-ratelimit-limit"] !== undefined && Number.isFinite(lim))
      this.limit = lim;
    if (h["x-ratelimit-reset"] !== undefined && Number.isFinite(reset))
      this.resetAt = reset * 1000;
    if (r.status === 403 || r.status === 429) {
      const ra = Number(h["retry-after"]);
      if (h["retry-after"] !== undefined && Number.isFinite(ra) && ra >= 0) {
        this.pauseUntil(now + ra * 1000, "retry");
        return true;
      }
      if (this.remaining === 0 && this.resetAt !== null && this.resetAt > now) {
        this.pauseUntil(this.resetAt, "budget");
        return true;
      }
      const msg = isObj(r.body) ? asStr(r.body.message) : "";
      if (r.status === 429 || /rate limit/i.test(msg)) {
        this.pauseUntil(now + SECONDARY_WAIT_MS, "secondary");
        return true;
      }
    }
    const low = this.budgetLow(now, this.d.settings());
    if (low) this.pauseUntil(low, "budget");
    return false;
  }

  /** The reset time when the budget is under the floor, else null. */
  private budgetLow(now: number, s: GithubWatchSettings): number | null {
    if (this.remaining === null || this.resetAt === null) return null;
    if (this.resetAt <= now) return null;
    return this.remaining < s.budgetFloor ? this.resetAt : null;
  }

  private pauseUntil(until: number, why: PauseWhy): void {
    if (!this.pause || this.pause.until < until) this.pause = { until, why };
  }

  private paused(now: number): { until: number; why: PauseWhy } | null {
    return this.pause && this.pause.until > now ? this.pause : null;
  }

  // ── Views and files ─────────────────────────────────────────────────────

  private what(w: Watch): string {
    return w.kind === "pr"
      ? `${w.repo} pull request ${w.number}`
      : `${w.repo} run ${w.number}`;
  }

  private why(r: GhResponse): string {
    if (r.status === 0) return r.error || "no answer";
    const msg = isObj(r.body) ? asStr(r.body.message) : "";
    return `HTTP ${r.status}${msg ? `: ${msg.slice(0, 120)}` : ""}`;
  }

  private pauseNote(p: { until: number; why: PauseWhy }): string {
    const s = this.d.settings();
    if (p.why === "budget")
      return `Paused: GitHub's API budget is low (${this.remaining} calls left, Den's floor is ${s.budgetFloor}). Den looks again after GitHub's reset at ${iso(p.until)}.`;
    if (p.why === "retry")
      return `Paused: GitHub asked Den to wait (Retry-After). Den looks again at ${iso(p.until)}.`;
    return `Paused: GitHub's secondary rate limit. Den looks again at ${iso(p.until)}.`;
  }

  private view(w: Watch): WatchView {
    const p = w.phase === "done" ? null : this.paused(this.now());
    return {
      id: w.id,
      repo: w.repo,
      ...(w.kind === "pr" ? { pr: w.number } : { run: w.number }),
      head: w.head ?? null,
      state: p ? "paused" : w.phase === "ready" ? "running" : w.phase,
      note: p ? this.pauseNote(p) : w.note,
      ...(w.checks ? { checks: { ...w.checks } } : {}),
      ...(w.failed && w.failed.length ? { failed: [...w.failed] } : {}),
      delivered: !!w.delivered,
      createdAt: iso(w.createdAt),
    };
  }

  private prune(now: number): void {
    const before = this.watches.length;
    this.watches = this.watches.filter(
      (w) => !(w.delivered && (w.doneAt ?? 0) + DONE_KEEP_MS < now),
    );
    if (this.watches.length !== before) this.save();
  }

  private load(): void {
    if (!this.d.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.d.file, "utf-8")) as {
        watches?: unknown;
      };
      if (Array.isArray(j.watches))
        this.watches = j.watches.filter(
          (w): w is Watch =>
            isObj(w) &&
            typeof w.id === "string" &&
            typeof w.agent === "string" &&
            typeof w.repo === "string" &&
            REPO_RE.test(w.repo) &&
            (w.kind === "pr" || w.kind === "run") &&
            typeof w.number === "number",
        );
    } catch {
      /* none kept yet */
    }
  }

  private save(): void {
    if (!this.d.file) return;
    writeJson(this.d.file, { watches: this.watches });
  }

  private writeStatus(now: number): void {
    if (!this.d.statusFile) return;
    void now;
    writeJson(this.d.statusFile, this.status());
  }
}

function writeJson(file: string, v: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
  } catch {
    /* a status that can't be written is only doctor's loss */
  }
}
