// gate/714.mjs: gate slots held over MCP: told on grant, passed on when
// unclaimed, and leased (issue 714).
//
// Clause 1 runs through the bed's own gate folder (the bed-gate-dir proof
// on v0.4.85) with two stub agents, each holding its own MCP session for
// the whole check (ctx.mcp, issue 1213):
//   A asks and holds; B asks and waits; B goes idle at its prompt.
//   A releases: B's slot is granted and Den types the grant line into B.
//   A asks again (now next in line). B never claims: after claim_minutes
//   the slot goes to A, and Den tells B it passed on and B is back in line.
// It asks for a browser slot ("self": the container rule on a macOS bed).
//
// On a bed without ctx.mcp clause 1 is not run (needs-mcp-session): a
// one-shot `mcp --call` exits at once, and its slot is taken back as gone.
//
// Clauses 2 to 4 need a lapse, which needs claim_minutes and
// mcp_lapse_minutes at 1: gate settings are person-only, and a fixture
// session counts as an agent there (issue 814, bed coverage of person-only
// paths). At the defaults one run would take over 17 minutes.
export const issue = 714;
// Issue 866 asked for this live check; issue 1213 gave it ctx.mcp.
export const items = [714, 866, 1213];
export const clauses = [
  "a queued agent that idles is woken by the grant message; unclaimed after claim_minutes, the slot goes to the next in line, and the agent is re-queued and told",
  "an MCP slot not renewed and past its estimate lapses within the lapse time, and the next holder starts",
  "a renewed slot past its estimate keeps holding",
  "the lapse shows in the slot log and the bell, and the agent's next gate call says so",
];
// It starts two stub agents and asks the bed's gate: it runs alone.
export const timeoutMs = 600000;

/** The grant line can take one notice tick (10 s) and a prompt to land. */
const GRANT_MS = 90_000;
/** Past claim_minutes (3 by default) by a notice tick and a margin. */
const PASS_EXTRA_MS = 120_000;

const NO_MCP =
  "this bed's harness has no ctx.mcp (issue 1213): a one-shot mcp --call exits at once, and its slot is taken back as gone. Not asked";
const PERSON =
  "needs claim_minutes and mcp_lapse_minutes at 1 for the bed run; gate settings are person-only, and a fixture session counts as an agent there (issue 814). Not asked";

const parse = (r) => {
  try {
    return JSON.parse(r?.text ?? "");
  } catch {
    return { error: String(r?.text ?? "").slice(0, 300) };
  }
};

/** What Den typed into a stub since `since`, as one string. */
async function typedText(ctl, since) {
  try {
    const rows = await ctl.typed({ since });
    return Array.isArray(rows) ? rows.map((x) => x?.text ?? "").join("") : "";
  } catch {
    return "";
  }
}

/** A stub agent under this check's own name, running, recorded for teardown. */
async function stub(ctx, state, role) {
  const name = `gate714-${role}-${state.tag}`;
  const ctl = await ctx.agent(name);
  const a = { name, id: ctl?.id ?? name, ctl };
  state.made.push(a);
  const r = await ctl.start("tester");
  if (r && typeof r.code === "number" && r.code !== 0)
    throw new Error(
      `${name}: the bed refused to start it: ${String(r.all ?? r.err ?? r.out ?? "").slice(0, 200)}`,
    );
  await ctl.running(20000);
  return a;
}

/** A session recorded for teardown (the harness closes it too). */
async function session(ctx, state, a) {
  const m = await ctx.mcp({ agent: a.id });
  state.sessions.push({ m, slots: new Set() });
  return state.sessions.at(-1);
}

async function ask(s, state, more = {}) {
  const v = parse(
    await s.m.call("gate_slot_request", {
      kind: "browser",
      label: `gate714-${state.tag}`,
      estimate_minutes: 5,
      browser_endpoint: "self",
      ...more,
    }),
  );
  if (v?.id) s.slots.add(v.id);
  return v;
}

export async function setup(ctx) {
  return {
    mcp: typeof ctx.mcp === "function",
    tag: Date.now().toString(36),
    made: [],
    sessions: [],
  };
}

export async function run(ctx, state) {
  if (!state.mcp) return { mcp: false };
  const r = { mcp: true };
  const A = await stub(ctx, state, "a");
  const B = await stub(ctx, state, "b");
  const sa = await session(ctx, state, A);
  const sb = await session(ctx, state, B);

  const a1 = await ask(sa, state);
  const b1 = await ask(sb, state);
  r.aGranted = a1.granted === true;
  r.bWaited = b1.granted === false;
  if (!r.aGranted || !r.bWaited) {
    r.why = `A ${JSON.stringify(a1).slice(0, 200)}; B ${JSON.stringify(b1).slice(0, 200)}`;
    return r;
  }

  // B idles at its prompt; A gives its slot back.
  await B.ctl.idlePrompt();
  const since = ctx.now();
  await sa.m.call("gate_slot_release", { id: a1.id });
  sa.slots.delete(a1.id);
  const grant = `slot is granted: ${b1.id}`;
  r.grantMs = await ctx.until(
    async () => (await typedText(B.ctl, since)).includes(grant),
    GRANT_MS,
  );

  // A asks again: next in line. B never claims.
  const a2 = await ask(sa, state);
  const passed = `${b1.id} passed to the next in line`;
  const status = parse(await sa.m.call("gate_slot_status", {}));
  const claimMin = Number(status?.settings?.claimMinutes ?? 3);
  r.passMs = await ctx.until(
    async () => (await typedText(B.ctl, since)).includes(passed),
    claimMin * 60_000 + PASS_EXTRA_MS,
  );
  // The slot went to A, the next in line.
  const a3 = parse(await sa.m.call("gate_slot_request", { id: a2.id }));
  r.aGotIt = a3.granted === true;
  // B is back in line: a waiting slot of B's is in the queue.
  const after = parse(await sb.m.call("gate_slot_status", {}));
  const bWho = (e) => String(e?.who ?? "").includes(B.id);
  const slots = after?.slots ?? after?.entries ?? [];
  r.bRequeued = slots.some((e) => bWho(e) && !e.grantedAt && !e.granted);
  return r;
}

export function expect(r) {
  const rows = [];
  if (!r?.mcp)
    rows.push({
      clause: clauses[0],
      ok: null,
      skip: "needs-mcp-session",
      detail: NO_MCP,
    });
  else {
    const ok =
      r.aGranted &&
      r.bWaited &&
      r.grantMs !== null &&
      r.passMs !== null &&
      r.aGotIt &&
      r.bRequeued;
    rows.push({
      clause: clauses[0],
      ok: !!ok,
      detail: r.why
        ? `the line didn't form: ${r.why}`
        : `grant line typed after ${r.grantMs ?? "never (90 s)"} ms; passed-on line after ${r.passMs ?? "never"} ms; next in line got it: ${!!r.aGotIt}; B back in line: ${!!r.bRequeued}`,
    });
  }
  for (const clause of clauses.slice(1))
    rows.push({ clause, ok: null, skip: "person", detail: PERSON });
  return rows;
}

export async function teardown(ctx, state) {
  for (const s of state?.sessions ?? []) {
    for (const id of s.slots)
      await Promise.resolve(s.m.call("gate_slot_release", { id })).catch(
        () => {},
      );
    await Promise.resolve(s.m.close?.()).catch(() => {});
  }
  for (const a of state?.made ?? [])
    await Promise.resolve(a.ctl?.remove?.()).catch(() => {});
}
