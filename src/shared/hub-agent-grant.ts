/**
 * Issue 249: the install's one grant that covers its agents. Connect
 * always sends agents=yes on Hub's /connect (a Hub that doesn't know the
 * field ignores it), so a new install needs one Allow.
 *
 * Whether this install's grant covers its agents, Den learns only from
 * Hub's mint answer: 403 agents_not_covered (an install connected before
 * agent grants). Whoami's connect.agents feature only says Hub CAN do
 * agent grants; it says nothing about this install's grant, so Den never
 * reads it as coverage.
 *
 * On agents_not_covered Den marks the install not covered (a small file in
 * the server's state, no token), asks Hub no more until the install
 * connects again, and posts ONE item in the person's attention list (Needs
 * you): "Reconnect to Hub so your agents sign their own work", which opens
 * Settings › Hub, where Connect is. Connect and Disconnect clear the mark
 * and take the item back. Never a command.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";
import type { NotificationStore } from "./notifications.js";

/** Hub's mint refusal (403): the install's grant doesn't cover agents. */
export const AGENTS_NOT_COVERED = "agents_not_covered";

/**
 * Hub's mint refusal (403): the install's grant lacks the agents-manage
 * permission. Handled as AGENTS_NOT_COVERED: the fix is the same Connect.
 */
export const AGENTS_MANAGE_MISSING = "agents_manage_missing";

/** The refusals a new Connect fixes: one reconnect item, no retry. */
export const RECONNECT_CODES: readonly string[] = [
  AGENTS_NOT_COVERED,
  AGENTS_MANAGE_MISSING,
];

/** Hub's mint refusal (403): an agent's own token asked to mint (a Den bug). */
export const INSTALL_TOKEN_REQUIRED = "install_token_required";

const markOf = (stateDir: string) =>
  path.join(stateDir, "hub", "agents-not-covered.json");

/** Hub `url` said agents_not_covered: no mints until the install reconnects. */
export function markAgentsNotCovered(stateDir: string, url: string): void {
  const f = markOf(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeFileAtomic(
    f,
    JSON.stringify({ hubUrl: url, at: new Date().toISOString() }) + "\n",
    { mode: 0o600 },
  );
}

/** Whether Hub `url` said this install's grant doesn't cover agents. */
export function agentsNotCovered(stateDir: string, url: string): boolean {
  try {
    const v = JSON.parse(fs.readFileSync(markOf(stateDir), "utf8")) as {
      hubUrl?: unknown;
    } | null;
    return v?.hubUrl === url;
  } catch {
    return false;
  }
}

/** The install connected (or disconnected): the next mint asks again. */
export function clearAgentsNotCovered(stateDir: string): void {
  fs.rmSync(markOf(stateDir), { force: true });
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
  s: { connected: boolean; notCovered: boolean },
): void {
  const mine = (n: { subject: string }) =>
    n.subject === AGENT_GRANT_NOTE_SUBJECT;
  if (!(s.connected && s.notCovered)) {
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
