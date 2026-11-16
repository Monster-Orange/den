/**
 * Issue 103: the embedded agent pane's keys. The frame carries no Den
 * cookie, so Den mints it a key of its own, for the person, after the
 * host's handshake (embed-routes.ts): bound to one project, one agent and
 * the host's origin, and short-lived (Settings › Embedding key_minutes).
 *
 *   - `den_ek_` and 32 random bytes; only its sha256 is kept, in memory
 *     (a restart forgets every key: the frame asks again);
 *   - it rides in a header (X-Den-Embed-Key), never in a URL;
 *   - it reaches only the pane's own routes (/api/embed/say), and only
 *     while its origin is still on the list.
 */
import { createHash, randomBytes } from "crypto";

export const EMBED_KEY_HEADER = "x-den-embed-key";
const PREFIX = "den_ek_";
/** The most keys kept at once; the oldest goes first. */
const MAX_KEYS = 1000;

export interface EmbedGrant {
  project: string;
  agent: string;
  origin: string;
  expiresAt: number;
}

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

export class EmbedKeys {
  private keys = new Map<string, EmbedGrant>();

  constructor(private now: () => number = Date.now) {}

  /** A new key for `g`, lasting `ttlMs`. */
  mint(
    g: Omit<EmbedGrant, "expiresAt">,
    ttlMs: number,
  ): { key: string; expiresAt: number } {
    const t = this.now();
    for (const [h, v] of this.keys) if (v.expiresAt <= t) this.keys.delete(h);
    while (this.keys.size >= MAX_KEYS) {
      const oldest = this.keys.keys().next().value;
      if (oldest === undefined) break;
      this.keys.delete(oldest);
    }
    const key = PREFIX + randomBytes(32).toString("base64url");
    const expiresAt = t + ttlMs;
    this.keys.set(hash(key), { ...g, expiresAt });
    return { key, expiresAt };
  }

  /** What `key` grants, or why not: none (never Den's), or expired. */
  check(
    key: unknown,
  ):
    | { ok: true; grant: EmbedGrant }
    | { ok: false; code: "bad_key" | "key_expired" } {
    if (typeof key !== "string" || !key.startsWith(PREFIX) || key.length > 200)
      return { ok: false, code: "bad_key" };
    const h = hash(key);
    const g = this.keys.get(h);
    if (!g) return { ok: false, code: "bad_key" };
    if (g.expiresAt <= this.now()) {
      this.keys.delete(h);
      return { ok: false, code: "key_expired" };
    }
    return { ok: true, grant: g };
  }
}
