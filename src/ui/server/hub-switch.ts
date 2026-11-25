/**
 * Issue 1632 part 1: a switch to another Hub, waiting for the person's
 * sign-in there. hub_connect's Allow records it here and changes nothing
 * else: the old address and its token stay in use. Connect (with no typed
 * address) then goes to `to`; a code the new Hub exchanges swaps the
 * address and revokes the old token (hub-connect.ts finishOnce); any
 * failure leaves the install on `from`, and the bell says why.
 *
 * <state>/hub/switch.json, 0600, so it outlives a restart. Never a token.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../../shared/atomic-write.js";
import { hubUrlProblem } from "../../shared/hub.js";

export interface HubSwitch {
  /** The Hub the person allowed Den to move to. */
  to: string;
  /** The Hub in use when they allowed it; Den stays on it till sign-in. */
  from: string;
  /** ISO 8601: when the switch was allowed. */
  at: string;
}

export const hubSwitchFile = (stateDir: string): string =>
  path.join(stateDir, "hub", "switch.json");

/** The pending switch, or null (none, unreadable, or not https addresses). */
export function readHubSwitch(stateDir: string): HubSwitch | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(hubSwitchFile(stateDir), "utf-8"),
    ) as Record<string, unknown>;
    const { to, from, at } = raw ?? {};
    if (typeof to !== "string" || typeof from !== "string") return null;
    if (typeof at !== "string") return null;
    if (hubUrlProblem(to) || hubUrlProblem(from)) return null;
    return { to, from, at };
  } catch {
    return null;
  }
}

export function saveHubSwitch(stateDir: string, s: HubSwitch): void {
  const f = hubSwitchFile(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeFileAtomic(
    f,
    JSON.stringify({ to: s.to, from: s.from, at: s.at }) + "\n",
    { mode: 0o600 },
  );
}

export function clearHubSwitch(stateDir: string): void {
  fs.rmSync(hubSwitchFile(stateDir), { force: true });
}

/** The bell's one row for a switch (a record:hub- subject: a Hub change clears it). */
export const HUB_SWITCH_SUBJECT = "record:hub-switch";
const SETTINGS_HUB = "/settings#agents.hub";

/** Waiting for the sign-in, or (with `why`) the sign-in failed. */
export function switchBell(s: HubSwitch, why?: string) {
  return why
    ? {
        kind: "waiting" as const,
        subject: HUB_SWITCH_SUBJECT,
        scope: "workspace/den-server",
        text: `Den couldn't switch to ${s.to}: ${why}. It stays on ${s.from}; sign in again in Settings › Hub.`,
        msg: {
          key: "bell.m.hubSwitchFailed",
          vars: { to: s.to, from: s.from, why },
        },
        link: SETTINGS_HUB,
      }
    : {
        kind: "waiting" as const,
        subject: HUB_SWITCH_SUBJECT,
        scope: "workspace/den-server",
        text: `Sign in to ${s.to} to finish switching Hubs; Den stays on ${s.from} until then.`,
        msg: { key: "bell.m.hubSwitchWaits", vars: { to: s.to, from: s.from } },
        link: SETTINGS_HUB,
      };
}

type Bell = {
  add: (n: ReturnType<typeof switchBell>) => unknown;
  remove: (m: (n: { subject: string }) => boolean) => number;
};

/**
 * hub_connect's Allow: keep the switch on disk and say in the bell what
 * the person does next. Nothing about the Hub in use changes.
 */
export function beginHubSwitch(
  d: { stateDir: string; bell: Bell },
  s: HubSwitch,
): void {
  saveHubSwitch(d.stateDir, s);
  d.bell.add(switchBell(s));
}

/**
 * The sign-in ended. ok: the switch is done (the Hub change archived the
 * old Hub's state and its bell rows). Else the install is still on the old
 * Hub: the switch stays, so the person can sign in again, and the bell
 * says why.
 */
export function endHubSwitch(
  d: { stateDir: string; bell: Bell },
  r: { ok: boolean; why?: string },
): void {
  const s = readHubSwitch(d.stateDir);
  if (r.ok) {
    clearHubSwitch(d.stateDir);
    d.bell.remove((n) => n.subject === HUB_SWITCH_SUBJECT);
    return;
  }
  if (s) d.bell.add(switchBell(s, r.why || "the sign-in didn't finish"));
}

/** The running install's store and state dir. */
export async function hubSwitchDeps(): Promise<{
  stateDir: string;
  bell: Bell;
}> {
  const [paths, notes] = await Promise.all([
    import("../../shared/paths.js"),
    import("./notification-service.js"),
  ]);
  return {
    stateDir: paths.getStateDir(),
    bell: notes.notificationDeps().store as unknown as Bell,
  };
}
