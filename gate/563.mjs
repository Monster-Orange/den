// gate/563.mjs: after an update, the terminal host runs the installed Den
// (issue 563). The bed installs the new Den over the last one and, for a
// tag marked `bed: keep-host`, leaves the last one's terminal host running
// (BG_HOST_BEFORE: "<pid> <start epoch> <den version>"). The new web
// server's start must restart that host on the installed version. The
// check reads the host's own answer (doctor's terminal host row), starts a
// stub agent in it, and looks for the restart in the bell or the audit.
// The case of a host holding a native module npm deleted (the failure
// customers hit) is proven in the PR's tests (host-refresh*.test.ts): the
// bed's two versions share the same terminal module.
export const issue = 563;
export const clauses = [
  "after the update, the terminal host runs the installed Den, and is not the host from before the web start",
  "the terminal module the host loaded is on disk and is the installed one",
  "a new agent starts in the restarted host",
  "the bell or the audit says the terminal host was restarted",
];
export const timeoutMs = 180000;

const AGENT = "gate-563";

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

/** Doctor's terminal host row: { status, detail, host } or null. */
function hostRow(ctx) {
  const d = parse(ctx.cli(["doctor", "--json"]).out);
  const c = (Array.isArray(d?.checks) ? d.checks : []).find(
    (x) => x?.id === "terminal_host_module",
  );
  return c
    ? { status: c.status, detail: String(c.detail ?? ""), host: c.host ?? null }
    : null;
}

export async function setup(ctx) {
  const raw = (process.env.BG_HOST_BEFORE ?? "").trim();
  if (!raw) return { skip: "needs-keep-host" };
  const [pid, epoch, den] = raw.split(/\s+/);
  return { before: { pid: Number(pid), epoch: Number(epoch), den } };
}

export async function run(ctx, s) {
  if (s.skip) return { skip: s.skip };
  const pkg = parse(
    ctx.readBed("node_modules/@monster-orange/den/package.json"),
  );
  const out = { before: s.before, installed: pkg?.version ?? null };
  // The web start may still be waiting out an agent mid-turn: give it time.
  await ctx.until(() => {
    const r = hostRow(ctx);
    return !!r?.host && r.host.den === out.installed;
  }, 90000);
  out.first = hostRow(ctx);
  // A stub agent: it starts in the host (and makes it load its module).
  const a = ctx.agent(AGENT);
  out.start = a.start("tester")?.code ?? null;
  out.runningMs = await a.running(30000);
  out.after = hostRow(ctx);
  const p = out.after?.host?.pty?.path ?? null;
  if (p) {
    const m = /(node_modules\/@lydell\/[^/]+)\/(pty\.node)$/.exec(p);
    out.ptyRel = m ? m[1] : null;
    out.ptyListed = m ? (ctx.listBed(m[1]) ?? []).includes(m[2]) : false;
  }
  const n = await ctx.api("/api/notifications").catch(() => null);
  out.bell = JSON.stringify(n ?? "").includes("record:terminal-host-restarted");
  const audit = ctx.readBed("audit.jsonl") ?? "";
  out.audit = /"verb":"terminal-host","detail":"terminal host restarted/.test(
    audit,
  );
  ctx.log?.(`563: ${JSON.stringify(out)}`);
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
  if (res.skip)
    return clauses.map((clause) => ({ clause, ok: null, skip: res.skip }));
  const h = res.first?.host ?? null;
  const b = res.before ?? {};
  const startedEpoch = h?.startedAt ? Date.parse(h.startedAt) / 1000 : NaN;
  const other =
    !!h &&
    (h.pid !== b.pid ||
      !Number.isFinite(startedEpoch) ||
      Math.abs(startedEpoch - b.epoch) > 1);
  const c1 = !!h && h.den === res.installed && other;
  const after = res.after ?? {};
  const c2 =
    after.status === "ok" && !!after.host?.pty?.path && res.ptyListed === true;
  const c3 =
    res.start === 0 && res.runningMs !== null && res.runningMs !== undefined;
  const c4 = res.bell === true || res.audit === true;
  const note = (ok, s) => (ok ? {} : { note: s });
  return [
    {
      clause: clauses[0],
      ok: c1,
      ...note(
        c1,
        `host ${JSON.stringify(h)}; before ${JSON.stringify(b)}; installed ${res.installed}`,
      ),
    },
    {
      clause: clauses[1],
      ok: c2,
      ...note(
        c2,
        `row ${after.status}: ${after.detail}; listed ${res.ptyListed}`,
      ),
    },
    {
      clause: clauses[2],
      ok: c3,
      ...note(c3, `start ${res.start}, running after ${res.runningMs} ms`),
    },
    {
      clause: clauses[3],
      ok: c4,
      ...note(c4, `bell ${res.bell}, audit ${res.audit}`),
    },
  ];
}
