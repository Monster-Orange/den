import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";
import { getStateDir } from "./paths.js";

export interface SeenKey {
  subject: string;
  person: string;
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

  latest(subject: string): SubjectVersion | null {
    const v = this.read().latest[subject];
    return v && typeof v.version === "string" ? { ...v } : null;
  }

  seenVersion(subject: string, person: string): string | null {
    const v = this.read().seen[person]?.[subject];
    return typeof v === "string" ? v : null;
  }

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

  isSeen(k: SeenKey): boolean {
    const version = k.version ?? this.latest(k.subject)?.version;
    if (version === undefined) return true;
    return versionSeen(this.seenVersion(k.subject, k.person), version);
  }

  forget(subject: string): void {
    const d = this.read();
    let changed = delete d.latest[subject];
    for (const p of Object.values(d.seen))
      if (p && subject in p) changed = delete p[subject] || changed;
    if (changed) this.write();
  }
}

const stores = new Map<string, SeenMarks>();

export const agentSeenSubject = (id: string): string => `agent:${id}`;

export function seenMarks(stateDir: string = getStateDir()): SeenMarks {
  let s = stores.get(stateDir);
  if (!s) {
    s = new SeenMarks(stateDir);
    stores.set(stateDir, s);
  }
  return s;
}

export const seen = {
  mark: (k: SeenKey, stateDir?: string): boolean =>
    seenMarks(stateDir).markSeen(k),
  isSeen: (k: SeenKey, stateDir?: string): boolean =>
    seenMarks(stateDir).isSeen(k),
  latest: (subject: string, stateDir?: string): SubjectVersion | null =>
    seenMarks(stateDir).latest(subject),
};
