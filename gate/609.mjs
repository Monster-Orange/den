/**
 * Live check for issue 609: an agent's attention marks reach the bell on a
 * loaded machine and around a web restart, and an unplaced caller's audit
 * row names its reason. One bed stub agent (gate609-calls) sends its real
 * hook events (ctx.agent: permissionRequest, then a tool run that clears
 * it) while this check keeps the CPUs busy; each wait must show in Den's
 * attention list, and the audit must hold no refusal of its own calls.
 *
 * The load is this check's own: busy node processes, stopped when the
 * calls end and again in teardown. The bed's web server is taken down
 * and brought back once (as gate/369.mjs does); teardown brings it up if
 * it isn't answering. The terminal host restart is not run here.
 *
 * Unit tests for the same paths: tests/unit/agents/attention-hook-609.test.ts,
 * tests/unit/server/token-binding-609.test.ts, tests/unit/agents/lost-marks-609.test.ts.
 */
import { spawn } from "child_process";
import * as os from "os";
import { isAnswering } from "./lib/answering.mjs";

export const issue = 609;
export const clauses = [
  "under load, an agent's attention marks all reach the bell, with no \"couldn't place\" refusals",
  "a refusal, if one happens, names its reason",
  "around a web restart, an agent's attention mark still reaches the bell",
  "around a terminal host restart, an agent's attention mark still reaches the bell",
];
export const timeoutMs = 600000;

const AGENT = "gate609-calls";
/** Marks sent under load. */
export const MARKS = 10;
/** How long one mark may take to show (the hooks wait 20 s a try). */
const MARK_MS = 60000;
const tool = (i) => `Gate609Tool${i}`;

/** ctx.api's answer as JSON, whether it gives a Response or the body. */

/** Busy node processes, one per two CPUs (at least two), until stopped. */
function startLoad() {
  const n = Math.max(2, Math.floor(os.cpus().length / 2));
  const kids = [];
  for (let i = 0; i < n; i++)
    kids.push(
      spawn(process.execPath, ["-e", "for(;;){}"], {
        stdio: "ignore",
        detached: false,
      }),
    );
  return kids;
}
function stopLoad(kids) {
  for (const k of kids ?? [])
    try {
      k.kill("SIGKILL");
    } catch {
      /* gone */
    }
}

/** The audit's agent-token rows for this agent since `since`. */
export function tokenRows(audit, id, since) {
  return String(audit ?? "")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(
      (r) =>
        r &&
        r.verb === "agent-token" &&
        r.principal === `agent:${id}` &&
        Date.parse(r.ts) >= since,
    );
}

/** One mark: raise a permission wait, see it, clear it, see it go. */
async function mark(ctx, a, name) {
  const t0 = Date.now();
  await a.permissionRequest(name);
  const shown = await ctx.until(
    async () =>
      ((await a.waiting("permission")) ?? []).some((w) => w.what === name),
    MARK_MS,
  );
  await a.hook("PostToolUse", { tool_name: name });
  const cleared = await ctx.until(
    async () =>
      !((await a.waiting("permission")) ?? []).some((w) => w.what === name),
    MARK_MS,
  );
  return { name, shown, cleared, ms: Date.now() - t0 };
}

export async function setup(ctx) {
  const a = await ctx.agent(AGENT);
  const started = await a.start("tester");
  const runningMs = await a.running(30000);
  await a.sessionStart?.("startup");
  return {
    id: a.id ?? AGENT,
    start: started?.code ?? null,
    runningMs,
    load: null,
  };
}

export async function run(ctx, s) {
  const a = await ctx.agent(AGENT);
  const r = { id: s.id, start: s.start, runningMs: s.runningMs };
  r.since = Date.now();
  r.loadBefore = os.loadavg()[0];
  s.load = startLoad();
  r.burners = s.load.length;
  await ctx.sleep(3000);
  r.marks = [];
  try {
    for (let i = 0; i < MARKS; i++) r.marks.push(await mark(ctx, a, tool(i)));
    r.loadDuring = os.loadavg()[0];
  } finally {
    stopLoad(s.load);
    s.load = null;
  }

  // Around a web restart: a mark sent as soon as the server answers again.
  r.down = (await ctx.cli(["web", "down", "--json"]))?.code ?? null;
  r.downMs = await ctx.until(async () => !(await isAnswering(ctx)), 30000);
  r.up = (await ctx.cli(["web", "up", "--no-open"]))?.code ?? null;
  r.upMs = await ctx.until(() => isAnswering(ctx), 90000);
  r.restart = await mark(ctx, a, tool("R"));

  r.rows = tokenRows(ctx.readBed("audit.jsonl"), s.id, r.since);
  ctx.log?.(`609: ${JSON.stringify({ ...r, rows: r.rows.length })}`);
  return r;
}

export async function teardown(ctx, s) {
  stopLoad(s?.load);
  if (!(await isAnswering(ctx))) {
    await ctx.cli(["web", "up", "--no-open"]);
    await ctx.until(() => isAnswering(ctx), 90000);
  }
  try {
    const a = await ctx.agent(AGENT);
    if (await a.state()) await a.remove();
  } catch {
    /* none */
  }
}

/** Why a refusal row says it couldn't place the caller, or null. */
const unplaced = (row) =>
  /couldn't place/.test(row.detail ?? "") ? row.detail : null;
/** It names its reason: "(<reason>; pid …". */
const named = (detail) =>
  /couldn't place \((the lookup timed out|the lookup failed|no matching connection|more than one matching connection|the lookup was still running|the caller had gone); pid/.test(
    detail,
  );

export function expect(res) {
  const r = Array.isArray(res) ? res[0]?.result : res;
  if (!r || r.start === undefined)
    return clauses.map((clause) => ({ clause, ok: false, detail: "no run" }));
  const marks = r.marks ?? [];
  const landed = marks.filter((m) => m.shown !== null && m.cleared !== null);
  const rows = r.rows ?? [];
  const refused = rows.filter((x) => x.outcome === "refused");
  const couldnt = rows.map(unplaced).filter(Boolean);
  const slowest = Math.max(0, ...marks.map((m) => m.ms ?? 0));
  return [
    {
      clause: clauses[0],
      ok:
        marks.length === MARKS &&
        landed.length === MARKS &&
        couldnt.length === 0 &&
        refused.length === 0,
      detail: `${landed.length}/${MARKS} marks shown and cleared (slowest ${slowest} ms) with ${r.burners} busy processes (load ${r.loadBefore?.toFixed?.(1)} → ${r.loadDuring?.toFixed?.(1)}); refusals ${refused.length}, "couldn't place" ${couldnt.length}`,
    },
    {
      clause: clauses[1],
      ok: couldnt.every(named),
      detail: couldnt.length
        ? couldnt.join(" | ")
        : "no caller went unplaced in this run, so there was no reason to name",
    },
    {
      clause: clauses[2],
      ok:
        r.upMs !== null &&
        r.restart?.shown !== null &&
        r.restart?.cleared !== null,
      detail: `web down ${r.down} (${r.downMs} ms), up ${r.up} (${r.upMs} ms); mark shown ${r.restart?.shown} ms, cleared ${r.restart?.cleared} ms after`,
    },
    {
      clause: clauses[3],
      ok: null,
      skip: "needs-host-restart",
      detail:
        "the bed has no command that restarts its terminal host on its own",
    },
  ];
}
