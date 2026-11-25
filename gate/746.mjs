// Live check for #746: Allow and Deny in the bell's "Needs you" rows decide
// the held write (they went through busyAction names busy-den.js didn't list,
// so both buttons threw and decided nothing).
//
// Decided by test fixture (Vision ruling 11-22): on the bed's test install
// only, the fixture person clicks Allow and Deny in the bell, and only on the
// two held writes this check made itself. Never the person's identity, never
// a held write the check didn't make.
//
// Two stub agents, gate-746-allow-<run> and gate-746-deny-<run>, each ask
// through the bed's scoped MCP server (`mcp --actor agent:<id> --call
// agent_mode`, with the agent's own token file) to clear their own mode.
// Setup first gives each its own strictest mode (ask), so the clear is a real
// held write. Harmless on a stub; teardown withdraws the two requests with
// each stub's own token (`approvals withdraw`), then removes it. The fixture's click is
// refused by design (issue 810): the check proves it reaches Den, comes back
// as that refusal, and leaves the request pending.
import * as os from "os";
import * as path from "path";

export const issue = 746;
export const items = [746];
// The fixture person may never decide what waits for a person (issue 810),
// so on the bed each click must reach Den and come back as that refusal,
// with nothing run. Before the fix both buttons threw in the page and sent
// nothing at all; the decide itself is the Allow pop-up's, unchanged.
export const clauses = [
  "Allow in the bell's Needs you row sends the decision to Den (the fixture person's refusal is the answer; nothing runs)",
  "Deny in the bell's Needs you row sends the decision to Den (the fixture person's refusal is the answer; nothing runs)",
];
export const matrix = { browsers: ["chromium"], widths: [1280] };
export const timeoutMs = 180000;

const FIXTURE = "decided by test fixture (Vision ruling 11-22)";
// New names each run: a request an earlier run left waiting (the fixture
// can't decide it) never shares a row or the per-agent waiting cap with this
// run's (dev.5: two rows per name; dev.6: "already has 5 requests waiting").
const TAG = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const IDS = { allow: `gate-746-allow-${TAG}`, deny: `gate-746-deny-${TAG}` };
const NOTE = "Issue 746 live check: the test fixture decides this in the bell.";

/** The stub agent's project, from its record. */
function projectOf(ctx, id) {
  try {
    return JSON.parse(ctx.readBed(`state:agents/${id}.json`) || "{}").workspace;
  } catch {
    return null;
  }
}

/** The audit's approval-decide lines for request `rid`. */
function decideLines(ctx, rid) {
  const text = ctx.readBed("state:audit.jsonl") || "";
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.includes(rid)) continue;
    try {
      const e = JSON.parse(line);
      if (
        (e.verb === "approval-decide" &&
          (e.detail === rid || e.detail.endsWith(`[${rid}]`))) ||
        (e.verb === "fixture-scope" &&
          e.detail === `/api/approvals/${rid}/decide`)
      )
        out.push({
          detail: e.detail,
          actor: e.actor,
          outcome: e.outcome,
          reason: e.reason,
        });
    } catch {
      /* a line being written */
    }
  }
  return out;
}

/** The held writes on file: id → { agent, state } (held-writes.json). */
function heldIds(ctx) {
  try {
    const j = JSON.parse(ctx.readBed("state:held-writes.json") || "{}");
    const list = Array.isArray(j)
      ? j
      : (j.items ?? j.requests ?? Object.values(j));
    const out = new Map();
    for (const x of list)
      if (x && typeof x.id === "string")
        out.set(x.id, { agent: x.args?.agent ?? null, state: x.state ?? null });
    return out;
  } catch {
    return new Map();
  }
}

/** The request's state on file (GET /api/approvals/<id> is the asker's or the person's, not the fixture's). */
function stateOf(ctx, rid) {
  const h = heldIds(ctx).get(rid);
  return h ? (h.state ?? "none") : "not on file";
}

export async function setup(ctx) {
  const made = [];
  for (const id of Object.values(IDS)) {
    ctx.agent(id).start("tester");
    made.push(id);
  }
  const ready = {};
  for (const id of made) ready[id] = await ctx.agent(id).running(20000);
  // A fresh agent follows its project's mode, so there is nothing to clear and
  // agent_mode refuses before any held write exists. The person gives each
  // stub its own strictest mode ("ask") first; clearing it would widen the
  // agent, so the ask is a real held write the bell must decide.
  const own = {};
  for (const id of made) {
    const r = ctx.cli(["agents", "permission", id, "ask"], { timeout: 15000 });
    own[id] =
      r.code === 0
        ? "ask"
        : `failed (${r.code}): ${`${r.out || ""} ${r.err || ""}`.replace(/\s+/g, " ").trim().slice(-160)}`;
  }
  return { made, ready, own };
}

/**
 * The stub's own token file, as its session finds it (actor-token.ts
 * actorTokenDir): the bed's state dir is DEN_GATE_HOME, else ~/.den-gate,
 * as Den reads it (paths.ts getStateDir). Only the path is passed, never
 * the token. With it the ask is the agent's, not the bed's person's, so the
 * per-asker waiting cap (5) counts this agent alone (dev.6: the person's
 * 5 leftover requests refused the deny ask).
 */
function tokenFile(ctx, id) {
  if (!ctx.listBed(`state:actor-token/${id}`)?.includes("token")) return null;
  const home =
    process.env.DEN_GATE_HOME ||
    path.join(process.env.HOME || os.homedir(), ".den-gate");
  return path.join(home, "actor-token", id, "token");
}

/** One agent asks to clear its own mode, with its own token; the call returns at its timeout. */
function ask(ctx, id) {
  const project = projectOf(ctx, id);
  if (!project) return { project, code: null, err: "no project in its record" };
  const file = tokenFile(ctx, id);
  if (!file)
    return {
      project,
      code: null,
      err: "the stub has no token file of its own",
    };
  const r = ctx.cli(
    [
      "mcp",
      "--workspace",
      project,
      "--actor",
      `agent:${id}`,
      "--call",
      "agent_mode",
      JSON.stringify({ agent: id, ask: true, note: NOTE }),
    ],
    { timeout: 15000, env: { DEN_ACTOR_TOKEN_FILE: file } },
  );
  return {
    project,
    code: r.code,
    err: (r.err || "").slice(-300),
    out: (r.out || "").slice(-300),
  };
}

export async function run(ctx, s) {
  const page = ctx.page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await ctx.goto(page, "/");
  // Requests an earlier run left waiting (the fixture can't decide them and
  // nobody else is there to) name the same agents: pick this run's by id.
  const before = heldIds(ctx);
  const asked = {
    allow: ask(ctx, IDS.allow),
    deny: ask(ctx, IDS.deny),
  };
  const after = heldIds(ctx);
  const mine = {};
  for (const [rid, { agent }] of after)
    if (!before.has(rid))
      for (const w of ["allow", "deny"]) if (agent === IDS[w]) mine[w] = rid;
  // Each new held write opens the Allow pop-up first: put it off, so the
  // decision is made in the bell.
  const later = page.locator("#den-ap-later");
  const seen = {};
  for (const which of ["allow", "deny"]) {
    const id = IDS[which];
    if (await later.isVisible().catch(() => false)) await later.click();
    await page.locator("#den-bell").click();
    // Each agent asks about itself, so its id names one row.
    // Only this run's own request: never an older row with the same words.
    if (!mine[which]) {
      seen[which] = { rowMs: null, rid: null, noAsk: true };
      await page.keyboard.press("Escape");
      continue;
    }
    const row = page.locator(`[data-ap-row="${mine[which]}"]`);
    const rowMs = await ctx.until(
      async () => (await row.count()) > 0 && (await row.isVisible()),
      20000,
    );
    if (rowMs === null) {
      seen[which] = { rowMs, rid: null };
      await page.keyboard.press("Escape");
      continue;
    }
    const rid = await row.getAttribute("data-ap-row");
    const answered = page.waitForResponse(
      (r) => r.url().includes("/decide") && r.request().method() === "POST",
      { timeout: 15000 },
    );
    await row.locator(`[data-bell="${which}"]`).click();
    const res = await answered.catch(() => null);
    const status = res?.status() ?? null;
    let code = null;
    try {
      code = (await res?.json())?.code ?? null;
    } catch {
      code = null;
    }
    // Nothing ran: the request still waits for a person.
    let state = stateOf(ctx, rid);
    await ctx.until(async () => {
      state = stateOf(ctx, rid);
      return state === "pending";
    }, 5000);
    const audit = decideLines(ctx, rid);
    await ctx.shot(`746-${which}`);
    // The refusal's dialog covers the page: close it before the next row.
    for (let i = 0; i < 3; i++) await page.keyboard.press("Escape");
    const open = page
      .locator(
        'dialog[open] button, [role="dialog"] button, [role="alertdialog"] button',
      )
      .filter({ hasText: /^(OK|Close|Done|Got it)$/i });
    // Every such button still showing, by what it is (never by position).
    for (const b of await open.all().catch(() => []))
      if (await b.isVisible().catch(() => false))
        await b.click().catch(() => {});
    seen[which] = { rowMs, rid, status, code, state, audit };
  }
  return { ready: s.ready, own: s.own, asked, seen, errors };
}

// Issue 810: the fixture person never decides. Den refuses the decide route
// at the fixture's scope (fixture_scope), or, past it, at the approver check
// (fixture_cannot_approve); either is the answer this check wants.
const REFUSALS = ["fixture_scope", "fixture_cannot_approve"];

function row(r, which, clause) {
  const v = r.seen[which] || {};
  const line = (v.audit || []).find(
    (a) => a.outcome === "refused" && REFUSALS.includes(a.reason),
  );
  const ok =
    v.rowMs !== null &&
    v.rowMs !== undefined &&
    v.status === 403 &&
    REFUSALS.includes(v.code) &&
    v.state === "pending" &&
    !!line &&
    r.errors.length === 0;
  const a = r.asked[which] || {};
  return {
    clause,
    ok,
    evidence: [`746-${which}`],
    detail: `${FIXTURE}. ${IDS[which]} asked (running ${r.ready?.[IDS[which]] ?? "?"}, own mode ${r.own?.[IDS[which]] ?? "?"}, cli ${a.code}, project ${a.project}${a.code ? `, said "${`${a.out || ""} ${a.err || ""}`.replace(/\s+/g, " ").trim().slice(-240)}"` : ""}); bell row ${v.rowMs === null || v.rowMs === undefined ? "never showed" : `after ${v.rowMs} ms`}, request ${v.rid ?? (v.noAsk ? "none: this run's ask made no held write" : "none")}; ${which} reached Den: ${v.status ?? "no request sent"}${v.code ? ` ${v.code}` : ""}; state ${v.state ?? "?"}; audit ${line ? `refused (${line.reason})` : "no refused approval-decide line"}; page errors ${r.errors.length ? r.errors.join(" | ") : "none"}`,
  };
}

export function expect(cells) {
  const r = cells.find((c) => c?.result)?.result ?? {
    seen: {},
    asked: {},
    errors: ["no cell"],
  };
  r.asked = r.asked || {};
  r.asked.allow = r.asked.allow || {};
  r.asked.deny = r.asked.deny || {};
  return [row(r, "allow", clauses[0]), row(r, "deny", clauses[1])];
}

/**
 * This run's own held writes, withdrawn by their asker with
 * `approvals withdraw <id>` and the stub's own token file, so none waits out
 * held_writes.wait_minutes. Each stub asked with its own token, so it alone
 * may withdraw them, and it does so before it is removed (removal revokes
 * its token). Only requests on file whose agent is one of this run's ids.
 * Exit 0 means withdrawn or already ended. Best effort: a teardown never
 * fails the check. Each withdraw, or its refusal, is printed to the log.
 */
function withdrawOwn(ctx) {
  const mine = new Set(Object.values(IDS));
  for (const [rid, h] of heldIds(ctx)) {
    if (!mine.has(h.agent) || h.state !== "pending") continue;
    const file = tokenFile(ctx, h.agent);
    if (!file) continue;
    const r = ctx.cli(["approvals", "withdraw", rid], {
      timeout: 15000,
      env: { DEN_ACTOR_TOKEN_FILE: file },
    });
    // Both outcomes go to the run's log, so a live run shows each withdraw.
    process.stderr.write(
      r.code === 0
        ? `746 teardown: ${h.agent} withdrew ${rid}: ${(r.out || "").trim().slice(-200)}\n`
        : `746 teardown: ${h.agent} couldn't withdraw ${rid}: ${(r.err || r.out || "").trim().slice(-200)}\n`,
    );
  }
}

export async function teardown(ctx) {
  withdrawOwn(ctx);
  for (const id of Object.values(IDS))
    if (ctx.agent(id).state()) ctx.agent(id).remove();
}
