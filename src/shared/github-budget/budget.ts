/**
 * Issue 487: the account's GitHub budget, as Den's server sees it.
 *
 * Agents on one machine share one GitHub account and its hourly budget
 * (5,000 requests). Den reads what is left from GitHub's rate_limit route
 * (which costs nothing) and from every answer's X-RateLimit-* headers, and
 * keeps a reserve (github_budget.reserve): below it, an agent's
 * non-essential call through Den is refused, with the reason and the reset
 * time. The release path (`essential`) and a person's own calls are never
 * refused.
 *
 * Every request that cost the account is logged with who asked
 * (github-spend.jsonl, trimmed to the last day); the snapshot
 * (github-budget.json) carries the budget, the reserve and the last hour's
 * spend per caller, for the PreToolUse hook and `doctor`. No token or
 * secret is ever written.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";

/** What GitHub says is left: requests, of limit, until reset (epoch s). */
export interface RateLimit {
  remaining: number;
  limit: number;
  reset: number;
}

export interface BudgetSnapshot extends RateLimit {
  reserve: number;
  /** When Den last read it (ISO). */
  readAt: string;
  /** The last hour's spend per caller (agent:<id>, person:<user>, den). */
  spend: Record<string, number>;
}

/** Who asks for a GitHub call, and whether it is the release path. */
export interface Caller {
  /** agent:<id>, person:<user>, or den (Den's own work). */
  actor: string;
  /** The release path: never refused. */
  essential?: boolean;
}

export type BudgetCheck =
  | { ok: true }
  | { ok: false; reason: string; reset: number; resetAt: string };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** An agent's call (`agent:<id>`), which the reserve can refuse. */
export const isAgentCaller = (c: Caller) => c.actor.startsWith("agent:");

/** The rate limit in a response's headers, or null. */
export function rateFromHeaders(h: Headers): RateLimit | null {
  const n = (k: string) => {
    const v = h.get(k);
    return v === null ? NaN : Number(v);
  };
  const r = {
    remaining: n("x-ratelimit-remaining"),
    limit: n("x-ratelimit-limit"),
    reset: n("x-ratelimit-reset"),
  };
  return Number.isFinite(r.remaining) &&
    Number.isFinite(r.limit) &&
    Number.isFinite(r.reset)
    ? r
    : null;
}

/** A reset time (epoch s) as local time, e.g. "12:19 PM". */
export function resetClock(reset: number): string {
  return new Date(reset * 1000).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export interface GithubBudgetOpts {
  /** github-budget.json; absent, nothing is written. */
  snapshotFile?: string;
  /** github-spend.jsonl; absent, spend is kept in memory only. */
  spendFile?: string;
  /** The reserve, read on each check (a Setting). */
  reserve: () => number;
  /** GitHub's rate_limit route (free); absent, headers only. */
  readRateLimit?: () => Promise<RateLimit | null>;
  now?: () => number;
}

export class GithubBudget {
  private rate: RateLimit | null = null;
  private readAt = 0;
  private spent: { at: number; actor: string; cost: number }[] = [];
  private readonly now: () => number;

  constructor(private readonly o: GithubBudgetOpts) {
    this.now = o.now ?? Date.now;
    this.loadSpend();
  }

  /** What is left, or null before Den has read it. */
  current(): RateLimit | null {
    return this.rate;
  }

  /** How long ago Den last read it (ms), or Infinity before it has. */
  age(): number {
    return this.rate ? this.now() - this.readAt : Infinity;
  }

  /** Take what GitHub said (a response's headers, or rate_limit). */
  observe(rate: RateLimit | null): void {
    if (!rate) return;
    this.rate = rate;
    this.readAt = this.now();
    this.writeSnapshot();
  }

  /** Read rate_limit (free). Errors leave the last reading. */
  async refresh(): Promise<RateLimit | null> {
    try {
      const r = await this.o.readRateLimit?.();
      if (r) this.observe(r);
    } catch {
      /* keep what we had */
    }
    return this.rate;
  }

  /**
   * Whether this caller's call may go now. A person's and the release
   * path's always may; an agent's not while the budget is below the
   * reserve (until the reset).
   */
  check(c: Caller): BudgetCheck {
    if (c.essential || !isAgentCaller(c)) return { ok: true };
    const r = this.rate;
    if (!r) return { ok: true };
    if (r.reset * 1000 <= this.now()) return { ok: true };
    const reserve = this.o.reserve();
    if (r.remaining >= reserve) return { ok: true };
    const resetAt = resetClock(r.reset);
    return {
      ok: false,
      reset: r.reset,
      resetAt,
      reason: `the shared GitHub budget is at ${r.remaining} of ${r.limit} requests, below the reserve of ${reserve} kept for releases and people; agents' calls through Den wait until it resets at ${resetAt}`,
    };
  }

  /** Record a request that cost the account, split among who asked. */
  spend(actors: readonly string[], cost = 1): void {
    if (!actors.length || cost <= 0) return;
    const at = this.now();
    const each = cost / actors.length;
    for (const actor of actors) {
      this.spent.push({ at, actor, cost: each });
      if (this.o.spendFile)
        try {
          fs.mkdirSync(path.dirname(this.o.spendFile), { recursive: true });
          fs.appendFileSync(
            this.o.spendFile,
            JSON.stringify({
              at: new Date(at).toISOString(),
              actor,
              cost: each,
            }) + "\n",
          );
        } catch {
          /* the log is best effort */
        }
    }
    this.trim();
    this.writeSnapshot();
  }

  /** Spend per caller since `sinceMs` ago (default the last hour), most first. */
  spendBy(sinceMs = HOUR_MS): { actor: string; requests: number }[] {
    const from = this.now() - sinceMs;
    const by = new Map<string, number>();
    for (const s of this.spent)
      if (s.at >= from) by.set(s.actor, (by.get(s.actor) ?? 0) + s.cost);
    return [...by]
      .map(([actor, n]) => ({ actor, requests: Math.round(n * 100) / 100 }))
      .sort((a, b) => b.requests - a.requests);
  }

  snapshot(): BudgetSnapshot | null {
    if (!this.rate) return null;
    return {
      ...this.rate,
      reserve: this.o.reserve(),
      readAt: new Date(this.readAt).toISOString(),
      spend: Object.fromEntries(
        this.spendBy().map((s) => [s.actor, s.requests]),
      ),
    };
  }

  private writeSnapshot(): void {
    const s = this.snapshot();
    if (!s || !this.o.snapshotFile) return;
    try {
      fs.mkdirSync(path.dirname(this.o.snapshotFile), { recursive: true });
      writeFileAtomic(this.o.snapshotFile, JSON.stringify(s, null, 2) + "\n");
    } catch {
      /* best effort: the hook and doctor then say nothing */
    }
  }

  /** Keep a day in memory; the file is cut back to a day when it grows. */
  private trim(): void {
    const from = this.now() - DAY_MS;
    if (this.spent.length && this.spent[0].at < from)
      this.spent = this.spent.filter((s) => s.at >= from);
    const f = this.o.spendFile;
    if (!f) return;
    try {
      if (fs.statSync(f).size < 4 * 1024 * 1024) return;
      writeFileAtomic(
        f,
        this.spent
          .map((s) =>
            JSON.stringify({
              at: new Date(s.at).toISOString(),
              actor: s.actor,
              cost: s.cost,
            }),
          )
          .join("\n") + "\n",
      );
    } catch {
      /* best effort */
    }
  }

  private loadSpend(): void {
    const f = this.o.spendFile;
    if (!f) return;
    const from = this.now() - DAY_MS;
    try {
      for (const line of fs.readFileSync(f, "utf-8").split("\n")) {
        if (!line) continue;
        try {
          const v = JSON.parse(line) as {
            at?: string;
            actor?: string;
            cost?: number;
          };
          const at = Date.parse(v.at ?? "");
          if (
            Number.isFinite(at) &&
            at >= from &&
            typeof v.actor === "string" &&
            typeof v.cost === "number"
          )
            this.spent.push({ at, actor: v.actor, cost: v.cost });
        } catch {
          /* a torn line */
        }
      }
    } catch {
      /* none yet */
    }
  }
}
