export const issue = 1724;
export const items = [1724];

export const IPAD = { width: 820, height: 1180 };
export const DESK = { width: 1440, height: 900 };
export const SLACK_MS = 5000;
export const TAKE_MS = 15000;
export const SETTLE_MS = 3000;

export const clauses = [
  `WebKit at iPad size (${IPAD.width}x${IPAD.height}, touch) attaches to an agent's terminal and sizes it`,
  `while a desktop browser (${DESK.width}x${DESK.height}) holds the size after its Take over, the iPad's terminal socket closes and reattaches, then the iPad page reloads: the terminal keeps the desktop's size and the iPad pane shows "Sized by another view" (its Take over)`,
  `a desktop browser takes over, then goes away with a 1001 close: the terminal is back at the iPad's size within the leave grace (+${SLACK_MS / 1000} s)`,
  `a desktop browser takes over, then the desktop's connection closes normally (1000): the terminal is back at the iPad's size within the claim grace (+${SLACK_MS / 1000} s)`,
  `a person's Take over in between (the desktop back within the claim grace): the terminal keeps the desktop's size past the grace`,
];
export const CLOSE_WAY =
  "the desktop is a real Chromium page whose terminal socket goes through Playwright's WebSocket route: 'goes away' closes Den's side with 1001, 'closes normally' with 1000; after either, the route refuses the page's reconnects until the case brings it back. This does not cover a dead connection with no close (a laptop lid shut): Den finds that only by its heartbeat's timeout, with other timing";
export const timeoutMs = 360000;

const AGENT = "g1724-term";
const WS = "proj-gate";

const msg = (e) => String(e?.message ?? e).slice(0, 200);
const same = (a, b) =>
  Boolean(a && b) && a.cols === b.cols && a.rows === b.rows;
const sz = (z) => (z ? `${z.cols}x${z.rows}` : "none");

async function paneSizes(page, sid) {
  return page
    .evaluate((id) => {
      const d = globalThis.document.querySelector(
        `[data-id="${id}"][data-cols]`,
      )?.dataset;
      const n = (x) => (x ? Number(x) : null);
      if (!d) return null;
      return {
        own: d.cols ? { cols: n(d.cols), rows: n(d.rows) } : null,
        pty: d.ptyCols ? { cols: n(d.ptyCols), rows: n(d.ptyRows) } : null,
      };
    }, sid)
    .catch(() => null);
}

const ptyOf = async (page, sid) => (await paneSizes(page, sid))?.pty ?? null;

async function openPane(ctx, page, sid) {
  await ctx.goto(
    page,
    `/agents?project=${encodeURIComponent(WS)}&open=${encodeURIComponent(sid)}`,
  );
  await page
    .waitForSelector(`[data-id="${sid}"][data-cols]`, { timeout: 30000 })
    .catch(() => {});
}

async function routed(page) {
  const link = { gone: false, now: null, opened: 0 };
  await page.routeWebSocket(/\/api\/sessions\/[^/]+\/io/, (ws) => {
    if (link.gone) return ws.close({ code: 4001, reason: "the bed holds it" });
    link.now = { ws, server: ws.connectToServer() };
    link.opened++;
  });
  return link;
}

async function desktop(ctx, sid) {
  const d = await ctx.signedIn("chromium", DESK.width, { viewport: DESK });
  const link = await routed(d.page);
  await openPane(ctx, d.page, sid);
  return { ...d, link };
}

const followShown = async (page, sid) =>
  (await page
    .locator(`[data-id="${sid}"][data-cols] [data-act="take-size"]`)
    .count()
    .catch(() => 0)) > 0;

async function ipadAfter(ctx, page, sid) {
  await ctx.sleep(SETTLE_MS);
  return { pty: await ptyOf(page, sid), follow: await followShown(page, sid) };
}

async function idleIpad(ctx, page, sid, ip) {
  await leave({ link: ip }, 1000);
  ip.gone = false;
  await page.evaluate(() => globalThis.dispatchEvent(new Event("online")));
  if ((await ctx.until(async () => Boolean(ip.now), TAKE_MS)) === null)
    return { why: "the iPad page never reattached after its socket closed" };
  const reattached = await ipadAfter(ctx, page, sid);
  ip.now = null;
  await page.reload().catch(() => {});
  await page
    .waitForSelector(`[data-id="${sid}"][data-cols]`, { timeout: 30000 })
    .catch(() => {});
  if ((await ctx.until(async () => Boolean(ip.now), TAKE_MS)) === null)
    return { why: "the iPad page never reattached after its reload" };
  return { reattached, reloaded: await ipadAfter(ctx, page, sid) };
}

async function takeOver(ctx, d, ipadPage, sid) {
  const btn = d.page.locator(
    `[data-id="${sid}"][data-cols] [data-act="take-size"]`,
  );
  await btn.waitFor({ timeout: TAKE_MS }).catch(() => {});
  if (!(await btn.count())) return { took: false, why: "no Take over" };
  await btn.click();
  const want = async () => (await paneSizes(d.page, sid))?.own ?? null;
  const tookMs = await ctx.until(
    async () => same(await ptyOf(ipadPage, sid), await want()),
    TAKE_MS,
  );
  return { took: tookMs !== null, tookMs, desk: await want() };
}

async function leave(d, code) {
  d.link.gone = true;
  const now = d.link.now;
  d.link.now = null;
  if (!now) return false;
  await now.server.close({ code, reason: "gate 1724" }).catch(() => {});
  await now.ws.close({ code: 4001, reason: "gate 1724" }).catch(() => {});
  return true;
}

function refusedAttach(ctx, sid) {
  let text = null;
  try {
    text = ctx.readBed("state:audit.jsonl");
  } catch {
    text = null;
  }
  const want = `/api/sessions/${String(sid).slice(0, 8)}`;
  const hit = String(text ?? "")
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(
      (j) => j?.outcome === "refused" && String(j.detail ?? "").includes(want),
    )
    .pop();
  return hit ? `${hit.reason ?? "refused"} for ${hit.principal ?? "?"}` : null;
}

export async function setup(ctx) {
  const s = {};
  try {
    const g = await ctx.api("/api/settings");
    s.claimMs = (g?.sessions?.size_claim_grace_seconds ?? 30) * 1000;
    s.leaveMs = (g?.sessions?.size_leave_grace_seconds ?? 3) * 1000;
  } catch (e) {
    s.error = `the grace settings can't be read: ${msg(e)}`;
    return s;
  }
  const a = ctx.agent(AGENT, { workspace: WS });
  a.start("tester");
  s.runMs = await a.running(30000);
  try {
    s.sid =
      JSON.parse(ctx.readBed(`state:agents/${AGENT}.json`))?.session?.id ??
      null;
  } catch (e) {
    s.sidError = msg(e);
  }
  if (s.runMs == null || !s.sid)
    s.error = `the agent's terminal never ran (running ${s.runMs} ms, session ${s.sid ?? s.sidError ?? "none"})`;
  return s;
}

async function oneCase(ctx, ipad, s, how, r, ip) {
  const d = await desktop(ctx, s.sid);
  try {
    if (!d.link.opened)
      return {
        measured: false,
        why: "the desktop page opened no terminal socket",
      };
    const t = await takeOver(ctx, d, ipad, s.sid);
    if (!t.took)
      return {
        measured: true,
        took: false,
        why: t.why ?? "",
        pty: await ptyOf(ipad, s.sid),
      };
    if (how === "idle") {
      const got = await idleIpad(ctx, ipad, s.sid, ip);
      await leave(d, 1001);
      await ctx.until(
        async () => same(await ptyOf(ipad, s.sid), r.ipad),
        s.leaveMs + SLACK_MS,
      );
      if (got.why) return { measured: false, why: got.why };
      return { measured: true, took: true, desk: t.desk, ...got };
    }
    const t0 = Date.now();
    await leave(d, how === "1001" ? 1001 : 1000);
    if (how === "claimed") {
      await ctx.sleep(Math.min(2000, s.claimMs / 4));
      d.link.gone = false;
      await d.page.evaluate(() =>
        globalThis.dispatchEvent(new Event("online")),
      );
      const back = await ctx.until(async () => Boolean(d.link.now), TAKE_MS);
      if (back === null)
        return {
          measured: false,
          why: "the desktop page never reconnected for the Take over in between",
        };
      const again = await takeOver(ctx, d, ipad, s.sid);
      if (!again.took)
        return {
          measured: true,
          took: false,
          why: `the Take over in between: ${again.why ?? "never sized it"}`,
          pty: await ptyOf(ipad, s.sid),
        };
      await ctx.sleep(s.claimMs + SLACK_MS);
      const pty = await ptyOf(ipad, s.sid);
      await leave(d, 1001);
      await ctx.until(
        async () => same(await ptyOf(ipad, s.sid), r.ipad),
        s.leaveMs + SLACK_MS,
      );
      return {
        measured: true,
        took: true,
        kept: same(pty, again.desk),
        desk: again.desk,
        pty,
      };
    }
    const limit = (how === "1001" ? s.leaveMs : s.claimMs) + SLACK_MS;
    const backMs = await ctx.until(
      async () => same(await ptyOf(ipad, s.sid), r.ipad),
      limit,
    );
    return {
      measured: true,
      took: true,
      tookMs: t.tookMs,
      desk: t.desk,
      backMs: backMs === null ? null : Date.now() - t0,
      limit,
      pty: await ptyOf(ipad, s.sid),
    };
  } finally {
    d.link.gone = true;
    await d.ctx.close().catch(() => {});
  }
}

export async function run(ctx, s) {
  if (s.error) return { error: s.error };
  const r = { claimMs: s.claimMs, leaveMs: s.leaveMs, way: CLOSE_WAY };
  let ipad;
  try {
    ipad = await ctx.signedIn("webkit", IPAD.width, {
      viewport: IPAD,
      hasTouch: true,
    });
  } catch (e) {
    return { error: `no WebKit page: ${msg(e)}` };
  }
  let ip;
  try {
    ip = await routed(ipad.page);
    await openPane(ctx, ipad.page, s.sid);
    r.sizedMs = await ctx.until(async () => {
      const z = await paneSizes(ipad.page, s.sid);
      return same(z?.own, z?.pty);
    }, 20000);
    const z = await paneSizes(ipad.page, s.sid);
    r.pane = z !== null;
    r.ipad = z?.own ?? null;
    r.firstPty = z?.pty ?? null;
    if (!r.firstPty) r.refused = refusedAttach(ctx, s.sid);
    if (!r.pane || r.sizedMs === null) return r;
    for (const how of ["idle", "1001", "normal", "claimed"]) {
      try {
        r[how] = await oneCase(ctx, ipad.page, s, how, r, ip);
      } catch (e) {
        r[how] = { measured: false, why: msg(e) };
      }
      if (!same(await ptyOf(ipad.page, s.sid), r.ipad))
        await ctx.until(
          async () => same(await ptyOf(ipad.page, s.sid), r.ipad),
          s.claimMs + SLACK_MS,
        );
    }
  } finally {
    await ipad.ctx.close().catch(() => {});
  }
  const fs = await import("fs");
  fs.writeFileSync(ctx.evidence("1724-run.json"), JSON.stringify(r, null, 2));
  return r;
}

export async function teardown(ctx) {
  try {
    if (ctx.agent(AGENT, { workspace: WS }).state())
      ctx.agent(AGENT, { workspace: WS }).remove();
  } catch (e) {
    process.stderr.write(`1724 teardown: ${msg(e)}\n`);
  }
}

const row = (clause, ok, detail) => ({
  clause,
  ok,
  detail,
  evidence: ["1724-run.json"],
});

function idleRow(clause, c, r) {
  if (!c?.measured)
    throw new Error(`1724 not measured: ${c?.why ?? "the case never ran"}`);
  if (!c.took)
    return row(
      clause,
      false,
      `the desktop's Take over never sized the terminal${c.why ? ` (${c.why})` : ""}: it stayed ${sz(c.pty)}, iPad ${sz(r.ipad)}`,
    );
  const ok = (x) => same(x?.pty, c.desk) && x?.follow === true;
  const say = (x) =>
    `${sz(x?.pty)}, ${x?.follow ? "the iPad shows Sized by another view" : "the iPad shows no Sized by another view"}`;
  return row(
    clause,
    ok(c.reattached) && ok(c.reloaded),
    `desktop ${sz(c.desk)}, iPad ${sz(r.ipad)}; after the iPad's socket reattached: ${say(c.reattached)}; after its reload: ${say(c.reloaded)}`,
  );
}

function caseRow(clause, c, r, kept) {
  if (!c?.measured)
    throw new Error(`1724 not measured: ${c?.why ?? "the case never ran"}`);
  if (!c.took)
    return row(
      clause,
      false,
      `the desktop's Take over never sized the terminal${c.why ? ` (${c.why})` : ""}: it stayed ${sz(c.pty)}, iPad ${sz(r.ipad)}`,
    );
  if (kept)
    return row(
      clause,
      c.kept === true,
      `${r.claimMs + SLACK_MS} ms after the Take over in between: ${sz(c.pty)} (desktop ${sz(c.desk)}, iPad ${sz(r.ipad)})`,
    );
  return row(
    clause,
    c.backMs !== null && c.backMs <= c.limit,
    c.backMs === null
      ? `still ${sz(c.pty)} after ${c.limit} ms (desktop ${sz(c.desk)}, iPad ${sz(r.ipad)})`
      : `back at the iPad's ${sz(r.ipad)} in ${c.backMs} ms (limit ${c.limit}; desktop ${sz(c.desk)})`,
  );
}

export function expect(cells) {
  const r =
    (Array.isArray(cells) ? cells.find((c) => c?.result)?.result : cells) ?? {};
  if (r.error) throw new Error(`1724 not measured: ${r.error}`);
  if (!r.pane)
    throw new Error("1724 not measured: the iPad page showed no terminal pane");
  if (!r.firstPty && String(r.refused ?? "").startsWith("fixture_scope"))
    return clauses.map((c) => ({
      clause: c,
      ok: null,
      skip: "needs-attested-edge",
      detail: `Den refused the iPad's terminal attach (${r.refused}, from Den's audit): a check's signed-in browser is the bed's fixture person, and this bed's edge can't attest a person; parked with 653 until a box can (issue 1849)`,
    }));
  if (!r.firstPty)
    throw new Error(
      `1724 not measured: the iPad pane (${sz(r.ipad)}) never heard the terminal's size, so no case could run${r.refused ? `; Den refused its terminal attach (${r.refused})` : ""}`,
    );
  const first = row(
    clauses[0],
    r.sizedMs !== null && same(r.ipad, r.firstPty),
    `the iPad pane is ${sz(r.ipad)}; the terminal is ${sz(r.firstPty)}${r.sizedMs === null ? " (never matched in 20 s)" : ` (matched in ${r.sizedMs} ms)`}`,
  );
  if (!first.ok)
    return [
      first,
      ...clauses.slice(1).map((c) => ({
        clause: c,
        ok: null,
        skip: "needs-ipad-sized-first",
        detail: "the iPad pane never sized the terminal",
      })),
    ];
  return [
    first,
    idleRow(clauses[1], r.idle, r),
    caseRow(clauses[2], r["1001"], r, false),
    caseRow(clauses[3], r.normal, r, false),
    caseRow(clauses[4], r.claimed, r, true),
  ];
}
