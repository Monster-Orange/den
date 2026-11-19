// A fake bed for gate/172.mjs (tests/unit/test-infra/gate-172-runner.test.ts):
// a fake Den's alert feed, its push key and subscriptions, and one stub
// agent. When the agent waits on a permission, the fake Den alerts and
// sends Web Push to every subscription the way Den does (RFC 8291
// aes128gcm, VAPID RFC 8292), over real loopback HTTP. `push`:
//   "good":     as Den does;
//   "none":     no push is sent;
//   "unsigned": signed with a key other than the one served;
//   "garbled":  encrypted for other keys (the device can't read it);
//   "leak":     the alert's words carry the agent's tool line.
// Invented names only.
import {
  createCipheriv,
  createECDH,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

function vapidKey() {
  const { privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = privateKey.export({ format: "jwk" });
  return {
    key: privateKey,
    publicKey: b64u(
      Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]),
    ),
  };
}

function vapidAuth(endpoint, keys, served) {
  const enc = (o) => b64u(Buffer.from(JSON.stringify(o)));
  const head = enc({ typ: "JWT", alg: "ES256" });
  const claims = enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: "mailto:den@example.invalid",
  });
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), {
    key: keys.key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${served}`;
}

function encrypt(payload, p256dh, auth) {
  const uaPublic = unb64u(p256dh);
  const ecdh = createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    uaPublic,
    asPublic,
  ]);
  const ikm = Buffer.from(
    hkdfSync("sha256", shared, unb64u(auth), keyInfo, 32),
  );
  const salt = randomBytes(16);
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12),
  );
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    c.update(Buffer.concat([payload, Buffer.from([2])])),
    c.final(),
    c.getAuthTag(),
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

export function fakeBed({ push = "good" } = {}) {
  const served = vapidKey();
  const other = vapidKey();
  const subs = new Map();
  const alerts = [];
  let seq = 0;
  let agent = null;
  let waiting = [];
  const removed = [];

  async function alert(id, tool) {
    const a = {
      seq: ++seq,
      why: "permission",
      title: "Den",
      body: `${id} needs your permission${push === "leak" ? `: ${tool}` : ""}`,
      link: `/agents?project=default&agent=${id}`,
    };
    alerts.push(a);
    if (push === "none") return;
    const payload = Buffer.from(
      JSON.stringify({
        title: a.title,
        body: a.body,
        link: a.link,
        tag: String(a.seq),
      }),
    );
    for (const s of subs.values()) {
      const keys =
        push === "garbled"
          ? {
              p256dh: b64u(createECDH("prime256v1").generateKeys()),
              auth: b64u(randomBytes(16)),
            }
          : s;
      await fetch(s.endpoint, {
        method: "POST",
        headers: {
          authorization: vapidAuth(
            s.endpoint,
            push === "unsigned" ? other : served,
            served.publicKey,
          ),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(encrypt(payload, keys.p256dh, keys.auth)),
      }).catch(() => {});
    }
  }

  const ctx = {
    url: "http://bed.invalid",
    async sleep() {},
    async until(f, ms) {
      const end = Date.now() + Math.min(ms, 3000);
      for (let i = 0; Date.now() < end; i++) {
        if (await f()) return i * 50;
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    },
    async api(p, init) {
      const ok = (b) => ({ ok: true, ...b });
      if (p === "/api/alerts/push-key")
        return ok({ publicKey: served.publicKey });
      if (p === "/api/alerts/subscribe") {
        const b = JSON.parse(init.body);
        const s = b.subscription;
        subs.set(s.endpoint, { endpoint: s.endpoint, ...s.keys });
        return ok({});
      }
      if (p === "/api/alerts/unsubscribe") {
        const b = JSON.parse(init.body);
        return ok({ removed: subs.delete(b.endpoint) });
      }
      if (p.startsWith("/api/alerts")) {
        const after = Number(
          new URL(p, "http://x").searchParams.get("after") ?? seq,
        );
        return ok({ seq, alerts: alerts.filter((a) => a.seq > after) });
      }
      return { ok: false };
    },
    agent(id) {
      return {
        start() {
          agent = id;
        },
        async running() {
          return 10;
        },
        permissionRequest(tool, input) {
          waiting = ["permission"];
          void alert(id, input?.command ?? tool);
        },
        async waiting() {
          return waiting;
        },
        state() {
          return agent ? { id: agent } : null;
        },
        remove() {
          removed.push(agent);
          agent = null;
        },
      };
    },
  };
  return { ctx, subsLeft: () => subs.size, removed };
}
