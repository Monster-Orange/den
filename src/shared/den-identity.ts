/**
 * Issue 455: whether an address reaches THIS Den. Accepting a connection
 * proves nothing (another proxy on port 80 answers too, with its own 404),
 * so the check is a challenge only this install can answer:
 *
 *   GET <address>/api/den-identity?c=<challenge>
 *   → 200 { "den": "identity", "answer": HMAC(key, challenge) }
 *
 * `key` is HMAC(web.secret, "den-identity-v1"): the server and this
 * machine's CLI both read web.secret (0600), nothing else does. The
 * challenge is fresh for every probe, so a recorded answer is no use.
 * The key is its own (domain separated), so the route is no oracle for
 * anything web.secret signs (sessions, person tokens, login codes).
 *
 * The probe goes where a browser would: a loopback name (localhost,
 * *.localhost) to both 127.0.0.1 and ::1, any other name to each address
 * it resolves to. Every one that answers must answer as this Den; at
 * least one must answer. What answered otherwise is kept (its status and
 * Server header) so Den can say what it was.
 */
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import * as dns from "dns";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import { isLoopbackName } from "./web-url-check.js";

export const DEN_IDENTITY_PATH = "/api/den-identity";
const KEY_CONTEXT = "den-identity-v1";
const CHALLENGE_RE = /^[0-9a-f]{32,128}$/;
/** The most of an answer read: an identity answer is ~100 bytes. */
const MAX_BODY = 16 * 1024;

/** The identity key, from web.secret. */
export function identityKey(secret: Buffer): Buffer {
  return createHmac("sha256", secret).update(KEY_CONTEXT).digest();
}

/** A fresh challenge (hex). */
export function newChallenge(): string {
  return randomBytes(16).toString("hex");
}

/** The answer to `challenge`, or null when it isn't one. */
export function identityAnswer(key: Buffer, challenge: unknown): string | null {
  if (typeof challenge !== "string" || !CHALLENGE_RE.test(challenge))
    return null;
  return createHmac("sha256", key).update(challenge).digest("hex");
}

/** The route's JSON for `challenge` (null: not a challenge, 400). */
export function identityBody(
  key: Buffer,
  challenge: unknown,
): { den: "identity"; answer: string } | null {
  const answer = identityAnswer(key, challenge);
  return answer ? { den: "identity", answer } : null;
}

/** A JSON object body, or null. */
function parseJson(body: string): { den?: unknown; answer?: unknown } | null {
  try {
    const v: unknown = JSON.parse(body);
    return v && typeof v === "object"
      ? (v as { den?: unknown; answer?: unknown })
      : null;
  } catch {
    return null;
  }
}

function answerMatches(key: Buffer, challenge: string, given: unknown) {
  const want = identityAnswer(key, challenge);
  if (!want || typeof given !== "string" || given.length !== want.length)
    return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(want));
}

/** What one address said. */
export type ProbeHit =
  /** It answered as this Den. */
  | { kind: "den"; at: string }
  /** Nothing listens there (refused). */
  | { kind: "refused"; at: string }
  /** Something answered, and it isn't this Den. */
  | {
      kind: "other";
      at: string;
      status: number;
      /** Its Server header, when it sent one ("nginx/1.27.3"). */
      server: string | null;
      /** It answered the challenge wrongly: another Den install. */
      otherDen: boolean;
    }
  /** No answer in time, or the connection failed otherwise. */
  | { kind: "error"; at: string; error: string };

export interface ProbeResult {
  /** Every address that answered, answered as this Den. */
  ok: boolean;
  /** The address probed (an origin). */
  url: string;
  hits: ProbeHit[];
  /** The first answer that isn't this Den, when there is one. */
  other: Extract<ProbeHit, { kind: "other" }> | null;
}

export interface ProbeOptions {
  key: Buffer;
  /** One request's limit (Settings: web.address_check_timeout_seconds). */
  timeoutMs: number;
  /** Tries after a first that timed out or failed (web.address_check_retries). */
  retries: number;
  /** The addresses a name resolves to (dns.lookup by default). */
  lookup?: (host: string) => Promise<string[]>;
}

async function lookupAll(host: string): Promise<string[]> {
  const r = await dns.promises.lookup(host, { all: true, verbatim: true });
  return r.map((a) => a.address);
}

/** Where a browser goes for `hostname`. */
export async function probeTargets(
  hostname: string,
  lookup: (host: string) => Promise<string[]> = lookupAll,
): Promise<string[]> {
  const h = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(h)) return [h];
  if (isLoopbackName(h)) return ["127.0.0.1", "::1"];
  try {
    return [...new Set(await lookup(h))];
  } catch {
    return [];
  }
}

function once(
  u: URL,
  at: string,
  key: Buffer,
  timeoutMs: number,
): Promise<ProbeHit> {
  const challenge = newChallenge();
  const lib = u.protocol === "https:" ? https : http;
  const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  return new Promise((resolve) => {
    let settled = false;
    const done = (h: ProbeHit) => {
      if (settled) return;
      settled = true;
      resolve(h);
    };
    const req = lib.request(
      {
        host: at,
        port,
        method: "GET",
        path: `${DEN_IDENTITY_PATH}?c=${challenge}`,
        agent: false,
        // The Host a browser sends: the name, with its port when not default.
        headers: { host: u.host, accept: "application/json" },
        timeout: timeoutMs,
        // TLS: the challenge proves who answers, not the certificate.
        ...(u.protocol === "https:"
          ? {
              servername: net.isIP(u.hostname) ? undefined : u.hostname,
              rejectUnauthorized: false,
            }
          : {}),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => {
          body += d;
          if (body.length > MAX_BODY) res.destroy();
        });
        const finish = () => {
          const j = parseJson(body);
          const status = res.statusCode ?? 0;
          if (
            status === 200 &&
            j?.den === "identity" &&
            answerMatches(key, challenge, j.answer)
          )
            return done({ kind: "den", at });
          const server = res.headers.server;
          done({
            kind: "other",
            at,
            status,
            server:
              typeof server === "string" && server.trim()
                ? server.trim().slice(0, 80)
                : null,
            otherDen: j?.den === "identity",
          });
        };
        res.on("end", finish);
        res.on("close", finish);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      done({ kind: "error", at, error: "no answer in time" });
    });
    req.on("error", (e: NodeJS.ErrnoException) =>
      done(
        e.code === "ECONNREFUSED" ||
          e.code === "EADDRNOTAVAIL" ||
          e.code === "ENETUNREACH" ||
          e.code === "EAFNOSUPPORT"
          ? { kind: "refused", at }
          : { kind: "error", at, error: e.code ?? e.message },
      ),
    );
    req.end();
  });
}

/**
 * Whether `url` (an origin) reaches the Den that holds `key`: every
 * address a browser could land on that answers, answers as this Den.
 */
export async function probeIdentity(
  url: string,
  o: ProbeOptions,
): Promise<ProbeResult> {
  const u = new URL(url);
  const origin = u.origin;
  const targets = await probeTargets(u.hostname, o.lookup);
  const hits: ProbeHit[] = [];
  for (const at of targets) {
    let h = await once(u, at, o.key, o.timeoutMs);
    for (let i = 0; i < o.retries && h.kind === "error"; i++)
      h = await once(u, at, o.key, o.timeoutMs);
    hits.push(h);
  }
  const other = (hits.find((h) => h.kind === "other") ??
    null) as ProbeResult["other"];
  const answered = hits.filter((h) => h.kind === "den" || h.kind === "other");
  const ok =
    answered.length > 0 &&
    answered.every((h) => h.kind === "den") &&
    !hits.some((h) => h.kind === "error");
  return { ok, url: origin, hits, other };
}
