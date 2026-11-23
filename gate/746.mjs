// Live check for #746: Allow and Deny in the bell's "Needs you" rows decide
// the held write (they went through busyAction names busy-den.js didn't list,
// so both buttons threw and decided nothing).
//
// Decided by test fixture (Vision ruling 11-22): on the bed's test install
// only, the fixture person clicks Allow and Deny in the bell, and only on the
// two held writes this check made itself. Never the person's identity, never
// a held write the check didn't make.
//
// Two stub agents, gate-746-allow and gate-746-deny, each ask through the
// bed's scoped MCP server (`mcp --actor agent:<id> --call agent_mode`) to
// clear their own mode. Setup first gives each its own strictest mode (ask),
// so the clear is a real held write. Harmless on a stub; removed in teardown.
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
const IDS = { allow: "gate-746-allow", deny: "gate-746-deny" };
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
        e.verb === "approval-decide" &&
        (e.detail === rid || e.detail.endsWith(`[${rid}]`))
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

/** The request's state as the signed-in page reads it, or its status. */
async function stateOf(ctx, rid) {
  const r = await ctx.fetch(`/api/approvals/${encodeURIComponent(rid)}`);
  if (r.status !== 200) return `status ${r.status}`;
  try {
    const b = typeof r.body === "string" ? JSON.parse(r.body) : r.body;
    return b?.state ?? "none";
  } catch {
    return "unreadable";
  }
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

/** One agent asks to clear its own mode; the call returns at its timeout. */
function ask(ctx, id) {
  const project = projectOf(ctx, id);
  if (!project) return { project, code: null, err: "no project in its record" };
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
    { timeout: 15000 },
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
  const asked = {
    allow: ask(ctx, IDS.allow),
    deny: ask(ctx, IDS.deny),
  };
  // Each new held write opens the Allow pop-up first: put it off, so the
  // decision is made in the bell.
  const later = page.locator("#den-ap-later");
  const seen = {};
  for (const which of ["allow", "deny"]) {
    const id = IDS[which];
    if (await later.isVisible().catch(() => false)) await later.click();
    await page.locator("#den-bell").click();
    // Each agent asks about itself, so its id names one row.
    const row = page.locator("[data-ap-row]").filter({ hasText: id });
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
    let state = await stateOf(ctx, rid);
    await ctx.until(async () => {
      state = await stateOf(ctx, rid);
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
    if (
      await open
        .first()
        .isVisible()
        .catch(() => false)
    )
      await open
        .first()
        .click()
        .catch(() => {});
    seen[which] = { rowMs, rid, status, code, state, audit };
  }
  return { ready: s.ready, own: s.own, asked, seen, errors };
}

function row(r, which, clause) {
  const v = r.seen[which] || {};
  const line = (v.audit || []).find(
    (a) => a.outcome === "refused" && a.reason === "fixture_cannot_approve",
  );
  const ok =
    v.rowMs !== null &&
    v.rowMs !== undefined &&
    v.status === 403 &&
    v.code === "fixture_cannot_approve" &&
    v.state === "pending" &&
    !!line &&
    r.errors.length === 0;
  const a = r.asked[which] || {};
  return {
    clause,
    ok,
    evidence: [`746-${which}`],
    detail: `${FIXTURE}. ${IDS[which]} asked (running ${r.ready?.[IDS[which]] ?? "?"}, own mode ${r.own?.[IDS[which]] ?? "?"}, cli ${a.code}, project ${a.project}${a.code ? `, said "${`${a.out || ""} ${a.err || ""}`.replace(/\s+/g, " ").trim().slice(-240)}"` : ""}); bell row ${v.rowMs === null || v.rowMs === undefined ? "never showed" : `after ${v.rowMs} ms`}, request ${v.rid ?? "none"}; ${which} reached Den: ${v.status ?? "no request sent"}${v.code ? ` ${v.code}` : ""}; state ${v.state ?? "?"}; audit ${line ? `refused (${line.reason})` : "no refused approval-decide line"}; page errors ${r.errors.length ? r.errors.join(" | ") : "none"}`,
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

export async function teardown(ctx) {
  for (const id of Object.values(IDS))
    if (ctx.agent(id).state()) ctx.agent(id).remove();
}
