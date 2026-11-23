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
// clear their own mode: harmless on a stub, and removed with it in teardown.
export const issue = 746;
export const items = [746];
export const clauses = [
  "Allow in the bell's Needs you row runs the held write",
  "Deny in the bell's Needs you row denies it, and nothing runs",
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
      if (e.verb === "approval-decide" && e.detail.endsWith(`[${rid}]`))
        out.push({ detail: e.detail, actor: e.actor, outcome: e.outcome });
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
  return { made, ready };
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
  return { project, code: r.code, err: (r.err || "").slice(-300) };
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
    const row = page.locator("[data-ap-row]", { hasText: id }).first();
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
    const status = (await answered.catch(() => null))?.status() ?? null;
    const want = which === "allow" ? "done" : "denied";
    let state = await stateOf(ctx, rid);
    const stateMs = await ctx.until(async () => {
      state = await stateOf(ctx, rid);
      return state === want;
    }, 15000);
    const audit = decideLines(ctx, rid);
    await ctx.shot(`746-${which}`);
    await page.keyboard.press("Escape");
    seen[which] = { rowMs, rid, status, state, stateMs, audit };
  }
  return { ready: s.ready, asked, seen, errors };
}

function row(r, which, clause) {
  const v = r.seen[which] || {};
  const verb = which === "allow" ? "allow" : "deny";
  const want = which === "allow" ? "done" : "denied";
  const line = (v.audit || []).find(
    (a) => a.detail.startsWith(`${verb} agent_mode`) && a.outcome !== "refused",
  );
  const ok =
    v.rowMs !== null &&
    v.status === 200 &&
    v.state === want &&
    !!line &&
    r.errors.length === 0;
  return {
    clause,
    ok,
    evidence: [`746-${which}`],
    detail: `${FIXTURE}. ${IDS[which]} asked (cli ${r.asked[which].code}, project ${r.asked[which].project}); bell row ${v.rowMs === null ? "never showed" : `after ${v.rowMs} ms`}, request ${v.rid ?? "none"}; ${which} answered ${v.status}; state ${v.state ?? "?"}${v.stateMs !== null && v.stateMs !== undefined ? "" : " (not " + want + " in time)"}; audit ${line ? `"${line.detail}"` : "no approval-decide line"}; page errors ${r.errors.length ? r.errors.join(" | ") : "none"}`,
  };
}

export function expect(cells) {
  const r = cells[0]?.result ?? { seen: {}, asked: {}, errors: ["no cell"] };
  r.asked = r.asked || {};
  r.asked.allow = r.asked.allow || {};
  r.asked.deny = r.asked.deny || {};
  return [row(r, "allow", clauses[0]), row(r, "deny", clauses[1])];
}

export async function teardown(ctx) {
  for (const id of Object.values(IDS))
    if (ctx.agent(id).state()) ctx.agent(id).remove();
}
