/**
 * Issue 367: the contact Web Push gives the push services (VAPID's
 * subject, RFC 8292), shared by the server (web-push.ts) and doctor.
 */
import { isLoopbackName } from "./web-url-check.js";

/**
 * Issue 367: the contact for an install with no https address. Some push
 * services refuse it (a phone may then get nothing); doctor says so.
 */
export const PUSH_CONTACT_FALLBACK = "mailto:alerts@localhost";

/**
 * Issue 367: who the push services may contact about this install's
 * pushes (VAPID's subject, RFC 8292): its address (web.url) when that is
 * https on a name other devices reach, else the mailto fallback.
 * `accepted`: whether push services take it as given.
 */
export function pushContact(webUrl: string | null | undefined): {
  subject: string;
  accepted: boolean;
} {
  try {
    const u = new URL(String(webUrl ?? ""));
    if (u.protocol === "https:" && !isLoopbackName(u.hostname))
      return { subject: u.origin, accepted: true };
  } catch {
    /* none, or not an address */
  }
  return { subject: PUSH_CONTACT_FALLBACK, accepted: false };
}
