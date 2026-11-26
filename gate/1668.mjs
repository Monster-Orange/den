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
export const SEED_WAY =
  "two real stub starts (a template and a keeper); the keeper's own session then writes the other agents' records, transcripts and helpers straight into the Den's state, so seeding takes seconds and /api/sessions reads them as it reads any agent";
export const timeoutMs = 600000;

const WS = "proj-gate";
const KEEPER = "g1668-keeper";
const TEMPLATE = "g1668-template";
const PREFIX = "g1668-a";
const idOf = (i) => `${PREFIX}${String(i).padStart(3, "0")}`;
const D2S = [];

const msg = (e) => String(e?.message ?? e).slice(0, 200);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

const WRITE = `
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const near = [...Object.entries(process.env).filter(([k, v]) => /_HOME$/.test(k) && v).map(([, v]) => v), ...fs.readdirSync(process.cwd()).map((n) => path.join(process.cwd(), n, "h"))];
const mine = (h) => { try { return JSON.parse(fs.readFileSync(path.join(h, "agents", plan.keeper + ".json"), "utf8")).resumeToken === plan.keeperToken; } catch { return false; } };
const homes = [...new Set(near.map((h) => path.resolve(h)))].filter(mine);
if (homes.length !== 1) { console.log("found " + homes.length + " Den homes holding this keeper"); process.exit(2); }
const home = homes[0], adir = path.join(home, "agents");
const tpl = JSON.parse(fs.readFileSync(path.join(adir, plan.template + ".json"), "utf8"));
const pad = "x".repeat(1800);
let lines = [];
for (let n = 0; n * 2000 < plan.mb * 1048576; n++) lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_s" + n, content: pad }] } }));
const body = lines.join("\\n") + "\\n";
const made = { home, ids: [], files: [] };
for (const id of plan.ids) {
  const token = crypto.randomUUID();
  const rec = { ...tpl, id, displayName: id, resumeToken: token, stoppedAt: new Date().toISOString() };
  for (const k of ["sessionName", "peerName"]) if (typeof rec[k] === "string") rec[k] = rec[k].split(plan.template).join(id);
  delete rec.session;
  const f = path.join(adir, id + ".json");
  fs.writeFileSync(f + ".tmp", JSON.stringify(rec, null, 2));
  fs.renameSync(f + ".tmp", f);
  const t = path.join(plan.dir, token + ".jsonl");
  fs.writeFileSync(t, body);
  const sub = path.join(plan.dir, token, "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-h1.meta.json"), JSON.stringify({ toolUseId: "toolu_s1", requestShape: "task" }));
  fs.writeFileSync(path.join(sub, "agent-h1.jsonl"), JSON.stringify({ type: "assistant", timestamp: new Date().toISOString() }) + "\\n");
  made.ids.push(id); made.files.push(t);
}
fs.writeFileSync(plan.made, JSON.stringify(made));
console.log("seeded " + made.ids.length);
`
  .replace(/\s*\n\s*/g, " ")
  .trim();

const CLEAN = `
const fs = require("fs"), path = require("path");
const plan = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
let made; try { made = JSON.parse(fs.readFileSync(plan.made, "utf8")); } catch { console.log("nothing seeded"); process.exit(0); }
for (const id of made.ids) fs.rmSync(path.join(made.home, "agents", id + ".json"), { force: true });
for (const f of made.files) { fs.rmSync(f, { force: true }); fs.rmSync(f.replace(/\\.jsonl$/, ""), { recursive: true, force: true }); }
console.log("cleaned " + made.ids.length);
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
  const s = {};
  const tpl = d2.agent(TEMPLATE, { workspace: WS });
  tpl.start("tester");
  s.templateMs = await tpl.running(30000);
  const tplFile = d2.transcriptPath(TEMPLATE);
  tpl.stop();
  const keeper = d2.agent(KEEPER, { workspace: WS });
  keeper.start("tester");
  s.keeperMs = await keeper.running(30000);
  if (s.templateMs == null || s.keeperMs == null || !tplFile) {
    s.error = `the template or the keeper never ran (template ${s.templateMs} ms, transcript ${tplFile ? "found" : "none"}; keeper ${s.keeperMs} ms)`;
    return s;
  }
  let keeperToken = null;
  try {
    keeperToken = JSON.parse(
      await d2.readBed(`state:agents/${KEEPER}.json`),
    ).resumeToken;
  } catch (e) {
    s.error = `the keeper's record can't be read: ${msg(e)}`;
    return s;
  }
  const fs = await import("fs");
  const path = await import("path");
  s.plan = ctx.evidence("1668-seed.json");
  fs.writeFileSync(
    s.plan,
    JSON.stringify({
      mb: SEED_MB,
      keeper: KEEPER,
      keeperToken,
      template: TEMPLATE,
      dir: path.dirname(tplFile),
      ids: Array.from({ length: SEED_AGENTS }, (_, i) => idOf(i + 1)),
      made: `${s.plan}.made`,
    }),
  );
  const t = Date.now();
  const w = await keeper.sh(`node -e ${q(WRITE)} ${q(s.plan)}`, 60000);
  s.seedMs = Date.now() - t;
  s.seed = {
    status: w.status,
    said: String(`${w.out} ${w.err}`).trim().slice(0, 200),
  };
  return s;
}

export async function run(ctx, s) {
  if (s.error) return s;
  const d2 = D2S[0];
  const r = { seed: s.seed, seedMs: s.seedMs };
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
      if (s?.plan) {
        const c = await d
          .agent(KEEPER, { workspace: WS })
          .sh(`node -e ${q(CLEAN)} ${q(s.plan)}`, 60000);
        process.stderr.write(
          `1668 teardown: ${String(c.out || c.err)
            .trim()
            .slice(0, 120)}\n`,
        );
      }
    } catch (e) {
      process.stderr.write(`1668 teardown: clean failed: ${msg(e)}\n`);
    }
    for (const id of [KEEPER, TEMPLATE])
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
  const seeded = r.seed?.status === 0 && r.helperRows === SEED_AGENTS;
  const seedLine = `seeded ${SEED_AGENTS} agents in ${r.seedMs} ms by writing their records (${JSON.stringify(r.seed)}), rows with helpers ${r.helperRows}; ${SEED_WAY}`;
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
