/**
 * Issue 1333: each "sign in from another computer" request's start and end,
 * for the activity trail (verb `signin-request`) and doctor's count. A line
 * names the request by its public handle (ref), the browser, where it came
 * from and the Den address it opened, and how it ended. Never its code or
 * its poll id: those let a device in.
 */
import { promises as dns } from "dns";
import type { PairEvent } from "./pair-requests.js";

export {
  SIGNIN_REQUEST_VERB,
  signinRequestCounts,
} from "../../shared/signin-request-count.js";

/** The trail's line for one event (start or end). */
export function pairEventDetail(e: PairEvent): string {
  if (e.event === "end") return `end ${e.ref}: ${e.outcome ?? "ended"}`;
  const from = e.clientName
    ? `${e.clientName} (${e.client ?? "?"})`
    : (e.client ?? "an unknown address");
  return `start ${e.ref}: ${e.device} from ${from}${e.host ? `, opened ${e.host}` : ""}${e.link ? ", from a sign-in link" : ""}`;
}

/** A mesh address: 100.64.0.0/10 (CGNAT, as mesh VPNs hand out), or fd7a:115c:a1e0::/48. */
export function isMeshAddress(a: string): boolean {
  const v4 = /^(?:::ffff:)?100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (v4) return Number(v4[1]) >= 64 && Number(v4[1]) <= 127;
  return /^fd7a:115c:a1e0:/i.test(a);
}

/**
 * Issue 1333: a mesh address's device name, by a reverse lookup (a mesh
 * DNS answers with the device's name), within `timeoutMs`; null for any
 * other address, or none found.
 */
export async function meshNameOf(
  client: string,
  o: {
    reverse?: (a: string) => Promise<string[]>;
    timeoutMs?: number;
  } = {},
): Promise<string | null> {
  if (!isMeshAddress(client)) return null;
  const reverse = o.reverse ?? ((a: string) => dns.reverse(a));
  const addr = client.replace(/^::ffff:/, "");
  let timer: NodeJS.Timeout | undefined;
  try {
    const names = await Promise.race([
      reverse(addr),
      new Promise<string[]>((res) => {
        timer = setTimeout(() => res([]), o.timeoutMs ?? 1500);
        timer.unref?.();
      }),
    ]);
    const n = String(names[0] ?? "").replace(/\.$/, "");
    return /^[A-Za-z0-9.-]{1,253}$/.test(n) ? n : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
