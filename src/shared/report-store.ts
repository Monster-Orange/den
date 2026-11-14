/**
 * FB (den#81): where a report goes, how many a person may send, and the
 * drafts ("Finish later", and agents' drafts) on this computer.
 *
 *   - Destination: owner/repo from the engine's package `bugs.url` (never
 *     hard-coded), plus the distribution's own `feedback.repo` when it
 *     names one: then the form offers both.
 *   - `feedback.enabled: false` (the distribution's config or user.yml)
 *     hides every entry point.
 *   - `feedback.max_per_hour` (5): reports one person sends in an hour.
 *     The times are kept on disk, so a restart doesn't reset them.
 *   - Drafts: one JSON file each under <state>/reports/drafts. An agent's
 *     draft stays a draft until a person sends it.
 *
 * Nothing here talks to GitHub (report-routes.ts does, through `gh`).
 */
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { parse as parseYaml } from "yaml";

export interface FeedbackSettings {
  enabled: boolean;
  maxPerHour: number;
  /** owner/repo of every destination, the engine's first. */
  repos: string[];
  /** How long the page's screenshot may take before it is skipped (s). */
  captureSeconds: number;
  /** How many of the person's reports My reports shows. */
  myReportsMax: number;
}

/** owner/repo from a GitHub URL (https://github.com/o/r/issues), else null. */
export function repoOfUrl(u: unknown): string | null {
  if (typeof u !== "string") return null;
  const m =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/.exec(
      u.trim(),
    );
  return m ? `${m[1]}/${m[2]}` : null;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * The feedback settings. `pkg` is the engine's package.json, `dist` the
 * distribution's `feedback:` block, `user` user.yml's.
 */
export function feedbackSettings(
  pkg: { bugs?: unknown } | null,
  dist: unknown,
  user: unknown,
): FeedbackSettings {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const d = obj(dist);
  const u = obj(user);
  const bugs = typeof pkg?.bugs === "string" ? pkg.bugs : obj(pkg?.bugs).url;
  const repos: string[] = [];
  const engine = repoOfUrl(bugs);
  if (engine) repos.push(engine);
  if (
    typeof d.repo === "string" &&
    REPO_RE.test(d.repo) &&
    !repos.includes(d.repo)
  )
    repos.push(d.repo);
  const max = u.max_per_hour ?? d.max_per_hour;
  const cap = u.capture_seconds ?? d.capture_seconds;
  const mine = u.my_reports_max ?? d.my_reports_max;
  return {
    enabled: d.enabled !== false && u.enabled !== false,
    maxPerHour:
      typeof max === "number" && Number.isInteger(max) && max >= 1 ? max : 5,
    repos,
    captureSeconds:
      typeof cap === "number" && Number.isFinite(cap) && cap >= 1 ? cap : 15,
    myReportsMax:
      typeof mine === "number" &&
      Number.isInteger(mine) &&
      mine >= 1 &&
      mine <= 100
        ? mine
        : 20,
  };
}

const HOUR = 3_600_000;

/** The sent-report clock: who sent when, on disk. */
export function sentLog(stateDir: string) {
  const file = path.join(stateDir, "reports", "sent.json");
  const read = (): Record<string, number[]> => {
    try {
      const v = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;
      return v && typeof v === "object" ? (v as Record<string, number[]>) : {};
    } catch {
      return {};
    }
  };
  return {
    /** How many `who` sent in the last hour. */
    recent(who: string, now = Date.now()): number {
      return (read()[who] ?? []).filter((t) => now - t < HOUR).length;
    },
    /** When `who` may send again (the oldest in the hour, plus an hour). */
    nextAt(who: string, now = Date.now()): number {
      const r = (read()[who] ?? []).filter((t) => now - t < HOUR).sort();
      return r.length ? r[0] + HOUR : now;
    },
    add(who: string, now = Date.now()): void {
      const all = read();
      for (const k of Object.keys(all))
        all[k] = all[k].filter((t) => now - t < HOUR);
      all[who] = [...(all[who] ?? []), now];
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
    },
  };
}

export interface ReportDraft {
  id: string;
  /** "person" (Finish later) or "agent:<id>". */
  by: string;
  savedAt: string;
  kind: string;
  title: string;
  description: string;
  sections: Record<string, boolean>;
  redact: boolean;
  repo?: string;
  /** The masked screenshot, a data: URL, when there is one. */
  shot?: string;
}

/** The drafts, on this computer: <state>/reports/drafts/<id>.json. */
export function draftStore(stateDir: string) {
  const dir = path.join(stateDir, "reports", "drafts");
  const fileOf = (id: string) => {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("no such draft");
    return path.join(dir, `${id}.json`);
  };
  return {
    list(): ReportDraft[] {
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
      } catch {
        return [];
      }
      const out: ReportDraft[] = [];
      for (const n of names)
        try {
          out.push(JSON.parse(fs.readFileSync(path.join(dir, n), "utf-8")));
        } catch {
          /* unreadable: skipped */
        }
      return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    get(id: string): ReportDraft | null {
      try {
        return JSON.parse(fs.readFileSync(fileOf(id), "utf-8")) as ReportDraft;
      } catch {
        return null;
      }
    },
    save(
      d: Omit<ReportDraft, "id" | "savedAt"> & { id?: string },
    ): ReportDraft {
      const id = d.id ?? randomBytes(8).toString("hex");
      const rec: ReportDraft = { ...d, id, savedAt: new Date().toISOString() };
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(fileOf(id), JSON.stringify(rec), { mode: 0o600 });
      return rec;
    },
    remove(id: string): boolean {
      try {
        fs.unlinkSync(fileOf(id));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The feedback settings from disk: the engine's package.json, the
 * distribution's config file (its `feedback:` block) and user.yml's.
 */
export function readFeedbackSettings(
  engineRoot: string,
  distConfigFile: string,
  user: unknown,
): FeedbackSettings {
  let pkg: { bugs?: unknown } | null = null;
  try {
    pkg = JSON.parse(
      fs.readFileSync(path.join(engineRoot, "package.json"), "utf-8"),
    ) as { bugs?: unknown };
  } catch {
    /* no package: no engine destination */
  }
  let dist: unknown = undefined;
  try {
    const raw = parseYaml(fs.readFileSync(distConfigFile, "utf-8")) as {
      feedback?: unknown;
    } | null;
    dist = raw?.feedback;
  } catch {
    /* no config: the defaults */
  }
  return feedbackSettings(pkg, dist, user);
}
