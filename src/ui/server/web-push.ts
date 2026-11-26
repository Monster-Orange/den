/**
 * Issue 172 S2: Web Push, so a phone or a closed tab gets an alert
 * (alert-feed.ts decides what one says). Node's own crypto only:
 *
 *   - VAPID (RFC 8292): this install's P-256 key pair, made on first use
 *     in its own state dir (`push-vapid.json`, 0600, the dir 0700), the
 *     same store as web.secret. Only the public key is ever served; the
 *     private key is never printed, logged or sent.
 *   - The payload is encrypted for each device (RFC 8291, aes128gcm), so
 *     the push service carries what it can't read.
 *   - Subscriptions (a device's endpoint and keys) are kept in
 *     `push-subscriptions.json` (0600). An endpoint is https, or http on
 *     this machine (a local stub). A device the push service says is gone
 *     (404, 410) is dropped.
 */
import {
  createECDH,
  createHash,
  createCipheriv,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { PUSH_SUBSCRIPTIONS_FILE } from "../../shared/push-subscription-count.js";

export const VAPID_FILE = "push-vapid.json";
export const SUBSCRIPTIONS_FILE = PUSH_SUBSCRIPTIONS_FILE;
/** The most devices kept; the oldest goes first. */
export const MAX_SUBSCRIPTIONS = 20;

const b64u = (b: Buffer) => b.toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

export interface VapidKeys {
  /** The uncompressed public point, base64url (65 bytes). */
  publicKey: string;
  /** The private key, kept as a JWK; never leaves this module's callers. */
  key: KeyObject;
}

function writePrivate(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, text, { mode: 0o600 });
}

/** This install's VAPID keys, made on first use. */
export function vapidKeys(stateDir: string): VapidKeys {
  const file = path.join(stateDir, VAPID_FILE);
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf-8")) as {
      jwk?: { kty: string; crv: string; x: string; y: string; d: string };
    };
    if (j.jwk?.d && j.jwk.x && j.jwk.y) {
      const key = createPrivateKey({ key: j.jwk, format: "jwk" });
      const pub = Buffer.concat([
        Buffer.from([4]),
        unb64u(j.jwk.x),
        unb64u(j.jwk.y),
      ]);
      return { publicKey: b64u(pub), key };
    }
  } catch {
    /* none yet, or unreadable: make one */
  }
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = privateKey.export({ format: "jwk" }) as {
    x: string;
    y: string;
  };
  writePrivate(file, JSON.stringify({ jwk }));
  const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { publicKey: b64u(pub), key: privateKey };
}

/** The Authorization header for `endpoint` (RFC 8292). */
export function vapidAuth(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  nowMs: number = Date.now(),
): string {
  const enc = (o: unknown) => b64u(Buffer.from(JSON.stringify(o)));
  const head = enc({ typ: "JWT", alg: "ES256" });
  const claims = enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    sub: subject,
  });
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), {
    key: keys.key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** `payload` encrypted for one device (RFC 8291, aes128gcm, one record). */
export function encryptPayload(
  payload: Buffer,
  p256dh: string,
  auth: string,
): Buffer {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const ecdh = createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    uaPublic,
    asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12),
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([
    salt,
    rs,
    Buffer.from([asPublic.length]),
    asPublic,
    body,
  ]);
}

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** ISO 8601: when it was added. */
  at: string;
  /** What the device is ("iPhone", "Mac"...), from its browser; "" unknown. */
  device?: string;
  person?: string;
}

/**
 * A device's id as a page sees it: a hash of its endpoint, so a list or a
 * Forget never carries the endpoint (a capability: whoever holds it, with
 * the keys, can push to the device).
 */
export function deviceId(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}

/** Whose push service a device uses, from its endpoint's host. */
export type PushService =
  | "apple"
  | "google"
  | "mozilla"
  | "microsoft"
  | "other";

export function pushService(endpoint: string): PushService {
  let host = "";
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return "other";
  }
  const is = (d: string) => host === d || host.endsWith(`.${d}`);
  if (is("push.apple.com")) return "apple";
  if (is("googleapis.com")) return "google";
  if (is("mozilla.com")) return "mozilla";
  if (is("notify.windows.com")) return "microsoft";
  return "other";
}

/** What a device is, from its browser's User-Agent; "" when unknown. */
export function deviceOf(userAgent: string | undefined): string {
  const ua = String(userAgent ?? "");
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "";
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A device's subscription from a page (PushSubscription.toJSON()), checked. */
export function parseSubscription(
  v: unknown,
): Omit<PushSubscription, "at"> | null {
  if (!v || typeof v !== "object") return null;
  const r = v as { endpoint?: unknown; keys?: Record<string, unknown> };
  if (typeof r.endpoint !== "string" || r.endpoint.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(r.endpoint);
  } catch {
    return null;
  }
  if (
    !(
      u.protocol === "https:" ||
      (u.protocol === "http:" && LOOPBACK.has(u.hostname))
    )
  )
    return null;
  const p256dh = r.keys?.p256dh;
  const auth = r.keys?.auth;
  const ok = (s: unknown, n: number) =>
    typeof s === "string" &&
    /^[A-Za-z0-9_-]+={0,2}$/.test(s) &&
    unb64u(s).length === n;
  if (!ok(p256dh, 65) || !ok(auth, 16)) return null;
  return {
    endpoint: u.toString(),
    p256dh: (p256dh as string).replace(/=+$/, ""),
    auth: (auth as string).replace(/=+$/, ""),
  };
}

/** The person's devices that get alerts by push. */
export class PushSubscriptions {
  constructor(private readonly stateDir: string) {}

  private get file() {
    return path.join(this.stateDir, SUBSCRIPTIONS_FILE);
  }

  list(): PushSubscription[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf-8")) as unknown;
      return Array.isArray(v)
        ? v
            .filter(
              (x): x is PushSubscription =>
                !!x &&
                typeof x.endpoint === "string" &&
                typeof x.p256dh === "string" &&
                typeof x.auth === "string",
            )
            .map((x) => ({
              ...x,
              device: typeof x.device === "string" ? x.device.slice(0, 32) : "",
              ...(typeof x.person === "string" && x.person
                ? { person: x.person.slice(0, 200) }
                : { person: undefined }),
            }))
        : [];
    } catch {
      return [];
    }
  }

  private save(list: PushSubscription[]): void {
    writePrivate(this.file, JSON.stringify(list));
  }

  add(
    s: Omit<PushSubscription, "at" | "device"> & { device?: string },
    now = new Date(),
  ): void {
    const list = this.list().filter((x) => x.endpoint !== s.endpoint);
    list.push({ ...s, at: now.toISOString() });
    this.save(list.slice(-MAX_SUBSCRIPTIONS));
  }

  remove(endpoint: string): boolean {
    const list = this.list();
    const left = list.filter((x) => x.endpoint !== endpoint);
    if (left.length === list.length) return false;
    this.save(left);
    return true;
  }
}

/** What a device's service worker gets (public/den-sw.js). */
export interface PushMessage {
  title: string;
  body: string;
  link: string;
  tag: string;
}

export interface PushOptions {
  subs: PushSubscriptions;
  keys: () => VapidKeys;
  subject: string;
  timeoutMs: number;
  ttlSeconds: number;
  fetch?: typeof fetch;
  only?: readonly string[];
}

/**
 * Send `msg` to every device. A gone one (404, 410) is dropped; any other
 * failure is left for the next alert. Resolves to each device's status
 * (0: no answer in time). Never throws.
 */
export async function pushAll(
  msg: PushMessage,
  o: PushOptions,
): Promise<number[]> {
  return (await pushEach(msg, o)).map((r) => r.status);
}

/** pushAll, saying which device each status is (a test alert's answer). */
export async function pushEach(
  msg: PushMessage,
  o: PushOptions,
): Promise<{ endpoint: string; status: number }[]> {
  const only = o.only ? new Set(o.only) : null;
  const list = o.subs.list().filter((s) => !only || only.has(s.endpoint));
  if (!list.length) return [];
  let keys: VapidKeys;
  try {
    keys = o.keys();
  } catch {
    return list.map((s) => ({ endpoint: s.endpoint, status: 0 }));
  }
  const f = o.fetch ?? fetch;
  const payload = Buffer.from(JSON.stringify(msg));
  return Promise.all(
    list.map(async (s) => {
      try {
        const r = await f(s.endpoint, {
          method: "POST",
          headers: {
            authorization: vapidAuth(s.endpoint, keys, o.subject),
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: String(o.ttlSeconds),
            urgency: "high",
          },
          body: new Uint8Array(encryptPayload(payload, s.p256dh, s.auth)),
          signal: AbortSignal.timeout(o.timeoutMs),
        });
        if (r.status === 404 || r.status === 410) o.subs.remove(s.endpoint);
        return { endpoint: s.endpoint, status: r.status };
      } catch {
        return { endpoint: s.endpoint, status: 0 };
      }
    }),
  );
}
