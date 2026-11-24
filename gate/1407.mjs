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
//   3. On the Agents page (one browser read), job's row Restart shows the
//      answer under the row (data-rs-state "job", the command), with
//      Restart now.
//   4. Restart now (the row's button, else the agent route's when: now)
//      ends the job and restarts it: a new session, and the sleep is gone.
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
const msg = (e) => String(e?.message ?? e).slice(0, 200);
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

async function say(d2, id, text) {
  const r = await d2.fetch(
    `/api/workspaces/${encodeURIComponent(WS)}/agents/${encodeURIComponent(id)}/say`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  return r?.status ?? null;
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
    s.bg = await say(d2, JOB, `/bg ${JOB_S} ${JOB_NAME}`);
    await ctx.sleep(2000);
    await endTurn(d2, job, JOB, "Started the watcher in the background.");
    await ctx.sleep(2000);
    s.jobAlive = jobAlive();
    if (!s.jobAlive) return { ...s, skip: "needs-background-job" };
    s.before = {
      idle: {
        session: sessionOf(d2, IDLE),
        token: recordOf(d2, IDLE)?.resumeToken ?? null,
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
        r.resumeToken === s.before.idle.token &&
        r.denVersion !== OLD
      );
    }, 60000);
    const after = recordOf(d2, IDLE);
    s.idleAfter = {
      session: after?.session?.id ?? null,
      token: after?.resumeToken ?? null,
      denVersion: after?.denVersion ?? null,
    };
  } catch (e) {
    s.fail = msg(e);
  }
  return s;
}

export async function run(ctx, s) {
  const out = { ...s };
  if (s?.skip || s?.fail || !D2) return out;
  const d2 = D2;
  // Clauses 3 and 4: the Agents page on den2.
  if (d2.signedIn && d2.goto) {
    // A page signed in to den2 (its own fixture person), not the bed's.
    let opened = null;
    try {
      opened = await d2.signedIn(ctx.browser ?? "chromium", ctx.width ?? 1280);
      const p = opened.page;
      await d2.goto(p, "/agents");
      const row = `#agl .agst[data-agent="${JOB}"]`;
      const btn = `${row} [data-act="tools-restart"]`;
      out.rowSeen = await p
        .locator(btn)
        .waitFor({ timeout: 20000 })
        .then(() => true)
        .catch(() => false);
      if (out.rowSeen) {
        await p.click(btn);
        const ans = `${row} [data-rs-agent="${JOB}"]`;
        await p
          .locator(ans)
          .waitFor({ timeout: 20000 })
          .catch(() => {});
        out.pageState = await p
          .getAttribute(ans, "data-rs-state")
          .catch(() => null);
        out.pageLine =
          (await p.textContent(`${ans} [data-rs-line]`).catch(() => "")) ?? "";
        out.pageNow = await p.locator(`${ans} [data-rs-now]`).count();
        try {
          await ctx.shotOf?.(p, "1407-row-job");
        } catch {
          /* a missing screenshot fails nothing */
        }
        if (out.pageNow === 1) {
          await p.click(`${ans} [data-rs-now]`);
          out.nowBy = "page";
        }
      }
    } catch (e) {
      out.pageError = msg(e);
    } finally {
      await opened?.ctx?.close().catch(() => {});
    }
  }
  if (!out.nowBy) {
    out.nowStatus = await restartNowApi(d2, JOB).catch(() => null);
    out.nowBy = "api";
  }
  out.nowMs = await ctx.until(() => {
    const id = sessionOf(d2, JOB);
    return !!id && id !== s.before?.job?.session && !jobAlive();
  }, 60000);
  out.jobAliveEnd = jobAlive();
  ctx.log?.(`1407: ${JSON.stringify(out)}`);
  return out;
}

export async function teardown(ctx) {
  const d = D2;
  D2 = null;
  if (!d) return;
  try {
    await say(d, JOB, "/bg-stop").catch(() => null);
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
  const r = (Array.isArray(cells) ? cells[0]?.result : cells) ?? {};
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
      r.idleAfter?.token === r.before?.idle?.token,
    detail: `stale ${JSON.stringify(r.stale)}; restart-stale ${r.status}: ${JSON.stringify(idle ?? null)}; back ${r.idleBackMs} ms, same conversation ${r.idleAfter?.token === r.before?.idle?.token}, tools ${r.idleAfter?.denVersion}`,
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
  const row3 =
    r.rowSeen === undefined
      ? {
          clause: clauses[2],
          ok: null,
          skip: "needs-page",
          detail: "den2 gives no signed-in page (signedIn, goto)",
        }
      : {
          clause: clauses[2],
          ok:
            r.rowSeen === true &&
            r.pageState === "job" &&
            /sleep 270/.test(String(r.pageLine)) &&
            r.pageNow === 1,
          detail: `row seen ${r.rowSeen}; state ${r.pageState}; line ${JSON.stringify(r.pageLine)}; Restart now ${r.pageNow}${r.pageError ? `; ${r.pageError}` : ""}`,
        };
  const row4 = {
    clause: clauses[3],
    ok: r.nowMs != null && r.jobAliveEnd === false,
    detail: `Restart now by ${r.nowBy}${r.nowStatus != null ? ` (${r.nowStatus})` : ""}: restarted and job gone in ${r.nowMs} ms; job running at the end ${r.jobAliveEnd}`,
  };
  return [row1, row2, row3, row4];
}
