/**
 * Issue 142's live check (gate/142.mjs) on a bed whose agents.max_concurrent
 * is 4 (the default) with one other agent already running: it must never
 * have so many of its own stubs running that the next start is refused.
 * On 11-18 it kept the perm, ask and turnq stubs running, so the idle
 * stub's start was refused and every clause errored. A refused start
 * must say so, naming the cap.
 * A fake ctx (no bed, no browser), in a child node: the gate file is ESM.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

/** Runs gate/142's setup and run on a fake bed; its answer as JSON. */
function runGate(opts: { max: number; others: number }) {
  const js = `
    const g = await import("./gate/142.mjs");
    const MAX = ${opts.max}, OTHERS = ${opts.others};
    const running = new Set();
    let peak = 0, refused = 0;
    const said = new Map(); // agent -> "needs" | "update"
    const reads = new Map(); // idle agent's update, read this many times
    const settings = { bell_kinds: { finished: false } };
    const item = (name, kind) => ({ id: name + kind, subject: "agent:" + name, kind, read: false, link: "/agents?agent=" + name });
    const bell = () => {
      const needs = [], updates = [];
      for (const [name, k] of said) {
        if (k === "needs") needs.push(item(name, "waiting"));
        else {
          const n = (reads.get(name) ?? 0) + 1;
          reads.set(name, n);
          if (n <= 3) updates.push(item(name, "finished"));
        }
      }
      const groups = (l) => [{ scope: "workspace/w", subjects: l.map((n) => ({ subject: n.subject, items: [n] })) }];
      return { unread: needs.length, waiting: [], groups: groups(needs), updates: { count: updates.length, groups: groups(updates) } };
    };
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const ctx = {
      page: null,
      url: "http://bed.invalid",
      api: async (p) => ok(p === "/api/settings" ? settings : p === "/api/notifications" ? bell() : { ok: true }),
      agent: async (name) => ({
        id: name,
        start() {
          if (running.size + OTHERS >= MAX) {
            refused++;
            return { code: 1, out: "", err: "", all: "✗ " + MAX + " agents are running and agents.max_concurrent is " + MAX };
          }
          running.add(name);
          peak = Math.max(peak, running.size);
          return { code: 0, out: "started", err: "", all: "started" };
        },
        running: async () => (running.has(name) ? 10 : null),
        stop: async () => { running.delete(name); return { code: 0 }; },
        remove: async () => { running.delete(name); return { code: 0 }; },
        sessionStart: async () => {},
        print: async () => {},
        idlePrompt: async () => {},
        permissionRequest: async () => { said.set(name, "needs"); },
        askHuman: async () => { said.set(name, "needs"); },
        hook: async (ev, input) => {
          if (ev === "Stop") said.set(name, /\\?$/.test(input.last_assistant_message ?? "") ? "needs" : "update");
        },
      }),
    };
    let error = null;
    try {
      const state = await g.setup(ctx);
      await g.run(ctx, state);
      await g.teardown(ctx, state);
    } catch (e) { error = String(e?.message ?? e); }
    console.log(JSON.stringify({ peak, refused, error }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    peak: number;
    refused: number;
    error: string | null;
  };
}

describe("gate/142.mjs under agents.max_concurrent", () => {
  it("max 4, one other agent running: no start refused, never more than 2 of its own running", () => {
    const r = runGate({ max: 4, others: 1 });
    expect(r).toEqual({ peak: expect.any(Number), refused: 0, error: null });
    expect(r.peak).toBeLessThanOrEqual(2);
  }, 120_000);

  it("a refused start throws at once, naming the cap", () => {
    const r = runGate({ max: 1, others: 1 });
    expect(r.error).toMatch(/max_concurrent/);
    expect(r.error).toMatch(/gate142-perm-/);
  }, 120_000);
});

/**
 * Gate 93's setup on a fake bed: its "turns" stub must end two turns with
 * the Stop hook (never ctl.stop(), which stops the agent), so the turns
 * row exists and no wait runs out (WAIT_MS is 20 s). Until 11-18 it
 * stopped the agent, its row never came, and clause 4 always skipped.
 */
function runGate93() {
  const js = `
    const g = await import("./gate/93.mjs");
    const items = [];
    let stops = 0, hooks = 0, refused = 0;
    const running = new Set();
    const groups = (l) => [{ scope: "workspace/w", subjects: l.map((n) => ({ subject: n.subject, items: [n] })) }];
    const bell = () => {
      const needs = items.filter((n) => n.kind === "waiting");
      const updates = items.filter((n) => n.kind === "finished");
      return { unread: needs.filter((n) => !n.read).length, waiting: [], groups: groups(needs), updates: { count: updates.length, groups: groups(updates) } };
    };
    const add = (name, kind) => items.push({ id: name + ":" + items.length, subject: "agent:" + name, kind, read: false, link: "/agents?agent=" + name });
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const ctx = {
      page: null,
      url: "http://bed.invalid",
      api: async (p, init) => {
        if (p === "/api/notifications") return ok(bell());
        if (p === "/api/notifications/read") {
          const id = JSON.parse(init.body).id;
          for (const n of items) if (n.id === id) n.read = true;
        }
        return ok(p === "/api/settings" ? { bell_kinds: { finished: false } } : { ok: true });
      },
      agent: async (name) => ({
        id: name,
        start() {
          if (running.size + 1 >= 4) { refused++; return { code: 1, all: "agents.max_concurrent is 4" }; }
          running.add(name);
          return { code: 0, all: "started" };
        },
        running: async () => (running.has(name) ? 10 : null),
        stop: async () => { stops++; running.delete(name); },
        sessionStart: async () => {},
        print: async () => {},
        askHuman: async () => add(name, "waiting"),
        hook: async (ev) => {
          if (ev === "Stop" && running.has(name)) { hooks++; add(name, "finished"); }
        },
      }),
    };
    const t0 = Date.now();
    let error = null, links = null;
    try { links = (await g.setup(ctx)).links; } catch (e) { error = String(e?.message ?? e); }
    console.log(JSON.stringify({ ms: Date.now() - t0, stops, hooks, refused, links, error }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    ms: number;
    stops: number;
    hooks: number;
    refused: number;
    links: Record<string, string | null> | null;
    error: string | null;
  };
}

describe("gate/93.mjs: its turns stub ends turns, it doesn't stop", () => {
  it("two Stop hooks, no ctl.stop() in setup, the turns row with no wait run out", () => {
    const r = runGate93();
    expect(r.error).toBeNull();
    expect(r.refused).toBe(0);
    expect(r.stops).toBe(0);
    expect(r.hooks).toBe(2);
    expect(r.links?.turns).toMatch(/gate93-turns-/);
    // WAIT_MS is 20 s: one wait run out would show here.
    expect(r.ms).toBeLessThan(15_000);
  }, 120_000);
});

/**
 * Gate 93's run on a fake page whose rows' text has no box when first
 * measured (the bell drew its rows again: the 11-18 dev.1 bed run threw
 * on `box.x` and the whole module errored). The long row never gets a
 * box: its clause fails with detail. The short row gets one when measured
 * again: it is clicked. Nothing throws.
 */
function runGate93Page() {
  const js = `
    const g = await import("./gate/93.mjs");
    const links = { long: "/agents?agent=l", short: "/agents?agent=s", turns: "/agents?agent=t" };
    const measured = { long: 0, short: 0 };
    let url = "http://bed.invalid/services";
    const which = (opts) => {
      const h = String(opts?.has?.sel ?? "");
      return h.includes(links.long) ? "long" : h.includes(links.short) ? "short" : null;
    };
    const loc = (sel, row = null) => ({
      sel,
      count: async () => 1,
      first() { return loc(sel, row); },
      nth() { return loc(sel, row); },
      locator(s) { return loc(s, row); },
      getByRole() { return loc(sel, row); },
      waitFor: async () => {},
      getAttribute: async () => null,
      click: async () => {},
      focus: async () => {},
      evaluate: async (fn) => (String(fn).includes("outerHTML") ? '<div class="den-bell-row"><a href="' + (links[row] ?? "") + '">row</a></div>' : ""),
      boundingBox: async () => {
        if (!row) return { x: 1, y: 1, width: 10, height: 10 };
        measured[row]++;
        if (row === "long") return null;
        return measured[row] === 1 ? null : { x: 1, y: 1, width: 10, height: 10 };
      },
    });
    const page = {
      goto: async (u) => { url = u; },
      url: () => url,
      waitForSelector: async () => {},
      click: async () => {},
      focus: async () => {},
      keyboard: { press: async () => {} },
      mouse: { click: async () => {} },
      evaluate: async () => "",
      $$eval: async () => [],
      locator(sel, opts) { return loc(sel, which(opts)); },
    };
    const shots = [];
    const ctx = {
      page, url: "http://bed.invalid", width: 1280, browser: "chromium",
      api: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
      shot: async (n) => { shots.push(n); },
    };
    let error = null, rows = null, seen = null;
    try {
      seen = await g.run(ctx, { links, language: null });
      rows = g.expect([{ result: seen, cell: { browser: "chromium", width: 1280 } }]);
    } catch (e) { error = String(e?.stack ?? e); }
    console.log(JSON.stringify({ error, click: seen?.click ?? null, first: rows?.[0] ?? null, measured, shots }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    error: string | null;
    click: Record<
      string,
      { opened: boolean; noBox?: Record<string, unknown> }
    > | null;
    first: { ok: boolean; detail: string } | null;
    measured: Record<string, number>;
    shots: string[];
  };
}

describe("gate/93.mjs: a row with no box yet", () => {
  it("waits, measures again, and fails that clause with detail instead of throwing", () => {
    const r = runGate93Page();
    expect(r.error).toBeNull();
    expect(r.measured.short).toBe(2);
    expect(r.click?.short.noBox).toBeUndefined();
    expect(r.click?.long.noBox).toMatchObject({
      html: expect.stringContaining("den-bell-row"),
      rows: 1,
      shot: expect.stringMatching(/^nobox-long-/),
    });
    expect(r.shots).toContain(r.click?.long.noBox?.shot);
    expect(r.first?.ok).toBe(false);
    expect(r.first?.detail).toContain("noBox");
  }, 120_000);
});
