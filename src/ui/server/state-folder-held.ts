import { hubUrlProblem } from "../../shared/hub-url.js";
import type { HeldCheck } from "./approval-routes.js";
import type { AskedBy } from "./approvals.js";

export interface StateFolderOwnDeps {
  shared: () => boolean;
  give: () => string;
  carryOn: (dir: string, hub: string) => void;
  restart: (
    reason: string,
    asked?: AskedBy,
  ) => Promise<{ ok: boolean; restarting?: boolean; error?: string }>;
}

type Line = [string, { key: string; vars?: Record<string, string> }];

export function checkStateFolderOwn(
  d: StateFolderOwnDeps,
  a: Record<string, unknown>,
): HeldCheck {
  const hub = typeof a.hub === "string" ? a.hub.trim().replace(/\/+$/, "") : "";
  if (hub) {
    const bad = hubUrlProblem(hub);
    if (bad) return { ok: false, error: bad.replace("hub.url", "hub") };
  }
  if (!d.shared())
    return {
      ok: false,
      error: "this install's state folder is its own already",
    };
  const lines: Line[] = [
    [
      "A new, empty state folder for this install, beside the shared one.",
      { key: "ap.sf.new" },
    ],
    [
      "Nothing is copied or moved: its agents, sign-ins and history stay with the other copy, and you sign in to this Den again.",
      { key: "ap.sf.empty" },
    ],
    [
      "The other copy keeps the shared folder as it is.",
      { key: "ap.sf.other" },
    ],
    hub
      ? [
          `Den restarts on its own folder, then carries on with Connect to ${hub}.`,
          { key: "ap.sf.restart", vars: { hub } },
        ]
      : ["Den restarts on its own folder.", { key: "ap.sf.restartNone" }],
  ];
  return {
    ok: true,
    personOnly: true,
    args: hub ? { hub } : {},
    summary: "give this install its own state folder",
    params: {},
    details: lines.map(([l]) => l),
    detailKeys: lines.map(([, k]) => k),
  };
}

export async function runStateFolderOwn(
  d: StateFolderOwnDeps,
  a: Record<string, unknown>,
  asked?: AskedBy,
): Promise<unknown> {
  const dir = d.give();
  const hub = typeof a.hub === "string" ? a.hub : "";
  if (hub) d.carryOn(dir, hub);
  const r = await d.restart("this install now has its own state folder", asked);
  return r.ok
    ? {
        ok: true,
        next: "Den restarts on this install's own state folder. Sign in again, and Connect carries on.",
      }
    : { ok: false, error: r.error ?? "Den couldn't restart itself" };
}
