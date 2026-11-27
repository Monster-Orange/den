// gate/659.mjs: Claude Code's folder-trust question is never answered by
// Den's typing, and the agent's row, pane and bell name it.
//
// Clause 1: a running stub draws Claude Code 2.1.329's trust question
// (the captured screen in tests/fixtures/claude-code-screens/1-trust.raw,
// without its colours: "No, exit" highlighted first, so a bare Enter would
// pick it). A message from the page (POST .../agents/<id>/say) then
// answers 409 dialog_open, and nothing at all reaches the stub's terminal
// (no text, no Enter). The stub then clears its screen.
//
// Clause 2: a stub starts on the trust screen (ctx.stub.nextStart, mode
// "trust", "No, exit" highlighted, so a bare Enter would decline), once
// in each shape: "1. Yes, I trust this folder" (a) and "1. Yes, proceed"
// (b). No conversation is written until it's answered. While it shows:
// the agent's row (/api/sessions) is waiting with waitingWhy "trust" (the
// pane reads the same row), the bell has its "Waiting: trust this
// folder?" item, and the stub's log shows no key with Enter from Den.
// Shape a is then answered Yes by the stub's own stand-in for the person
// (ctx.stub.trust: its control channel, never Den's terminal or page),
// and the wait leaves the row and the bell.
//
// Clause 3: shape b is answered No the same way. The stub exits 1 with
// nothing written. The row says trustDeclined, and the bell has the
// "Didn't start: this folder isn't trusted. Resume and choose Yes." item.
//
// A bed without the stub's start modes skips clauses 2 and 3
// (needs-stub-start-modes). Without ctx.stub.trust, the answers (and so
// clause 3) skip as the person's.
import { allSessions } from "./lib/sessions.mjs";
export const issue = 659;
export const clauses = [
  "Den never answers the folder-trust question: a message to an agent showing it answers 409 dialog_open and types nothing, not even Enter",
  'while the folder-trust question is on screen, the agent\'s row, pane and bell say "Waiting: trust this folder?"',
  "after a No, the row says \"Didn't start: this folder isn't trusted. Resume and choose Yes.\"",
];
export const timeoutMs = 240000;

const NAME = "gate-659-trust";
const SHAPED = "gate-659-start";
const PROBE = "gate 659 probe: a message while the trust question shows";
const WAITING = "Waiting: trust this folder?";
const DECLINED =
  "Didn't start: this folder isn't trusted. Resume and choose Yes.";
// Den looks every agents.trust_check_seconds (5 by default).
const LOOK_MS = 30000;
// How long the screen is watched for a key from Den.
const QUIET_MS = 12000;
// Claude Code 2.1.329's trust question, as the stub's /print takes it
// (JSON string escapes, one line). "No, exit" is highlighted (❯).
const TRUST = [
  "\\u001b[2J\\u001b[H",
  " Accessing workspace:\\r\\n\\r\\n",
  " /tmp/project\\r\\n\\r\\n",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source\\r\\n",
  " project, or work from your team). If not, take a moment to review what's in this folder first.\\r\\n\\r\\n",
  " Claude Code'll be able to read, edit, and execute files here.\\r\\n\\r\\n",
  " Security guide\\r\\n\\r\\n",
  " \\u276f No, exit\\r\\n",
  "   Yes, I trust this folder\\r\\n\\r\\n",
  " Enter to confirm \\u00b7 Esc to cancel\\r\\n",
].join("");
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

/** Everything typed into the stub's terminal since `since`, or null. */
async function typedOf(a, since) {
  try {
    const rows = await a.typed({ since });
    if (!Array.isArray(rows)) return null;
    return rows.map((x) => `${x?.text ?? ""}${x?.enter ? "\\r" : ""}`).join("");
  } catch {
    return null;
  }
}

/** Keys Den sent with Enter since `since` (the stub's log), or null. */
function entersOf(ctx, id, since) {
  try {
    const rows = ctx.stubLog(id, { since, k: "keys" });
    if (!Array.isArray(rows)) return null;
    return rows.filter((x) => x?.v?.enter === true).length;
  } catch {
    return null;
  }
}

/** The person's answer on the trust screen: the stub's own stand-in. */
function answer(ctx, id, yes) {
  if (typeof ctx.stub?.trust !== "function") return false;
  ctx.stub.trust(id, yes);
  return true;
}

/** The agent's row, and its bell items' words. */
async function seen(ctx, id, ws) {
  const d = await allSessions(
    (u) => ctx.api(u),
    `ws=${encodeURIComponent(ws)}`,
  ).catch(() => null);
  const r = (d?.sessions ?? []).find(
    (s) => s?.kind === "agent" && s?.agent === id,
  );
  const n = await ctx.api("/api/notifications").catch(() => ({}));
  const items = [
    ...(n?.groups ?? []),
    ...(n?.updates?.groups ?? []),
    ...(n?.older?.groups ?? []),
  ]
    .flatMap((g) => g?.subjects ?? [])
    .filter((s) => s?.subject === `agent:${id}`)
    .flatMap((s) => s?.items ?? []);
  const said = (w, key) =>
    items.some((i) => String(i?.text ?? "").includes(w) || i?.msg?.key === key);
  return {
    row: r
      ? {
          waiting: r.waiting === true,
          waitingWhy: r.waitingWhy ?? null,
          trustDeclined: r.trustDeclined === true,
          exited: r.exited === true,
        }
      : null,
    bellWaiting: said(WAITING, "bell.m.trust"),
    bellDeclined: said(DECLINED, "bell.m.trustDeclined"),
  };
}

const onTrust = (v) =>
  v.row?.waiting === true && v.row?.waitingWhy === "trust" && v.bellWaiting;

/** Clause 1: a message while the trust question shows. */
async function message(ctx) {
  const a = ctx.agent(NAME);
  const r = { start: a.start("tester")?.code ?? null };
  const ms = await a.running(30000);
  r.running = ms !== null && ms !== undefined;
  const rec = parse(ctx.readBed(`state:agents/${NAME}.json`));
  r.ws = rec?.workspace ?? null;
  r.runtime = rec?.runtime ?? null;
  if (!r.running || !r.ws) return r;
  await ctx.sleep(2500);
  a.print(TRUST);
  // The stub takes its control file every 500 ms: let it draw.
  await ctx.sleep(3000);
  const since = Date.now();
  const res = await ctx.fetch(
    `/api/workspaces/${encodeURIComponent(r.ws)}/agents/${encodeURIComponent(NAME)}/say`,
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
  await ctx.sleep(2000);
  r.typed = await typedOf(a, since);
  a.print(PROMPT);
  return r;
}

/**
 * Clauses 2 and 3: a start on the trust screen in `shape`, answered Yes
 * (a) or No (b) by the stub's stand-in for the person.
 */
async function trustStart(ctx, id, shape, yes) {
  const a = ctx.agent(id);
  const r = { agent: id, shape };
  const since = Date.now();
  ctx.stub.nextStart({ mode: "trust", shape, default: "no" });
  try {
    r.start = a.start("tester")?.code ?? null;
  } catch (e) {
    r.startThrew = String(e?.message ?? e).slice(0, 200);
  }
  const rec = parse(ctx.readBed(`state:agents/${id}.json`));
  r.ws = rec?.workspace ?? null;
  if (!r.ws) return r;
  r.waitMs = await ctx.until(
    async () => onTrust(await seen(ctx, id, r.ws)),
    LOOK_MS,
  );
  // Watched a while: Den sends no Enter (no key at all) to the question.
  const left = QUIET_MS - (Date.now() - since);
  if (left > 0) await ctx.sleep(left);
  r.whileShown = await seen(ctx, id, r.ws);
  r.enters = entersOf(ctx, id, since);
  r.typed = await typedOf(a, since);
  r.startMode = JSON.stringify(
    (ctx.stubLog?.(id, { since, k: "start-mode" }) ?? []).map((x) => x?.v),
  ).slice(0, 200);
  r.answered = answer(ctx, id, yes);
  if (!r.answered) return r;
  if (yes)
    r.goneMs = await ctx.until(async () => {
      const v = await seen(ctx, id, r.ws);
      return !v.bellWaiting && v.row?.waitingWhy !== "trust";
    }, LOOK_MS);
  else
    r.declinedMs = await ctx.until(async () => {
      const v = await seen(ctx, id, r.ws);
      return v.row?.trustDeclined === true && v.bellDeclined;
    }, LOOK_MS);
  r.after = await seen(ctx, id, r.ws);
  r.trustLog = JSON.stringify(
    (ctx.stubLog?.(id, { since }) ?? [])
      .filter((x) => x?.k === "trust" || x?.k === "exit")
      .map((x) => ({ k: x.k, v: x.v })),
  ).slice(0, 200);
  return r;
}

export async function setup() {
  return { a: fresh(`${SHAPED}-a`), b: fresh(`${SHAPED}-b`) };
}

export async function run(ctx, s) {
  const out = { message: await message(ctx) };
  try {
    ctx.agent(NAME).remove();
  } catch {
    /* teardown tries again */
  }
  out.modes = typeof ctx.stub?.nextStart === "function";
  if (out.modes) {
    out.a = await trustStart(ctx, s.a, "a", true);
    try {
      ctx.agent(s.a).remove();
    } catch {
      /* teardown tries again */
    }
    out.b = await trustStart(ctx, s.b, "b", false);
  }
  ctx.log?.(`659: ${JSON.stringify(out)}`);
  return out;
}

export async function teardown(ctx, s) {
  try {
    ctx.stub?.clearNextStart?.();
  } catch {
    /* none */
  }
  for (const id of [NAME, s?.a, s?.b]) {
    if (!id) continue;
    try {
      const a = ctx.agent(id);
      if (a.state()) a.remove();
    } catch {
      /* none */
    }
  }
}

/** Clause 2 for one shape: the words while it shows, and no Enter. */
const shown = (x) =>
  !!x?.ws &&
  // The stub's log is read (its start took the trust mode): a log that
  // can't be read never passes as "no Enter".
  /"mode":"trust"/.test(x.startMode ?? "") &&
  x.waitMs != null &&
  onTrust(x.whileShown ?? {}) &&
  x.enters === 0 &&
  x.typed === "";

const said = (x) =>
  `shape ${x?.shape}: ${x?.startThrew ? `start threw ${x.startThrew}; ` : ""}start mode ${x?.startMode}; words ${x?.waitMs} ms; while shown ${JSON.stringify(x?.whileShown)}; Enter keys from Den ${x?.enters}; typed ${JSON.stringify(x?.typed)}`;

export function expect(r) {
  const res = r ?? {};
  const y = res.message ?? {};
  const ok1 =
    y.running === true &&
    !!y.ws &&
    y.status === 409 &&
    y.code === "dialog_open" &&
    y.typed === "";
  const d1 = !y.running
    ? `the ${NAME} stub did not run (start ${y.start})`
    : `runtime ${y.runtime}; ws ${y.ws}; status ${y.status} ${y.code}: ${y.error}; typed ${y.typed === null ? "(the stub can't say)" : JSON.stringify(y.typed)}`;
  const rows = [{ clause: clauses[0], ok: ok1, detail: d1 }];
  if (!res.modes) {
    const no = {
      ok: null,
      skip: "needs-stub-start-modes",
      detail:
        "the bed's stub has no start modes (ctx.stub.nextStart): it never shows the trust screen before its conversation is written",
    };
    rows.push({ clause: clauses[1], ...no }, { clause: clauses[2], ...no });
    return rows;
  }
  const a = res.a ?? {};
  const b = res.b ?? {};
  const yesGone = !a.answered || a.goneMs != null;
  rows.push({
    clause: clauses[1],
    ok: shown(a) && shown(b) && yesGone,
    detail: `${said(a)}; after Yes (${a.answered ? "the stub's stand-in" : "not answered"}) the words went ${a.goneMs} ms, then ${JSON.stringify(a.after)} ${a.trustLog}. ${said(b)}`,
  });
  if (!b.answered)
    rows.push({
      clause: clauses[2],
      ok: null,
      skip: "person",
      detail:
        "the bed has no stand-in to answer the trust screen (ctx.stub.trust): the No is the person's",
    });
  else
    rows.push({
      clause: clauses[2],
      ok:
        shown(b) &&
        b.declinedMs != null &&
        b.after?.row?.trustDeclined === true &&
        b.after?.bellDeclined === true,
      detail: `after No: declined ${b.declinedMs} ms; ${JSON.stringify(b.after)}; stub ${b.trustLog}`,
    });
  return rows;
}
