/**
 * Issue 415: who can see a report. Each Report destination is public,
 * private or internal on GitHub; the Report form says so (the kit's pill
 * and the line above Send).
 *
 * Read through the GitHub access Report already files with, the person's
 * `gh`: `gh api repos/<owner>/<name>` → `visibility` (else `private`). No
 * new scope: reading a repo you can file in needs none. When `gh` can't say
 * (no sign-in, a failure, no answer), GitHub's tokenless answer is the
 * fallback: only a 200 with `private: false` is public. A tokenless 404 is
 * private, gone or renamed, so it stays unknown, as does any other status,
 * a rate limit or a timeout (feedback.visibility_timeout_seconds).
 * Unknown is said as unknown, never as public: the form then shows "not
 * known" with the caution kept.
 *
 * A real answer is kept per repo, in memory and in
 * <state>/report-visibility.json, for feedback.visibility_cache_hours
 * (24). An unknown answer or a failure is held only feedback.visibility_retry_seconds (60, so repeated opens
 * don't storm GitHub; 0: asked again on every open), then asked again: one blip never labels a private repo public
 * for the hours kept. A lookup never holds GET /api/report past
 * feedback.visibility_timeout_seconds (3): one still running keeps going
 * and fills the cache for the next open. One lookup per repo at a time.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import type { GhResult } from "./report-routes.js";

export type RepoVisibility = "public" | "private" | "internal";

interface Entry {
  v: RepoVisibility | null;
  at: number;
  /** "anon": learned with no sign-in (a sign-in asks again at once). */
  by?: "anon";
}

/** GitHub's tokenless answer for a repo: "public", or null (not known). */
export type PublicLookup = (
  repo: string,
  timeoutMs: number,
) => Promise<"public" | null>;

/**
 * GitHub's REST API without a token (60 calls an hour per address, so it
 * is only the fallback, and its answer is kept like any other): a 200 with
 * `private: false` is public; anything else, null.
 */
export function publicRepoVisibility(
  apiBase: string,
  fetchFn: typeof fetch = fetch,
): PublicLookup {
  return async (repo, timeoutMs) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
    try {
      const r = await fetchFn(`${apiBase}/repos/${repo}`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      });
      if (r.status !== 200) return null;
      const j = (await r.json()) as { private?: unknown };
      return j && j.private === false ? "public" : null;
    } catch {
      return null;
    }
  };
}

const FILE = "report-visibility.json";

/** GitHub's answer for a repo → its visibility, or null when it doesn't say. */
export function visibilityOf(stdout: string): RepoVisibility | null {
  let j: unknown;
  try {
    j = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as { visibility?: unknown; private?: unknown };
  if (
    o.visibility === "public" ||
    o.visibility === "private" ||
    o.visibility === "internal"
  )
    return o.visibility;
  if (o.private === true) return "private";
  if (o.private === false) return "public";
  return null;
}

/** One state directory's cache: memory, backed by its file. */
class Cache {
  private mem = new Map<string, Entry>();
  private running = new Map<string, Promise<Entry>>();
  constructor(private dir: string) {
    try {
      const j = JSON.parse(
        fs.readFileSync(path.join(dir, FILE), "utf-8"),
      ) as Record<string, Entry>;
      for (const [repo, e] of Object.entries(j ?? {}))
        if (e && typeof e.at === "number")
          this.mem.set(repo, {
            v:
              e.v === "public" || e.v === "private" || e.v === "internal"
                ? e.v
                : null,
            at: e.at,
            ...(e.by === "anon" ? { by: "anon" as const } : {}),
          });
    } catch {
      // No file yet, or an unreadable one: every repo is looked up.
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      writeFileAtomic(
        path.join(this.dir, FILE),
        JSON.stringify(Object.fromEntries(this.mem)),
      );
    } catch {
      // Memory still has it; the file is only for the next start.
    }
  }

  private lookup(
    repo: string,
    gh: ((args: string[]) => Promise<GhResult>) | null,
    anon: PublicLookup | undefined,
    timeoutMs: number,
    now: () => number,
  ): Promise<Entry> {
    const r = this.running.get(repo);
    if (r) return r;
    const p = (async () => {
      let v: RepoVisibility | null = null;
      // The person's sign-in first; GitHub's tokenless answer after.
      if (gh)
        try {
          const res = await gh(["api", `repos/${repo}`]);
          if (res.code === 0) v = visibilityOf(res.stdout);
        } catch {
          v = null;
        }
      if (v === null && anon) v = await anon(repo, timeoutMs).catch(() => null);
      const e: Entry = gh ? { v, at: now() } : { v, at: now(), by: "anon" };
      this.mem.set(repo, e);
      this.running.delete(repo);
      this.save();
      return e;
    })();
    this.running.set(repo, p);
    return p;
  }

  async of(
    repos: string[],
    o: {
      gh: ((args: string[]) => Promise<GhResult>) | null;
      anon?: PublicLookup;
      ttlMs: number;
      timeoutMs: number;
      retryMs: number;
      now: () => number;
    },
  ): Promise<Record<string, RepoVisibility | null>> {
    const out: Record<string, RepoVisibility | null> = {};
    await Promise.all(
      repos.map(async (repo) => {
        const e = this.mem.get(repo);
        // Not known with no sign-in, and now signed in: ask again at once.
        const stale = !!(e && !e.v && e.by === "anon" && o.gh);
        const keep = e?.v ? o.ttlMs : Math.min(o.ttlMs, o.retryMs);
        if (e && !stale && o.now() - e.at < keep) {
          out[repo] = e.v;
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        const late = new Promise<null>((ok) => {
          timer = setTimeout(() => ok(null), o.timeoutMs);
          timer.unref?.();
        });
        const got = await Promise.race([
          this.lookup(repo, o.gh, o.anon, o.timeoutMs, o.now),
          late,
        ]);
        clearTimeout(timer);
        // Past the wait: what was kept before (even stale), else unknown.
        out[repo] = got ? got.v : (e?.v ?? null);
      }),
    );
    return out;
  }
}

const CACHES = new Map<string, Cache>();

/**
 * Each repo's visibility (null: unknown), from the cache when it is
 * younger than `ttlMs`, else looked up, waiting at most `timeoutMs`.
 * `gh` null: no sign-in, so only `anon` (GitHub's tokenless answer) asks.
 */
export function repoVisibilities(
  stateDir: string,
  repos: string[],
  o: {
    gh: ((args: string[]) => Promise<GhResult>) | null;
    /** GitHub's tokenless answer, the fallback (none: not asked). */
    anon?: PublicLookup;
    ttlMs: number;
    timeoutMs: number;
    /** How long an unknown answer or a failure is held. */
    retryMs: number;
    now?: () => number;
  },
): Promise<Record<string, RepoVisibility | null>> {
  let c = CACHES.get(stateDir);
  if (!c) CACHES.set(stateDir, (c = new Cache(stateDir)));
  return c.of(repos, { ...o, now: o.now ?? Date.now });
}
