/**
 * Issue 784: a person's own settings, kept for the person rather than for
 * this Den: their attention mapping (780), alert sounds (783), keys (782)
 * and pane layouts (781). Each is an area holding only the person's
 * overrides, `{ v: <version>, ... }`; the defaults live in code, as data,
 * so a missing area means all defaults.
 *
 * One record per person, keyed by who is signed in (index.ts's
 * personKey). Each area has its own rev (an integer from 0, up by one on
 * every write). A write names the area's rev it read: a stale one is
 * refused (409) with what is there now, so two tabs or Dens never
 * overwrite each other unseen, and a change to one area never refuses a
 * write to another. A person's request only: an agent's is refused.
 *
 *   GET /api/account/prefs          → { areas: {<area>: value}, revs: {<area>: n} }
 *   PUT /api/account/prefs/<area>   { value, rev } → { ok: true, rev }
 *
 * Slice 1 keeps the record in this Den's state folder. Where it lives can
 * change behind this API without touching the areas' owners.
 */
import type * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../../shared/atomic-write.js";

/** One area's check: null when the value is good, else why it isn't. */
export type AreaCheck = (value: unknown) => string | null;

const AREAS = new Map<string, AreaCheck>();

/**
 * An area's owner registers it with its check, in its own module (so no
 * one list is edited by every lane).
 */
export function registerAccountArea(name: string, check: AreaCheck): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name))
    throw new Error(`account area "${name}" is not a plain name`);
  AREAS.set(name, check);
}

/** Tests only: forget every registered area. */
export function resetAccountAreasForTest(): void {
  AREAS.clear();
}

/** The default size limit for one area's value, in KB (account_prefs_max_kb). */
export const ACCOUNT_PREFS_MAX_KB_DEFAULT = 64;

export interface AccountPrefs {
  /** Each area's value (the person's overrides); a cleared one is left out. */
  areas: Record<string, unknown>;
  /** Each area's rev; one never written is left out (rev 0). */
  revs: Record<string, number>;
}

const KEY_RE = /^[a-z]+:[A-Za-z0-9_.-]{1,100}$/;

/** Where a person's record is: `<state>/account-prefs/<key>.json`. */
export function accountPrefsFile(stateDir: string, key: string): string {
  if (!KEY_RE.test(key) || key.includes(".."))
    throw new Error(`account key "${key}" can't name a file`);
  return path.join(stateDir, "account-prefs", `${key.replace(":", "_")}.json`);
}

/** A person's record; none saved: no areas, no revs. */
export function readAccountPrefs(stateDir: string, key: string): AccountPrefs {
  const out: AccountPrefs = { areas: {}, revs: {} };
  let raw: { areas?: unknown };
  try {
    raw = JSON.parse(
      fs.readFileSync(accountPrefsFile(stateDir, key), "utf-8"),
    ) as typeof raw;
  } catch {
    return out;
  }
  if (!raw?.areas || typeof raw.areas !== "object") return out;
  for (const [name, a] of Object.entries(raw.areas as object)) {
    const { value, rev } = (a ?? {}) as { value?: unknown; rev?: unknown };
    if (!Number.isInteger(rev) || (rev as number) < 0) continue;
    out.revs[name] = rev as number;
    if (value !== null && value !== undefined) out.areas[name] = value;
  }
  return out;
}

/** The file's own form: each area's value (null: cleared) and rev. */
function saveAccountPrefs(stateDir: string, key: string, p: AccountPrefs) {
  const areas: Record<string, { value: unknown; rev: number }> = {};
  for (const [name, rev] of Object.entries(p.revs))
    areas[name] = { value: p.areas[name] ?? null, rev };
  writeFileAtomic(
    accountPrefsFile(stateDir, key),
    JSON.stringify({ v: 1, areas }, null, 2) + "\n",
    { mode: 0o600 },
  );
}

export type AreaWrite =
  | { ok: true; rev: number }
  | {
      ok: false;
      status: 400 | 409 | 413;
      error: string;
      current?: { value: unknown; rev: number };
    };

/**
 * Save one area (null: back to its defaults), at the rev the writer read.
 * Checked in full before anything is written.
 */
export function writeAccountArea(
  stateDir: string,
  key: string,
  area: string,
  body: { value: unknown; rev: number },
  maxKb: number = ACCOUNT_PREFS_MAX_KB_DEFAULT,
): AreaWrite {
  const check = AREAS.get(area);
  if (!check)
    return {
      ok: false,
      status: 400,
      error: `no account area "${area}" (known: ${[...AREAS.keys()].join(", ") || "none"})`,
    };
  const { value } = body;
  if (value !== null) {
    if (typeof value !== "object" || Array.isArray(value))
      return {
        ok: false,
        status: 400,
        error: `${area}: the value must be an object, or null`,
      };
    const v = (value as { v?: unknown }).v;
    if (!Number.isInteger(v) || (v as number) < 1)
      return {
        ok: false,
        status: 400,
        error: `${area}: the value needs its version, v (a whole number from 1)`,
      };
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size > maxKb * 1024)
      return {
        ok: false,
        status: 413,
        error: `${area}: ${Math.ceil(size / 1024)} KB is over the ${maxKb} KB an area may hold (account_prefs_max_kb)`,
      };
    const why = check(value);
    if (why) return { ok: false, status: 400, error: why };
  }
  const now = readAccountPrefs(stateDir, key);
  const had = now.revs[area] ?? 0;
  if (body.rev !== had)
    return {
      ok: false,
      status: 409,
      error: `${area} changed elsewhere since this page read it: reload to see it`,
      current: { value: now.areas[area] ?? null, rev: had },
    };
  const rev = had + 1;
  if (value === null) delete now.areas[area];
  else now.areas[area] = value;
  now.revs[area] = rev;
  saveAccountPrefs(stateDir, key, now);
  return { ok: true, rev };
}

export interface AccountPrefsDeps {
  stateDir: () => string;
  /**
   * Whose record a request reads and writes, or null when it isn't a
   * person's (an agent's token, an agent's own call): refused.
   */
  personKey: (req: http.IncomingMessage) => string | null;
  /** account_prefs_max_kb (default ACCOUNT_PREFS_MAX_KB_DEFAULT). */
  maxKb: () => number;
}

const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
};

async function readBody(req: http.IncomingMessage, limit: number) {
  let n = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > limit) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/** The route; false when the path isn't this route's. */
export async function handleAccountPrefsRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  d: AccountPrefsDeps,
): Promise<boolean> {
  const all = pathname === "/api/account/prefs";
  const one = /^\/api\/account\/prefs\/([^/]+)$/.exec(pathname);
  if (!all && !one) return false;
  const key = d.personKey(req);
  if (!key) {
    send(res, 403, {
      error:
        "A person's own settings are read and changed by that person, in their browser: an agent can't.",
      code: "person_only",
    });
    return true;
  }
  if (all) {
    if (req.method !== "GET") {
      send(res, 405, { error: "GET only" });
      return true;
    }
    send(res, 200, readAccountPrefs(d.stateDir(), key));
    return true;
  }
  if (req.method !== "PUT") {
    send(res, 405, { error: "PUT only" });
    return true;
  }
  const maxKb = d.maxKb();
  const raw = await readBody(req, maxKb * 1024 + 4096);
  if (raw === null) {
    send(res, 413, {
      error: `over the ${maxKb} KB an area may hold (account_prefs_max_kb)`,
    });
    return true;
  }
  let body: { value?: unknown; rev?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    send(res, 400, { error: "the body must be JSON: { value, rev }" });
    return true;
  }
  if (!body || typeof body !== "object" || !Number.isInteger(body.rev)) {
    send(res, 400, {
      error: "rev must be the area's rev this page read (GET; 0 for none)",
    });
    return true;
  }
  const w = writeAccountArea(
    d.stateDir(),
    key,
    decodeURIComponent(one![1]),
    { value: body.value ?? null, rev: body.rev as number },
    maxKb,
  );
  if (w.ok) send(res, 200, w);
  else
    send(res, w.status, {
      error: w.error,
      ...(w.current ? { current: w.current } : {}),
    });
  return true;
}
