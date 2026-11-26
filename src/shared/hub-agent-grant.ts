import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "./atomic-write.js";
import type { NotificationStore } from "./notifications.js";

export function bestEffort(f: () => unknown): void {
  try {
    f();
  } catch {
    return;
  }
}

export const AGENTS_NOT_COVERED = "agents_not_covered";

export const AGENTS_MANAGE_MISSING = "agents_manage_missing";

export const RECONNECT_CODES: readonly string[] = [
  AGENTS_NOT_COVERED,
  AGENTS_MANAGE_MISSING,
];

export const INSTALL_TOKEN_REQUIRED = "install_token_required";

const markOf = (stateDir: string) =>
  path.join(stateDir, "hub", "agents-not-covered.json");

export function markAgentsNotCovered(stateDir: string, url: string): void {
  const f = markOf(stateDir);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeFileAtomic(
    f,
    JSON.stringify({ hubUrl: url, at: new Date().toISOString() }) + "\n",
    { mode: 0o600 },
  );
}

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

export function clearAgentsNotCovered(stateDir: string): void {
  fs.rmSync(markOf(stateDir), { force: true });
}

export const AGENT_GRANT_NOTE_SUBJECT = "record:hub-agent-grant";

export const AGENT_GRANT_NOTE_LINK = "/settings#agents.hub";

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
