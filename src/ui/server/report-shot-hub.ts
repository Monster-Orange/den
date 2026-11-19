/**
 * Issue 403: every Hub call about a report's screenshot, in one place, so
 * how Hub stores and shares it can change without Den changing.
 *
 *   preflight(target)   GET  <hub>PREFLIGHT_PATH?target=<owner/name>
 *                       → { ok, share, recipient, why? } | { ok: false, reason }
 *   upload(png, { draftId, targetRepo })
 *                       POST <hub>UPLOAD_PATH, the raw masked PNG, with
 *                       X-Den-Report: <draft id> (Hub keeps one per id) and
 *                       X-Den-Target: <owner/name>
 *                       201 → { ok, id, tool, sha256, expires, recipient,
 *                       confirmed } (sha256 64 hex, expires a date; confirmed:
 *                       Hub's sha256 is the one of the bytes sent)
 *                       else { ok: false, why, status? }
 *
 * Both with the install's connection Bearer (as the project sync and the
 * deliveries call Hub). Nothing here throws, and nothing logs the token or
 * the image: a failure is an outcome the filing falls back from.
 */

import { createHash } from "crypto";

/** Hub's answer to "would a screenshot for this repo be shared?". */
export const PREFLIGHT_PATH =
  "/api/installs/self/reports/screenshots/preflight";
/** Where a report's masked screenshot is sent. */
export const UPLOAD_PATH = "/api/installs/self/reports/screenshots";
/** The largest screenshot Hub takes. */
export const MAX_SHOT_BYTES = 6 * 1024 * 1024;

export type Preflight =
  | { ok: true; share: boolean; recipient: string; why?: string }
  | {
      ok: false;
      reason: "not-connected" | "bad-target" | "unreachable" | "refused";
    };

/** Why an upload didn't happen: each a plain, non-fatal outcome. */
export type UploadWhy =
  | "not-connected"
  | "unreachable"
  | "off"
  | "not-maintained"
  | "not-a-person"
  | "refused"
  | "conflict"
  | "too-big"
  | "not-png"
  | "limit";

export type Upload =
  | {
      ok: true;
      id: string;
      tool: string;
      sha256: string;
      expires: string;
      recipient: string;
      /** Hub's sha256 is the one of the bytes Den sent. */
      confirmed: boolean;
    }
  | { ok: false; why: UploadWhy; status?: number };

export interface ReportShotHubDeps {
  /** Hub's address and this install's token, or null when not connected. */
  hub: () => Promise<{ url: string; token: string } | null>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const TARGET = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HUB_403_WHY = new Set(["off", "not-maintained", "not-a-person"]);
const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;

export function reportShotHub(d: ReportShotHubDeps) {
  const timeout = d.timeoutMs ?? 10_000;
  const call = async (
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; body: Record<string, unknown> } | null> => {
    try {
      const res = await (d.fetch ?? fetch)(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
      let body: Record<string, unknown> = {};
      try {
        const v = (await res.json()) as unknown;
        if (v && typeof v === "object") body = v as Record<string, unknown>;
      } catch {
        /* not JSON */
      }
      return { status: res.status, body };
    } catch {
      return null;
    }
  };
  const hubOf = async () => {
    try {
      return await d.hub();
    } catch {
      return null;
    }
  };

  return {
    async preflight(targetRepo: string): Promise<Preflight> {
      if (!TARGET.test(targetRepo)) return { ok: false, reason: "bad-target" };
      const at = await hubOf();
      if (!at) return { ok: false, reason: "not-connected" };
      const r = await call(
        `${at.url}${PREFLIGHT_PATH}?target=${encodeURIComponent(targetRepo)}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${at.token}`,
            Accept: "application/json",
          },
        },
      );
      if (!r || r.status >= 500) return { ok: false, reason: "unreachable" };
      const recipient = str(r.body.recipient);
      if (r.status !== 200 || typeof r.body.share !== "boolean" || !recipient)
        return { ok: false, reason: "refused" };
      const why = str(r.body.why);
      return {
        ok: true,
        share: r.body.share,
        recipient: recipient.slice(0, 200),
        ...(why ? { why } : {}),
      };
    },

    async upload(
      png: Buffer,
      o: { draftId: string; targetRepo: string },
    ): Promise<Upload> {
      if (png.length > MAX_SHOT_BYTES) return { ok: false, why: "too-big" };
      if (!png.subarray(0, 8).equals(PNG_MAGIC))
        return { ok: false, why: "not-png" };
      if (!TARGET.test(o.targetRepo)) return { ok: false, why: "refused" };
      const at = await hubOf();
      if (!at) return { ok: false, why: "not-connected" };
      const r = await call(`${at.url}${UPLOAD_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${at.token}`,
          Accept: "application/json",
          "Content-Type": "image/png",
          "X-Den-Report": o.draftId,
          "X-Den-Target": o.targetRepo,
        },
        body: new Uint8Array(png),
      });
      if (!r) return { ok: false, why: "unreachable" };
      const { status, body } = r;
      if (status === 201) {
        const id = str(body.id);
        const tool = str(body.tool);
        const sha256 = str(body.sha256);
        const expires = str(body.expires);
        const recipient = str(body.recipient);
        if (
          id &&
          tool &&
          sha256 &&
          SHA256.test(sha256) &&
          expires &&
          expires.length <= 64 &&
          Number.isFinite(Date.parse(expires)) &&
          recipient
        )
          return {
            ok: true,
            id,
            tool,
            sha256: sha256.toLowerCase(),
            expires,
            recipient: recipient.slice(0, 200),
            confirmed:
              sha256.toLowerCase() ===
              createHash("sha256").update(png).digest("hex"),
          };
        return { ok: false, why: "refused", status };
      }
      const why: UploadWhy =
        status === 403
          ? HUB_403_WHY.has(String(body.why))
            ? (body.why as UploadWhy)
            : "refused"
          : status === 409
            ? "conflict"
            : status === 413
              ? "too-big"
              : status === 415
                ? "not-png"
                : status === 429
                  ? "limit"
                  : status >= 500
                    ? "unreachable"
                    : "refused";
      return { ok: false, why, status };
    },
  };
}

export type ReportShotHub = ReturnType<typeof reportShotHub>;
