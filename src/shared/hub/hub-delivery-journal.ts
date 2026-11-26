/**
 * P0-D4: what happened to each Hub delivery, one JSON line per event, so a
 * gap (a decision Hub said it sent and no agent saw) can be timed from
 * Den's side. Ids, the agent, the kind, the doc's link, held ids and the
 * outcome only: never a body, a name or a token. 0600, capped (the newer
 * half kept). Doctor sums the last 24 h (journalSummary).
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";

export type JournalOutcome =
  | "received" // Den took it from Hub (or made it, an inbox item)
  | "repeat" // Hub sent it again: never typed twice
  | "refused" // no such agent here
  | "replaced" // Hub's Try again: the new copy takes its place
  | "held" // it waits (why: the reason's code)
  | "typed" // typed into the agent
  | "done" // the agent's turn ended
  | "failed" // the agent stopped before it ended
  | "no-answer" // typed, and its turn never showed as ended
  | "passed"; // an inbox item passed over (older, or a delivery had it)

export interface JournalEntry {
  at: string;
  id: string;
  agent: string;
  outcome: JournalOutcome;
  kind?: string;
  version?: number;
  thread?: string;
  url?: string;
  /** Held write ids Hub's text names. */
  held?: string[];
  why?: string;
}

/** 1 MB: weeks of deliveries. */
export const JOURNAL_MAX_BYTES = 1 << 20;

export function appendJournal(
  file: string,
  e: JournalEntry,
  maxBytes = JOURNAL_MAX_BYTES,
): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify(e) + "\n";
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* a new file */
    }
    const bytes = (t: string) => Buffer.byteLength(t, "utf8");
    const n = bytes(line);
    if (size + n > maxBytes) {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      const kept = lines.slice(Math.ceil(lines.length / 2));
      const text = () => kept.join("\n") + (kept.length ? "\n" : "");
      while (kept.length && bytes(text()) + n > maxBytes / 2) kept.shift();
      writeFileAtomic(file, text() + line, { mode: 0o600 });
    } else fs.appendFileSync(file, line, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch {
    /* the log's trouble never stops a delivery */
  }
}

export interface JournalSummary {
  counts: Partial<Record<JournalOutcome, number>>;
  lastTypedAt: number | null;
  file: string;
}

/** The last `windowMs` (24 h) by outcome; null when there is no file. */
export function journalSummary(
  file: string,
  now: number,
  windowMs = 24 * 3600_000,
): JournalSummary | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const counts: JournalSummary["counts"] = {};
  let lastTypedAt: number | null = null;
  for (const l of text.split("\n")) {
    let e: Partial<JournalEntry>;
    try {
      e = JSON.parse(l) as Partial<JournalEntry>;
    } catch {
      continue;
    }
    const at = Date.parse(String(e.at));
    if (!Number.isFinite(at) || typeof e.outcome !== "string") continue;
    if (e.outcome === "typed") lastTypedAt = Math.max(lastTypedAt ?? 0, at);
    if (now - at > windowMs) continue;
    counts[e.outcome] = (counts[e.outcome] ?? 0) + 1;
  }
  return { counts, lastTypedAt, file };
}
