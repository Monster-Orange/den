/**
 * NT-6: Hub's notifications in Den's bell, read both ways, against a
 * fake Hub and a temp state dir. Invented names only.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  NotificationStore,
  parseHubNote,
} from "../../../src/shared/notifications.js";
import { syncHubNotes } from "../../../src/shared/hub-notes-sync.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-hubnotes-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const note = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  source: "hub",
  kind: "mention",
  subject: `thread:th_${id}`,
  scope: "hub/web/main",
  text: `Kim mentioned you on Pricing page (${id})`,
  link: `https://hub.example.test/a/pricing#th_${id}`,
  at: "2026-11-13T10:00:00Z",
  readBy: [] as string[],
  ...over,
});

function rig(items: () => unknown[], owner: string | null = "pat") {
  const store = new NotificationStore(dir);
  const marked: string[][] = [];
  let failMark = false;
  return {
    store,
    marked,
    failMark: (v: boolean) => (failMark = v),
    pass: () =>
      syncHubNotes({
        store,
        owner: () => owner,
        list: async () => ({ items: items() }),
        markRead: async (ids) => {
          if (failMark) throw new Error("Hub answered 503");
          marked.push(ids);
          return ids.length;
        },
      }),
  };
}

const hubItems = (s: NotificationStore) =>
  s.list().filter((n) => n.source === "hub");

describe("NT-6: Hub's notifications in the bell", () => {
  it("adds Hub's items, unread unless the owner read them on Hub; Den's own are left alone", async () => {
    let items = [note("n1"), note("n2", { readBy: ["Pat"] })];
    const r = rig(() => items);
    r.store.add({
      kind: "waiting",
      subject: "agent:a1",
      scope: "workspace/web",
      text: "a1 waits",
    });
    expect(await r.pass()).toEqual({ ok: true, items: 2, pushed: 0 });
    const h = hubItems(r.store);
    expect(h.map((n) => [n.id, n.read, n.scope, n.link])).toEqual([
      [
        "hub:n1",
        false,
        "hub/web/main",
        "https://hub.example.test/a/pricing#th_n1",
      ],
      [
        "hub:n2",
        true,
        "hub/web/main",
        "https://hub.example.test/a/pricing#th_n2",
      ],
    ]);
    // Read on Hub later: read here on the next pass.
    items = [note("n1", { readBy: ["pat"] }), note("n2", { readBy: ["pat"] })];
    await r.pass();
    expect(hubItems(r.store).every((n) => n.read)).toBe(true);
    // Hub stops listing n2: it goes. Den's own item stays.
    items = [note("n1", { readBy: ["pat"] })];
    await r.pass();
    expect(hubItems(r.store).map((n) => n.id)).toEqual(["hub:n1"]);
    expect(r.store.list().some((n) => n.subject === "agent:a1")).toBe(true);
  });

  it("read in Den: told to Hub once; a failed tell is tried again on the next pass", async () => {
    const r = rig(() => [note("n1")]);
    await r.pass();
    r.store.markRead({ id: "hub:n1" });
    r.failMark(true);
    expect((await r.pass()).pushed).toBe(0);
    r.failMark(false);
    expect((await r.pass()).pushed).toBe(1);
    expect(r.marked).toEqual([["n1"]]);
    // Hub's list still says unread for a moment: no second tell, and it stays read.
    expect((await r.pass()).pushed).toBe(0);
    expect(hubItems(r.store)[0].read).toBe(true);
  });

  it("read, then newer activity on Hub's item: unread again", async () => {
    let items = [note("n1")];
    const r = rig(() => items);
    await r.pass();
    r.store.markRead({ id: "hub:n1" });
    await r.pass();
    items = [
      note("n1", { at: "2026-11-13T11:00:00Z", text: "Kim replied again" }),
    ];
    await r.pass();
    const n = hubItems(r.store)[0];
    expect([n.read, n.text]).toEqual([false, "Kim replied again"]);
  });

  it("owner unknown: items shown, reads never pushed or pulled", async () => {
    const r = rig(() => [note("n1", { readBy: ["pat"] })], null);
    await r.pass();
    expect(hubItems(r.store)[0].read).toBe(false);
    r.store.markRead({ id: "hub:n1" });
    expect((await r.pass()).pushed).toBe(0);
    expect(r.marked).toEqual([]);
  });

  it("Hub doesn't answer: the bell stays as it was", async () => {
    const store = new NotificationStore(dir);
    const lines: string[] = [];
    const p = await syncHubNotes({
      store,
      owner: () => "pat",
      list: async () => {
        throw new Error("Hub could not be reached");
      },
      markRead: async () => 0,
      log: (l) => lines.push(l),
    });
    expect(p.ok).toBe(false);
    expect(lines[0]).toContain("Hub didn't list them");
  });

  it("a muted Hub project's new items are left out", async () => {
    const r = rig(() => [note("n1")]);
    r.store.mute("hub/web/main", 60);
    await r.pass();
    expect(hubItems(r.store)).toEqual([]);
  });

  it("parseHubNote: only Hub's own kinds and subjects, an https link, a real time", () => {
    expect(parseHubNote(note("ok"))).not.toBeNull();
    expect(parseHubNote(note("k", { kind: "spam" }))).toBeNull();
    expect(parseHubNote(note("s", { subject: "file:/etc/passwd" }))).toBeNull();
    expect(parseHubNote(note("t", { at: "soon" }))).toBeNull();
    expect(
      parseHubNote(note("l", { link: "javascript:alert(1)" }))?.link,
    ).toBeUndefined();
    expect(
      parseHubNote(note("h", { link: "http://hub.example.test/x" }))?.link,
    ).toBeUndefined();
  });
});
