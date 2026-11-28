/**
 * Issue 334: server keys. A web app on this computer that hosts its own
 * chats relays a person's message to one project agent, and reads that
 * agent's state, with a key its server holds (never a browser):
 *
 *   - one key per project + agent + origin, made by the person in
 *     Settings › Embedding (a held write: it runs on their Allow), shown
 *     to them once and never again;
 *   - `den_sk_<id>_<secret>`; only the whole key's sha256 is kept, in
 *     <state>/embed/server-keys.json (0600), and it is compared in
 *     constant time;
 *   - revoked by the person (a held write too): it answers 401 at once;
 *   - it rides in X-Den-Embed-Key, and reaches only the embed routes
 *     (EMBED_KEY_ROUTES), for its one agent.
 *
 * The file is read on every check, so a revoke counts at once, on every
 * server reading the same state.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { readStateJson } from "../../shared/state-backup.js";

export const SERVER_KEY_PREFIX = "den_sk_";
const KEY_RE = /^den_sk_([0-9a-f]{16})_[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[0-9a-f]{16}$/;
/** How often last-used is written for one key, at most. */
const TOUCH_MS = 60_000;

export interface ServerKeyGrant {
  project: string;
  agent: string;
  origin: string;
  /** The person's own name for it ("staging app"), one line. */
  label?: string;
}

/** A key as it is listed: never its hash, never the key. */
export interface ServerKeyView extends ServerKeyGrant {
  id: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface Stored extends ServerKeyView {
  hash: string;
}

const sha = (key: string) => createHash("sha256").update(key).digest();
/** A hash no key has: a lookup that misses still compares once. */
const NONE = Buffer.alloc(32);

const view = (r: Stored): ServerKeyView => {
  const { hash: _hash, ...v } = r;
  return v;
};

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.length <= max ? v : undefined;

function parse(v: unknown): Stored | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const id = str(r.id, 16);
  const hash = str(r.hash, 64);
  const project = str(r.project, 128);
  const agent = str(r.agent, 128);
  const origin = str(r.origin, 512);
  const createdAt = str(r.createdAt, 64);
  if (
    !id ||
    !ID_RE.test(id) ||
    !hash ||
    !/^[0-9a-f]{64}$/.test(hash) ||
    !project ||
    !agent ||
    !origin ||
    !createdAt
  )
    return null;
  const label = str(r.label, 200);
  const lastUsedAt = str(r.lastUsedAt, 64);
  const revokedAt = str(r.revokedAt, 64);
  return {
    id,
    hash,
    project,
    agent,
    origin,
    createdAt,
    ...(label ? { label } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
  };
}

export type ServerKeyCheck =
  | { ok: true; key: ServerKeyView }
  | { ok: false; code: "bad_key" | "key_revoked" };

export class ServerKeys {
  private readonly file: string;

  constructor(
    private readonly stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = path.join(stateDir, "embed", "server-keys.json");
  }

  /** The store under a state dir. */
  static at(stateDir: string, now?: () => number): ServerKeys {
    return new ServerKeys(stateDir, now);
  }

  private read(): Stored[] {
    try {
      const r = readStateJson(this.stateDir, this.file);
      if (!r.ok) return [];
      const v = (r.value ?? {}) as {
        keys?: unknown;
      };
      return Array.isArray(v.keys)
        ? v.keys.map(parse).filter((r): r is Stored => !!r)
        : [];
    } catch {
      return []; // none yet, or broken: no key works
    }
  }

  private write(keys: Stored[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, `${JSON.stringify({ keys }, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  /** A new key for `g`. The key is returned here only, never again. */
  create(g: ServerKeyGrant): { key: string; view: ServerKeyView } {
    const keys = this.read();
    let id: string;
    do id = randomBytes(8).toString("hex");
    while (keys.some((k) => k.id === id));
    const key = `${SERVER_KEY_PREFIX}${id}_${randomBytes(32).toString("base64url")}`;
    const rec: Stored = {
      id,
      hash: sha(key).toString("hex"),
      project: g.project,
      agent: g.agent,
      origin: g.origin,
      ...(g.label ? { label: g.label } : {}),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.write([...keys, rec]);
    return { key, view: view(rec) };
  }

  /** Every key, newest first, revoked ones too (marked). */
  list(): ServerKeyView[] {
    return this.read().reverse().map(view);
  }

  get(id: unknown): ServerKeyView | null {
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    const r = this.read().find((k) => k.id === id);
    return r ? view(r) : null;
  }

  /** Revoke `id`: null when there is none, or it was revoked already. */
  revoke(id: unknown): ServerKeyView | null {
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    const keys = this.read();
    const r = keys.find((k) => k.id === id);
    if (!r || r.revokedAt) return null;
    r.revokedAt = new Date(this.now()).toISOString();
    this.write(keys);
    return view(r);
  }

  /**
   * What `key` grants, or why not. The hashes are compared in constant
   * time, and a key with no record compares once too.
   */
  check(key: unknown): ServerKeyCheck {
    if (typeof key !== "string" || key.length > 200)
      return { ok: false, code: "bad_key" };
    const m = KEY_RE.exec(key);
    const r = m ? this.read().find((k) => k.id === m[1]) : undefined;
    const want = r ? Buffer.from(r.hash, "hex") : NONE;
    const same = timingSafeEqual(sha(key), want);
    if (!m || !r || !same) return { ok: false, code: "bad_key" };
    if (r.revokedAt) return { ok: false, code: "key_revoked" };
    return { ok: true, key: view(r) };
  }

  /** Mark `id` used now (written at most once a minute). */
  touch(id: string): void {
    const keys = this.read();
    const r = keys.find((k) => k.id === id);
    if (!r || r.revokedAt) return;
    const t = this.now();
    const last = r.lastUsedAt ? Date.parse(r.lastUsedAt) : NaN;
    if (Number.isFinite(last) && t - last < TOUCH_MS) return;
    r.lastUsedAt = new Date(t).toISOString();
    try {
      this.write(keys);
    } catch {
      /* last-used is best effort */
    }
  }
}
