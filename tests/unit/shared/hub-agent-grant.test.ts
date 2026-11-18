/**
 * Issue 249 (b, c): whether Hub takes agents=yes on /connect (from its
 * whoami features), and the one attention item an install connected
 * before that gets: "Reconnect to Hub so your agents sign their own
 * work", which opens Settings › Hub (Connect). Temp dirs only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NotificationStore } from "../../../src/shared/notifications.js";
import {
  AGENT_GRANT_NOTE_SUBJECT,
  HUB_AGENT_GRANT_FEATURE,
  forgetHubFeatures,
  hubOffersAgentGrant,
  noteHubFeatures,
  syncAgentGrantNote,
} from "../../../src/shared/hub-agent-grant.js";
import { readHubConfig } from "../../../src/shared/hub.js";

const dirs: string[] = [];
afterEach(() => {
  forgetHubFeatures();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const store = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-249-grant-"));
  dirs.push(d);
  return new NotificationStore(d);
};
const HUB = "https://hub.example.test";

describe("issue 249 (b): does Hub take agents=yes?", () => {
  it("only when its whoami features name it, per Hub address; never by default", () => {
    expect(hubOffersAgentGrant(HUB)).toBe(false);
    noteHubFeatures(HUB, ["deliveries.all_comments"]);
    expect(hubOffersAgentGrant(HUB)).toBe(false);
    noteHubFeatures(HUB, ["deliveries.all_comments", HUB_AGENT_GRANT_FEATURE]);
    expect(hubOffersAgentGrant(HUB)).toBe(true);
    expect(hubOffersAgentGrant("https://other.example.test")).toBe(false);
    noteHubFeatures(HUB, undefined);
    expect(hubOffersAgentGrant(HUB)).toBe(false);
  });

  it("hub.agents_grant (Connect writes it) is read as a boolean, false by default", () => {
    const rd = (u: Record<string, unknown>) =>
      readHubConfig({ hub: { url: HUB } }, { hub: u }, () => ({}) as never);
    expect(rd({})?.agentsGrant).toBe(false);
    expect(rd({ agents_grant: true })?.agentsGrant).toBe(true);
    expect(() => rd({ agents_grant: "yes" })).toThrow("hub.agents_grant");
  });
});

describe("issue 249 (c): one attention item to reconnect", () => {
  it("connected before agents=yes, and Hub takes it: ONE needs-you item that opens Settings › Hub; never a command", () => {
    const s = store();
    const st = { connected: true, offered: true, granted: false };
    syncAgentGrantNote(s, st);
    syncAgentGrantNote(s, st);
    const items = s
      .list()
      .filter((n) => n.subject === AGENT_GRANT_NOTE_SUBJECT);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "waiting",
      text: "Reconnect to Hub so your agents sign their own work",
      msg: { key: "bell.m.hubAgentsReconnect", vars: {} },
      link: "/settings#agents.hub",
    });
    // Read, and still not reconnected: not posted again.
    s.markRead({ subject: AGENT_GRANT_NOTE_SUBJECT });
    syncAgentGrantNote(s, st);
    expect(
      s.list().filter((n) => n.subject === AGENT_GRANT_NOTE_SUBJECT),
    ).toHaveLength(1);
    expect(JSON.stringify(s.list())).not.toMatch(/`|\bden \w+ /);
  });

  it("goes once the grant is in place, Hub doesn't take it, or Hub isn't connected; none is posted then", () => {
    for (const st of [
      { connected: true, offered: true, granted: true },
      { connected: true, offered: false, granted: false },
      { connected: false, offered: true, granted: false },
    ]) {
      const s = store();
      syncAgentGrantNote(s, { connected: true, offered: true, granted: false });
      syncAgentGrantNote(s, st);
      expect(
        s.list().filter((n) => n.subject === AGENT_GRANT_NOTE_SUBJECT),
      ).toEqual([]);
    }
  });
});
