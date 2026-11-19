/**
 * Issue 479's live check (gate/479.mjs) on a fake bed: a fake Den and a fake
 * page. The fixed Den refuses start, resume and restart of a runtime whose
 * pinned copy is quarantined (409 runtime_quarantined, with the path), before
 * anything runs; its Start dialog shows the quarantine line with Copy path
 * and Start off, and a refused Resume offers Open Settings › Runtimes. The
 * Den before the fix runs the copy (the stub's log says so), restart stops
 * the agent first, and the page shows nothing of it.
 * Quarantine is a fake xattr (DEN_GATE_XATTR): a file beside the stub.
 * A fake ctx (no bed, no browser), in a child node: the gate file is ESM.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "gate479-test-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
const XATTR = path.join(TMP, "xattr");
fs.writeFileSync(
  XATTR,
  '#!/bin/sh\ncase "$1" in\n -w) echo "$3" > "$4.quarantine";;\n -p) [ -f "$3.quarantine" ] && cat "$3.quarantine";;\n *) exit 2;;\nesac\n',
  { mode: 0o755 },
);

type Row = {
  clause: string;
  ok: boolean | null;
  skip?: string;
  detail?: string;
};

function runGate(
  right: boolean,
  xattr: string | null = XATTR,
  restart: "holds" | "stopsFirst" | "replaces" = "holds",
) {
  const evidence = path.join(TMP, right ? "right" : "wrong");
  const js = `
    const { spawnSync } = await import("child_process");
    const fs = await import("fs");
    const path = await import("path");
    const g = await import("./gate/479.mjs");
    const RIGHT = ${right}, RESTART = ${JSON.stringify(restart)};
    let sessions = 0;
    const fresh = (id) => Object.assign(agents.get(id), { running: true, session: "s" + ++sessions });
    const WS = "proj-a", RT = "den-claude";
    const agents = new Map(); // id -> { running, session }
    const pins = new Map(); // ws -> bin
    const pinnedTo = [];
    let calls = [];
    const isQ = (f) => !!process.env.DEN_GATE_XATTR &&
      spawnSync(process.env.DEN_GATE_XATTR, ["-p", "com.apple.quarantine", f]).status === 0;
    const copy = () => pins.get(WS);
    const quarantinedCopy = () => copy() && isQ(copy()) ? copy() : null;
    // A start: the fixed Den refuses a quarantined copy before anything runs.
    const launch = (id) => {
      const q = quarantinedCopy();
      if (RIGHT && q) return { status: 409, body: { ok: false, code: "runtime_quarantined",
        error: RT + " can't start: macOS has quarantined " + q, quarantined: { runtime: RT, path: q } } };
      if (copy()) spawnSync(copy(), []);
      fresh(id);
      return { status: 200, body: { ok: true } };
    };
    const ok = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, body });
    const fetchFn = async (p, init) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      calls.push(p);
      let m;
      if ((m = /^\\/api\\/agents\\/runtimes\\/([^/]+)\\/path$/.exec(p))) {
        if (body.bin === null) pins.delete(body.workspace);
        else { spawnSync(body.bin, ["--version"]); pins.set(body.workspace, body.bin); pinnedTo.push(body.bin); }
        return ok({ ok: true });
      }
      if ((m = /\\/agents\\/([^/]+)\\/restart$/.exec(p))) {
        const id = decodeURIComponent(m[1]);
        // "stopsFirst": refuses, but only after stopping the agent;
        // "replaces": refuses, after starting it again in a new session.
        if (RIGHT && quarantinedCopy()) {
          if (RESTART === "stopsFirst") agents.get(id).running = false;
          if (RESTART === "replaces") fresh(id);
          return launch(id);
        }
        agents.get(id).running = false;
        const r = launch(id);
        return ok(r.body, r.status);
      }
      return ok({}, 404);
    };
    const ctx = {
      url: "http://bed.invalid",
      evidence: (n) => path.join(${JSON.stringify(evidence)}, n),
      evidenceDir: ${JSON.stringify(evidence)},
      sleep: async () => {},
      shot: async () => {},
      goto: async (page, p) => page._go(p),
      readBed: async (rel) => {
        const id = /^state:agents\\/(.+)\\.json$/.exec(rel)?.[1];
        return id && agents.has(id) ? JSON.stringify({ id, runtime: RT, workspace: WS }) : null;
      },
      api: async (p) => p.startsWith("/api/agents/runtimes")
        ? ok([{ id: RT, source: pins.has(WS) ? "workspace" : "setting", path: copy() ?? "/bed/bin/claude",
            ...(RIGHT && quarantinedCopy() ? { quarantined: true } : {}) }])
        : p === "/api/workspaces/" + WS + "/agents"
          ? ok({ workspace: WS, agents: [...agents].map(([agent, a]) => ({ agent, workspace: WS,
              state: a.running ? "running" : "stopped", ...(a.running ? { session: { id: a.session } } : {}) })) })
        : ok({}),
      fetch: async (p, init) => { const r = await fetchFn(p, init); return { status: r.status, headers: {}, body: JSON.stringify(r.body) }; },
      agent: async (name) => {
        agents.set(name, { running: false });
        return {
          id: name,
          start: async () => { fresh(name); return { code: 0 }; },
          // As the bed: it resumes an agent that isn't running, then answers
          // the ms it took (0: it already ran), or null on a timeout.
          running: async () => {
            if (!agents.has(name)) return null;
            if (!agents.get(name).running) fresh(name);
            return 0;
          },
          state: async () => (agents.get(name)?.running ? "running" : "stopped"),
          stop: async () => { if (agents.has(name)) agents.get(name).running = false; },
          remove: async () => { agents.delete(name); },
        };
      },
    };
    // The page: what each selector finds, from the fake Den's state.
    const ui = { view: "", dlg: false, copied: false, pop: null };
    const stopped = () => [...agents].find(([id, a]) => id.includes("stopped") && !a.running)?.[0];
    const find = (sel) => {
      const q = RIGHT && quarantinedCopy();
      const has = (s) => sel.includes(s);
      if (ui.view === "settings") return has('.rt[data-runtime="' + RT + '"]') ? [{}] : [];
      if (has(".bz-dlg")) {
        if (!ui.pop) return [];
        if (has("a.bz-btn")) return ui.pop.href ? [{ text: "Open Settings › Runtimes", href: ui.pop.href,
          click: () => { ui.view = "settings"; ui.url = "http://bed.invalid" + ui.pop.href; } }] : [];
        return [{ text: ui.pop.text }];
      }
      if (has("[data-quarantined]")) {
        if (!ui.dlg || !q) return [];
        if (has(".ag-q-path")) return [{ text: q }];
        if (has("button[data-q-copy]")) return [{ text: ui.copied ? "Copied" : "Copy path", click: () => (ui.copied = true) }];
        return [{ text: "Claude Code was not started: macOS has quarantined " + q }];
      }
      if (sel === "#ag-start") return [{ click: () => (ui.dlg = true) }];
      if (sel === "#ag-dlg") return ui.dlg ? [{}] : [];
      if (sel === "#ag-ws" || sel === "#ag-runtime") return [{}];
      if (sel === "#ag-go") return [{ disabled: !!q }];
      const b = stopped();
      if (b && has('data-agent="' + b + '"') && has('data-act="resume"'))
        return [{ click: async () => {
          const r = launch(b);
          ui.pop = r.status === 409
            ? { text: r.body.error, href: "/settings?runtime=" + RT + "&project=" + WS + "#agents.runtimes" }
            : { text: "Resumed" };
        } }];
      return [];
    };
    const loc = (sel) => {
      const all = () => find(sel);
      const one = () => all()[0];
      const l = {
        first: () => l,
        locator: (s) => loc(sel + " " + s),
        count: async () => all().length,
        waitFor: async () => { if (!all().length) throw new Error("timeout: " + sel); },
        click: async () => { const e = one(); if (!e) throw new Error("no " + sel); await e.click?.(); },
        selectOption: async () => {},
        textContent: async () => one()?.text ?? "",
        isDisabled: async () => !!one()?.disabled,
        getAttribute: async (a) => (a === "href" ? one()?.href ?? null : null),
      };
      return l;
    };
    const page = {
      _go: (p) => { ui.view = p.startsWith("/settings") ? "settings" : "agents"; ui.dlg = false; ui.copied = false; ui.pop = null; },
      locator: loc,
      keyboard: { press: async () => { ui.dlg = false; } },
      waitForURL: async () => {},
      url: () => ui.url ?? "",
    };
    ctx.page = page;
    let state, rows, error = null, ranAfter = [];
    try {
      state = await g.setup(ctx);
      const cells = [];
      for (const cell of [{ browser: "chromium", width: 1280 }, { browser: "webkit", width: 390 }]) {
        ctx.browser = cell.browser; ctx.width = cell.width;
        cells.push({ cell, result: await g.run(ctx, state) });
      }
      rows = g.expect(cells);
    } catch (e) { error = String(e?.stack ?? e); }
    finally { await g.teardown(ctx, state); }
    const left = fs.existsSync(${JSON.stringify(evidence)}) ? fs.readdirSync(${JSON.stringify(evidence)}) : [];
    console.log(JSON.stringify({ rows, error, left, agents: agents.size, pins: [...pins],
      stubs: pinnedTo.map((f) => ({ f, under: f.startsWith(${JSON.stringify(evidence)} + path.sep), there: fs.existsSync(f) })) }));`;
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (xattr) env.DEN_GATE_XATTR = xattr;
  else delete env.DEN_GATE_XATTR;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120_000,
    env,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    rows: Row[];
    error: string | null;
    left: string[];
    agents: number;
    pins: [string, string][];
    stubs: { f: string; under: boolean; there: boolean }[];
  };
}

describe("gate/479.mjs on a fake bed", () => {
  it("the fixed Den: every clause passes; the pin, the agents and the folder are gone after", () => {
    const r = runGate(true);
    expect(r.error).toBeNull();
    expect(r.rows.map((x) => [x.ok, x.detail])).toEqual(
      r.rows.map((x) => [true, x.detail]),
    );
    expect(r.left).toEqual([]);
    expect(r.agents).toBe(0);
    expect(r.pins).toEqual([]);
    // The quarantined stub lived under ctx.evidenceDir, and is deleted.
    expect(r.stubs.length).toBeGreaterThan(0);
    expect(r.stubs.every((x) => x.under && !x.there)).toBe(true);
  }, 120_000);

  it("restart refused, Den lists the agent running in the same session: a pass", () => {
    const r = runGate(true);
    expect(r.rows[3]).toMatchObject({ ok: true });
    expect(r.rows[3].detail).toMatch(
      /running before, running right after, running 4 s later; the same session/,
    );
  }, 120_000);

  it("a restart that refuses only after stopping the agent: clause 4 fails, though running() would resume it", () => {
    const r = runGate(true, XATTR, "stopsFirst");
    expect(r.rows[3]).toMatchObject({ ok: false });
    expect(r.rows[3].detail).toMatch(
      /HTTP 409 .*running before, stopped right after, stopped 4 s later/,
    );
  }, 120_000);

  it("a restart that refuses after starting a new session: clause 4 fails", () => {
    const r = runGate(true, XATTR, "replaces");
    expect(r.rows[3]).toMatchObject({ ok: false });
    expect(r.rows[3].detail).toMatch(/its session changed \(s\d+ → s\d+\)/);
  }, 120_000);

  it("a Den that runs the quarantined copy: red on every clause", () => {
    const r = runGate(false);
    expect(r.error).toBeNull();
    expect(r.rows.map((x) => x.ok)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(r.rows[4].detail).toMatch(/the stub ran/);
    expect(r.rows[3].detail).toMatch(/HTTP 200/);
    expect(r.left).toEqual([]);
    expect(r.pins).toEqual([]);
  }, 120_000);

  it("off macOS with no xattr: every clause skips as needs-macos", () => {
    if (process.platform === "darwin") return;
    const r = runGate(true, null);
    expect(r.rows.map((x) => x.skip)).toEqual(Array(5).fill("needs-macos"));
  }, 120_000);
});
