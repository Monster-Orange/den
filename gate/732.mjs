// gate/732.mjs: a background job an agent left running doesn't make it
// busy for typing; restarts still wait for, or ask about, the job.
//
// A stub in the bed's workspace linked to Hub's e2e project ends its turn,
// then gets the stub's `/bg <secs>` verb (typed in as a message from the
// page): it forks a detached shell under the stub's own process that
// sources a file under shell-snapshots/ and sleeps, as Claude Code's
// background shells look to Den.
//
// First, whether Den sees that job at all: a Restart after its turn, as
// the Agents page asks it, must answer 409 job_running with the job's
// minutes, and nothing restarts (clause 3). If it doesn't (a bed whose
// stub has no /bg verb, or a job outside its session), every
// clause skips (needs-background-job): the restart then goes ahead on
// this check's own stub, and teardown removes it.
//
// Clause 1: with the job still running and the turn ended, a Hub comment
// for it is typed in within seconds. Clause 2: a turn starts (a prompt
// record appended to its transcript, as the runtime writes one); a second
// comment waits, with Den's held reason "the agent is busy with a turn";
// once the turn ends it is typed. A second Restart probe after clause 2
// shows the job was still running through it.
//
// Without a Hub on the bed, every clause skips (needs-hub). Names are new
// each run.

export const issue = 732;
export const clauses = [
  "an agent whose turn ended, with a background shell still running: a Hub comment for it is typed within seconds",
  "the same agent mid-turn: the comment waits, then is typed once the turn ends",
  "a restart after its turn on that agent still asks about the job (job_running), and nothing restarts",
];
export const timeoutMs = 300000;

const WS = "proj-gate";
const NAME = "gate-732";
const JOB_S = 270;
const SEEN_MS = 20000;
const TYPED_MS = 30000;
const HOLD_MS = 15000;
const BUSY = "the agent is busy with a turn";
const PROMPT = "\\u001b[2J\\u001b[H> ";

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

const fresh = (p) =>
  `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** What was typed into the stub's terminal since `since`: text, or null. */
async function typedOf(a, since) {
  try {
    const rows = await a.typed({ since });
    if (!Array.isArray(rows)) return null;
    return rows.map((x) => `${x?.text ?? ""}${x?.enter ? "\\r" : ""}`).join("");
  } catch {
    return null;
  }
}

/** Den's held file: the reason it last told Hub for `id`'s comments. */
function heldReason(ctx, id) {
  const f = parse(ctx.readBed("state:hub/deliveries-seen.json"));
  const q = f?.held?.queue?.[id];
  if (!Array.isArray(q)) return null;
  return q.map((r) => r?.held_reason).find((x) => typeof x === "string") ?? "";
}

/** The agent's session id, from its record. */
function sessionOf(ctx, id) {
  return parse(ctx.readBed(`state:agents/${id}.json`))?.session?.id ?? null;
}

/** A message from the page (POST …/say): { status, code }. */
async function say(ctx, id, text) {
  const r = await ctx.fetch(
    `/api/workspaces/${encodeURIComponent(WS)}/agents/${encodeURIComponent(id)}/say`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  return { status: r?.status ?? null, code: parse(r?.body)?.code ?? null };
}

/** Restart after its turn, as the page asks it: { status, code, job }. */
async function restartProbe(ctx, id) {
  const r = await ctx.fetch(
    `/api/workspaces/${encodeURIComponent(WS)}/agents/${encodeURIComponent(id)}/restart`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ when: "after-turn" }),
    },
  );
  const b = parse(r?.body) ?? {};
  return {
    status: r?.status ?? null,
    code: b.code ?? null,
    job: b.job ?? null,
  };
}

const line = (o) => JSON.stringify(o).replace(/'/g, "");

/** Appends one record to the stub's transcript, from inside its session. */
async function append(ctx, a, id, rec) {
  const file = ctx.transcriptPath(id);
  if (!file) return false;
  const r = await a.sh(`printf '%s\\n' '${line(rec)}' >> '${file}'`, 30000);
  return r?.status === 0;
}

async function endTurn(ctx, a, id, text) {
  await append(ctx, a, id, {
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
    },
  });
  a.print(text);
  await a.hook("Stop", {
    stop_hook_active: false,
    last_assistant_message: text,
  });
  a.print(PROMPT);
}

async function post(ctx, s, token, text) {
  return (
    (
      await ctx.hub.comment({
        agent: s.id,
        workspace: WS,
        text: `${text} (${token})`,
      })
    )?.id ?? null
  );
}

export async function setup(ctx) {
  const id = fresh(NAME);
  return { id, hub: !!ctx.hub };
}

export async function run(ctx, s) {
  const r = { hub: s?.hub === true, agent: s?.id };
  if (!r.hub) return r;
  const a = ctx.agent(s.id, { workspace: WS });
  r.start = a.start("tester")?.code ?? null;
  const ran = await a.running(30000);
  r.running = ran !== null && ran !== undefined;
  if (!r.running) return r;
  await ctx.sleep(2000);
  r.transcript = !!ctx.transcriptPath(s.id);
  await endTurn(ctx, a, s.id, "Watching the build log in the background.");

  // The background shell: the stub's `/bg <secs>` verb, typed in as a
  // message from the page, forks a detached shell of its own that sources
  // a file under shell-snapshots/ and sleeps, as Claude Code's background
  // shells look to Den. Its turn ends at once.
  const bg = await say(ctx, s.id, `/bg ${JOB_S} g732`);
  r.bg = { status: bg.status, code: bg.code };
  await ctx.sleep(2000);
  await endTurn(ctx, a, s.id, "Started the watcher in the background.");
  await ctx.sleep(2000);

  // Clause 3, and whether Den sees the job at all.
  r.session = sessionOf(ctx, s.id);
  r.probe = await restartProbe(ctx, s.id);
  for (
    let i = 0;
    r.probe.code !== "job_running" &&
    r.probe.status !== 202 &&
    i < SEEN_MS / 2000;
    i++
  ) {
    await ctx.sleep(2000);
    r.probe = await restartProbe(ctx, s.id);
  }
  r.seen = r.probe.code === "job_running";
  if (!r.seen) return r;
  // Nothing restarted: the same session a few seconds on.
  await ctx.sleep(3000);
  r.sameSession = sessionOf(ctx, s.id) === r.session && !!r.session;

  // Clause 1: turn ended, job running: typed within seconds.
  const t1 = `g732idle-${Date.now()}`;
  const since1 = Date.now();
  try {
    r.id1 = await post(
      ctx,
      s,
      t1,
      "gate 732: a comment while a background job runs",
    );
  } catch (e) {
    r.postThrew = String(e?.message ?? e).slice(0, 200);
    return r;
  }
  r.typed1Ms = await ctx.until(
    async () => ((await typedOf(a, since1)) ?? "").includes(t1),
    TYPED_MS,
  );
  r.delivery1 = r.id1 ? await ctx.hub.delivery(r.id1).catch(() => null) : null;

  // Clause 2: mid-turn, the same job: it waits, then is typed.
  if (!r.transcript) return r;
  await ctx.sleep(2000);
  r.turnStarted = await append(ctx, a, s.id, {
    type: "user",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "check the log again" },
  });
  a.print("✻ Working…");
  await ctx.sleep(1500);
  const t2 = `g732busy-${Date.now()}`;
  const since2 = Date.now();
  try {
    r.id2 = await post(ctx, s, t2, "gate 732: a comment mid-turn");
  } catch (e) {
    r.postThrew = String(e?.message ?? e).slice(0, 200);
    return r;
  }
  r.reasonMs = await ctx.until(() => !!heldReason(ctx, s.id), HOLD_MS);
  r.reason = heldReason(ctx, s.id);
  const left = HOLD_MS - (Date.now() - since2);
  if (left > 0) await ctx.sleep(left);
  r.typedWhileBusy = ((await typedOf(a, since2)) ?? "").includes(t2);
  r.probe2 = await restartProbe(ctx, s.id);
  await endTurn(ctx, a, s.id, "Checked it.");
  r.typed2Ms = await ctx.until(
    async () => ((await typedOf(a, since2)) ?? "").includes(t2),
    TYPED_MS,
  );
  ctx.log?.(`732: ${JSON.stringify(r)}`);
  return r;
}

export async function teardown(ctx, s) {
  if (!s?.id) return;
  try {
    const a = ctx.agent(s.id, { workspace: WS });
    if (a.state()) {
      // The stub's exit ends its background shells too; /bg-stop first.
      await say(ctx, s.id, "/bg-stop").catch(() => null);
      a.remove();
    }
  } catch {
    /* none */
  }
}

const skipAll = (skip, detail) =>
  clauses.map((clause) => ({ clause, ok: null, skip, detail }));

export function expect(res) {
  const r = res ?? {};
  if (!r.hub)
    return skipAll(
      "needs-hub",
      "the bed has no Hub, so no comment can reach an agent",
    );
  if (!r.running)
    return clauses.map((clause) => ({
      clause,
      ok: false,
      detail: `the ${r.agent} stub did not run in ${WS} (start ${r.start})`,
    }));
  if (!r.seen)
    return skipAll(
      "needs-background-job",
      `Den saw no job under the stub's session (/bg answered ${JSON.stringify(r.bg ?? null)}; restart after its turn answered ${JSON.stringify(r.probe)}): the bed's stub kept no background shell under it`,
    );
  const c3 =
    r.probe.status === 409 &&
    r.probe.code === "job_running" &&
    typeof r.probe.job?.minutes === "number" &&
    r.sameSession === true;
  const row3 = {
    clause: clauses[2],
    ok: c3,
    detail: `restart after its turn: ${JSON.stringify(r.probe)}; same session after ${r.sameSession}; after clause 2: ${JSON.stringify(r.probe2 ?? null)}`,
  };
  const row1 = {
    clause: clauses[0],
    ok: !r.postThrew && !!r.id1 && r.typed1Ms != null,
    detail: r.postThrew
      ? `the comment could not be posted: ${r.postThrew}`
      : `comment ${r.id1}: typed ${r.typed1Ms} ms (limit ${TYPED_MS}); Hub then ${JSON.stringify(r.delivery1)}`,
  };
  let row2;
  if (!r.transcript)
    row2 = {
      clause: clauses[1],
      ok: null,
      skip: "needs-transcript",
      detail:
        "the stub wrote no conversation file, so no turn could be started",
    };
  else
    row2 = {
      clause: clauses[1],
      ok:
        r.turnStarted === true &&
        !!r.id2 &&
        r.typedWhileBusy === false &&
        r.reason === BUSY &&
        r.typed2Ms != null &&
        r.probe2?.code === "job_running",
      detail: `turn started ${r.turnStarted}; comment ${r.id2}: typed while mid-turn ${r.typedWhileBusy}; Den's held reason ${JSON.stringify(r.reason)} (${r.reasonMs} ms); job still seen ${r.probe2?.code}; typed after the turn ended ${r.typed2Ms} ms`,
    };
  return [row1, row2, row3];
}
