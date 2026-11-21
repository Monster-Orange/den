/**
 * Issue 773: the "seen" mark. A mark is subject + version + person: this
 * person has seen this version of this subject. It is generic: an agent's
 * subject is "agent:<id>" and its version its last finished turn (Done, not
 * seen, on the Agents page and in the bell); a Hub doc's would be
 * "doc:<id>" and its version number.
 *
 * Each subject also keeps its latest version (noteVersion), so a caller
 * that only knows the subject (opening an agent, a peek) marks the latest
 * one. Versions made of digits order as numbers: a mark of version 4 has
 * seen version 2 too. Any other version is seen only when it is the one
 * marked.
 *
 * <state>/seen/marks.json:
 *   { latest: { "<subject>": { version, at } },
 *     seen: { "<person>": { "<subject>": "<version>" } } }
 * Kept across restarts; ids and versions only, no secrets. Never throws on
 * a bad file: it reads as no marks.
 *
 *   seenMarks(stateDir?)  the folder's one store
 *   seen.mark / seen.isSeen / seen.latest  the same, through that store
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";
import { getStateDir } from "./paths.js";

export interface SeenKey {
  subject: string;
  person: string;
  /** Default: the subject's latest version. */
  version?: string;
}

export interface SubjectVersion {
  version: string;
  at: string;
}

interface SeenFile {
  latest: Record<string, SubjectVersion>;
  seen: Record<string, Record<string, string>>;
}

const MAX_KEY = 300;
const okKey = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= MAX_KEY;

/** Whether a mark of version `marked` has seen version `v`. */
export function versionSeen(marked: string | null, v: string): boolean {
  if (marked === null) return false;
  if (marked === v) return true;
  if (/^\d{1,15}$/.test(marked) && /^\d{1,15}$/.test(v))
    return Number(marked) >= Number(v);
  return false;
}

export class SeenMarks {
  private data: SeenFile | null = null;

  constructor(private readonly stateDir: string) {}

  private file(): string {
    return path.join(this.stateDir, "seen", "marks.json");
  }

  private read(): SeenFile {
    if (this.data) return this.data;
    let v: SeenFile = { latest: {}, seen: {} };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as unknown;
      if (raw && typeof raw === "object") {
        const r = raw as Partial<SeenFile>;
        v = {
          latest:
            r.latest && typeof r.latest === "object" ? { ...r.latest } : {},
          seen: r.seen && typeof r.seen === "object" ? { ...r.seen } : {},
        };
      }
    } catch {
      /* none yet, or unreadable: no marks */
    }
    this.data = v;
    return v;
  }

  private write(): void {
    try {
      writeFileAtomic(this.file(), JSON.stringify(this.read()) + "\n", {
        mode: 0o600,
      });
    } catch {
      /* best effort: the marks in memory hold until the next write */
    }
  }

  /** `subject`'s latest version is `version` (e.g. an agent's turn ended). */
  noteVersion(
    subject: string,
    version: string,
    at: string = new Date().toISOString(),
  ): void {
    if (!okKey(subject) || !okKey(version)) return;
    const d = this.read();
    const cur = d.latest[subject];
    if (cur?.version === version && cur.at === at) return;
    d.latest[subject] = { version, at };
    this.write();
  }

  /** `subject`'s latest version and when, or null (none noted). */
  latest(subject: string): SubjectVersion | null {
    const v = this.read().latest[subject];
    return v && typeof v.version === "string" ? { ...v } : null;
  }

  /** The version `person` last marked seen of `subject`, or null. */
  seenVersion(subject: string, person: string): string | null {
    const v = this.read().seen[person]?.[subject];
    return typeof v === "string" ? v : null;
  }

  /**
   * `person` has seen `subject` (the version given, else its latest).
   * False when there is no version to mark.
   */
  markSeen(k: SeenKey): boolean {
    if (!okKey(k.subject) || !okKey(k.person)) return false;
    const version = k.version ?? this.latest(k.subject)?.version;
    if (!okKey(version)) return false;
    const d = this.read();
    const mine = (d.seen[k.person] ??= {});
    if (versionSeen(mine[k.subject] ?? null, version)) return true;
    mine[k.subject] = version;
    this.write();
    return true;
  }

  /**
   * Whether `person` has seen `subject` (the version given, else its
   * latest). A subject with no version has nothing to see: seen.
   */
  isSeen(k: SeenKey): boolean {
    const version = k.version ?? this.latest(k.subject)?.version;
    if (version === undefined) return true;
    return versionSeen(this.seenVersion(k.subject, k.person), version);
  }

  /** `subject` is gone (an agent removed): its version and marks go. */
  forget(subject: string): void {
    const d = this.read();
    let changed = delete d.latest[subject];
    for (const p of Object.values(d.seen))
      if (p && subject in p) changed = delete p[subject] || changed;
    if (changed) this.write();
  }
}

const stores = new Map<string, SeenMarks>();

/** The one store for `stateDir` (default: Den's state folder). */
export function seenMarks(stateDir: string = getStateDir()): SeenMarks {
  let s = stores.get(stateDir);
  if (!s) {
    s = new SeenMarks(stateDir);
    stores.set(stateDir, s);
  }
  return s;
}

/** The seen mark's short names (issue 773), on the shared store. */
export const seen = {
  mark: (k: SeenKey, stateDir?: string): boolean =>
    seenMarks(stateDir).markSeen(k),
  isSeen: (k: SeenKey, stateDir?: string): boolean =>
    seenMarks(stateDir).isSeen(k),
  latest: (subject: string, stateDir?: string): SubjectVersion | null =>
    seenMarks(stateDir).latest(subject),
};
