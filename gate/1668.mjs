export const issue = 1668;
export const items = [1668];

export const SEED_AGENTS = 140;
export const SEED_MB = 4;
export const TRIES = 5;
export const LIMIT_MS = 1500;
export const PROBE_MS = 500;
export const PROBE_AFTER_MS = 20;
export const IN_FLIGHT_MIN = 3;
export const IDLE_TRIES = 3;
export const HELPERS_WAIT_MS = 60000;

export const clauses = [
  `with ${SEED_AGENTS} agents, each with helpers and ${SEED_MB} MB of transcript, the agents list (GET /api/sessions) answers within ${LIMIT_MS} ms: the first list right after the seed (cold, its helpers not yet read), and the median of ${TRIES} tries once the list shows every seeded agent's helpers (within ${HELPERS_WAIT_MS / 1000} s)`,
  `while that list is being made, /api/server-info answers within ${PROBE_MS} ms (started ${PROBE_AFTER_MS} ms after each list, counted only while that list is still in flight, on at least ${IN_FLIGHT_MIN} of ${TRIES} tries, unless the list itself answers within ${PROBE_MS} ms, so nothing can wait behind it longer; the same bar holds during the cold list and on each poll while the helpers fill; its idle time is shown beside it)`,
];
export const SEED_WAY =
  "one real stub start makes a template agent; the gate process then writes the other agents' records, transcripts and helpers into that test Den's own state (the one home whose template record holds the token it just made), so seeding takes seconds and /api/sessions reads them as it reads any agent";
export const timeoutMs = 600000;

const WS = "proj-gate";
const TEMPLATE = "g1668-template";
const PREFIX = "g1668-a";
const idOf = (i) => `${PREFIX}${String(i).padStart(3, "0")}`;
const D2S = [];

const msg = (e) => String(e?.message ?? e).slice(0, 200);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

function findHome(fs, path, cwd, token) {
  if (!cwd) return { error: "the template's record names no folder" };
  const ups = [];
  for (let a = path.resolve(cwd), k = 0; k < 4; k++, a = path.dirname(a)) {
    ups.push(a);
    if (path.dirname(a) === a) break;
  }
  const list = (d) => {
    try {
      return fs.readdirSync(d).map((n) => path.join(d, n, "h"));
    } catch {
      return [];
    }
  };
  const holds = (h) => {
    try {
      const rec = JSON.parse(
        fs.readFileSync(path.join(h, "agents", `${TEMPLATE}.json`), "utf8"),
      );
      return rec.resumeToken === token;
    } catch {
      return false;
    }
  };
  const homes = [
    ...new Set(ups.flatMap((a) => [path.join(a, "h"), ...list(a)])),
  ].filter(holds);
  return homes.length === 1
    ? { home: homes[0] }
    : { error: `found ${homes.length} Den homes holding this template` };
}

function seed(fs, path, crypto, home, dir, made, mb = SEED_MB) {
  const adir = path.join(home, "agents");
  const tpl = JSON.parse(
    fs.readFileSync(path.join(adir, `${TEMPLATE}.json`), "utf8"),
  );
  const pad = "x".repeat(1800);
  const lines = [];
  for (let n = 0; n * 2000 < mb * 1048576; n++)
    lines.push(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: `toolu_s${n}`, content: pad },
          ],
        },
      }),
    );
  const body = lines.join("\n") + "\n";
  for (let i = 1; i <= SEED_AGENTS; i++) {
    const id = idOf(i);
    const token = crypto.randomUUID();
    const rec = {
      ...tpl,
      id,
      displayName: id,
      resumeToken: token,
      stoppedAt: new Date().toISOString(),
    };
    for (const k of ["sessionName", "peerName"])
      if (typeof rec[k] === "string") rec[k] = rec[k].split(TEMPLATE).join(id);
    rec.session = {
      ...(tpl.session && typeof tpl.session === "object" ? tpl.session : {}),
      id: crypto.randomUUID(),
    };
    for (const k of ["name"])
      if (typeof rec.session[k] === "string")
        rec.session[k] = rec.session[k].split(TEMPLATE).join(id);
    const f = path.join(adir, `${id}.json`);
    const t = path.join(dir, `${token}.jsonl`);
    made.push({ id, record: f, transcript: t });
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(rec, null, 2));
    fs.renameSync(`${f}.tmp`, f);
    fs.writeFileSync(t, body);
    const sub = path.join(dir, token, "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, "agent-h1.meta.json"),
      JSON.stringify({ toolUseId: "toolu_s1", requestShape: "task" }),
    );
    fs.writeFileSync(
      path.join(sub, "agent-h1.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
      }) + "\n",
    );
  }
}

function fillSay(fill) {
  const xs = fill ?? [];
  if (!xs.length) return "none (helpers were there at once)";
  return `${xs.length} probes, max ${Math.max(...xs.map((p) => p.ms))} ms ${JSON.stringify(xs.slice(0, 10).map((p) => p.ms))}${xs.length > 10 ? " …" : ""}`;
}

function clean(fs, path, s) {
  let n = 0;
  const inside = (f, d) =>
    path.resolve(f).startsWith(path.resolve(d) + path.sep);
  for (const m of s?.made ?? []) {
    if (!m.id.startsWith(PREFIX)) continue;
    if (inside(m.record, path.join(s.home, "agents")))
      fs.rmSync(m.record, { force: true });
    if (inside(m.transcript, s.dir) && m.transcript.endsWith(".jsonl")) {
      fs.rmSync(m.transcript, { force: true });
      fs.rmSync(m.transcript.slice(0, -6), { recursive: true, force: true });
    }
    n++;
  }
  return n;
}

export const seedFiles = { findHome, seed, clean };

async function timedList(d2) {
  const t = Date.now();
  const r = await d2
    .fetch("/api/sessions", { method: "GET" })
    .catch((e) => ({ status: null, body: { error: msg(e) } }));
  return {
    ms: Date.now() - t,
    end: Date.now(),
    status: r.status,
    body: r.body,
  };
}

function helperRows(body) {
  const rows = Array.isArray(body?.sessions) ? body.sessions : [];
  return new Set(
    rows
      .filter(
        (r) =>
          String(r?.agent ?? "").startsWith(PREFIX) && r?.helpers?.total > 0,
      )
      .map((r) => r.agent),
  ).size;
}

export async function setup(ctx) {
  if (!ctx.den2) return { error: "the bed gives no ctx.den2" };
  let d2;
  try {
    d2 = await ctx.den2({ product: { testInstall: true } });
  } catch (e) {
    return { error: `den2: ${msg(e)}` };
  }
  D2S.push(d2);
  const s = { made: [] };
  const tpl = d2.agent(TEMPLATE, { workspace: WS });
  tpl.start("tester");
  s.templateMs = await tpl.running(30000);
  const tplFile = d2.transcriptPath(TEMPLATE);
  tpl.stop();
  if (s.templateMs == null || !tplFile) {
    s.error = `the template never ran (${s.templateMs} ms, transcript ${tplFile ? "found" : "none"})`;
    return s;
  }
  let rec;
  try {
    rec = JSON.parse(await d2.readBed(`state:agents/${TEMPLATE}.json`));
  } catch (e) {
    s.error = `the template's record can't be read: ${msg(e)}`;
    return s;
  }
  const fs = await import("fs");
  const path = await import("path");
  const crypto = await import("crypto");
  const found = findHome(fs, path, String(rec.cwd ?? ""), rec.resumeToken);
  if (found.error) {
    s.error = found.error;
    return s;
  }
  s.home = found.home;
  s.dir = path.dirname(tplFile);
  const t = Date.now();
  try {
    seed(fs, path, crypto, s.home, s.dir, s.made);
    s.seed = { status: 0, said: `seeded ${s.made.length}` };
  } catch (e) {
    s.seed = { status: 1, said: msg(e) };
  }
  s.seedMs = Date.now() - t;
  return s;
}

export async function run(ctx, s) {
  if (s.error) return { error: s.error };
  const d2 = D2S[0];
  const r = { seed: s.seed, seedMs: s.seedMs };
  if (s.seed?.status !== 0) return r;
  const info = async () => {
    const pt = Date.now();
    const p = await d2
      .fetch("/api/server-info", { method: "GET" })
      .catch(() => ({ status: null }));
    return { start: pt, ms: Date.now() - pt, status: p.status };
  };
  const coldList = timedList(d2);
  await ctx.sleep(PROBE_AFTER_MS);
  const cp = await info();
  const cold = await coldList;
  r.coldMs = cold.ms;
  r.coldStatus = cold.status;
  r.coldProbe = { ms: cp.ms, status: cp.status, inFlight: cold.end > cp.start };
  const look = (body) => {
    const all = Array.isArray(body?.sessions) ? body.sessions : [];
    const seen = all.filter((x) => String(x?.agent ?? "").startsWith(PREFIX));
    return {
      helperRows: helperRows(body),
      listed: seen.length,
      listRows: all.length,
      sample: seen[0]
        ? {
            keys: Object.keys(seen[0]).sort(),
            helpers: seen[0].helpers ?? null,
            state: seen[0].state ?? null,
          }
        : null,
    };
  };
  Object.assign(r, { coldHelperRows: look(cold.body).helperRows });
  const t0 = Date.now();
  let last = look(cold.body);
  r.fill = [];
  while (last.helperRows < SEED_AGENTS && Date.now() - t0 < HELPERS_WAIT_MS) {
    await ctx.sleep(1000);
    const fp = await info();
    r.fill.push({ ms: fp.ms, status: fp.status });
    last = look((await timedList(d2)).body);
  }
  r.helpersMs = last.helperRows >= SEED_AGENTS ? Date.now() - t0 : null;
  Object.assign(r, last);
  r.seedDir = s.dir;
  if (r.helpersMs === null) {
    (await import("fs")).writeFileSync(
      ctx.evidence("1668-run.json"),
      JSON.stringify(r, null, 2),
    );
    return r;
  }
  const warm = await timedList(d2);
  r.warmMs = warm.ms;
  r.idle = [];
  for (let i = 0; i < IDLE_TRIES; i++) {
    await ctx.sleep(200);
    const p = await info();
    r.idle.push({ ms: p.ms, status: p.status });
  }
  r.idleMs = median(r.idle.map((p) => p.ms));
  r.tries = [];
  r.probes = [];
  for (let i = 0; i < TRIES; i++) {
    await ctx.sleep(1000);
    const list = timedList(d2);
    await ctx.sleep(PROBE_AFTER_MS);
    const p = await info();
    const l = await list;
    r.probes.push({ ms: p.ms, status: p.status, inFlight: l.end > p.start });
    r.tries.push({ ms: l.ms, status: l.status });
  }
  r.medianMs = median(r.tries.map((t) => t.ms));
  const counted = r.probes.filter((p) => p.inFlight);
  r.inFlight = counted.length;
  r.maxProbeMs = counted.length ? Math.max(...counted.map((p) => p.ms)) : null;
  const fs = await import("fs");
  fs.writeFileSync(ctx.evidence("1668-run.json"), JSON.stringify(r, null, 2));
  return r;
}

export async function teardown(ctx, s) {
  const fs = await import("fs");
  const path = await import("path");
  for (const d of D2S.splice(0)) {
    try {
      if (s?.home)
        process.stderr.write(`1668 teardown: cleaned ${clean(fs, path, s)}\n`);
    } catch (e) {
      process.stderr.write(`1668 teardown: clean failed: ${msg(e)}\n`);
    }
    try {
      if (d.agent(TEMPLATE, { workspace: WS }).state())
        d.agent(TEMPLATE, { workspace: WS }).remove();
    } catch (e) {
      process.stderr.write(`1668 teardown: ${msg(e)}\n`);
    }
    await d.close().catch(() => {});
  }
}

const row = (clause, ok, detail) => ({
  clause,
  ok,
  detail,
  evidence: ["1668-run.json"],
});

export function expect(cells) {
  const r =
    (Array.isArray(cells) ? cells.find((c) => c?.result)?.result : cells) ?? {};
  if (r.error) throw new Error(`1668 not measured: ${r.error}`);
  if (r.seed?.status !== 0)
    throw new Error(`1668 not measured: seed ${JSON.stringify(r.seed)}`);
  if (r.helperRows !== SEED_AGENTS)
    throw new Error(
      `1668 not measured: the list showed helpers on ${r.helperRows} of ${SEED_AGENTS} seeded agents within ${HELPERS_WAIT_MS / 1000} s of the seed (it listed ${r.listed ?? "?"} of them, ${r.listRows ?? "?"} rows in all)`,
    );
  const seedLine = `seeded ${SEED_AGENTS} agents in ${r.seedMs} ms, rows with helpers ${r.helperRows}; ${SEED_WAY}`;
  const few = (r.inFlight ?? 0) < IN_FLIGHT_MIN;
  const bounded = few && r.medianMs !== null && r.medianMs <= PROBE_MS;
  if (few && !bounded)
    throw new Error(
      `1668 not measured: server-info started while the list was still in flight on ${r.inFlight ?? 0} of ${TRIES} tries (needs ${IN_FLIGHT_MIN}); list tries ${JSON.stringify((r.tries ?? []).map((t) => t.ms))} ms`,
    );
  const allOk = (xs) =>
    (xs ?? []).length === TRIES && xs.every((t) => t.status === 200);
  return [
    row(
      clauses[0],
      r.coldStatus === 200 &&
        r.coldMs <= LIMIT_MS &&
        allOk(r.tries) &&
        r.medianMs !== null &&
        r.medianMs <= LIMIT_MS,
      `${seedLine}; cold list ${r.coldMs} ms (helpers on ${r.coldHelperRows ?? "?"} of ${SEED_AGENTS}); helpers on all after ${r.helpersMs} ms; warm-up ${r.warmMs} ms; tries ${JSON.stringify((r.tries ?? []).map((t) => t.ms))} ms, median ${r.medianMs} (limit ${LIMIT_MS})`,
    ),
    row(
      clauses[1],
      r.coldProbe?.status === 200 &&
        r.coldProbe.ms <= PROBE_MS &&
        (r.fill ?? []).every((p) => p.status === 200 && p.ms <= PROBE_MS) &&
        allOk(r.probes) &&
        (bounded
          ? r.probes.every((p) => p.ms <= PROBE_MS)
          : r.maxProbeMs <= PROBE_MS),
      `${seedLine}; server-info idle ${r.idleMs} ms (median of ${IDLE_TRIES}); during the cold list ${r.coldProbe?.ms ?? "?"} ms${r.coldProbe?.inFlight ? "" : " (list done)"}; while the helpers filled ${fillSay(r.fill)}; during each list ${JSON.stringify((r.probes ?? []).map((p) => (p.inFlight ? p.ms : `${p.ms} (list done)`)))} ms, ${bounded ? `in flight on ${r.inFlight} of ${TRIES}, but the list answered in ${r.medianMs} ms (median), within ${PROBE_MS}, so nothing could wait behind it longer; max ${Math.max(...r.probes.map((p) => p.ms))}` : `max in flight ${r.maxProbeMs} over ${r.inFlight} of ${TRIES}`} (limit ${PROBE_MS})`,
    ),
  ];
}
