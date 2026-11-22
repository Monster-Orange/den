/**
 * Issue 621: gate-only runner tokens. A CI job in a runner VM has no Den
 * and no process on this machine; it takes a gate slot over HTTP with one
 * of these:
 *
 *   - made on the person's Allow (the held write gate_runner_token_create),
 *     named for its runner ("ci-linux"), one live token per name;
 *   - `den_gr_<id>_<secret>`; only the whole token's sha256 is kept, in
 *     <state>/gate/runner-tokens.json (0600), compared in constant time;
 *   - it reaches only the gate-slot ask, renew and release routes
 *     (request-guard.ts RUNNER_ROUTES): every other route answers 403;
 *   - listed (never the token, never its hash) and revoked in Settings:
 *     a revoked token answers 401 at once.
 *
 * The file is read on every check, so a revoke counts at once.
 */
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as path from "path";

export const RUNNER_TOKEN_PREFIX = "den_gr_";
const TOKEN_RE = /^den_gr_([0-9a-f]{16})_[A-Za-z0-9_-]{43}$/;
const ID_RE = /^[0-9a-f]{16}$/;
/** A runner's name: what `gate status` shows for its slots. */
export const RUNNER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** How often last-used is written for one token, at most. */
const TOUCH_MS = 60_000;

/** A token as it is listed: never its hash, never the token. */
export interface RunnerView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface Stored extends RunnerView {
  hash: string;
}

const sha = (t: string) => createHash("sha256").update(t).digest();
/** A hash no token has: a lookup that misses still compares once. */
const NONE = Buffer.alloc(32);

const view = (r: Stored): RunnerView => {
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
  const name = str(r.name, 64);
  const createdAt = str(r.createdAt, 64);
  if (
    !id ||
    !ID_RE.test(id) ||
    !hash ||
    !/^[0-9a-f]{64}$/.test(hash) ||
    !name ||
    !RUNNER_NAME_RE.test(name) ||
    !createdAt
  )
    return null;
  const lastUsedAt = str(r.lastUsedAt, 64);
  const revokedAt = str(r.revokedAt, 64);
  return {
    id,
    hash,
    name,
    createdAt,
    ...(lastUsedAt ? { lastUsedAt } : {}),
    ...(revokedAt ? { revokedAt } : {}),
  };
}

export type RunnerCheck =
  | { ok: true; runner: RunnerView }
  | { ok: false; code: "bad_token" | "token_revoked" };

export class RunnerTokens {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The store under a state dir. */
  static at(stateDir: string, now?: () => number): RunnerTokens {
    return new RunnerTokens(
      path.join(stateDir, "gate", "runner-tokens.json"),
      now,
    );
  }

  private read(): Stored[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf-8")) as {
        tokens?: unknown;
      };
      return Array.isArray(v.tokens)
        ? v.tokens.map(parse).filter((r): r is Stored => !!r)
        : [];
    } catch {
      return []; // none yet, or broken: no token works
    }
  }

  private write(tokens: Stored[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ tokens }, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmp, this.file);
  }

  /**
   * A new token for runner `name`. The token is returned here only, never
   * again. Throws when the name is bad or a live token has it already.
   */
  create(name: string): { token: string; view: RunnerView } {
    if (!RUNNER_NAME_RE.test(name))
      throw new Error(
        "a runner's name is letters, digits, dot, dash or underscore, at most 64",
      );
    const tokens = this.read();
    if (tokens.some((t) => t.name === name && !t.revokedAt))
      throw new Error(
        `a runner named ${name} has a token already: revoke it first`,
      );
    let id: string;
    do id = randomBytes(8).toString("hex");
    while (tokens.some((t) => t.id === id));
    const token = `${RUNNER_TOKEN_PREFIX}${id}_${randomBytes(32).toString("base64url")}`;
    const rec: Stored = {
      id,
      hash: sha(token).toString("hex"),
      name,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.write([...tokens, rec]);
    return { token, view: view(rec) };
  }

  /** Every token, newest first; never a token or its hash. */
  list(): RunnerView[] {
    return this.read()
      .map(view)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Whether a live token has this name. */
  named(name: string): boolean {
    return this.read().some((t) => t.name === name && !t.revokedAt);
  }

  /** Revokes it; the view, or null when there is no such token. */
  revoke(id: unknown): RunnerView | null {
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    const tokens = this.read();
    const t = tokens.find((x) => x.id === id);
    if (!t) return null;
    if (!t.revokedAt) {
      t.revokedAt = new Date(this.now()).toISOString();
      this.write(tokens);
    }
    return view(t);
  }

  /** What a token proves, compared in constant time. */
  check(token: unknown): RunnerCheck {
    const m =
      typeof token === "string" && token.length <= 128
        ? TOKEN_RE.exec(token)
        : null;
    const tokens = m ? this.read() : [];
    const rec = m ? tokens.find((t) => t.id === m[1]) : undefined;
    const want = rec ? Buffer.from(rec.hash, "hex") : NONE;
    const same = timingSafeEqual(
      sha(typeof token === "string" ? token : ""),
      want,
    );
    if (!rec || !same) return { ok: false, code: "bad_token" };
    if (rec.revokedAt) return { ok: false, code: "token_revoked" };
    const t = this.now();
    if (!rec.lastUsedAt || t - Date.parse(rec.lastUsedAt) > TOUCH_MS)
      this.touch(rec.id, t);
    return { ok: true, runner: view(rec) };
  }

  /**
   * Last used, written from a fresh read right before the write: it sets
   * that one field on a live token and never writes back a stale copy (a
   * revoke made meanwhile stays). Best effort.
   */
  private touch(id: string, t: number): void {
    try {
      const fresh = this.read();
      const r = fresh.find((x) => x.id === id);
      if (!r || r.revokedAt) return;
      r.lastUsedAt = new Date(t).toISOString();
      this.write(fresh);
    } catch {
      /* last-used is best effort */
    }
  }

  /** Whether token `id` is still live (not revoked, not gone). */
  live(id: string): boolean {
    return this.read().some((t) => t.id === id && !t.revokedAt);
  }
}
