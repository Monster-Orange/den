/**
 * Journeys snapshot store — deterministic per-action PNG persistence plus
 * the SnapshotIndex consumed by the rendered report/gallery and friction
 * evidence (jrn-reporting packet).
 *
 * Screenshots live under `<reportDir>/snapshots/NNN-<action>.png` (the run
 * entrypoint passes `reports/journeys/<run-id>` as the report dir). Entries
 * for sensitive actions can be *suppressed*: the capture callback is never
 * invoked — so the frame is never serialized — and the index records a
 * masked entry with a null path (critique finding D2-1).
 */

import * as fs from "fs";
import * as path from "path";

/** One SnapshotIndex row. `path` is null when capture was suppressed. */
export interface SnapshotIndexEntry {
  seq: number;
  action: string;
  url: string;
  path: string | null;
  ts: string;
  /** Present (true) when the action failed and this is its failure frame. */
  failure?: boolean;
  /** Present (true) when the action's input was masked as sensitive. */
  masked?: boolean;
  /** Present (true) when the screenshot was suppressed pre-capture. */
  suppressed?: boolean;
  /**
   * Present when the capture callback (or the snapshots-dir mkdir)
   * failed — the entry is still recorded (path null) so the missing
   * evidence surfaces as a report warning (review finding 9).
   */
  captureError?: string;
}

export interface PersistOptions {
  /** Short action label, e.g. "navigate", "click"; slugged into the name. */
  action: string;
  /** Page URL at capture time (already policy-checked by the caller). */
  url: string;
  /**
   * Writes the PNG to the given absolute path (typically
   * `page.screenshot({path})`). NOT invoked when `suppress` is set.
   */
  capture: (filePath: string) => Promise<void>;
  failure?: boolean;
  masked?: boolean;
  suppress?: boolean;
}

/** Slug an action label into a filesystem-safe fragment. */
function slugify(action: string): string {
  return (
    action
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "action"
  );
}

export class SnapshotStore {
  private readonly entries: SnapshotIndexEntry[] = [];
  readonly snapshotsDir: string;

  constructor(reportDir: string) {
    this.snapshotsDir = path.join(reportDir, "snapshots");
  }

  /** SnapshotIndex entries in capture order. */
  get index(): readonly SnapshotIndexEntry[] {
    return this.entries;
  }

  /**
   * Persist one action's screenshot and append its index entry. Ordering
   * contract: when `suppress` is set, `capture` is NEVER called — the entry
   * is recorded with a null path, so no sensitive frame can be serialized.
   *
   * Capture failures never throw (review finding 9): the entry is still
   * recorded with `captureError` set, so a passing run with missing
   * required evidence is reported loudly instead of silently.
   */
  async persist(options: PersistOptions): Promise<SnapshotIndexEntry> {
    const seq = this.entries.length + 1;
    const entry: SnapshotIndexEntry = {
      seq,
      action: options.action,
      url: options.url,
      path: null,
      ts: new Date().toISOString(),
    };
    if (options.failure) entry.failure = true;
    if (options.masked) entry.masked = true;

    if (options.suppress) {
      entry.suppressed = true;
      this.entries.push(entry);
      return entry;
    }

    const name = `${String(seq).padStart(3, "0")}-${slugify(options.action)}${
      options.failure ? "-failure" : ""
    }.png`;
    try {
      fs.mkdirSync(this.snapshotsDir, { recursive: true });
      const filePath = path.join(this.snapshotsDir, name);
      await options.capture(filePath);
      entry.path = filePath;
    } catch (error) {
      entry.captureError =
        error instanceof Error ? error.message : String(error);
    }
    this.entries.push(entry);
    return entry;
  }
}
