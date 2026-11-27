/**
 * Issue 581: Hub's "shared with you" items in Den's bell. Hub sends a
 * notification of kind "shared" with bounded data and no text; Den keeps
 * the data and writes the words itself, in en, es and ja. Invented names.
 *
 *  - "shared" is a kind, under the "Shared with you" switch;
 *  - artifact.slug (128), artifact.title (200), actor.login (64),
 *    actor.kind (agent | person), note (1000): cut, control characters out;
 *    no slug or no login: dropped;
 *  - "<actor> shared <title> with you" (+ the note); an agent reads as one;
 *  - the link only when https on the connected Hub's origin; otherwise
 *    Hub's home.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  NotificationStore,
  bellView,
  parseHubNote,
  switchOf,
} from "../../../src/shared/notifications.js";
import { syncHubNotes } from "../../../src/shared/hub/hub-notes-sync.js";
import { enCatalog, langCatalog } from "../server/helpers/en-catalog.js";

const HUB = "https://hub.example.test";

const shared = (over: Record<string, unknown> = {}) => ({
  id: "n_1",
  kind: "shared",
  subject: "record:artifact/pricing-mock",
  scope: "hub/web",
  at: "2026-11-22T10:00:00Z",
  link: `${HUB}/a/pricing-mock`,
  readBy: [] as string[],
  data: {
    artifact: { slug: "pricing-mock", title: "Pricing mock" },
    actor: { login: "kim", kind: "person" },
  },
  ...over,
});
const withData = (data: Record<string, unknown>) =>
  shared({ data: { ...shared().data, ...data } });

const fill = (tpl: string, vars: Record<string, unknown>) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`));

describe("issue 581: a shared item from Hub", () => {
  it("is kind shared, under the Shared with you switch, not Needs you", () => {
    const n = parseHubNote(shared(), HUB);
    expect(n?.kind).toBe("shared");
    expect(switchOf("shared")).toBe("shared");
  });

  it("Den writes the words: a person, an agent, with a note", () => {
    const p = parseHubNote(shared(), HUB);
    expect(p?.msg).toEqual({
      key: "bell.m.shared",
      vars: { actor: "kim", title: "Pricing mock" },
    });
    expect(p?.text).toBe("kim shared Pricing mock with you");
    const a = parseHubNote(
      withData({ actor: { login: "quiet-scribe", kind: "agent" } }),
      HUB,
    );
    expect(a?.msg?.key).toBe("bell.m.sharedAgent");
    const n = parseHubNote(withData({ note: "Look at the tiers." }), HUB);
    expect(n?.msg).toEqual({
      key: "bell.m.sharedNote",
      vars: { actor: "kim", title: "Pricing mock", note: "Look at the tiers." },
    });
  });

  it("the words in en, es and ja", () => {
    const keys = [
      "bell.m.shared",
      "bell.m.sharedNote",
      "bell.m.sharedAgent",
      "bell.m.sharedAgentNote",
    ];
    const vars = { actor: "kim", title: "Pricing mock", note: "Look." };
    for (const c of [enCatalog(), langCatalog("es"), langCatalog("ja")])
      for (const k of keys) {
        expect(typeof c[k]).toBe("string");
        const said = fill(String(c[k]), vars);
        expect(said).toContain("kim");
        expect(said).toContain("Pricing mock");
        if (k.endsWith("Note")) expect(said).toContain("Look.");
      }
    expect(fill(enCatalog()["bell.m.shared"] as string, vars)).toBe(
      "kim shared Pricing mock with you",
    );
  });

  it("oversized fields are cut, control characters cleaned", () => {
    const p = parseHubNote(
      withData({
        artifact: {
          slug: "s".repeat(300),
          title: "T\u0007it\u001b[31mle" + "x".repeat(400),
        },
        actor: { login: "k".repeat(100), kind: "person" },
        note: "n".repeat(2000),
      }),
      HUB,
    );
    expect(p).not.toBeNull();
    const v = p!.msg!.vars;
    expect(String(v.actor)).toHaveLength(64);
    expect(String(v.title).length).toBeLessThanOrEqual(200);
    // eslint-disable-next-line no-control-regex
    expect(String(v.title)).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(String(v.title).startsWith("T it [31mle")).toBe(true);
    expect(String(v.note).length).toBeLessThanOrEqual(1000);
  });

  it("an item missing its slug or its login is dropped", () => {
    expect(
      parseHubNote(withData({ artifact: { title: "x" } }), HUB),
    ).toBeNull();
    expect(
      parseHubNote(withData({ actor: { kind: "person" } }), HUB),
    ).toBeNull();
    expect(parseHubNote(shared({ data: undefined }), HUB)).toBeNull();
  });

  it("a link to another origin is not used: Hub's home instead", () => {
    expect(parseHubNote(shared(), HUB)?.link).toBe(`${HUB}/a/pricing-mock`);
    for (const link of [
      "https://elsewhere.example.test/a/pricing-mock",
      "http://hub.example.test/a/pricing-mock",
      "javascript:alert(1)",
      `${HUB}.evil.test/a`,
    ])
      expect(parseHubNote(shared({ link }), HUB)?.link).toBe(`${HUB}/`);
  });
});

describe("issue 581: in the bell", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-581-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("a sync keeps Den's words; the switch turns it off", async () => {
    const store = new NotificationStore(dir);
    await syncHubNotes({
      store,
      hubUrl: HUB,
      owner: () => "pat",
      list: async () => ({ items: [shared()] }),
      markRead: async (ids) => ids.length,
    });
    const items = store.list().filter((n) => n.kind === "shared");
    expect(items).toHaveLength(1);
    expect(items[0].msg?.key).toBe("bell.m.shared");
    expect(items[0].link).toBe(`${HUB}/a/pricing-mock`);
    const on = bellView(
      items,
      { off: [], foldDays: 7 },
      Date.parse("2026-11-22T11:00:00Z"),
    );
    expect(on.updates).toHaveLength(1);
    expect(on.recent).toHaveLength(0);
    const off = bellView(
      items,
      { off: ["shared"], foldDays: 7 },
      Date.parse("2026-11-22T11:00:00Z"),
    );
    expect([...off.recent, ...off.updates, ...off.older]).toHaveLength(0);
  });

  it("the page's bell shows it under the same switch", async () => {
    const { switchOf: pageSwitch } =
      await import("../../../src/ui/server/public/bell.js");
    expect(pageSwitch("shared")).toBe("shared");
  });
});
