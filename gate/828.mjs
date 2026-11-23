/**
 * Live check for issue 828: a notice that needs the person is read by its
 * type, and a pending AskUserQuestion is its question. Issue 1104 gave the
 * bed's stub agent the signals Claude Code sends for one: a PermissionRequest
 * for AskUserQuestion with its `questions`, then the `permission_prompt`
 * notice (ctx.agent: askUserQuestion), and a Notification of any type
 * (ctx.agent: notice).
 *
 * Bed stub agents only, made as gate-828-* and removed in teardown, one at
 * a time (the bed's agent cap). The bed's web server is taken down and
 * brought back once (as gate/609.mjs does); teardown brings it up if it
 * isn't answering. Answering is the agent going on (the tool runs), as
 * Claude Code reports it: no person's act is run.
 *
 * Unit tests for the same paths: tests/unit/server/notice-type-828.test.ts.
 */
export const issue = 828;
export const items = [828, 1104];
export const clauses = [
  'a pending AskUserQuestion shows its question as a "needs you" row in the Agents list and the bell, not "needs your permission: AskUserQuestion"',
  "an elicitation notice from an agent with hooks marks it waiting",
  "after a Den restart, the question's row is still there",
  "its answer (the tool's run) ends it",
];
export const timeoutMs = 300000;

const ASK = "gate-828-ask";
const ELICIT = "gate-828-elicit";
export const QUESTION = "Gate check 828: which colour, red or blue?";
const ELICIT_TEXT = "Claude needs your input: gate check 828";
/** How long one wait may take to show (the hooks wait 20 s a try). */
const SHOW_MS = 30000;
/** Raises before giving up: an early SessionStart ends a question on screen. */
const TRIES = 3;

/** ctx.api's answer as JSON, whether it gives a Response or the body. */
async function body(r) {
  return r && typeof r.json === "function" ? r.json() : r;
}
const answering = async (ctx) => {
  try {
    return Array.isArray(
      (await body(await ctx.api("/api/notifications"))).groups,
    );
  } catch {
    return false;
  }
};

/** The bell's items about agent `id` (Needs you, then Updates). */
export function bellItems(n, id) {
  return [...(n?.groups || []), ...(n?.updates?.groups || [])]
    .flatMap((g) => g.subjects || [])
    .filter((s) => s.subject === `agent:${id}`)
    .flatMap((s) => s.items || [])
    .map((i) => ({ kind: i.kind, text: i.text ?? "" }));
}

/** What waits on the person for agent `id`: `{ why, what }` rows. */
async function waits(a) {
  return ((await a.waiting()) ?? []).map((w) => ({
    why: w.why,
    what: w.what ?? null,
  }));
}

/** Agent `id`'s row in the Agents list: whether it waits, and why. */
async function agentRow(ctx, id) {
  const d = await body(await ctx.api("/api/sessions"));
  const s = (d?.sessions ?? []).find((x) => x.id === id);
  return s ? { waiting: s.waiting ?? null, why: s.waitingWhy ?? null } : null;
}

/** Raise with `raise` until `seen` holds; the ms it took, or null. */
async function raiseUntil(ctx, raise, seen) {
  for (let i = 0; i < TRIES; i++) {
    await raise();
    const ms = await ctx.until(seen, SHOW_MS / TRIES);
    if (ms !== null) return { ms, tries: i + 1 };
  }
  return { ms: null, tries: TRIES };
}

const asked = (text) => (rows) =>
  rows.some((w) => w.why === "asked" && (!text || w.what === text));

async function removeAgent(ctx, id) {
  try {
    const a = await ctx.agent(id);
    if (await a.state()) await a.remove();
  } catch {
    /* none */
  }
}

export async function setup(ctx) {
  const a = await ctx.agent(ASK);
  const started = await a.start("tester");
  const runningMs = await a.running(30000);
  return { start: started?.code ?? null, runningMs };
}

export async function run(ctx, s) {
  const r = { start: s.start, runningMs: s.runningMs };
  const a = await ctx.agent(ASK);

  // Clause 1: the question, as Claude Code sends it.
  r.raised = await raiseUntil(
    ctx,
    () => a.askUserQuestion(QUESTION),
    async () => asked(QUESTION)(await waits(a)),
  );
  r.waits = await waits(a);
  r.row = await agentRow(ctx, ASK);
  r.bell = bellItems(await body(await ctx.api("/api/notifications")), ASK);

  // Clause 3: around a web restart, the question still waits.
  r.down = (await ctx.cli(["web", "down", "--json"]))?.code ?? null;
  r.downMs = await ctx.until(async () => !(await answering(ctx)), 30000);
  r.up = (await ctx.cli(["web", "up", "--no-open"]))?.code ?? null;
  r.upMs = await ctx.until(() => answering(ctx), 90000);
  r.afterWaits = await waits(a);
  r.afterBell = bellItems(await body(await ctx.api("/api/notifications")), ASK);

  // Clause 4: the person answers in the dialog; the tool runs.
  const input = { questions: [{ question: QUESTION }] };
  await a.hook("PostToolUse", {
    tool_name: "AskUserQuestion",
    tool_input: input,
  });
  r.endedMs = await ctx.until(
    async () => !asked(null)(await waits(a)),
    SHOW_MS,
  );
  await removeAgent(ctx, ASK);

  // Clause 2: an elicitation notice, from a second agent (one at a time).
  const e = await ctx.agent(ELICIT);
  r.eStart = (await e.start("tester"))?.code ?? null;
  r.eRunningMs = await e.running(30000);
  r.elicit = await raiseUntil(
    ctx,
    () => e.notice("elicitation_dialog", ELICIT_TEXT),
    async () => asked(null)(await waits(e)),
  );
  r.eWaits = await waits(e);
  r.eRow = await agentRow(ctx, ELICIT);
  ctx.log?.(`828: ${JSON.stringify(r)}`);
  return r;
}

export async function teardown(ctx) {
  if (!(await answering(ctx))) {
    await ctx.cli(["web", "up", "--no-open"]);
    await ctx.until(() => answering(ctx), 90000);
  }
  await removeAgent(ctx, ASK);
  await removeAgent(ctx, ELICIT);
}

const PERMISSION = /needs your permission/;
const hasQuestion = (items) =>
  items.some((i) => i.text.includes(QUESTION) && !PERMISSION.test(i.text));

export function expect(res) {
  const r = Array.isArray(res) ? res[0]?.result : res;
  if (!r || r.start === undefined)
    return clauses.map((clause) => ({ clause, ok: false, detail: "no run" }));
  const waitsNow = r.waits ?? [];
  const bell = r.bell ?? [];
  const permissions = waitsNow.filter((w) => w.why === "permission");
  const permBell = bell.filter((i) => PERMISSION.test(i.text));
  const after = r.afterWaits ?? [];
  return [
    {
      clause: clauses[0],
      ok:
        r.raised?.ms != null &&
        asked(QUESTION)(waitsNow) &&
        permissions.length === 0 &&
        r.row?.waiting === true &&
        r.row?.why === "asked" &&
        hasQuestion(bell) &&
        permBell.length === 0,
      detail: `waits ${JSON.stringify(waitsNow)} (try ${r.raised?.tries}, ${r.raised?.ms} ms); Agents list row ${JSON.stringify(r.row)}; bell ${JSON.stringify(bell)}`,
    },
    {
      clause: clauses[1],
      ok:
        r.elicit?.ms != null &&
        asked(null)(r.eWaits ?? []) &&
        r.eRow?.waiting === true &&
        r.eRow?.why === "asked",
      detail: `start ${r.eStart}, running in ${r.eRunningMs} ms; waits ${JSON.stringify(r.eWaits)} (try ${r.elicit?.tries}, ${r.elicit?.ms} ms); Agents list row ${JSON.stringify(r.eRow)}`,
    },
    {
      clause: clauses[2],
      ok:
        r.downMs != null &&
        r.upMs != null &&
        asked(QUESTION)(after) &&
        hasQuestion(r.afterBell ?? []),
      detail: `web down ${r.down} (${r.downMs} ms), up ${r.up} (${r.upMs} ms); waits after ${JSON.stringify(after)}; bell after ${JSON.stringify(r.afterBell)}`,
    },
    {
      clause: clauses[3],
      ok: asked(QUESTION)(after) && r.endedMs != null,
      detail:
        r.endedMs != null
          ? `the question's wait ended ${r.endedMs} ms after the tool ran`
          : "the question still waited after the tool ran",
    },
  ];
}
