// gate/629.mjs: Den never types into an agent while its screen ends with a
// dialog for its person (a permission dialog or its trust question).
//
// Clause 1 (the note after a restart): the bed's server agent stub (record
// "server", project den-server; resumed, never started anew) shows Claude
// Code's permission dialog. ui.restart_wait_seconds is set to 10 for this
// check (ctx.userYml, put back after) and server_agent.self_update to auto
// (put back after), so the agent's own den_restart_server restarts Den at
// once and the next server has a note for it. Past the wait, nothing was
// typed into its terminal, the bell has the record:den-back-note-held
// item, and the agent's waiting row is still there. Then the stub itself
// clears its dialog (its screen back at its prompt; Den never answers
// it): the note is typed and the bell item goes. A restart held for an
// Allow fails the clause; the check never presses one.
//
// Clause 4: a message from the page (POST .../agents/<id>/say) to a stub
// showing the dialog answers 409 dialog_open and types nothing.
//
// Clauses 2 (a Hub comment) and 3 (the tools note): the bed has no Hub and
// can't change a tool list, so both skip.
export const issue = 629;
export const clauses = [
  "after a restart, Den's note to its agent is not typed while the agent shows a dialog for its person; the bell says the note waits, the agent's waiting row stays, and the note is typed once the dialog is answered",
  "a Hub comment for an agent is not typed while it shows a dialog for its person",
  "the tools note is not typed while the agent shows a dialog for its person",
  "a message from the page to an agent showing a dialog for its person answers 409 dialog_open and types nothing",
];
export const timeoutMs = 360000;

const SERVER = "server";
const SAY = "gate-629-say";
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
const server = (ctx) => ctx.agent(SERVER, { workspace: "den-server" });

export async function setup(ctx) {
  const s = {};
  const set = await ctx.api("/api/settings").catch(() => null);
  s.selfUpdateWas = set?.server_agent_self_update ?? null;
  // A short restart wait for this check; put back byte for byte after.
  s.yml = ctx.userYml({ ui: { restart_wait_seconds: WAIT_S } });
  const b = ctx.agent(SAY);
  s.sayStart = b.start("tester")?.code ?? null;
  s.sayRunningMs = await b.running(30000);
  await ctx.sleep(2500);
  return s;
}

async function restartNote(ctx) {
  const a = server(ctx);
  const r = {};
  r.selfUpdate = (
    await ctx.fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server_agent_self_update: "auto" }),
    })
  ).status;
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
  b.permissionRequest("Bash", { command: "npm test" });
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
  return r;
}

export async function run(ctx, s) {
  const { yml, ...rest } = s ?? {};
  const out = { setup: { ...rest, yml: !!yml } };
  out.say = await sayRefused(ctx, s);
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
    await ctx.api("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        server_agent_self_update: s?.selfUpdateWas ?? null,
      }),
    });
  } catch {
    /* the person's setting: put back on the next check's read */
  }
  try {
    await s?.yml?.close?.();
  } catch {
    /* none */
  }
  try {
    // The bed's server agent stays; its screen goes back to its prompt.
    server(ctx).print(PROMPT);
  } catch {
    /* none */
  }
  try {
    if (ctx.agent(SAY).state()) ctx.agent(SAY).remove();
  } catch {
    /* none */
  }
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
    { clause: clauses[0], ok: c1, detail: d1 },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-hub",
      detail: "the bed has no Hub and no way to queue a comment for an agent",
    },
    {
      clause: clauses[2],
      ok: null,
      skip: "needs-hub",
      detail:
        "the bed can't change an agent's tool list, so no tools note is sent",
    },
    { clause: clauses[3], ok: c4, detail: d4 },
  ];
}
