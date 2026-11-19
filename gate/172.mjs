// Live check for #172: when an agent needs the person, an alert goes out beyond the bell, in the bell's words.
// One bed stub agent, made as gate-172-wait and removed in teardown. No page is open on it, so it alerts.
// The phone: this check is a device of its own. It subscribes a push endpoint it serves on this machine
// (http on loopback, which Den accepts for a local stub) with its own keys, and must receive Den's Web Push
// for the alert: VAPID-signed with the install's served key, encrypted for its keys (RFC 8291), and
// decrypting to the alert's words and link. The real push service and a real phone are beyond the bed.
// Unsubscribed and closed in teardown.
import {
  createECDH,
  createDecipheriv,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import http from "node:http";

export const issue = 172;
export const clauses = [
  "when an agent needs the person, they are told on the desktop, not only in the bell",
  "they are told on a phone",
  "it follows the approval policy (#160): people see what they watch or what is critical",
];
export const timeoutMs = 90000;
const ID = "gate-172-wait";
const SECRET = "gate-172-tool-line";

const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url");

/** A device of the check's own: a loopback push endpoint and its keys. */
async function device() {
  const ecdh = createECDH("prime256v1");
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got.push({
        path: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks),
      });
      res.writeHead(201);
      res.end();
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const tag = randomBytes(6).toString("hex");
  const endpoint = `http://127.0.0.1:${server.address().port}/push/${tag}`;
  return { ecdh, pub, auth, got, server, endpoint };
}

/** One push as the device reads it: RFC 8291 aes128gcm, one record. */
function decryptPush(d, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const shared = d.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    d.pub,
    asPublic,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, d.auth, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12),
  );
  const dc = createDecipheriv("aes-128-gcm", cek, nonce);
  dc.setAuthTag(ct.subarray(ct.length - 16));
  let plain = Buffer.concat([
    dc.update(ct.subarray(0, ct.length - 16)),
    dc.final(),
  ]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  if (plain[end - 1] !== 2) throw new Error("no record delimiter");
  plain = plain.subarray(0, end - 1);
  return JSON.parse(plain.toString("utf-8"));
}

/** The VAPID header: its key is the served one, its token signed by it, for this endpoint. */
function checkVapid(header, servedKey, endpoint) {
  const m = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(
    String(header || ""),
  );
  if (!m) return { ok: false, why: "no vapid header" };
  const [head, claims, sig] = m[1].split(".");
  if (m[2] !== servedKey) return { ok: false, why: "k is not the served key" };
  const pt = unb64u(m[2]);
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: b64u(pt.subarray(1, 33)),
      y: b64u(pt.subarray(33, 65)),
    },
    format: "jwk",
  });
  const signed = verify(
    "sha256",
    Buffer.from(`${head}.${claims}`),
    { key, dsaEncoding: "ieee-p1363" },
    unb64u(sig),
  );
  let c = {};
  try {
    c = JSON.parse(unb64u(claims).toString("utf-8"));
  } catch {
    /* unreadable */
  }
  const aud = c.aud === new URL(endpoint).origin;
  return {
    ok: signed && aud,
    why: signed ? (aud ? "" : `aud ${c.aud}`) : "bad signature",
  };
}

export async function setup(ctx) {
  const a = ctx.agent(ID);
  a.start("tester");
  return { runMs: await a.running(20000) };
}

let dev = null;

export async function run(ctx, s) {
  const a = ctx.agent(ID);
  // The phone: subscribed before anything needs the person.
  const key = await ctx.api("/api/alerts/push-key");
  const served = typeof key?.publicKey === "string" ? key.publicKey : null;
  let subscribed = null;
  if (served) {
    dev = await device();
    const r = await ctx.api("/api/alerts/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subscription: {
          endpoint: dev.endpoint,
          keys: { p256dh: b64u(dev.pub), auth: b64u(dev.auth) },
        },
      }),
    });
    subscribed = r?.ok === true;
  }
  await ctx.sleep(2500);
  const before = await ctx.api("/api/alerts");
  const seq = Number.isInteger(before.seq) ? before.seq : 0;
  a.permissionRequest("Bash", { command: `echo ${SECRET}` });
  const raiseMs = await ctx.until(
    async () => (await a.waiting("permission")).length > 0,
    10000,
  );
  let mine = [];
  const alertMs = await ctx.until(async () => {
    const r = await ctx.api(`/api/alerts?after=${seq}`);
    mine = (r.alerts || []).filter((x) =>
      String(x.link || "").includes(`agent=${ID}`),
    );
    return mine.length > 0;
  }, 10000);
  // The push for this alert, at the check's own endpoint.
  const pushes = [];
  if (dev) {
    const pushMs = await ctx.until(async () => dev.got.length > 0, 15000);
    for (const p of dev.got) {
      const row = {
        status: "received",
        encoding: p.headers["content-encoding"] || null,
      };
      try {
        row.vapid = checkVapid(p.headers.authorization, served, dev.endpoint);
        const msg = decryptPush(dev, p.body);
        row.msg = { title: msg.title, body: msg.body, link: msg.link };
        row.leak = JSON.stringify(msg).includes(SECRET);
      } catch (e) {
        row.error = String(e?.message ?? e);
      }
      pushes.push(row);
    }
    pushes.ms = pushMs;
  }
  return {
    ...s,
    feedOk: before.ok === true,
    raiseMs,
    alertMs,
    alerts: mine.map((x) => ({
      why: x.why,
      title: x.title,
      body: x.body,
      link: x.link,
    })),
    leaks: mine.some((x) => JSON.stringify(x).includes(SECRET)),
    pushKey: !!served && served.length > 20,
    phone: { subscribed, pushes, pushMs: pushes.ms ?? null },
  };
}

export function expect(r) {
  const one = r.alerts.length === 1 ? r.alerts[0] : null;
  return [
    {
      clause: clauses[0],
      ok:
        r.feedOk &&
        r.raiseMs !== null &&
        r.alertMs !== null &&
        !!one &&
        one.why === "permission" &&
        /needs your permission/.test(one.body || "") &&
        !r.leaks,
      detail: `feed ${r.feedOk ? "answers" : "missing"}; wait raised ${r.raiseMs} ms; ${r.alerts.length} alert(s) after ${r.alertMs} ms: ${r.alerts.map((a) => `${a.why} "${a.body}" → ${a.link}`).join(" | ") || "none"}; tool line in the alert: ${r.leaks}`,
    },
    phoneRow(r),
    {
      clause: clauses[2],
      ok: null,
      skip: "needs-watched-item",
      detail:
        "needs a watched or critical item and a held write the policy holds for the person; the bed has neither",
    },
  ];
}

/** Clause 2: Den's Web Push reached the check's own subscribed device, signed and readable. */
function phoneRow(r) {
  const p = r.phone;
  if (!r.pushKey || !p)
    return {
      clause: clauses[1],
      ok: null,
      skip: "needs-push-key",
      detail: "this install serves no push key",
    };
  const mine = (p.pushes || []).filter((x) =>
    String(x.msg?.link || "").includes(`agent=${ID}`),
  );
  const good = mine.filter(
    (x) =>
      x.encoding === "aes128gcm" &&
      x.vapid?.ok === true &&
      /needs your permission/.test(x.msg?.body || "") &&
      !x.leak,
  );
  return {
    clause: clauses[1],
    ok:
      p.subscribed === true && good.length >= 1 && mine.length === good.length,
    detail:
      `a device of the check's own (loopback endpoint, its own keys): subscribed ${p.subscribed}; ` +
      `${(p.pushes || []).length} push(es) after ${p.pushMs} ms; ` +
      (p.pushes || [])
        .map((x) =>
          x.error
            ? `unreadable: ${x.error}`
            : `${x.encoding}, VAPID ${x.vapid?.ok ? "signed by the served key" : x.vapid?.why}: "${x.msg?.body}" → ${x.msg?.link}${x.leak ? " (tool line leaked)" : ""}`,
        )
        .join(" | ") +
      "; the real push service and a phone are beyond the bed",
  };
}

export async function teardown(ctx) {
  if (dev) {
    await ctx
      .api("/api/alerts/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: dev.endpoint }),
      })
      .catch(() => {});
    await new Promise((ok) => dev.server.close(ok));
    dev = null;
  }
  if (ctx.agent(ID).state()) ctx.agent(ID).remove();
}
