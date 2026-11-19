/**
 * Issue 403: a filed report's masked screenshot, kept on this install so
 * whoever fixes it can ask for it (report_screenshot(<report id>), the
 * person or this install's own server agent only). One PNG and its record
 * per report under <state>/reports/shots, kept for
 * `reports.screenshot_keep_days` (30) and then deleted by the janitor.
 *
 *   <state>/reports/shots/<id>.png    the masked PNG
 *   <state>/reports/shots/<id>.json   { id, repo, savedAt, hub? }
 *                                      hub: Hub's record when it took one
 *                                      { id, sha256, expires, recipient }
 *
 * Nothing here talks to Hub or GitHub, and nothing logs the image.
 */
import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { writeFileAtomic } from "./atomic-write.js";

/** A report id: 16 hex, the same shape as a draft's. */
export const REPORT_ID = /^[a-f0-9]{16}$/;

/** How long a kept screenshot stays, in days, by default. */
export const SHOT_KEEP_DAYS_DEFAULT = 30;
export const SHOT_KEEP_DAYS_MIN = 1;
export const SHOT_KEEP_DAYS_MAX = 3650;

/** user.yml `reports.screenshot_keep_days`, or the default. */
export function shotKeepDays(user: unknown): number {
  const r =
    user && typeof user === "object"
      ? (user as { reports?: unknown }).reports
      : undefined;
  const v =
    r && typeof r === "object"
      ? (r as { screenshot_keep_days?: unknown }).screenshot_keep_days
      : undefined;
  return typeof v === "number" &&
    Number.isInteger(v) &&
    v >= SHOT_KEEP_DAYS_MIN &&
    v <= SHOT_KEEP_DAYS_MAX
    ? v
    : SHOT_KEEP_DAYS_DEFAULT;
}

export interface ShotRecord {
  id: string;
  /** owner/name the report was filed on. */
  repo: string;
  savedAt: string;
  /**
   * Hub's record of it. `confirmed`: Hub's sha256 is the one of the bytes
   * sent (false: Hub stored something else, or said so wrongly).
   */
  hub?: {
    id: string;
    sha256: string;
    expires: string;
    recipient: string;
    confirmed: boolean;
  };
}

const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;
/** The largest screenshot Den keeps (a data URL's PNG). */
export const MAX_KEPT_BYTES = 8 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG data URL's bytes, or null when it isn't one (or is too big). */
export function pngOfDataUrl(v: unknown): Buffer | null {
  if (typeof v !== "string" || v.length > MAX_KEPT_BYTES * 1.4) return null;
  const m = PNG_DATA_URL.exec(v);
  if (!m) return null;
  const png = Buffer.from(m[1]!, "base64");
  if (png.length > MAX_KEPT_BYTES || !png.subarray(0, 8).equals(PNG_MAGIC))
    return null;
  return png;
}

/** A new report id. */
export function newReportId(): string {
  return randomBytes(8).toString("hex");
}

export function shotStore(stateDir: string) {
  const dir = path.join(stateDir, "reports", "shots");
  const fileOf = (id: string, ext: "png" | "json") => {
    if (!REPORT_ID.test(id)) throw new Error("no such report");
    return path.join(dir, `${id}.${ext}`);
  };
  const readRec = (id: string): ShotRecord | null => {
    try {
      return JSON.parse(
        fs.readFileSync(fileOf(id, "json"), "utf-8"),
      ) as ShotRecord;
    } catch {
      return null;
    }
  };
  return {
    dir,
    save(id: string, png: Buffer, repo: string, now = Date.now()): ShotRecord {
      // The same report sent again with the same bytes keeps Hub's record.
      const had = readRec(id);
      let same = false;
      try {
        same = !!had?.hub && fs.readFileSync(fileOf(id, "png")).equals(png);
      } catch {
        same = false;
      }
      const rec: ShotRecord = {
        id,
        repo,
        savedAt: new Date(now).toISOString(),
        ...(same && had?.hub ? { hub: had.hub } : {}),
      };
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileAtomic(fileOf(id, "png"), png, { mode: 0o600 });
      writeFileAtomic(fileOf(id, "json"), JSON.stringify(rec), { mode: 0o600 });
      return rec;
    },
    /** Hub's record of it (its id, sha256, expiry and recipient). */
    recordHub(id: string, hub: NonNullable<ShotRecord["hub"]>): void {
      const rec = readRec(id);
      if (!rec) return;
      writeFileAtomic(fileOf(id, "json"), JSON.stringify({ ...rec, hub }), {
        mode: 0o600,
      });
    },
    get(id: string): { record: ShotRecord; png: Buffer } | null {
      if (!REPORT_ID.test(id)) return null;
      const record = readRec(id);
      if (!record) return null;
      try {
        return { record, png: fs.readFileSync(fileOf(id, "png")) };
      } catch {
        return null;
      }
    },
    /**
     * The janitor: every screenshot older than `keepDays` goes, its record
     * too (and a stray file of either kind). How many went.
     */
    sweep(keepDays: number, now = Date.now()): number {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return 0;
      }
      const cutoff = now - keepDays * 86_400_000;
      let gone = 0;
      const ids = new Set(
        names
          .map((n) => /^([a-f0-9]{16})\.(png|json)$/.exec(n)?.[1])
          .filter((x): x is string => !!x),
      );
      for (const id of ids) {
        const rec = readRec(id);
        let at = rec ? Date.parse(rec.savedAt) : NaN;
        if (!Number.isFinite(at))
          try {
            at = fs.statSync(path.join(dir, `${id}.png`)).mtimeMs;
          } catch {
            at = 0;
          }
        if (at > cutoff) continue;
        for (const ext of ["png", "json"] as const)
          try {
            fs.unlinkSync(fileOf(id, ext));
          } catch {
            /* already gone */
          }
        gone++;
      }
      return gone;
    },
  };
}
