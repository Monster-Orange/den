// gate/701.mjs: a question an agent asked its person never holds Hub
// comments, and a comment Den holds says why, to the person and to Hub.
//
// Clauses 1 and 2: a stub in the bed's workspace linked to Hub's e2e
// project asks its person a question (ask_human, from inside its own
// session) and ends its turn. The bell shows it asked. A Hub comment for
// it is then typed into it, once (clause 1). Den's typed text names who
// wrote it: "(your person · …)" for the install's own person. Only that
// comment answers the question, so clause 2 (the question leaves the
// bell) runs only when the bed's Hub comments as the install's person;
// otherwise it skips (needs-owner-comment): Hub refuses a person's
// sign-in link in an agent session, so the clause is the person's to check.
//
// Clause 3: a second stub shows a permission dialog (proven on screen,
// with its hook), then a Hub comment comes for it. Nothing is typed. Hub
// hears `queued` (ctx.hub.delivery). Den's side: the agent's row counts
// the comment as waiting with the dialog as its reason (waitingWhy
// "permission"), and Den's held file, which doctor reads, keeps the plain
// reason Hub was told ("a permission question is on its screen"); doctor
// --json lists it. The bed's Hub helper doesn't return the ack's reason,
// so the words Hub got are read from Den's own record of what it sent.
// The bell's item for a held comment comes only after
// hub.delivery_held_bell_minutes (default 5), so this check reads doctor.
//
// A stub mid-turn draws no dialog: clause 3 is then not run (skip
// needs-dialog), nothing is posted. Without a Hub on the bed, every
// clause skips (needs-hub). Stub names are new each run, so a comment an
// earlier run left can't reach them.
// Hub's delivery list doesn't show a delivery's answer yet: `ack` reads null
// whatever Hub stored. A delivery that has left Hub's unanswered list
// (`acked: true`) was answered; Den's side (row, reason, doctor) says how.
// When Hub shows the answer, the answer itself is checked.
const answered = (d) => d != null && d.ack == null && d.acked === true;

import { doctorChecks } from "./lib/read-json.mjs";
export const issue = 701;
export const clauses = [
  "a Hub comment for an agent that asked its person a question (ask_human) is typed into the agent, once",
  "a comment from the agent's own person clears its question in the bell",
  "a comment Den holds shows its plain reason on the agent's row and in doctor, and Hub hears queued with that reason",
];
export const timeoutMs = 300000;

const WS = "proj-gate";
const ASK = "gate-701-ask";
const HELD = "gate-701-held";
const QUESTION = "Gate 701: which file should I open first?";
const ASK_MS = 15000;
const DIALOG_MS = 10000;
const TYPED_MS = 60000;
const QUIET_MS = 15000;
const REASON = "a permission question is on its screen";
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

/** The bell, for one agent: its waiting rows and its "needs you" items. */
async function bellOf(ctx, id) {
  const n = await ctx.api("/api/notifications").catch(() => ({}));
  const items = [
    ...(n?.groups ?? []),
    ...(n?.updates?.groups ?? []),
    ...(n?.older?.groups ?? []),
  ]
    .flatMap((g) => g?.subjects ?? [])
    .filter((s) => s?.subject === `agent:${id}`)
    .flatMap((s) => s?.items ?? []);
  const waits = (n?.waiting ?? []).filter((w) => w?.agent === id);
  return {
    asked: waits.some((w) => w?.why === "asked"),
    why: waits.map((w) => w?.why ?? null),
    items: items.filter((i) => i?.kind === "waiting" && !i?.read).length,
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

/** The agent's row as the Agents page gets it. */
async function rowOf(ctx, id) {
  const d = await ctx
    .api(`/api/sessions?all=1&ws=${encodeURIComponent(WS)}`)
    .catch(() => null);
  const r = (d?.sessions ?? []).find(
    (s) => s?.kind === "agent" && s?.agent === id,
  );
  return r
    ? {
        waitingWhy: r.waitingWhy ?? null,
        queued: r.hubWork?.queued ?? 0,
        held: r.hubWork?.held ?? null,
      }
    : null;
}

/** Den's held file: the reason it last told Hub for `id`'s comments. */
function heldReason(ctx, id) {
  const f = parse(ctx.readBed("state:hub/deliveries-seen.json"));
  const q = f?.held?.queue?.[id];
  if (!Array.isArray(q)) return null;
  return q.map((r) => r?.held_reason).find((x) => typeof x === "string") ?? "";
}

/** doctor --json's "Hub comments held" row. */
function doctorHeld(ctx) {
  const r = ctx.cli(["doctor", "--json"], { timeout: 90000 });
  const c = doctorChecks(r).find((x) => x?.id === "hub_held_comments");
  return c ? String(c.detail ?? "") : null;
}

async function startStub(ctx, name) {
  const a = ctx.agent(name, { workspace: WS });
  const code = a.start("tester")?.code ?? null;
  const runningMs = await a.running(30000);
  return { a, code, running: runningMs !== null && runningMs !== undefined };
}

export async function setup(ctx) {
  return { ask: fresh(ASK), held: fresh(HELD), hub: !!ctx.hub };
}

/** Clauses 1 and 2. */
async function asked(ctx, s) {
  const r = { agent: s.ask };
  const { a, code, running } = await startStub(ctx, s.ask);
  r.start = code;
  r.running = running;
  if (!running) return r;
  await ctx.sleep(2000);
  a.askHuman(QUESTION);
  // Its turn ends on the question, as a real agent's does.
  await a.hook("Stop", {
    stop_hook_active: false,
    last_assistant_message: QUESTION,
  });
  r.askedMs = await ctx.until(
    async () => (await bellOf(ctx, s.ask)).asked,
    ASK_MS,
  );
  r.bellAsked = await bellOf(ctx, s.ask);
  if (r.askedMs === null) {
    r.askLog = JSON.stringify(
      (ctx.stubLog?.(s.ask, { k: "sh" }) ?? []).slice(-1),
    ).slice(0, 300);
    return r;
  }
  const token = `g701ask-${Date.now()}`;
  const since = Date.now();
  try {
    r.id =
      (
        await ctx.hub.comment({
          agent: s.ask,
          workspace: WS,
          text: `gate 701: a Hub comment for an agent that asked a question (${token})`,
        })
      )?.id ?? null;
  } catch (e) {
    r.postThrew = String(e?.message ?? e).slice(0, 200);
    return r;
  }
  r.typedMs = await ctx.until(
    async () => ((await typedOf(a, since)) ?? "").includes(token),
    TYPED_MS,
  );
  const typed = (await typedOf(a, since)) ?? "";
  r.typedTimes = typed.split(token).length - 1;
  // Den's header for the comment: who wrote it, as Den sees them.
  r.from = /\(([^·()]*)·/.exec(typed)?.[1]?.trim() ?? null;
  r.own = /\(your person\s*·/.test(typed);
  r.by = ctx.hub.by ?? null;
  if (r.typedMs !== null && r.own)
    r.clearedMs = await ctx.until(async () => {
      const b = await bellOf(ctx, s.ask);
      return !b.asked && b.items === 0;
    }, 20000);
  r.bellAfter = await bellOf(ctx, s.ask);
  r.delivery = r.id ? await ctx.hub.delivery(r.id).catch(() => null) : null;
  return r;
}

/** Clause 3. */
async function held(ctx, s) {
  const r = { agent: s.held };
  const { a, code, running } = await startStub(ctx, s.held);
  r.start = code;
  r.running = running;
  if (!running) return r;
  await ctx.sleep(2000);
  a.permissionRequest("Bash", { command: "npm test" });
  r.raisedMs = await ctx.until(
    async () => (await bellOf(ctx, s.held)).why.includes("permission"),
    DIALOG_MS,
  );
  if (r.raisedMs === null) {
    r.noDialog = true;
    return r;
  }
  await ctx.sleep(1500);
  const token = `g701held-${Date.now()}`;
  const since = Date.now();
  try {
    r.id =
      (
        await ctx.hub.comment({
          agent: s.held,
          workspace: WS,
          text: `gate 701: a Hub comment Den holds (${token})`,
        })
      )?.id ?? null;
  } catch (e) {
    r.postThrew = String(e?.message ?? e).slice(0, 200);
    return r;
  }
  r.queuedMs = r.id
    ? await ctx.until(async () => {
        const d = await ctx.hub.delivery(r.id).catch(() => null);
        return d?.ack === "queued" || answered(d);
      }, 20000)
    : null;
  r.delivery = r.id ? await ctx.hub.delivery(r.id).catch(() => null) : null;
  r.reasonMs = await ctx.until(() => !!heldReason(ctx, s.held), 20000);
  r.reason = heldReason(ctx, s.held);
  r.rowMs = await ctx.until(
    async () => ((await rowOf(ctx, s.held))?.queued ?? 0) > 0,
    15000,
  );
  r.row = await rowOf(ctx, s.held);
  r.doctor = doctorHeld(ctx);
  const left = QUIET_MS - (Date.now() - since);
  if (left > 0) await ctx.sleep(left);
  r.typedWhileHeld = await typedOf(a, since);
  // The stub answers its own dialog (its screen clears; its hook says the
  // tool ran), so the comment goes in before the stub is removed.
  a.print(PROMPT);
  await a.hook("PostToolUse", { tool_name: "Bash" });
  return r;
}

export async function run(ctx, s) {
  const out = { hub: s?.hub === true };
  if (!out.hub) return out;
  out.asked = await asked(ctx, s);
  try {
    ctx.agent(s.ask, { workspace: WS }).remove();
  } catch {
    /* teardown tries again */
  }
  out.held = await held(ctx, s);
  ctx.log?.(`701: ${JSON.stringify(out)}`);
  return out;
}

export async function teardown(ctx, s) {
  for (const id of [s?.ask, s?.held]) {
    if (!id) continue;
    try {
      const a = ctx.agent(id, { workspace: WS });
      if (a.state()) a.remove();
    } catch {
      /* none */
    }
  }
}

const NO_HUB = {
  ok: null,
  skip: "needs-hub",
  detail: "the bed has no Hub, so no comment can reach an agent",
};

export function expect(r) {
  const res = r ?? {};
  if (!res.hub) return clauses.map((clause) => ({ clause, ...NO_HUB }));
  const q = res.asked ?? {};
  const h = res.held ?? {};

  const qBase = !q.running
    ? `the ${q.agent} stub did not run in ${WS} (start ${q.start})`
    : q.askedMs == null
      ? `ask_human never showed in the bell as "asked" within ${ASK_MS} ms (its call: ${q.askLog})`
      : q.postThrew
        ? `the comment could not be posted: ${q.postThrew}`
        : null;
  const c1 =
    q.running === true &&
    q.askedMs != null &&
    !!q.id &&
    q.typedMs != null &&
    q.typedTimes === 1;
  const d1 =
    qBase ??
    `asked in the bell ${q.askedMs} ms (${JSON.stringify(q.bellAsked)}); comment ${q.id}; typed ${q.typedMs} ms, ${q.typedTimes} time(s); Den saw it from ${JSON.stringify(q.from)}; Hub then ${JSON.stringify(q.delivery)}`;

  let row2;
  if (c1 && !q.own)
    row2 = {
      ok: null,
      skip: "needs-owner-comment",
      detail:
        "Hub refuses a person's sign-in link in an agent session, so the bed can't comment as the install's own person; this clause goes to the person's check list.",
    };
  else
    row2 = {
      ok: c1 && q.own === true && q.clearedMs != null,
      detail:
        qBase ??
        `typed ${q.typedMs} ms as from ${JSON.stringify(q.from)}; question gone from the bell ${q.clearedMs} ms; bell after ${JSON.stringify(q.bellAfter)}`,
    };

  let row3;
  if (h.running && h.noDialog)
    row3 = {
      ok: null,
      skip: "needs-dialog",
      detail: `${h.agent}: the dialog never came up (no "permission" wait in the bell within ${DIALOG_MS} ms); no comment posted`,
    };
  else {
    const ok =
      h.running === true &&
      !!h.id &&
      h.typedWhileHeld === "" &&
      (h.delivery?.ack === "queued" || answered(h.delivery)) &&
      h.reason === REASON &&
      (h.row?.queued ?? 0) > 0 &&
      h.row?.waitingWhy === "permission" &&
      typeof h.doctor === "string" &&
      h.doctor.includes(h.agent) &&
      h.doctor.includes(REASON);
    row3 = {
      ok,
      detail: !h.running
        ? `the ${h.agent} stub did not run in ${WS} (start ${h.start})`
        : h.postThrew
          ? `the comment could not be posted: ${h.postThrew}`
          : `comment ${h.id}; typed while held ${JSON.stringify((h.typedWhileHeld ?? "(the stub can't say)").slice(0, 80))}; Hub ${JSON.stringify(h.delivery)} (queued ${h.queuedMs} ms); reason Den told Hub ${JSON.stringify(h.reason)} (${h.reasonMs} ms); row ${JSON.stringify(h.row)}; doctor ${JSON.stringify((h.doctor ?? "(no row)").slice(0, 300))}`,
    };
  }
  return [
    { clause: clauses[0], ok: c1, detail: d1 },
    { clause: clauses[1], ...row2 },
    { clause: clauses[2], ...row3 },
  ];
}
