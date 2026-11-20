// gate/658.mjs: Resume of a conversation that was never written starts the
// agent fresh under the same id, with its last handoff, and never a 502.
//
// Clauses 1 and 2: a stub agent runs and writes its handoff (as an agent
// does: from inside its own session, into its files folder, with the five
// headings and a token new each run). It is stopped, and relaunched from
// that handoff (POST .../relaunch {fromHandoff: true}, as the ⋯ menu
// does), with the stub's next start in mode "unwritten"
// (ctx.stub.nextStart): it exits 1 before writing any conversation.
// Clause 2: handoff.md comes back (with the token) and the rotation is
// due again (Den's look, or its Resume). Clause 1: Resume (POST
// .../resume) then answers 200, never 502, and starts the agent from the
// handoff: the answer says it relaunched or used the handoff, the agent
// runs, its new conversation is written, and handoff.md is kept aside
// again (in handoffs/, with the token). The stub's log drops a start's
// multi-line arguments, so the prompt's own text isn't read here.
//
// Clause 3: a new agent whose first start is "unwritten" (no handoff
// ever). Resume answers 200, never 502, says "nothing to resume yet"
// (and no handoff), and the stub starts fresh (not --resume) under the
// same conversation id the failed start had.
//
// A bed without the stub's start modes skips every clause
// (needs-stub-start-modes).
export const issue = 658;
export const clauses = [
  "after a relaunch that exits before its conversation exists, Resume starts the agent with its handoff as the first prompt, never a 502",
  "a relaunch that exits at once leaves handoff.md in place and the rotation due",
  "with no handoff on file, Resume starts fresh under the same id and says it had nothing to continue",
];
export const timeoutMs = 300000;

const HAND = "gate-658-hand";
const NONE = "gate-658-none";
const BACK_MS = 90000;

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

const recordOf = (ctx, id) => parse(ctx.readBed(`state:agents/${id}.json`));
const files = (id, rel) => `state:agent-files/${id}/${rel}`;

/** A handoff that passes Den's check, with this run's token. */
const handoffText = (token) =>
  [
    "## Objective",
    `Gate 658 (${token}): relaunch from this handoff after a start that wrote nothing.`,
    "",
    "## State",
    "The stub wrote this handoff from inside its own session.",
    "",
    "## Open items",
    "None.",
    "",
    "## How to QA",
    "Check that Resume starts from this handoff and never answers 502.",
    "",
    "## Next step",
    "Report the result.",
    "",
  ].join("\n");

/** POST a lifecycle verb through the page's route: { status, body }. */
async function verb(ctx, ws, id, v, body = {}) {
  const r = await ctx.fetch(
    `/api/workspaces/${encodeURIComponent(ws)}/agents/${encodeURIComponent(id)}/${v}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const b = parse(r.body) ?? {};
  return {
    status: r.status,
    code: b.code ?? null,
    note: typeof b.note === "string" ? b.note : null,
    handoff: b.handoff === true,
    relaunched: b.relaunched === true,
    error: typeof b.error === "string" ? b.error.slice(0, 200) : null,
  };
}

const kept = (ctx, id, token) =>
  (ctx.listBed(files(id, "handoffs")) ?? []).some((n) =>
    (ctx.readBed(files(id, `handoffs/${n}`)) ?? "").includes(token),
  );

/** Clauses 1 and 2. */
async function withHandoff(ctx, id) {
  const a = ctx.agent(id);
  const r = { agent: id };
  r.start = a.start("tester")?.code ?? null;
  r.running = (await a.running(30000)) != null;
  const rec = recordOf(ctx, id);
  r.ws = rec?.workspace ?? null;
  if (!r.running || !r.ws) return r;
  await ctx.sleep(2000);
  // Its files folder, as its runtime was given it (the stub's start log).
  const st = (ctx.stubLog(id, { k: "start" }) ?? []).pop();
  const dir = st?.v?.filesDir ?? null;
  if (!dir) {
    r.noDir = true;
    return r;
  }
  r.token = `g658-${Date.now().toString(36)}`;
  // One control line: the newlines go as \n, printf %b makes them lines.
  const doc = handoffText(r.token).replace(/'/g, "").split("\n").join("\\n");
  r.wrote = (
    await a.sh(`printf '%b' '${doc}' > '${dir}/handoff.md'`, 30000)
  )?.status;
  r.onFile = (ctx.readBed(files(id, "handoff.md")) ?? "").includes(r.token);
  if (!r.onFile) return r;
  a.stop();
  await ctx.until(() => a.state() !== "running", 30000);
  // The relaunch's start writes nothing and exits 1.
  r.firstToken = recordOf(ctx, id)?.resumeToken ?? null;
  ctx.stub.nextStart({ mode: "unwritten" });
  r.relaunch = await verb(ctx, r.ws, id, "relaunch", { fromHandoff: true });
  r.relaunchToken = recordOf(ctx, id)?.resumeToken ?? null;
  r.relaunchExit = JSON.stringify(
    (ctx.stubLog(id, { k: "exit" }) ?? []).map((x) => x?.v),
  ).slice(0, 120);
  // Clause 2: handoff.md back, the rotation due again.
  r.backMs = await ctx.until(() => {
    const h = ctx.readBed(files(id, "handoff.md")) ?? "";
    const rot = parse(ctx.readBed(files(id, "rotation.json")));
    return h.includes(r.token) && !!rot?.due;
  }, BACK_MS);
  r.handoffBack = (ctx.readBed(files(id, "handoff.md")) ?? "").includes(
    r.token,
  );
  const rot = parse(ctx.readBed(files(id, "rotation.json")));
  r.rotation = rot
    ? { due: rot.due ?? null, relaunchWanted: rot.relaunchWanted ?? null }
    : null;
  // Clause 1: Resume.
  r.resume = await verb(ctx, r.ws, id, "resume");
  r.runningAfter = (await a.running(30000)) != null;
  r.tokenAfter = recordOf(ctx, id)?.resumeToken ?? null;
  r.written = !!ctx.transcriptPath?.(id);
  r.keptAside =
    !(ctx.readBed(files(id, "handoff.md")) ?? "").includes(r.token) &&
    kept(ctx, id, r.token);
  const last = recordOf(ctx, id)?.rotations?.slice(-1)?.[0];
  r.lastRotation = last ? { reason: last.reason ?? null } : null;
  return r;
}

/** Clause 3. */
async function noHandoff(ctx, id) {
  const a = ctx.agent(id);
  const r = { agent: id };
  ctx.stub.nextStart({ mode: "unwritten" });
  try {
    r.start = a.start("tester")?.code ?? null;
  } catch (e) {
    r.start = `threw: ${String(e?.message ?? e).slice(0, 120)}`;
  }
  const rec = recordOf(ctx, id);
  r.ws = rec?.workspace ?? null;
  r.firstToken = rec?.resumeToken ?? null;
  if (!r.ws) return r;
  await ctx.until(() => a.state() !== "running", 15000);
  r.firstExit = JSON.stringify(
    (ctx.stubLog(id, { k: "exit" }) ?? []).map((x) => x?.v),
  ).slice(0, 120);
  r.resume = await verb(ctx, r.ws, id, "resume");
  r.runningAfter = (await a.running(30000)) != null;
  r.tokenAfter = recordOf(ctx, id)?.resumeToken ?? null;
  const starts = ctx.stubLog(id, { k: "start" }) ?? [];
  r.starts = starts.length;
  r.lastResumed = starts.length ? starts.at(-1)?.v?.resumed === true : null;
  r.written = !!ctx.transcriptPath?.(id);
  return r;
}

export async function setup() {
  return { hand: fresh(HAND), none: fresh(NONE) };
}

export async function run(ctx, s) {
  const out = { modes: typeof ctx.stub?.nextStart === "function" };
  if (!out.modes) return out;
  out.hand = await withHandoff(ctx, s.hand);
  try {
    ctx.stub.clearNextStart?.();
    ctx.agent(s.hand).remove();
  } catch {
    /* teardown tries again */
  }
  out.none = await noHandoff(ctx, s.none);
  ctx.log?.(`658: ${JSON.stringify(out)}`);
  return out;
}

export async function teardown(ctx, s) {
  try {
    ctx.stub?.clearNextStart?.();
  } catch {
    /* none */
  }
  for (const id of [s?.hand, s?.none]) {
    if (!id) continue;
    try {
      const a = ctx.agent(id);
      if (a.state()) a.remove();
    } catch {
      /* none */
    }
  }
}

const never502 = (v) => !!v && v.status === 200 && v.code !== "resume_failed";

export function expect(r) {
  const res = r ?? {};
  if (!res.modes)
    return clauses.map((clause) => ({
      clause,
      ok: null,
      skip: "needs-stub-start-modes",
      detail:
        "the bed's stub has no start modes (ctx.stub.nextStart), and it writes its conversation as soon as it starts",
    }));
  const h = res.hand ?? {};
  const n = res.none ?? {};
  const pre = !h.running
    ? `the ${h.agent} stub did not run (start ${h.start})`
    : h.noDir
      ? "the stub's start log has no files folder"
      : !h.onFile
        ? `its handoff was not written (sh ${h.wrote})`
        : null;
  const relaunchSaid = `relaunch ${JSON.stringify(h.relaunch)}, stub exit ${h.relaunchExit} (conversation ${h.firstToken} → ${h.relaunchToken})`;
  const c2 =
    !pre && h.backMs != null && h.handoffBack === true && !!h.rotation?.due;
  const c1 =
    !pre &&
    h.backMs != null &&
    never502(h.resume) &&
    (h.resume.relaunched || h.resume.handoff) &&
    h.runningAfter === true &&
    h.written === true &&
    h.keptAside === true;
  const c3 =
    n.ws != null &&
    never502(n.resume) &&
    /nothing to resume yet/.test(n.resume?.note ?? "") &&
    n.resume?.handoff === false &&
    n.runningAfter === true &&
    !!n.firstToken &&
    n.tokenAfter === n.firstToken &&
    n.starts >= 2 &&
    n.lastResumed === false &&
    n.written === true;
  return [
    {
      clause: clauses[0],
      ok: c1,
      detail:
        pre ??
        `${relaunchSaid}; back ${h.backMs} ms; resume ${JSON.stringify(h.resume)}; running ${h.runningAfter}; conversation ${h.tokenAfter} written ${h.written}; handoff kept aside ${h.keptAside}; last rotation ${JSON.stringify(h.lastRotation)}`,
    },
    {
      clause: clauses[1],
      ok: c2,
      detail:
        pre ??
        `${relaunchSaid}; handoff.md back ${h.handoffBack} (${h.backMs} ms); rotation ${JSON.stringify(h.rotation)}`,
    },
    {
      clause: clauses[2],
      ok: c3,
      detail: !n.ws
        ? `the ${n.agent} agent has no record (start ${n.start})`
        : `first start ${n.start}, exit ${n.firstExit}; resume ${JSON.stringify(n.resume)}; running ${n.runningAfter}; conversation ${n.firstToken} → ${n.tokenAfter}; stub starts ${n.starts}, last resumed ${n.lastResumed}; written ${n.written}`,
    },
  ];
}
