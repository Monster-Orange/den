// gate/500.mjs: a terminal host that doesn't answer says so, and Restart
// replaces it (issue 500). On the bed: a stub agent of its own starts the
// terminal host; the host's sessions.host.json (its pid, start and
// version) must name the same host doctor's Host row does; the installed
// Den's terminal host client must wait Settings › Terminal host wait; and a person's
// Restart (the route Terminal's Restart button calls through the working
// pop-up) must replace the host, with a new agent starting in the new one.
// The Restart runs only when the host holds nothing but this check's own
// agent (it ends every terminal and agent in the host); else it is skipped.
// A host that holds its socket and answers nothing can't be stood up on
// the bed from a check; doctor's ✗ and Terminal's host_stuck for one are
// proven in the PR's tests (tests/unit/sessions/host-stuck.test.ts and
// tests/unit/server/agent-routes.test.ts).
//
// Clause 2 of the issue (an update replaces an old host) is gate 563's
// (issue 597's rule); clause 3 (the host says its version) is its hello,
// which gate 563 reads too.
export const issue = 500;
export const clauses = [
  "the terminal host writes its pid, start and version to sessions.host.json, and doctor's Host row names that same host",
  "the terminal host's hello waits Settings › Terminal host wait (agents_list.host_timeout_seconds), a Setting with a permissive default (10 s)",
  "a person's Restart replaces the terminal host, and a new agent starts in the new one",
  "a host that doesn't answer: doctor shows ✗ with the reason and the host's version, and Terminal answers host_stuck (offering Restart) instead of a silent click",
];
export const timeoutMs = 180000;

const AGENT = "gate-500";

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

/** Doctor's terminal host row: { status, detail, host, stuck } or null. */
function hostRow(ctx) {
  const d = parse(ctx.cli(["doctor", "--json"]).out);
  const c = (Array.isArray(d?.checks) ? d.checks : []).find(
    (x) => x?.id === "terminal_host_module",
  );
  return c
    ? {
        status: c.status,
        detail: String(c.detail ?? ""),
        host: c.host ?? null,
        stuck: c.stuck === true,
      }
    : null;
}

const info = (ctx) => parse(ctx.readBed("state:sessions.host.json"));

export async function setup() {
  return {};
}

export async function run(ctx) {
  const out = {};
  const a = ctx.agent(AGENT);
  out.start = a.start("tester")?.code ?? null;
  out.runningMs = await a.running(30000);
  out.row = hostRow(ctx);
  out.info = info(ctx);
  const cfg =
    ctx.readBed(
      "node_modules/@monster-orange/den/src/shared/sessions/client.ts",
    ) ?? "";
  out.keyRead = /hostAnswerMs\(/.test(cfg) && /agentsListWaits/.test(cfg);
  const def = /DEFAULT_HOST_WAIT_SECONDS\s*=\s*(\d+)/.exec(cfg);
  out.defaultS = def ? Number(def[1]) : null;

  // The Restart: only when nothing but this check's agent runs in the host.
  const list = parse(await ctx.api("/api/sessions").catch(() => null));
  const live = (Array.isArray(list?.sessions) ? list.sessions : []).filter(
    (s) => !s?.exited && !(s?.kind === "agent" && s?.agent === AGENT),
  );
  out.others = live.length;
  if (live.length === 0) {
    const r = await ctx
      .fetch("/api/agents/terminal-host/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      .catch((e) => ({ status: 0, body: String(e?.message ?? e) }));
    const body = parse(r.body);
    out.restart = { status: r.status, restarted: body?.restarted ?? null };
    out.afterInfo = info(ctx);
    // A new agent starts in the new host.
    try {
      if (a.state()) a.remove();
    } catch {
      /* gone with the host */
    }
    out.start2 = a.start("tester")?.code ?? null;
    out.running2Ms = await a.running(30000);
    out.after = hostRow(ctx);
  }
  ctx.log?.(`500: ${JSON.stringify(out)}`);
  return out;
}

export async function teardown(ctx) {
  try {
    if (ctx.agent(AGENT).state()) ctx.agent(AGENT).remove();
  } catch {
    /* none */
  }
}

export function expect(r) {
  const res = r ?? {};
  const h = res.row?.host ?? null;
  const i = res.info ?? null;
  const c1 =
    !!h &&
    !!i &&
    i.pid === h.pid &&
    i.den === h.den &&
    i.startedAt === h.startedAt &&
    res.row?.status === "ok";
  const c2 =
    res.keyRead === true &&
    typeof res.defaultS === "number" &&
    res.defaultS >= 10;
  const note = (ok, s) => (ok ? {} : { note: s });
  const rows = [
    {
      clause: clauses[0],
      ok: c1,
      ...note(c1, `row ${JSON.stringify(res.row)}; file ${JSON.stringify(i)}`),
    },
    {
      clause: clauses[1],
      ok: c2,
      ...note(c2, `read ${res.keyRead}, default ${res.defaultS}`),
    },
  ];
  if (!res.restart)
    rows.push({
      clause: clauses[2],
      ok: null,
      skip: "needs-idle-terminal-host",
    });
  else {
    const rs = res.restart.restarted ?? {};
    const nh = res.after?.host ?? null;
    const c3 =
      res.restart.status === 200 &&
      rs.forced === false &&
      !!h &&
      rs.from === h.pid &&
      rs.to > 0 &&
      rs.to !== h.pid &&
      res.afterInfo?.pid === rs.to &&
      nh?.pid === rs.to &&
      res.start2 === 0 &&
      res.running2Ms !== null &&
      res.running2Ms !== undefined;
    rows.push({
      clause: clauses[2],
      ok: c3,
      ...note(
        c3,
        `restart ${JSON.stringify(res.restart)}; before ${h?.pid}; file after ${res.afterInfo?.pid}; row after ${nh?.pid}; start ${res.start2}, running ${res.running2Ms}`,
      ),
    });
  }
  rows.push({ clause: clauses[3], ok: null, skip: "needs-stuck-host" });
  return rows;
}
