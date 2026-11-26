export const issue = 1668;
export const items = [1668];

export const SEED_AGENTS = 140;
export const SEED_MB = 4;
export const TRIES = 5;
export const LIMIT_MS = 1500;
export const PROBE_MS = 500;

export const clauses = [
  `with ${SEED_AGENTS} agents, each with helpers and ${SEED_MB} MB of transcript, the agents list (GET /api/sessions) answers within ${LIMIT_MS} ms (the median of ${TRIES} tries after a warm-up)`,
  `while that list is being made, /api/server-info answers within ${PROBE_MS} ms`,
];
export const timeoutMs = 1800000;

const WS = "proj-gate";
const KEEPER = "g1668-keeper";
const idOf = (i) => `g1668-a${String(i).padStart(3, "0")}`;
const D2S = [];

const msg = (e) => String(e?.message ?? e).slice(0, 200);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

const WRITE = `
const fs = require("fs"), path = require("path");
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const pad = "x".repeat(1800);
let lines = [];
for (let n = 0; n * 2000 < plan.mb * 1048576; n++)
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_s" + n, content: pad }] } }));
const body = lines.join("\\n") + "\\n";
for (const f of plan.files) {
  fs.appendFileSync(f, body);
  const sub = path.join(f.replace(/\\.jsonl$/, ""), "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-h1.meta.json"), JSON.stringify({ toolUseId: "toolu_s1", requestShape: "task" }));
  fs.writeFileSync(path.join(sub, "agent-h1.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString() }) + "\\n");
}
console.log("seeded " + plan.files.length);
`
  .replace(/\s*\n\s*/g, " ")
  .trim();

const CLEAN = `
const fs = require("fs");
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const f of plan.files) {
  try { fs.truncateSync(f, 0); } catch {}
  fs.rmSync(f.replace(/\\.jsonl$/, ""), { recursive: true, force: true });
}
console.log("cleaned " + plan.files.length);
`
  .replace(/\s*\n\s*/g, " ")
  .trim();

const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

async function timedList(d2) {
  const t = Date.now();
  const r = await d2
    .fetch("/api/sessions", { method: "GET" })
    .catch((e) => ({ status: null, body: { error: msg(e) } }));
  return { ms: Date.now() - t, status: r.status, body: r.body };
}

function helperRows(body) {
  const rows = Array.isArray(body?.sessions) ? body.sessions : [];
  return rows.filter(
    (r) => /^g1668-a/.test(String(r?.agent ?? "")) && r?.helpers?.total > 0,
  ).length;
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
  const s = { files: [], started: 0, missing: [] };
  for (let i = 0; i < SEED_AGENTS; i++) {
    const a = d2.agent(idOf(i), { workspace: WS });
    a.start("tester");
    const ms = await a.running(30000);
    const f = ms == null ? null : d2.transcriptPath(idOf(i));
    a.stop();
    if (f) {
      s.files.push(f);
      s.started++;
    } else s.missing.push(idOf(i));
  }
  const keeper = d2.agent(KEEPER, { workspace: WS });
  keeper.start("tester");
  s.keeperMs = await keeper.running(30000);
  const fs = await import("fs");
  s.plan = ctx.evidence("1668-seed.json");
  fs.writeFileSync(s.plan, JSON.stringify({ mb: SEED_MB, files: s.files }));
  const w = await keeper.sh(`node -e ${q(WRITE)} ${q(s.plan)}`, 60000);
  s.seed = {
    status: w.status,
    said: String(`${w.out} ${w.err}`).trim().slice(0, 200),
  };
  return s;
}

export async function run(ctx, s) {
  if (s.error) return s;
  const d2 = D2S[0];
  const r = {
    started: s.started,
    missing: s.missing.slice(0, 5),
    seed: s.seed,
  };
  const warm = await timedList(d2);
  r.warmMs = warm.ms;
  r.helperRows = helperRows(warm.body);
  r.tries = [];
  r.probes = [];
  for (let i = 0; i < TRIES; i++) {
    await ctx.sleep(1000);
    const list = timedList(d2);
    await ctx.sleep(50);
    const pt = Date.now();
    const p = await d2
      .fetch("/api/server-info", { method: "GET" })
      .catch(() => ({ status: null }));
    r.probes.push({ ms: Date.now() - pt, status: p.status });
    const l = await list;
    r.tries.push({ ms: l.ms, status: l.status });
  }
  r.medianMs = median(r.tries.map((t) => t.ms));
  r.maxProbeMs = Math.max(...r.probes.map((p) => p.ms));
  const fs = await import("fs");
  fs.writeFileSync(ctx.evidence("1668-run.json"), JSON.stringify(r, null, 2));
  return r;
}

export async function teardown(ctx, s) {
  for (const d of D2S.splice(0)) {
    try {
      if (s?.plan)
        await d
          .agent(KEEPER, { workspace: WS })
          .sh(`node -e ${q(CLEAN)} ${q(s.plan)}`, 60000);
    } catch (e) {
      process.stderr.write(`1668 teardown: clean failed: ${msg(e)}\n`);
    }
    for (const id of [
      KEEPER,
      ...Array.from({ length: SEED_AGENTS }, (_, i) => idOf(i)),
    ])
      try {
        if (d.agent(id, { workspace: WS }).state())
          d.agent(id, { workspace: WS }).remove();
      } catch {
        continue;
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
  if (r.error) return clauses.map((c) => row(c, false, r.error));
  const seeded =
    r.started === SEED_AGENTS &&
    r.seed?.status === 0 &&
    r.helperRows === SEED_AGENTS;
  const seedLine = `seeded ${r.started}/${SEED_AGENTS} agents (${JSON.stringify(r.seed)}), rows with helpers ${r.helperRows}${r.missing?.length ? `, no transcript: ${r.missing.join(", ")}` : ""}`;
  const allOk = (xs) =>
    (xs ?? []).length === TRIES && xs.every((t) => t.status === 200);
  return [
    row(
      clauses[0],
      seeded && allOk(r.tries) && r.medianMs !== null && r.medianMs <= LIMIT_MS,
      `${seedLine}; warm-up ${r.warmMs} ms; tries ${JSON.stringify((r.tries ?? []).map((t) => t.ms))} ms, median ${r.medianMs} (limit ${LIMIT_MS})`,
    ),
    row(
      clauses[1],
      seeded && allOk(r.probes) && r.maxProbeMs <= PROBE_MS,
      `${seedLine}; server-info during each list ${JSON.stringify((r.probes ?? []).map((p) => p.ms))} ms, max ${r.maxProbeMs} (limit ${PROBE_MS})`,
    ),
  ];
}
