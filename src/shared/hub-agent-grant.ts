/**
 * Issue 249: the install's one grant that covers its agents. Connect
 * always sends agents=yes on Hub's /connect (a Hub that doesn't know the
 * field ignores it). After the token, Hub's whoami says whether the grant
 * took (its features name HUB_AGENT_GRANT_FEATURE); only then is it kept
 * as hub.agents_grant (user.yml). So a new install needs one Allow.
 *
 * An install whose grant didn't take (it connected to an older Hub) gets
 * ONE item in the person's attention list (Needs you) once Hub takes it:
 * "Reconnect to Hub so your agents sign their own work", which opens
 * Settings › Hub, where Connect is. It goes once the grant is in place,
 * Hub no longer takes it, or Hub is disconnected. Never a command.
 */
import type { NotificationStore } from "./notifications.js";

/** The whoami feature that says Hub takes agents=yes on /connect. */
export const HUB_AGENT_GRANT_FEATURE = "connect.agents";

const offered = new Map<string, boolean>();

/** What Hub's whoami said it carries, for Hub `url` (the latest wins). */
export function noteHubFeatures(
  url: string,
  features: readonly string[] | undefined,
): void {
  offered.set(url, !!features?.includes(HUB_AGENT_GRANT_FEATURE));
}

/** Whether Hub `url` said it takes agents=yes (false until it says so). */
export function hubOffersAgentGrant(url: string): boolean {
  return offered.get(url) === true;
}

/** Forget what Hubs said (tests). */
export function forgetHubFeatures(): void {
  offered.clear();
}

/** The one attention item's subject. */
export const AGENT_GRANT_NOTE_SUBJECT = "record:hub-agent-grant";

/** Where the item goes: Settings › Hub, where Connect is. */
export const AGENT_GRANT_NOTE_LINK = "/settings#agents.hub";

/**
 * Post or take back the reconnect item. Posted once: a read one that is
 * still true is never posted again.
 */
export function syncAgentGrantNote(
  store: Pick<NotificationStore, "add" | "remove" | "list">,
  s: { connected: boolean; offered: boolean; granted: boolean },
): void {
  const mine = (n: { subject: string }) =>
    n.subject === AGENT_GRANT_NOTE_SUBJECT;
  if (!(s.connected && s.offered && !s.granted)) {
    store.remove(mine);
    return;
  }
  if (store.list().some(mine)) return;
  store.add({
    kind: "waiting",
    subject: AGENT_GRANT_NOTE_SUBJECT,
    scope: "workspace/den-server",
    text: "Reconnect to Hub so your agents sign their own work",
    msg: { key: "bell.m.hubAgentsReconnect", vars: {} },
    link: AGENT_GRANT_NOTE_LINK,
  });
}
