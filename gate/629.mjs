// gate/629.mjs: Den never types into an agent while its screen ends with a
// dialog for its person (a permission dialog or its trust question).
//
// Clause 1 (the note after a restart): the bed's server agent stub (record
// "server", project den-server; resumed, never started anew) shows Claude
// Code's permission dialog. ui.restart_wait_seconds is set to 10 for this
// check (ctx.userYml, put back after). The agent's own den_restart_server
// restarts Den at once only when the person's server_agent.self_update is
// auto; the check never changes it (a person's setting). Otherwise the
// restart waits for the person's Allow, so the clause is not run (skip
// person), never a FAIL. Restarted so, the next server has a note for it. Past the wait, nothing was
// typed into its terminal, the bell has the record:den-back-note-held
// item, and the agent's waiting row is still there. Then the stub itself
// clears its dialog (its screen back at its prompt; Den never answers
// it): the note is typed and the bell item goes. A restart held for an
// Allow fails the clause; the check never presses one.
//
// Clause 4: a message from the page (POST .../agents/<id>/say) to a stub
// showing the dialog answers 409 dialog_open and types nothing. The page's
// say is refused to the fixture person (issue 810, 403 fixture_scope), and
// the test operator's say reaches only an agent Den marked testBed when it
// started it on the test-person path (issues 943, 956; a plain 403).
//   403 fixture_scope                not run: the operator path is off here
//   plain 403, stub not marked       not run: not started with --test-person
//   plain 403, mark unreadable       not run, and the detail says so
//   plain 403, stub marked testBed   FAIL: issue 956 or the mark is broken
// (skip needs-fixture-say for each not run; the detail names the code.)
//
// Clauses 2 (a Hub comment) and 3 (the tools note): the bed has no Hub and
// can't change a tool list (needs-hub, needs-tool-list-change). With a Hub, clause 2's stub
// answers its dialog as a real agent does: its screen clears, then its
// PostToolUse hook (the waiting mark Den holds the comment on clears only
// on a hook). Its name is new each run, so a comment an earlier run left
// held can't reach it.
//
// Clauses 2 and 4 first wait (DIALOG_MS) for the stub's waiting mark in
// the bell. A stub mid-turn draws no dialog: then the clause is not run
// (skip needs-dialog, "the dialog never came up"), nothing is posted, and
// it is never a FAIL.
// Hub's delivery list doesn't show a delivery's answer yet: `ack` reads null
// whatever Hub stored. A delivery that has left Hub's unanswered list
// (`acked: true`) was answered; Den's side (row, reason, doctor) says how.
// When Hub shows the answer, the answer itself is checked.
const hubBlind = (d) => d != null && d.ack == null && d.acked === true;

export const issue = 629;
export const clauses = [
  "after a restart, Den's note to its agent is not typed while the agent shows a dialog for its person; the bell says the note waits, the agent's waiting row stays, and the note is typed once the dialog is answered",
  "a Hub comment for an agent is not typed while it shows a dialog for its person",
  "the tools note is not typed while the agent shows a dialog for its person",
  "a message from the page to an agent showing a dialog for its person answers 409 dialog_open and types nothing",
];
export const timeoutMs = 420000;
const NO_SEND_TO =
  /^hub comment: (the doc's Send to names the person @|the doc page has no Send to box)/;

const SERVER = "server";
const SAY = "gate-629-say";
// Clause 2's stub: in the bed's workspace linked to Hub's e2e project.
// A prefix: each run adds its own suffix (setup).
const HUB = "gate-629-hub";
const HUB_WS = "proj-gate";
const HUB_QUIET_MS = 20000;
// How long a stub's dialog has to show in the bell before a clause.
const DIALOG_MS = 10000;
const NO_DIALOG = `the dialog never came up: no waiting mark in the bell within ${DIALOG_MS} ms (the stub mid-turn?)`;
const HELD = "record:den-back-note-held";
const WAIT_S = 10;
const MARGIN_MS = 20000;
const PROBE = "gate 629 probe: a message from the page";
// The stub answers its own dialog: the screen clears back to its prompt.
const PROMPT = "\\u001b[2J\\u001b[H> ";

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

const answering = async (ctx) => {
  try {
    return Array.isArray((await ctx.api("/api/notifications"))?.groups);
  } catch {
    return false;
  }
};

/** The bell: the held-note item, and the agent's waiting row. */
async function bellOf(ctx, id) {
  const n = await ctx.api("/api/notifications").catch(() => ({}));
  // A "service" item (the held note) is listed under updates, not groups.
  const subjects = [
    ...(n?.groups ?? []),
    ...(n?.updates?.groups ?? []),
    ...(n?.older?.groups ?? []),
  ].flatMap((g) => g?.subjects ?? []);
  const items = (s) =>
    subjects.filter((x) => x?.subject === s).flatMap((x) => x?.items ?? []);
  return {
    held: items(HELD).length > 0,
    waitingRow: items(`agent:${id}`).some((i) => i?.kind === "waiting"),
    live: (n?.waiting ?? []).some((w) => w?.agent === id),
  };
}

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

const recordOf = (ctx, id) => parse(ctx.readBed(`state:agents/${id}.json`));

/** Raise the stub's dialog and wait for its waiting mark: ms, or null. */
async function raise(ctx, a, id) {
  a.permissionRequest("Bash", { command: "npm test" });
  return ctx.until(async () => (await bellOf(ctx, id)).waitingRow, DIALOG_MS);
}

/** This run's Hub stub name: new each run. */
const hubName = () =>
  `${HUB}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const server = (ctx) => ctx.agent(SERVER, { workspace: "den-server" });

export async function setup(ctx) {
  const s = {};
  const set = await ctx.api("/api/settings").catch(() => null);
  s.selfUpdateWas = set?.server_agent_self_update ?? null;
  // The bed's server agent: put back as found (running, or not) in teardown.
  try {
    s.serverWasRunning = server(ctx).state() === "running";
  } catch {
    s.serverWasRunning = null;
  }
  // A short restart wait for this check; put back byte for byte after.
  s.yml = ctx.userYml({ ui: { restart_wait_seconds: WAIT_S } });
  const b = ctx.agent(SAY);
  s.sayStart = b.start("tester")?.code ?? null;
  s.sayRunningMs = await b.running(30000);
  if (ctx.hub) {
    s.hub = hubName();
    const h = ctx.agent(s.hub, { workspace: HUB_WS });
    s.hubStart = h.start("tester")?.code ?? null;
    s.hubRunningMs = await h.running(30000);
  }
  await ctx.sleep(2500);
  return s;
}

async function restartNote(ctx) {
  const a = server(ctx);
  const r = {};
  // The person's setting, read only. Not auto: the restart would wait for
  // the person's Allow, which a check never presses.
  const set = await ctx.api("/api/settings").catch(() => null);
  r.selfUpdate = set?.server_agent_self_update ?? null;
  if (r.selfUpdate !== "auto") {
    r.needsAllow = true;
    return r;
  }
  // The bed's server agent: resumed, never started anew.
  r.runningMs = await a.running(30000);
  r.runtime = recordOf(ctx, SERVER)?.runtime ?? null;
  if (r.runningMs === null || r.runningMs === undefined) return r;
  await ctx.sleep(2500);
  a.permissionRequest("Bash", { command: "npm test" });
  r.raisedMs = await ctx.until(
    async () => (await bellOf(ctx, SERVER)).waitingRow,
    15000,
  );
  const before = await ctx.api("/api/server-info").catch(() => null);
  r.startedBefore = before?.startedAt ?? null;
  const since = Date.now();
  try {
    await a.mcp("den_restart_server", {
      reason: "gate 629: a restart while a dialog is open",
    });
  } catch (e) {
    r.mcpThrew = String(e?.message ?? e).slice(0, 200);
  }
  // Down, then back on a new process.
  r.backMs = await ctx.until(async () => {
    const i = await ctx.api("/api/server-info").catch(() => null);
    return !!i?.startedAt && i.startedAt !== r.startedBefore;
  }, 120000);
  if (r.backMs === null) {
    r.mcpLog = JSON.stringify(ctx.stubLog(SERVER, { k: "shq" }) ?? null).slice(
      -400,
    );
    return r;
  }
  const upAt = Date.now();
  const info = await ctx.api("/api/server-info").catch(() => null);
  r.waitS = Number(info?.restartWaitSeconds) || WAIT_S;
  // The bell says the note waits, once the wait has run out.
  r.heldMs = await ctx.until(
    async () => (await bellOf(ctx, SERVER)).held,
    r.waitS * 1000 + 30000,
  );
  // Past the wait by a margin: still nothing typed.
  const left = r.waitS * 1000 + MARGIN_MS - (Date.now() - upAt);
  if (left > 0) await ctx.sleep(left);
  r.waitedMs = Date.now() - upAt;
  r.typedWhileOpen = await typedOf(a, since);
  r.bellWhileOpen = await bellOf(ctx, SERVER);
  // The stub answers its own dialog: its screen goes back to its prompt
  // (a print, never typed input; Den never answers it).
  const answered = Date.now();
  a.print(PROMPT);
  r.toldMs = await ctx.until(
    async () => ((await typedOf(a, answered)) ?? "").length > 0,
    30000,
  );
  r.typedAfter = ((await typedOf(a, answered)) ?? "").slice(0, 400);
  r.goneMs = await ctx.until(
    async () => !(await bellOf(ctx, SERVER)).held,
    30000,
  );
  // Its audit row is written once the note is typed: look until it lands.
  const told = /"verb":"server-back","detail":"[^"]*agent:server told/;
  r.auditTold =
    (await ctx.until(
      () => told.test(ctx.readBed("state:audit.jsonl") ?? ""),
      15000,
    )) !== null;
  return r;
}

async function sayRefused(ctx, s) {
  const b = ctx.agent(SAY);
  const r = {
    running: s.sayRunningMs !== null && s.sayRunningMs !== undefined,
  };
  const rec = recordOf(ctx, SAY);
  r.ws = rec?.workspace ?? null;
  r.runtime = rec?.runtime ?? null;
  if (!r.running || !r.ws) return r;
  r.raisedMs = await raise(ctx, b, SAY);
  if (r.raisedMs === null) {
    r.noDialog = true;
    return r;
  }
  await ctx.sleep(1500);
  const since = Date.now();
  const res = await ctx.fetch(
    `/api/workspaces/${encodeURIComponent(r.ws)}/agents/${encodeURIComponent(SAY)}/say`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: PROBE }),
    },
  );
  r.status = res.status;
  const body = parse(res.body);
  r.code = body?.code ?? null;
  r.error = typeof body?.error === "string" ? body.error.slice(0, 200) : null;
  await ctx.sleep(1500);
  r.typed = await typedOf(b, since);
  const audit = ctx.readBed("state:audit.jsonl") ?? "";
  r.auditSent = audit.includes(`send ${SAY} a message`);
  // The stub's mark: true, false, or null when its record can't be read.
  const rec2 = recordOf(ctx, SAY);
  r.testBed = rec2 ? rec2.testBed === true : null;
  return r;
}

/** Clause 2: a Hub comment for an agent showing a dialog waits for it. */
async function hubHeld(ctx, s) {
  if (!ctx.hub) return { skip: true };
  const h = ctx.agent(s.hub, { workspace: HUB_WS });
  const r = {
    agent: s.hub,
    running: s.hubRunningMs !== null && s.hubRunningMs !== undefined,
  };
  if (!r.running) return r;
  r.raisedMs = await raise(ctx, h, s.hub);
  if (r.raisedMs === null) {
    r.noDialog = true;
    return r;
  }
  await ctx.sleep(1500);
  const token = `g629hub-${Date.now()}`;
  const since = Date.now();
  try {
    r.id =
      (
        await ctx.hub.comment({
          agent: s.hub,
          workspace: HUB_WS,
          text: `gate 629: a Hub comment while a dialog is open (${token})`,
        })
      )?.id ?? null;
  } catch (e) {
    r.postThrew = String(e?.message ?? e).slice(0, 200);
    return r;
  }
  // Well past Den's 2 s pump: nothing typed while the dialog is open.
  await ctx.sleep(HUB_QUIET_MS);
  r.typedWhileOpen = await typedOf(h, since);
  r.stateWhileOpen = (await ctx.hub.delivery?.(r.id).catch(() => null)) ?? null;
  // The stub answers its dialog as a real agent does: its screen goes
  // back to its prompt, then the allowed tool runs and its PostToolUse
  // hook says it went on ("resumed"). Den's waiting mark is set by a hook
  // and clears only on one, never on the screen.
  const answered = Date.now();
  h.print(PROMPT);
  await h.hook("PostToolUse", { tool_name: "Bash" });
  r.toldMs = await ctx.until(
    async () => ((await typedOf(h, answered)) ?? "").includes(token),
    60000,
  );
  const after = (await typedOf(h, answered)) ?? "";
  r.typedTimes = after.split(token).length - 1;
  // Den acks once it has typed it: Hub then says delivered (when it can say).
  if (r.stateWhileOpen)
    await ctx.until(async () => {
      const d = await ctx.hub.delivery(r.id).catch(() => null);
      return d?.state === "delivered" || hubBlind(d);
    }, 15000);
  r.stateAfter = (await ctx.hub.delivery?.(r.id).catch(() => null)) ?? null;
  return r;
}

export async function run(ctx, s) {
  const { yml, ...rest } = s ?? {};
  const out = { setup: { ...rest, yml: !!yml } };
  out.say = await sayRefused(ctx, s);
  out.hub = await hubHeld(ctx, s);
  out.back = await restartNote(ctx);
  ctx.log?.(`629: ${JSON.stringify(out)}`);
  return out;
}

export async function teardown(ctx, s) {
  if (!(await answering(ctx))) {
    ctx.cli(["web", "up", "--no-open"]);
    await ctx.until(() => answering(ctx), 60000);
  }
  try {
    await s?.yml?.close?.();
  } catch {
    /* none */
  }
  try {
    // The bed's server agent: its screen goes back to its prompt, and it is
    // left as found. Stopped before the check, stopped again after (a running
    // one would hold one of the bed's agent slots for the next modules).
    server(ctx).print(PROMPT);
    if (s?.serverWasRunning === false) server(ctx).stop();
  } catch {
    /* none */
  }
  try {
    if (ctx.agent(SAY).state()) ctx.agent(SAY).remove();
    if (ctx.hub && s?.hub && ctx.agent(s.hub, { workspace: HUB_WS }).state())
      ctx.agent(s.hub, { workspace: HUB_WS }).remove();
  } catch {
    /* none */
  }
}

function hubRow(h) {
  if (!h || h.skip)
    return {
      clause: clauses[1],
      ok: null,
      skip: "needs-hub",
      detail: "the bed has no Hub and no way to queue a comment for an agent",
    };
  if (NO_SEND_TO.test(h.postThrew ?? ""))
    return {
      clause: clauses[1],
      ok: null,
      skip: "needs-hub-fixture-comment",
      detail: `the bed's test doc offers no agent to send a comment to, so none was posted: ${h.postThrew}`,
    };
  if (h.running && h.noDialog)
    return {
      clause: clauses[1],
      ok: null,
      skip: "needs-dialog",
      detail: `${h.agent}: ${NO_DIALOG}; no comment posted`,
    };
  const ok =
    h.running === true &&
    !!h.id &&
    h.typedWhileOpen === "" &&
    h.toldMs != null &&
    h.typedTimes === 1 &&
    // Hub's own view, when the hook can read it: held, then delivered.
    // A delivery Hub can't show the answer of (see hubBlind) counts on Den's side.
    (h.stateWhileOpen == null ||
      h.stateWhileOpen.state === "held" ||
      hubBlind(h.stateWhileOpen)) &&
    (h.stateWhileOpen == null ||
      h.stateAfter?.state === "delivered" ||
      hubBlind(h.stateAfter));
  const detail = !h.running
    ? `the ${h.agent} stub did not run in ${HUB_WS}`
    : h.postThrew
      ? `the comment could not be posted: ${h.postThrew}`
      : `comment ${h.id}; typed while open ${JSON.stringify((h.typedWhileOpen ?? "(the stub can't say)").slice(0, 80))} after ${HUB_QUIET_MS} ms; Hub state then ${JSON.stringify(h.stateWhileOpen)}; typed after the answer ${h.toldMs} ms, ${h.typedTimes} time(s); Hub state after ${JSON.stringify(h.stateAfter)}`;
  return { clause: clauses[1], ok, detail };
}

export function expect(r) {
  const res = r ?? {};
  const b = res.back ?? {};
  const y = res.say ?? {};
  const running = b.runningMs !== null && b.runningMs !== undefined;
  const waitedPast = (b.waitedMs ?? 0) > (b.waitS ?? WAIT_S) * 1000;
  const c1 =
    running &&
    b.raisedMs != null &&
    b.backMs != null &&
    b.heldMs != null &&
    waitedPast &&
    b.typedWhileOpen === "" &&
    b.bellWhileOpen?.held === true &&
    b.bellWhileOpen?.waitingRow === true &&
    b.toldMs != null &&
    (b.typedAfter ?? "").length > 0 &&
    b.goneMs != null;
  const d1 = !running
    ? `the server agent did not run (${b.runningMs})`
    : b.backMs == null
      ? `Den did not come back on a new process after den_restart_server (self_update ${b.selfUpdate}; ${b.mcpThrew ?? "no throw"}; its answer ${b.mcpLog}); a restart held for an Allow fails here`
      : `runtime ${b.runtime}; waiting row raised ${b.raisedMs} ms; self_update ${b.selfUpdate}; back ${b.backMs} ms; wait ${b.waitS} s, waited ${b.waitedMs} ms; held item ${b.heldMs} ms; typed while open ${JSON.stringify((b.typedWhileOpen ?? "(the stub can't say)").slice(0, 80))}; bell then ${JSON.stringify(b.bellWhileOpen ?? null)}; typed after the answer ${b.toldMs} ms (${(b.typedAfter ?? "").length} chars); held item gone ${b.goneMs} ms; audit told ${b.auditTold}`;
  const c4 =
    y.running === true &&
    !!y.ws &&
    y.status === 409 &&
    y.code === "dialog_open" &&
    y.auditSent === false &&
    y.typed === "";
  const d4 = `runtime ${y.runtime}; ws ${y.ws}; status ${y.status} ${y.code}: ${y.error}; typed ${y.typed === null ? "(the stub can't say)" : JSON.stringify(y.typed)}; audit sent ${y.auditSent}`;
  return [
    b.needsAllow
      ? {
          clause: clauses[0],
          ok: null,
          skip: "person",
          detail: `server_agent.self_update is ${JSON.stringify(b.selfUpdate)}, so den_restart_server waits for the person's Allow; a check never presses one, and never changes the person's setting`,
        }
      : { clause: clauses[0], ok: c1, detail: d1 },
    hubRow(r?.hub),
    {
      clause: clauses[2],
      ok: null,
      skip: "needs-tool-list-change",
      detail:
        "the bed can't change an agent's tool list, so no tools note is sent",
    },
    y.status === 403 && y.code !== "fixture_scope" && y.testBed === true
      ? {
          clause: clauses[3],
          ok: false,
          detail: `the test operator's say was refused for ${SAY}, which Den marked testBed: 403 ${y.code ?? "(no code)"}: ${y.error} (issue 956 or the mark is broken); nothing was typed: ${JSON.stringify(y.typed)}`,
        }
      : y.status === 403
        ? {
            clause: clauses[3],
            ok: null,
            skip: "needs-fixture-say",
            detail: `the say never reached the dialog: 403 ${y.code ?? "(no code)"}: ${y.error}; ${y.code === "fixture_scope" ? "the operator path is off on this bed (issue 814)" : y.testBed === false ? `${SAY} has no testBed mark: not started with --test-person (issues 943, 956)` : `${SAY}'s record couldn't be read, so its testBed mark is unknown`}; nothing was typed: ${JSON.stringify(y.typed)}`,
          }
        : y.running === true && y.noDialog
          ? {
              clause: clauses[3],
              ok: null,
              skip: "needs-dialog",
              detail: `${SAY}: ${NO_DIALOG}; no message sent`,
            }
          : { clause: clauses[3], ok: c4, detail: d4 },
  ];
}
