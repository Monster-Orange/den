/**
 * Issue 142, clause 4: a held write waiting on the person's Allow counts in
 * the bell. Every pending held write is one "decision" item (it needs the
 * person), whoever asked; Den's own update ask already has its item, so it
 * never gets a second. The item goes once the request is no longer
 * pending (Allow, Deny, expiry, withdrawn, or a restart that ended it).
 * Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  bellView,
  NotificationStore,
} from "../../../src/shared/notifications.js";
import type { Approval } from "../../../src/ui/server/approvals.js";
import { syncHeldBell } from "../../../src/ui/server/held-bell.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-heldbell-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const held = (id: string, over: Partial<Approval> = {}): Approval => ({
  id,
  actor: "agent:north-planner",
  agent: "north-planner",
  action: "workspace_create",
  args: { name: "orchard" },
  summary: 'create the workspace "orchard"',
  requestedAt: 1,
  expiresAt: 2,
  state: "pending",
  ...over,
});

const heldItems = (s: NotificationStore) =>
  s.list().filter((n) => n.subject.startsWith("record:held-"));

describe("syncHeldBell", () => {
  it("an agent's pending held write is one counted decision item, linked to the agent", () => {
    const s = new NotificationStore(tmp());
    syncHeldBell(s, [held("aaaaaaaaaaaaaaaa")], {
      projectOf: () => "north",
    });
    const items = heldItems(s);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "decision",
      subject: "record:held-aaaaaaaaaaaaaaaa",
      scope: "workspace/north",
      read: false,
      msg: {
        key: "bell.m.heldAllow",
        vars: { name: "north-planner", what: 'create the workspace "orchard"' },
      },
    });
    expect(items[0].link).toBe("/agents?project=north&agent=north-planner");
    // It needs the person: in the badge, not under Updates.
    const v = bellView(s.list(), { off: [], foldDays: 7 } as never);
    expect(v.recent.map((n) => n.subject)).toContain(
      "record:held-aaaaaaaaaaaaaaaa",
    );
    expect(v.unread).toBeGreaterThanOrEqual(1);
  });

  it("a person's own held write counts too, linked to a page where the Allow opens", () => {
    const s = new NotificationStore(tmp());
    syncHeldBell(
      s,
      [held("bbbbbbbbbbbbbbbb", { actor: "person:pat", agent: undefined })],
      {},
    );
    const [n] = heldItems(s);
    expect(n).toMatchObject({
      kind: "decision",
      scope: "workspace/den-server",
      msg: { key: "bell.m.heldAllowAsk" },
    });
    expect(n.link).toBe("/agents");
  });

  it("Den's own update ask never gets a second item", () => {
    const s = new NotificationStore(tmp());
    syncHeldBell(
      s,
      [
        held("cccccccccccccccc", {
          actor: "den:update-check",
          agent: undefined,
          action: "den_update",
        }),
      ],
      {},
    );
    expect(heldItems(s)).toEqual([]);
  });

  it("one held write is one item, however often it is synced, and a read one is not raised again", () => {
    const s = new NotificationStore(tmp());
    const p = [held("dddddddddddddddd")];
    syncHeldBell(s, p, {});
    syncHeldBell(s, p, {});
    expect(heldItems(s)).toHaveLength(1);
    s.markRead({ subject: "record:held-dddddddddddddddd" } as never);
    syncHeldBell(s, p, {});
    expect(heldItems(s)).toHaveLength(1);
    expect(heldItems(s)[0].read).toBe(true);
  });

  it("no longer pending (allowed, denied, expired, withdrawn): its item goes", () => {
    const s = new NotificationStore(tmp());
    syncHeldBell(s, [held("eeeeeeeeeeeeeeee"), held("ffffffffffffffff")], {});
    syncHeldBell(s, [held("ffffffffffffffff")], {});
    expect(heldItems(s).map((n) => n.subject)).toEqual([
      "record:held-ffffffffffffffff",
    ]);
  });

  it("after a restart (the queue is empty, the store is on disk): never two, and the stale one goes", () => {
    const dir = tmp();
    syncHeldBell(new NotificationStore(dir), [held("gggggggggggggggg")], {});
    // The same request still pending after a restart: still one item.
    syncHeldBell(new NotificationStore(dir), [held("gggggggggggggggg")], {});
    expect(heldItems(new NotificationStore(dir))).toHaveLength(1);
    // The restart ended it (the queue lives in memory): the item goes.
    syncHeldBell(new NotificationStore(dir), [], {});
    expect(heldItems(new NotificationStore(dir))).toEqual([]);
  });

  it("leaves every other item alone", () => {
    const s = new NotificationStore(tmp());
    s.add({
      kind: "service",
      subject: "record:approval-hhhhhhhhhhhhhhhh",
      scope: "workspace/north",
      text: "north-planner did this without your Allow",
    });
    syncHeldBell(s, [], {});
    expect(s.list()).toHaveLength(1);
  });
});
