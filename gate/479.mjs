/* eslint-env browser */
// gate/479.mjs: no start path runs a quarantined runtime copy (issue 479).
// Setup starts two stub agents under this check's own names (gate479-*):
// one left running, one stopped. It writes a stub CLI in a folder of its
// own (gate479-*, under ctx.evidenceDir, else the OS temp dir; never the
// bed's folder or Den's state folder) that only logs that it ran
// and prints a version, pins the agents' runtime to it for their project
// (POST /api/agents/runtimes/<id>/path, as Settings' Use this does), then
// marks that one file with com.apple.quarantine (xattr -w, on nothing
// else). Restart of the running agent, through the route the page uses,
// must refuse before it stops anything. Per cell, through the page as a
// person uses it: the Start dialog says why, shows the path with Copy
// path and keeps Start off; the stopped agent's Resume refuses and offers
// Open Settings › Runtimes, which opens at the runtime's row. The stub
// must never have run, and the attribute is still there. Teardown puts the
// project's pin back, removes the agents and the folder. macOS only.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const issue = 479;
export const clauses = [
  "Start stops before running a quarantined copy: the Start dialog says why and shows its path, with Start off",
  "the dialog's Copy path copies the path (or selects it, to copy by hand)",
  "Resume refuses with the path, and offers Open Settings › Runtimes at that runtime's row",
  "restart refuses before stopping: the running agent keeps running",
  "nothing was run, and Den never removed the quarantine",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280, 390] };
export const timeoutMs = 240000;

const QUARANTINE = "com.apple.quarantine";
// DEN_GATE_XATTR: another xattr to use (this check's unit test, off macOS).
const XATTR = process.env.DEN_GATE_XATTR || "/usr/bin/xattr";

const canQuarantine = () =>
  !!process.env.DEN_GATE_XATTR ||
  (process.platform === "darwin" && fs.existsSync(XATTR));

/**
 * A folder of this check's own for its stub: under the harness's evidence
 * folder (ctx.evidenceDir), else the OS temp dir. Never the bed's folder
 * or Den's state folder.
 */
function stubFolder(ctx, prefix) {
  const e = ctx.evidenceDir;
  const base =
    typeof e === "string" && path.isAbsolute(e)
      ? e
      : typeof e === "function"
        ? e()
        : os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

/** A runtimes answer, as a list (the route answers a list or { runtimes }). */
const listOf = (v) =>
  Array.isArray(v) ? v : Array.isArray(v?.runtimes) ? v.runtimes : [];

/** A fetch answer's body as JSON (ctx.fetch keeps it as text or JSON). */
function bodyOf(r) {
  const b = r?.body;
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(String(b ?? ""));
  } catch {
    return {};
  }
}

const postJson = (ctx, p, body) =>
  ctx.fetch(p, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Runtime `id`'s row for project `ws`, or null. */
async function runtimeRow(ctx, ws, id) {
  try {
    const r = await ctx.api(
      `/api/agents/runtimes?workspace=${encodeURIComponent(ws)}`,
    );
    if (!r.ok) return null;
    return listOf(await r.json()).find((x) => x.id === id) ?? null;
  } catch {
    return null;
  }
}

/** Whether file `f` still carries the quarantine attribute. */
function marked(f) {
  try {
    execFileSync(XATTR, ["-p", QUARANTINE, f], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The stub's own log: every time anything ran it. */
function ranLines(log) {
  try {
    return fs.readFileSync(log, "utf-8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** A stub under this check's name, started and running; recorded for teardown. */
async function stub(ctx, state, role) {
  const name = `gate479-${role}-${state.tag}`;
  const ctl = await ctx.agent(name);
  const a = { name, id: ctl?.id ?? name, ctl };
  state.made.push(a);
  const r = await ctl.start("tester");
  if (r && typeof r.code === "number" && r.code !== 0)
    throw new Error(
      `${name}: the bed refused to start it (agents.max_concurrent?): ${String(r.all ?? r.err ?? r.out ?? "").slice(0, 200)}`,
    );
  await ctl.running(20000);
  return a;
}

export async function setup(ctx) {
  const state = {
    tag: Date.now().toString(36),
    made: [],
    skip: null,
    error: null,
  };
  if (!canQuarantine()) {
    state.skip = "needs-macos";
    return state;
  }
  try {
    const a = await stub(ctx, state, "run");
    const b = await stub(ctx, state, "stopped");
    await b.ctl.stop();
    let rec = null;
    try {
      rec = JSON.parse((await ctx.readBed(`state:agents/${a.id}.json`)) ?? "");
    } catch {
      rec = null;
    }
    if (!rec?.runtime || !rec?.workspace)
      throw new Error(`${a.id}: its record has no runtime or project`);
    const rt = rec.runtime;
    const ws = rec.workspace;
    const before = await runtimeRow(ctx, ws, rt);
    // The project's own pin, to put back (null: none, the search decided).
    const prev = before?.source === "workspace" ? (before.path ?? null) : null;
    const bin = before?.path ? path.basename(before.path) : rt;
    const dir = stubFolder(ctx, "gate479-");
    state.dir = dir;
    const file = path.join(dir, bin);
    const log = path.join(dir, "runs.log");
    // Prints a version line every catalog runtime's identity matches.
    fs.writeFileSync(
      file,
      `#!/bin/sh\necho "$0 $*" >> '${log}'\necho "9.9.9 (Claude Code) codex gemini grok, a stub of this check"\n`,
      { mode: 0o755 },
    );
    Object.assign(state, {
      runtime: rt,
      ws,
      file,
      log,
      prev,
      a: a.id,
      b: b.id,
    });
    const pin = await postJson(ctx, `/api/agents/runtimes/${rt}/path`, {
      scope: "workspace",
      workspace: ws,
      bin: file,
    });
    if (pin.status !== 200)
      throw new Error(
        `pinning ${rt} to the stub for ${ws}: HTTP ${pin.status} ${JSON.stringify(bodyOf(pin)).slice(0, 200)}`,
      );
    state.pinned = true;
    // Its version was asked to check it; only what runs from here counts.
    fs.writeFileSync(log, "");
    execFileSync(XATTR, ["-w", QUARANTINE, "0081;00000000;gate479;", file]);
    const row = await runtimeRow(ctx, ws, rt);
    state.listed = {
      path: row?.path ?? null,
      quarantined: row?.quarantined === true,
    };

    // Restart, as the page asks it (POST …/restart { when: "now" }).
    const r = await postJson(
      ctx,
      `/api/workspaces/${encodeURIComponent(ws)}/agents/${encodeURIComponent(a.id)}/restart`,
      { when: "now" },
    );
    const body = bodyOf(r);
    await ctx.sleep(1500);
    state.restart = {
      status: r.status,
      code: body.code ?? null,
      path: body.quarantined?.path ?? null,
      said: String(body.error ?? "").slice(0, 300),
      running: (await a.ctl.running(5000)) !== null,
      state: (await a.ctl.state?.()) ?? null,
    };
  } catch (e) {
    state.error = String(e?.message ?? e).slice(0, 300);
  }
  return state;
}

/** The Start dialog, as a person opens it, for the agents' project and runtime. */
async function startDialog(ctx, page, s) {
  const out = { shown: false, path: null, copy: 0, copied: null, goOff: null };
  await ctx.goto(page, "/agents");
  await page.locator("#ag-start").click();
  await page.locator("#ag-dlg").waitFor({ timeout: 15000 });
  await page
    .locator("#ag-ws")
    .selectOption(s.ws)
    .catch(() => {});
  await page
    .locator("#ag-runtime")
    .selectOption(s.runtime)
    .catch(() => {});
  const q = page.locator("#ag-dlg [data-quarantined]").first();
  await q.waitFor({ timeout: 15000 }).catch(() => {});
  if (!(await q.count())) return out;
  out.shown = true;
  out.text = ((await q.textContent()) ?? "").trim().slice(0, 300);
  out.path = ((await q.locator(".ag-q-path").textContent()) ?? "").trim();
  out.goOff = await page.locator("#ag-go").isDisabled();
  const copy = q.locator("button[data-q-copy]");
  out.copy = await copy.count();
  if (out.copy) {
    out.copyLabel = ((await copy.first().textContent()) ?? "").trim();
    await copy.first().click();
    await ctx.sleep(600);
    out.copied = ((await copy.first().textContent()) ?? "").trim();
  }
  await ctx.shot(`start-${ctx.browser}-${ctx.width}`);
  await page.keyboard.press("Escape").catch(() => {});
  return out;
}

/** The stopped agent's Resume (or Start fresh), then the pop-up's one action. */
async function resume(ctx, page, s) {
  const out = { button: false, href: null, said: null, row: false };
  await ctx.goto(page, "/agents");
  const btn = page
    .locator(
      `.agst[data-agent="${s.b}"][data-ws="${s.ws}"] button[data-act="resume"], .agst[data-agent="${s.b}"][data-ws="${s.ws}"] button[data-act="fresh"]`,
    )
    .first();
  await btn.waitFor({ timeout: 15000 }).catch(() => {});
  if (!(await btn.count())) return out;
  out.button = true;
  await btn.click();
  const dlg = page.locator(".bz-dlg").first();
  const link = dlg.locator('a.bz-btn.bz-primary[href*="/settings?runtime="]');
  await link.waitFor({ timeout: 20000 }).catch(() => {});
  out.said = ((await dlg.textContent().catch(() => "")) ?? "")
    .trim()
    .slice(0, 400);
  if (!(await link.count())) return out;
  out.href = await link.getAttribute("href");
  out.label = ((await link.textContent()) ?? "").trim();
  await ctx.shot(`resume-${ctx.browser}-${ctx.width}`);
  await link.click();
  await page.waitForURL(/\/settings/, { timeout: 15000 }).catch(() => {});
  const row = page.locator(`.rt[data-runtime="${s.runtime}"]`);
  await row
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  out.row = (await row.count()) > 0;
  out.url = page.url();
  return out;
}

export async function run(ctx, s) {
  const { made: _made, ...rest } = s;
  if (s.skip || s.error) return rest;
  const page = ctx.page;
  const seen = { start: null, resume: null };
  try {
    seen.start = await startDialog(ctx, page, s);
  } catch (e) {
    seen.start = { error: String(e?.message ?? e).slice(0, 200) };
  }
  try {
    seen.resume = await resume(ctx, page, s);
  } catch (e) {
    seen.resume = { error: String(e?.message ?? e).slice(0, 200) };
  }
  seen.ran = ranLines(s.log);
  seen.marked = marked(s.file);
  return { ...rest, seen };
}

export async function teardown(ctx, state) {
  if (state?.pinned)
    await postJson(ctx, `/api/agents/runtimes/${state.runtime}/path`, {
      scope: "workspace",
      workspace: state.ws,
      bin: state.prev ?? null,
    }).catch(() => {});
  for (const a of state?.made ?? []) {
    try {
      await a.ctl.stop?.();
      await (a.ctl.remove ?? a.ctl.dispose ?? a.ctl.close)?.call(a.ctl);
    } catch {
      /* best effort */
    }
  }
  const dir = state?.dir;
  // Only the folder this check made (named gate479-): the quarantined stub
  // first, then the folder with its log.
  if (dir && path.basename(dir).startsWith("gate479-") && fs.existsSync(dir)) {
    if (state.file && path.dirname(state.file) === dir)
      fs.rmSync(state.file, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** One cell's rows. */
function rows(r, cell) {
  const c = (k, row) => ({ clause: clauses[k], ...row });
  if (r?.skip)
    return clauses.map((_, k) =>
      c(k, {
        ok: null,
        skip: r.skip,
        detail: "com.apple.quarantine is a macOS attribute",
      }),
    );
  if (r?.error)
    return clauses.map((_, k) => c(k, { ok: false, detail: r.error }));
  const where = cell ? `${cell.browser} ${cell.width}: ` : "";
  const st = r.seen?.start ?? {};
  const rs = r.seen?.resume ?? {};
  const re = r.restart ?? {};
  const ran = r.seen?.ran ?? [];
  const ev = (n) => (cell ? [`${n}-${cell.browser}-${cell.width}.png`] : []);
  return [
    c(0, {
      ok: st.shown === true && st.path === r.file && st.goOff === true,
      detail:
        where +
        (st.error
          ? st.error
          : st.shown
            ? `"${st.text}"; path ${st.path}; Start ${st.goOff ? "off" : "on"}`
            : `no quarantine line in the Start dialog (Den lists the copy ${r.listed?.quarantined ? "quarantined" : "not quarantined"})`),
      evidence: ev("start"),
    }),
    c(1, {
      ok:
        st.copy > 0 &&
        !!st.copied &&
        st.copied !== st.copyLabel &&
        st.path === r.file,
      detail:
        where +
        (st.copy
          ? `"${st.copyLabel}" became "${st.copied}"`
          : "no Copy path button"),
      evidence: ev("start"),
    }),
    c(2, {
      ok:
        !!rs.href &&
        rs.href.includes(`runtime=${encodeURIComponent(r.runtime)}`) &&
        String(rs.said ?? "").includes(r.file) &&
        rs.row === true,
      detail:
        where +
        (rs.error
          ? rs.error
          : !rs.button
            ? `no Resume for ${r.b}`
            : rs.href
              ? `"${rs.label}" → ${rs.href}; ${rs.row ? "Settings at its row" : "no runtime row in Settings"}; the pop-up ${String(rs.said ?? "").includes(r.file) ? "shows" : "doesn't show"} the path`
              : `no Settings action in the pop-up: "${rs.said}"`),
      evidence: ev("resume"),
    }),
    c(3, {
      ok:
        re.status === 409 &&
        re.code === "runtime_quarantined" &&
        re.path === r.file &&
        re.running === true,
      detail: `restart: HTTP ${re.status} ${re.code ?? ""} ${re.path ?? ""}; the agent ${re.running ? "still runs" : `isn't running (${re.state ?? "?"})`}`,
    }),
    c(4, {
      ok: ran.length === 0 && r.seen?.marked === true,
      detail:
        where +
        `${ran.length ? `the stub ran: ${ran.slice(0, 3).join(" | ")}` : "the stub never ran"}; the attribute is ${r.seen?.marked ? "still there" : "gone"}`,
    }),
  ];
}

export function expect(cells) {
  const list = Array.isArray(cells) ? cells : [{ result: cells }];
  const per = list.map((c) => rows(c?.result, c?.cell));
  return clauses.map((clause, k) => {
    const got = per.map((r) => r[k]);
    if (got.every((r) => r.ok === null)) return got[0];
    const ran = got.filter((r) => r.ok !== null);
    return {
      clause,
      ok: ran.every((r) => r.ok === true),
      detail: ran.map((r) => r.detail).join(" | "),
      evidence: ran.flatMap((r) => r.evidence ?? []),
    };
  });
}
