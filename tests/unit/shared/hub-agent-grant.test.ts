import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { NotificationStore } from "../../../src/shared/notifications.js";
import * as grant from "../../../src/shared/hub-agent-grant.js";
import {
  AGENT_GRANT_NOTE_SUBJECT,
  agentsNotCovered,
  clearAgentsNotCovered,
  markAgentsNotCovered,
  syncAgentGrantNote,
} from "../../../src/shared/hub-agent-grant.js";
import { readHubConfig } from "../../../src/shared/hub.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-249-grant-"));
  dirs.push(d);
  return d;
};
const store = () => new NotificationStore(tmp());
const HUB = "https://hub.example.test";

describe("issue 249 (b): coverage comes from the mint, never from whoami's feature", () => {
  it("connect.agents in whoami is a capability only: Den keeps no 'grant took' from it", () => {
    expect(Object.keys(grant)).not.toEqual(
      expect.arrayContaining(["noteHubFeatures"]),
    );
    expect(Object.keys(grant)).not.toEqual(
      expect.arrayContaining(["hubOffersAgentGrant"]),
    );
    const c = readHubConfig(
      { hub: { url: HUB } },
      { hub: { agents_grant: true } },
      () => ({}) as never,
    ) as unknown as Record<string, unknown>;
    expect(c.agentsGrant).toBeUndefined();
  });

  it("not covered: marked per Hub address by the mint's 403, kept across restarts, cleared by a new connect", () => {
    const d = tmp();
    expect(agentsNotCovered(d, HUB)).toBe(false);
    markAgentsNotCovered(d, HUB);
    expect(agentsNotCovered(d, HUB)).toBe(true);
    expect(agentsNotCovered(d, "https://other.example.test")).toBe(false);
    const f = fs.readdirSync(path.join(d, "hub"));
    expect(f).toHaveLength(1);
    clearAgentsNotCovered(d);
    expect(agentsNotCovered(d, HUB)).toBe(false);
  });
});

describe("issue 249 (c): one attention item to reconnect", () => {
  it("the mint said agents_not_covered: ONE needs-you item that opens Settings › Hub; never a command", () => {
    const s = store();
    const st = { connected: true, notCovered: true };
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
    s.markRead({ subject: AGENT_GRANT_NOTE_SUBJECT });
    syncAgentGrantNote(s, st);
    expect(
      s.list().filter((n) => n.subject === AGENT_GRANT_NOTE_SUBJECT),
    ).toHaveLength(1);
    expect(JSON.stringify(s.list())).not.toMatch(/`|\bden \w+ /);
  });

  it("goes once the mint no longer says so (a new connect) or Hub isn't connected; none is posted then", () => {
    for (const st of [
      { connected: true, notCovered: false },
      { connected: false, notCovered: true },
    ]) {
      const s = store();
      syncAgentGrantNote(s, { connected: true, notCovered: true });
      syncAgentGrantNote(s, st);
      expect(
        s.list().filter((n) => n.subject === AGENT_GRANT_NOTE_SUBJECT),
      ).toEqual([]);
    }
  });
});
