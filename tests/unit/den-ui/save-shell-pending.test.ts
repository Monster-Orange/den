/**
 * Issue 394 (den-ui 0.11.0): a rail save no answer came back for is kept
 * (save-shell.js, opts.pending), and the next page lays it over the
 * server's copy (pendingOver), so an unpin made as the person clicks away
 * isn't undone by a page that reads the server first. Only while no
 * answer came back: a refused save is never kept. Never over a newer save
 * of the key from another device, never someone else's, never an old one.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  PENDING_MAX_AGE_MS,
  pendingOver,
  saveShell,
} from "../../../packages/den-ui/src/save-shell.js";

const g = globalThis as unknown as { fetch?: unknown };
const was = g.fetch;
afterEach(() => {
  g.fetch = was;
});

function memory() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}
const KEY = "den-shell-pending";
const store = (storage = memory(), who: string | null = "pat") => ({
  storage,
  key: KEY,
  who,
});
const PINS = [{ item: "billing", project: null }];
const OLD = [{ item: "shop", project: null }, ...PINS];

describe("saveShell keeps a save only while no answer came back", () => {
  it("no answer (the page went, the request failed): kept, and laid over the server's older copy", async () => {
    g.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    const s = store();
    expect(
      await saveShell("/s", { pins: PINS }, { changedAt: 1000, pending: s }),
    ).toBe(false);
    const over = pendingOver(
      s,
      { pins: OLD, collapsed: true },
      { pins: 500 },
      2000,
    );
    expect(over.shell).toEqual({ pins: PINS, collapsed: true });
    expect(over.resend).toEqual([{ patch: { pins: PINS }, at: 1000 }]);
  });

  it("saved: nothing is kept", async () => {
    g.fetch = () => Promise.resolve({ ok: true });
    const s = store();
    expect(
      await saveShell("/s", { pins: PINS }, { changedAt: 1000, pending: s }),
    ).toBe(true);
    expect(s.storage.raw.size).toBe(0);
  });

  it.each([400, 401, 403, 413])(
    "refused (%i): nothing is kept, and nothing is resent",
    async (status) => {
      g.fetch = () => Promise.resolve({ ok: false, status });
      const s = store();
      expect(
        await saveShell("/s", { pins: PINS }, { changedAt: 1000, pending: s }),
      ).toBe(false);
      expect(s.storage.raw.size).toBe(0);
      expect(pendingOver(s, { pins: OLD }, {}, 2000)).toEqual({
        shell: { pins: OLD },
        resend: [],
      });
    },
  );

  it("a later save of the same key, answered, doesn't clear an earlier one's entry by mistake", async () => {
    const s = store();
    g.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    await saveShell("/s", { pins: PINS }, { changedAt: 1000, pending: s });
    g.fetch = () => Promise.resolve({ ok: true });
    await saveShell("/s", { collapsed: true }, { changedAt: 1100, pending: s });
    expect(pendingOver(s, {}, {}, 2000).resend).toEqual([
      { patch: { pins: PINS }, at: 1000 },
    ]);
  });
});

describe("pendingOver drops what may not be laid over", () => {
  const kept = (
    s: ReturnType<typeof store>,
    at: number,
    who: string | null = "pat",
  ) =>
    s.storage.setItem(KEY, JSON.stringify({ pins: { value: PINS, at, who } }));

  it("the server has a newer save of the key (another device): the server's copy stands", () => {
    const s = store();
    kept(s, 1000);
    expect(pendingOver(s, { pins: OLD }, { pins: 1500 }, 2000)).toEqual({
      shell: { pins: OLD },
      resend: [],
    });
    expect(s.storage.raw.size).toBe(0);
  });

  it("someone else's save, once the page knows who is signed in", () => {
    const s = store(memory(), "sam");
    kept(s, 1000, "pat");
    expect(pendingOver(s, { pins: OLD }, {}, 2000).resend).toEqual([]);
    // Saved before the page knew who: once it knows, it can't tell, so dropped.
    const n = store(memory(), "sam");
    kept(n, 1000, null);
    expect(pendingOver(n, { pins: OLD }, {}, 2000).resend).toEqual([]);
    // Not yet known who: same browser, same install, still laid over.
    const t = store(memory(), null);
    kept(t, 1000, "pat");
    expect(pendingOver(t, { pins: OLD }, {}, 2000).shell.pins).toEqual(PINS);
  });

  it(`older than ${PENDING_MAX_AGE_MS / 60000} minutes, or from the future: dropped`, () => {
    const s = store();
    kept(s, 1000);
    expect(
      pendingOver(s, { pins: OLD }, {}, 1000 + PENDING_MAX_AGE_MS + 1).resend,
    ).toEqual([]);
    kept(s, 1000 + 2 * PENDING_MAX_AGE_MS);
    expect(pendingOver(s, { pins: OLD }, {}, 1000).resend).toEqual([]);
  });

  it("a broken store is nothing kept", () => {
    const s = store();
    s.storage.setItem(KEY, "{not json");
    expect(pendingOver(s, { pins: OLD }, {}, 2000)).toEqual({
      shell: { pins: OLD },
      resend: [],
    });
  });
});

describe("the age limit is the page's to give (Settings › web.shell_pending_minutes)", () => {
  it("maxAgeMs replaces the default", () => {
    const s = store();
    s.storage.setItem(
      KEY,
      JSON.stringify({ pins: { value: PINS, at: 1000, who: "pat" } }),
    );
    expect(
      pendingOver(s, { pins: OLD }, {}, 1000 + 61_000, 60_000).resend,
    ).toEqual([]);
    s.storage.setItem(
      KEY,
      JSON.stringify({ pins: { value: PINS, at: 1000, who: "pat" } }),
    );
    expect(
      pendingOver(
        s,
        { pins: OLD },
        {},
        1000 + PENDING_MAX_AGE_MS + 1,
        2 * PENDING_MAX_AGE_MS,
      ).resend,
    ).toHaveLength(1);
  });
});
