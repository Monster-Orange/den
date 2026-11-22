/**
 * #267: the Den agent's held write hub_connect. Set, change or clear Hub's
 * address through the same code as Settings › Hub's Save: the check
 * (patchHubUrl), the person's Allow, the write to user.yml, a disconnect
 * from the old Hub first when connected (so it revokes its token), and a
 * restart so every check and agent reads it anew. The token still needs
 * the person's own Connect, in a browser: the agent never handles one.
 */
import { isServerScope } from "../../shared/agents/server-agent.js";
import { patchHubUrl } from "../../shared/hub.js";
import type { HeldOpCheck } from "../cli/agent-ops.js";
import type { HeldAsker } from "./approval-routes.js";

export interface HubAddressDeps {
  readUser: () => Record<string, unknown>;
  writeUser: (user: Record<string, unknown>) => void;
  /** Revoke on the connected Hub (force: remove here anyway). */
  disconnect: (
    force: boolean,
  ) => Promise<{ ok: boolean; error?: string; message?: string }>;
  /**
   * Issue 726: the address was written: the old Hub's state is archived
   * and its bell items go (hub-change.ts noteHub).
   */
  changed?: (url: string | null) => Promise<unknown>;
  /** Restart Den after answering. */
  restart: (reason: string) => Promise<{ ok: boolean; error?: string }>;
}

const current = (user: Record<string, unknown>): string => {
  const hub = user.hub as Record<string, unknown> | undefined;
  return typeof hub?.url === "string" ? hub.url.replace(/\/+$/, "") : "";
};
const connected = (user: Record<string, unknown>): boolean =>
  !!(user.hub as Record<string, unknown> | undefined)?.token;

/** "none" or empty clears; anything else is an address to check. */
function wanted(a: Record<string, unknown>): string | null {
  const v = typeof a.url === "string" ? a.url.trim() : "";
  return !v || v === "none" ? null : v;
}

export function checkHubAddress(
  d: Pick<HubAddressDeps, "readUser">,
  a: Record<string, unknown>,
  who?: HeldAsker,
): HeldOpCheck<{ url: string | null }> {
  if (who?.project && !isServerScope(who.project))
    return {
      ok: false,
      error: `Hub's address is the whole install's: Den's own agent or a person sets it, not ${who.agent ?? "a project's agent"}`,
    };
  const user = structuredClone(d.readUser());
  const was = current(user);
  const p = patchHubUrl(user, wanted(a));
  if (!p.ok) return p;
  if (p.url === (was || null))
    return {
      ok: false,
      error: p.url
        ? `Hub's address is already ${p.url}; nothing to change`
        : "no Hub address is set; nothing to clear",
    };
  const leaving = connected(d.readUser());
  // Issue 205: each Review line with its message key.
  type Line = [string, { key: string; vars?: Record<string, string> }];
  const lines: Line[] = [
    p.url
      ? was
        ? [
            `Hub's address: ${was} → ${p.url}.`,
            { key: "ap.det.hub_connect.set", vars: { was, url: p.url } },
          ]
        : [
            `Hub's address: none → ${p.url}.`,
            { key: "ap.det.hub_connect.setNew", vars: { url: p.url } },
          ]
      : [
          `Hub's address ${was} is cleared; this Den stops using Hub.`,
          { key: "ap.det.hub_connect.clear", vars: { was } },
        ],
    ...(leaving
      ? [
          [
            "Den disconnects from the Hub it uses now first, so that Hub revokes its key.",
            { key: "ap.det.hub_connect.leave" },
          ] as Line,
        ]
      : []),
    [
      "Then Den restarts, and agents get Hub's tools when they next restart.",
      { key: "ap.det.hub_connect.restart" },
    ],
    ...(p.url
      ? [
          [
            "You connect in Settings › Hub afterwards: Connect signs you in to Hub there.",
            { key: "ap.det.hub_connect.connect" },
          ] as Line,
        ]
      : []),
  ];
  return {
    ok: true,
    // A different Hub, or none: agents lose Hub's tools until Connect.
    personOnly: true,
    args: { url: p.url },
    summary: p.url ? `set Hub's address to ${p.url}` : "clear Hub's address",
    params: { url: p.url ?? "", was },
    details: lines.map((l) => l[0]),
    detailKeys: lines.map((l) => l[1]),
  };
}

export async function runHubAddress(
  d: HubAddressDeps,
  a: Record<string, unknown>,
): Promise<{
  ok: boolean;
  url?: string | null;
  error?: string;
  next?: string;
}> {
  const target = wanted(a);
  if (connected(d.readUser()))
    await d
      .disconnect(false)
      .then((r) => (r.ok ? r : d.disconnect(true)))
      .catch(() => d.disconnect(true))
      .catch(() => undefined);
  const user = d.readUser();
  const p = patchHubUrl(user, target);
  if (!p.ok) return p;
  d.writeUser(user);
  await d.changed?.(p.url).catch(() => undefined);
  const r = await d.restart(
    p.url ? `Hub's address set to ${p.url}` : "Hub's address cleared",
  );
  if (!r.ok) return { ok: false, url: p.url, error: r.error };
  return {
    ok: true,
    url: p.url,
    next: p.url
      ? "Saved; Den is restarting. Tell your person to Connect in Settings › Hub: Connect signs them in to Hub, and agents get Hub's tools after."
      : "Cleared; Den is restarting without Hub.",
  };
}
