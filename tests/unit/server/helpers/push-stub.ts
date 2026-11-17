/**
 * Issue 172: a local push endpoint for tests, never a real push service.
 * It plays a device: its own P-256 key pair and auth secret (what a
 * browser's PushSubscription holds), and an HTTP server on loopback that
 * takes each push, checks its VAPID header and decrypts it (RFC 8291).
 */
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface Received {
  headers: http.IncomingHttpHeaders;
  /** The decrypted payload, or null when it didn't decrypt. */
  text: string | null;
  /** Whether the VAPID JWT verified against the key it names. */
  vapidOk: boolean;
  /** The JWT's claims. */
  claims: Record<string, unknown> | null;
}

/** Decrypt an aes128gcm body for the device holding `ecdh` and `auth`. */
export function decrypt(
  body: Buffer,
  ecdh: ReturnType<typeof createECDH>,
  auth: Buffer,
): string | null {
  try {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen);
    const data = body.subarray(21 + idlen);
    const uaPublic = ecdh.getPublicKey();
    const shared = ecdh.computeSecret(asPublic);
    const keyInfo = Buffer.concat([
      Buffer.from("WebPush: info\0"),
      uaPublic,
      asPublic,
    ]);
    const ikm = Buffer.from(hkdfSync("sha256", shared, auth, keyInfo, 32));
    const cek = Buffer.from(
      hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16),
    );
    const nonce = Buffer.from(
      hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12),
    );
    const d = createDecipheriv("aes-128-gcm", cek, nonce);
    d.setAuthTag(data.subarray(data.length - 16));
    const plain = Buffer.concat([
      d.update(data.subarray(0, data.length - 16)),
      d.final(),
    ]);
    // One record: the payload, then the last-record delimiter (2).
    if (plain[plain.length - 1] !== 2) return null;
    return plain.subarray(0, plain.length - 1).toString("utf-8");
  } catch {
    return null;
  }
}

/** Check `vapid t=<jwt>, k=<key>`; the claims, and whether it verified. */
export function checkVapid(header: string | undefined): {
  ok: boolean;
  claims: Record<string, unknown> | null;
} {
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(
    header ?? "",
  );
  if (!m) return { ok: false, claims: null };
  const [, h, c, sig, k] = m;
  const raw = Buffer.from(k, "base64url");
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
  const ok = verify(
    "sha256",
    Buffer.from(`${h}.${c}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(sig, "base64url"),
  );
  return {
    ok,
    claims: JSON.parse(Buffer.from(c, "base64url").toString("utf-8")) as Record<
      string,
      unknown
    >,
  };
}

export interface PushStub {
  /** A PushSubscription.toJSON() for this device. */
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  received: Received[];
  /** The status the next pushes get (201 by default). */
  answer: number;
  close(): Promise<void>;
}

export async function startPushStub(): Promise<PushStub> {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const stub = {
    received: [] as Received[],
    answer: 201,
  } as PushStub;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const v = checkVapid(req.headers.authorization);
      stub.received.push({
        headers: req.headers,
        text: decrypt(Buffer.concat(chunks), ecdh, auth),
        vapidOk: v.ok,
        claims: v.claims,
      });
      res.writeHead(stub.answer);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  stub.subscription = {
    endpoint: `http://127.0.0.1:${port}/push/device-1`,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
  };
  stub.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
  return stub;
}
