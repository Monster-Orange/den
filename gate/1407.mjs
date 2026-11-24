// gate/1407.mjs: a restart for out-of-date tools answers per agent and
// never waits silently on a background job (issue 1407).
//
// On a throwaway second Den (ctx.den2(), a test install: its page and API
// run as the fixture person), never the bed's own. Two stub agents start
// in the check's own project there and end their turn:
//
//   idle  nothing left running
//   job   the stub's `/bg <secs> g1407` verb leaves a background shell
//         under it (it sources a file under shell-snapshots/ and sleeps,
//         as Claude Code's background shells look to Den)
//
// Both are made out of date the way an update leaves them: their record's
// denVersion is set to an older Den's (issue 1223), in den2's own state
// folder. Then:
//
//   1. POST /api/agents/restart-stale answers per agent: idle "now", and it
//      comes back on the same conversation (its record keeps its resume
//      token, its session is new, and it is no longer out of date).
//   2. job "job", with the job's command (the sleep) and its minutes; it
//      is not restarted: the same session a few seconds on.
//   3. The Agents page (one browser read), on the bed's own Den, since a
//      bed browser can't reach den2's loopback: the check's own stub agent
//      there, with its own background job and made out of date the same
//      way. Its row's Restart (that one agent) shows the answer under the
//      row (data-rs-state "job", the command) with Restart now, which
//      restarts it and ends its job. Nothing else on the bed is touched.
//   4. On den2, Restart now (the agent route's when: now) ends the job and
//      restarts it: a new session, and the sleep is gone.
//
// Every row skips by name while the bed lacks what it needs (den2, the
// stub's /bg verb, a transcript Den can read). Teardown stops the job,
// removes both agents and closes den2, which removes it.
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export const issue = 1407;
export const items = [1407];
export const clauses = [
  "an idle agent with out-of-date tools: restart-stale answers now, and it comes back on the same conversation",
  "an agent whose turn ended with a background shell: the answer is job, with its command and minutes, and nothing waits",
  "the Agents page shows that answer under the agent's row, with Restart now",
  "Restart now ends the job and restarts the agent",
];
export const matrix = { browsers: ["chromium"], widths: [1280] };
export const timeoutMs = 240000;

const WS = "gate-1407";
const IDLE = "g1407-idle";
const JOB = "g1407-job";
const JOB_S = 270;
const JOB_NAME = "g1407";
const OLD = "0.0.1-gate1407";
const PROMPT = "\\u001b[2J\\u001b[H> ";

let D2 = null;

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};
// An error's text, with every URL's query cut (a one-time sign-in link
// carries its code there), short.
const clean = (t) => String(t ?? "").replace(/\?[^\s"'<>]*/g, "?…");
const msg = (e) => clean(e?.message ?? e).slice(0, 200);
// The idle agent's conversation id, kept here, never in a result or a log.
let IDLE_RESUME = null;
const skipAll = (skip, detail) =>
  clauses.map((clause) => ({ clause, ok: null, skip, detail }));

/** An agent's record on den2 (its state folder). */
function recordOf(d2, id) {
  return parse(d2.readBed(`state:agents/${id}.json`));
}

/** Its record's denVersion set to an older Den's: out of date (issue 1223). */
function makeOld(d2, id) {
  const home = d2.o?.denHome;
  if (!home) return false;
  const f = path.join(home, "agents", `${id}.json`);
  try {
    const rec = JSON.parse(fs.readFileSync(f, "utf8"));
    rec.denVersion = OLD;
    fs.writeFileSync(f, JSON.stringify(rec, null, 2));
    return true;
  } catch {
    return false;
  }
}

/** Whether the stub's background shell (its sleep) still runs. */
function jobAlive() {
  try {
    execFileSync("pgrep", ["-f", `snapshot-zsh-[0-9]+-${JOB_NAME}\\.sh`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

const line = (o) => JSON.stringify(o).replace(/'/g, "");

async function endTurn(d2, a, id, text) {
  const file = d2.transcriptPath(id);
  if (file)
    await a.sh(
      `printf '%s\\n' '${line({
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text }],
        },
      })}' >> '${file}'`,
      30000,
    );
  a.print(text);
  await a.hook?.("Stop", {
    stop_hook_active: false,
    last_assistant_message: text,
  });
  a.print(PROMPT);
  return !!file;
}

async function restartNowApi(d2, id) {
  const r = await d2.fetch(
    `/api/workspaces/${encodeURIComponent(WS)}/agents/${encodeURIComponent(id)}/restart`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ when: "now" }),
    },
  );
  return r?.status ?? null;
}

const sessionOf = (d2, id) => recordOf(d2, id)?.session?.id ?? null;

export async function setup(ctx) {
  const s = {};
  if (!ctx.den2) return { skip: "needs-den2" };
  let d2;
  try {
    d2 = await ctx.den2({ product: { testInstall: true } });
  } catch (e) {
    return { skip: "needs-den2-person", why: msg(e) };
  }
  D2 = d2;
  try {
    const mk = d2.cli(["workspace", "create", WS]);
    if (mk.code !== 0 && !/already/i.test(String(mk.all ?? "")))
      return { fail: `workspace create ${WS}: ${mk.code}` };
    const act = d2.cli(["workspace", "activate", WS]);
    if (act.code !== 0)
      return { fail: `workspace activate ${WS}: ${act.code}` };
    const idle = d2.agent(IDLE, { workspace: WS });
    const job = d2.agent(JOB, { workspace: WS });
    idle.start("tester");
    job.start("tester");
    if (
      (await idle.running(30000)) == null ||
      (await job.running(30000)) == null
    )
      return { fail: "the stub agents didn't start" };
    await ctx.sleep(2000);
    s.transcript =
      (await endTurn(d2, idle, IDLE, "Done for now.")) &&
      (await endTurn(d2, job, JOB, "Done for now."));
    if (!s.transcript) return { ...s, skip: "needs-transcript" };
    // Typed straight into the stub (agent.line), never Den's /say: a
    // test install's fixture person may not send an agent a message.
    if (!job.line) return { ...s, skip: "needs-stub-line" };
    job.line(`/bg ${JOB_S} ${JOB_NAME}`);
    s.bg = "line";
    await ctx.sleep(2000);
    await endTurn(d2, job, JOB, "Started the watcher in the background.");
    await ctx.sleep(2000);
    s.jobAlive = jobAlive();
    if (!s.jobAlive) return { ...s, skip: "needs-background-job" };
    IDLE_RESUME = recordOf(d2, IDLE)?.resumeToken ?? null;
    s.before = {
      idle: {
        session: sessionOf(d2, IDLE),
        hasConversation: !!recordOf(d2, IDLE)?.resumeToken,
      },
      job: { session: sessionOf(d2, JOB) },
    };
    s.made = makeOld(d2, IDLE) && makeOld(d2, JOB);
    if (!s.made) return { ...s, fail: "couldn't mark the agents out of date" };
    const st = await d2.fetch("/api/agents/stale?fresh=1");
    s.stale = (parse(st?.body)?.agents ?? []).map((a) => a.id).sort();
    const go = await d2.fetch("/api/agents/restart-stale", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    s.status = go?.status ?? null;
    s.agents = parse(go?.body)?.agents ?? null;
    // Clause 2: nothing waits, nothing restarts: the same session on.
    await ctx.sleep(4000);
    s.jobSameSession =
      !!s.before.job.session && sessionOf(d2, JOB) === s.before.job.session;
    s.jobAliveAfter = jobAlive();
    // Clause 1: the idle one came back, same conversation, current tools.
    s.idleBackMs = await ctx.until(() => {
      const r = recordOf(d2, IDLE);
      return (
        !!r?.session?.id &&
        r.session.id !== s.before.idle.session &&
        r.resumeToken === IDLE_RESUME &&
        r.denVersion !== OLD
      );
    }, 60000);
    const after = recordOf(d2, IDLE);
    s.idleAfter = {
      session: after?.session?.id ?? null,
      sameConversation: !!IDLE_RESUME && after?.resumeToken === IDLE_RESUME,
      denVersion: after?.denVersion ?? null,
    };
  } catch (e) {
    s.fail = msg(e);
  }
  return s;
}

const BED_WS = "proj-gate";
const PAGE_AGENT = "g1407-page";
const PAGE_JOB = "g1407p";
let PAGE_STARTED = false;

/** Whether a background shell named `name` (the stub's /bg) still runs. */
function jobAliveNamed(name) {
  try {
    execFileSync("pgrep", ["-f", `snapshot-zsh-[0-9]+-${name}\\.sh`], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** The bed's own Den's state folder, as readBed reads it. */
function bedHome(ctx) {
  return (
    ctx.o?.denHome ||
    path.join(ctx.o?.home || process.env.HOME || "", ".den-gate")
  );
}

/** Its record's denVersion set to an older Den's, on the bed's own Den. */
function makeOldOnBed(ctx, id) {
  const f = path.join(bedHome(ctx), "agents", `${id}.json`);
  try {
    const rec = JSON.parse(fs.readFileSync(f, "utf8"));
    rec.denVersion = OLD;
    fs.writeFileSync(f, JSON.stringify(rec, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clause 3 on the bed's own Den: a stub agent whose turn ended with a
 * background shell, out of date; its row's Restart on the Agents page.
 * What the row shows, then its Restart now.
 */
async function pageRow(ctx) {
  const r = {};
  const a = ctx.agent(PAGE_AGENT, { workspace: BED_WS });
  if (!a.line) return { skip: "needs-stub-line" };
  r.start = a.start("tester")?.code ?? null;
  PAGE_STARTED = true;
  if ((await a.running(30000)) == null) return { ...r, fail: "didn't start" };
  await ctx.sleep(2000);
  r.transcript = await endTurn(ctx, a, PAGE_AGENT, "Done for now.");
  if (!r.transcript) return { ...r, skip: "needs-transcript" };
  a.line(`/bg ${JOB_S} ${PAGE_JOB}`);
  await ctx.sleep(2000);
  await endTurn(ctx, a, PAGE_AGENT, "Started the watcher in the background.");
  await ctx.sleep(2000);
  if (!jobAliveNamed(PAGE_JOB)) return { ...r, skip: "needs-background-job" };
  if (!makeOldOnBed(ctx, PAGE_AGENT))
    return { ...r, fail: "couldn't mark it out of date" };
  const before = parse(ctx.readBed(`state:agents/${PAGE_AGENT}.json`))?.session
    ?.id;
  const p = await ctx.page.context().newPage();
  try {
    await ctx.goto(p, "/agents");
    const row = `#agl .agst[data-agent="${PAGE_AGENT}"]`;
    const btn = `${row} [data-act="tools-restart"]`;
    r.rowSeen = await p
      .locator(btn)
      .waitFor({ timeout: 20000 })
      .then(() => true)
      .catch(() => false);
    if (!r.rowSeen) return r;
    await p.click(btn);
    const ans = `${row} [data-rs-agent="${PAGE_AGENT}"]`;
    await p
      .locator(ans)
      .waitFor({ timeout: 20000 })
      .catch(() => {});
    r.state = await p.getAttribute(ans, "data-rs-state").catch(() => null);
    r.line = clean(
      (await p.textContent(`${ans} [data-rs-line]`).catch(() => "")) ?? "",
    ).slice(0, 200);
    r.now = await p.locator(`${ans} [data-rs-now]`).count();
    try {
      await ctx.shotOf?.(p, "1407-row-job");
    } catch {
      /* a missing screenshot fails nothing */
    }
    if (r.now === 1) {
      await p.click(`${ans} [data-rs-now]`);
      r.nowMs = await ctx.until(() => {
        const id = parse(ctx.readBed(`state:agents/${PAGE_AGENT}.json`))
          ?.session?.id;
        return !!id && id !== before && !jobAliveNamed(PAGE_JOB);
      }, 60000);
    }
  } finally {
    await p.close().catch(() => {});
  }
  return r;
}

export async function run(ctx, s) {
  const out = { ...s };
  if (s?.skip || s?.fail || !D2) return out;
  const d2 = D2;
  // Clause 3: the Agents page, on the bed's own Den (a bed browser can't
  // reach den2, which listens on loopback only). Its own stub agent only,
  // with its own background job, made out of date the same way; the row's
  // own Restart (one agent, the person's page), never the bulk one.
  if (ctx.page) out.page = await pageRow(ctx).catch((e) => ({ error: msg(e) }));
  out.nowStatus = await restartNowApi(d2, JOB).catch(() => null);
  out.nowBy = "api";
  out.nowMs = await ctx.until(() => {
    const id = sessionOf(d2, JOB);
    return !!id && id !== s.before?.job?.session && !jobAlive();
  }, 60000);
  out.jobAliveEnd = jobAlive();
  ctx.log?.(`1407: ${JSON.stringify(out)}`);
  return out;
}

export async function teardown(ctx) {
  if (PAGE_STARTED) {
    PAGE_STARTED = false;
    try {
      const a = ctx.agent(PAGE_AGENT, { workspace: BED_WS });
      try {
        a.line?.("/bg-stop");
      } catch {
        /* its exit ends its jobs too */
      }
      if (a.state()) a.remove();
    } catch {
      /* none */
    }
  }
  const d = D2;
  D2 = null;
  IDLE_RESUME = null;
  if (!d) return;
  try {
    try {
      d.agent(JOB, { workspace: WS }).line?.("/bg-stop");
    } catch {
      /* the stub's exit ends its jobs too */
    }
    for (const id of [IDLE, JOB]) {
      try {
        const a = d.agent(id, { workspace: WS });
        if (a.state()) a.remove();
      } catch {
        /* none */
      }
    }
  } finally {
    await d.close().catch(() => {});
  }
}

export function expect(cells) {
  // With a matrix the bed passes [{ cell, result }]: one cell here.
  const [only] = Array.isArray(cells) ? cells : [{ result: cells }];
  const r = only?.result ?? {};
  if (r.skip === "needs-den2")
    return skipAll("needs-den2", "the bed gives no ctx.den2");
  if (r.skip === "needs-den2-person")
    return skipAll(
      "needs-den2-person",
      `the second Den could not start signed in: ${r.why ?? ""}`,
    );
  if (r.skip === "needs-transcript")
    return skipAll(
      "needs-transcript",
      "the stubs wrote no conversation file, so Den can't read their turns",
    );
  if (r.skip === "needs-stub-line")
    return skipAll(
      "needs-stub-line",
      "the bed gives no ctx.agent(id).line(text)",
    );
  if (r.skip === "needs-background-job")
    return skipAll(
      "needs-background-job",
      `the stub's /bg answered ${r.bg}; no background shell ran under it`,
    );
  if (r.fail)
    return clauses.map((clause) => ({ clause, ok: false, detail: r.fail }));
  const by = (id) =>
    Array.isArray(r.agents) ? r.agents.find((a) => a?.id === id) : null;
  const idle = by(IDLE);
  const job = by(JOB);
  const row1 = {
    clause: clauses[0],
    ok:
      r.status === 202 &&
      idle?.state === "now" &&
      r.idleBackMs != null &&
      r.idleAfter?.sameConversation === true,
    detail: `stale ${JSON.stringify(r.stale)}; restart-stale ${r.status}: ${JSON.stringify(idle ?? null)}; back ${r.idleBackMs} ms, same conversation ${r.idleAfter?.sameConversation}, tools ${r.idleAfter?.denVersion}`,
  };
  const row2 = {
    clause: clauses[1],
    ok:
      job?.state === "job" &&
      /sleep 270/.test(String(job?.job?.command ?? "")) &&
      typeof job?.job?.minutes === "number" &&
      r.jobSameSession === true &&
      r.jobAliveAfter === true,
    detail: `answer ${JSON.stringify(job ?? null)}; same session after 4 s ${r.jobSameSession}; job still running ${r.jobAliveAfter}`,
  };
  // Clause 3 ran on the bed's own Den (pageRow): its own stub agent.
  const pg = r.page ?? null;
  const row3 = !pg
    ? {
        clause: clauses[2],
        ok: null,
        skip: "needs-page",
        detail: "the bed gave this cell no browser page",
      }
    : pg.skip
      ? {
          clause: clauses[2],
          ok: null,
          skip: pg.skip,
          detail: `on the bed's own Den: ${pg.skip}`,
        }
      : {
          clause: clauses[2],
          ok:
            !pg.error &&
            !pg.fail &&
            pg.rowSeen === true &&
            pg.state === "job" &&
            /sleep 270/.test(String(pg.line)) &&
            pg.now === 1 &&
            pg.nowMs != null,
          detail: `on the bed's own Den: row seen ${pg.rowSeen}; state ${pg.state}; line ${JSON.stringify(pg.line ?? "")}; Restart now ${pg.now}, then restarted with the job gone in ${pg.nowMs} ms${pg.fail ? `; ${pg.fail}` : ""}${pg.error ? `; ${clean(pg.error)}` : ""}`,
        };
  const row4 = {
    clause: clauses[3],
    ok: r.nowMs != null && r.jobAliveEnd === false,
    detail: `Restart now by ${r.nowBy}${r.nowStatus != null ? ` (${r.nowStatus})` : ""}: restarted and job gone in ${r.nowMs} ms; job running at the end ${r.jobAliveEnd}`,
  };
  return [row1, row2, row3, row4];
}
