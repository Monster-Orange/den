// gate/503.mjs: the terminal host closes an ended terminal's PTY (issue
// 503). In a project of the bed, through the API a person's page uses: it
// opens 20 plain terminals of its own, closes them again, and reads the
// terminal host's PTY count (doctor's Terminals row) before and after.
// Then it reads doctor's rows, the installed Den's config keys, and the
// installed @lydell/node-pty against the lockfile. It closes every
// terminal it opened (teardown too) and never touches one the bed had.
export const issue = 503;
export const clauses = [
  "opening and closing 20 terminals leaves the terminal host's PTY count where it started (±1), and the machine's doesn't grow",
  "doctor shows the terminal host's PTYs and the machine's",
  "sessions.pty_close_seconds, pty_warn_above and pty_machine_warn_percent are config keys the installed Den reads",
  "the installed @lydell/node-pty is exactly 1.2.0-beta.18, with the lockfile's integrity",
  "a terminal that can't get a PTY is refused with 503 and a reason, never a hang",
];
// Unloaded, a run takes ~40 s; under load several minutes.
export const timeoutMs = 360000;

const N = 20;
const PTY = "1.2.0-beta.18";
const INTEGRITY =
  "sha512-ryy4liRcw6QBBKWDIbJgTW7Pw8NI2xjri/5s/LZg/jJ8ZVg8MgA1xI/vjpT5qTvDvPjUpU5NybJBrKRgK/QvlA==";
const KEYS = [
  "pty_close_seconds",
  "pty_warn_above",
  "pty_machine_warn_percent",
];

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

/** Doctor's Terminals row: { host, machineUsed, machineMax, detail } or null. */
function ptyRow(ctx) {
  const r = ctx.cli(["doctor", "--json"]);
  const d = parse(r.out);
  const checks = Array.isArray(d?.checks) ? d.checks : [];
  const c = checks.find((x) => x?.id === "terminal_host_ptys");
  if (!c) return null;
  const detail = String(c.detail ?? "");
  const host = /holds (\d+) PTY/.exec(detail);
  const mach = /uses (\d+) of (\d+)/.exec(detail);
  return {
    detail,
    host: host ? Number(host[1]) : null,
    machineUsed: mach ? Number(mach[1]) : null,
    machineMax: mach ? Number(mach[2]) : null,
  };
}

const opened = [];

async function closeAll(ctx) {
  while (opened.length) {
    const id = opened.pop();
    await ctx
      .fetch(`/api/sessions/${encodeURIComponent(id)}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      .catch(() => {});
  }
}

export async function setup(ctx) {
  const list = parse((await ctx.fetch("/api/sessions")).body);
  const ws = (list?.workspaces ?? []).filter(Boolean)[0] ?? null;
  return { ws, before: ptyRow(ctx) };
}

export async function run(ctx, state) {
  const out = { ws: state.ws, before: state.before, opened: 0, closed: 0 };
  if (!state.ws) return { ...out, skipped: "needs-project" };
  for (let i = 0; i < N; i++) {
    const r = await ctx.fetch(
      `/api/workspaces/${encodeURIComponent(state.ws)}/sessions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    const id = parse(r.body)?.session?.id;
    if (r.status >= 300 || !id) {
      out.openError = { status: r.status, body: String(r.body).slice(0, 200) };
      break;
    }
    opened.push(id);
    out.opened++;
  }
  out.during = ptyRow(ctx);
  const n = opened.length;
  await closeAll(ctx);
  out.closed = n;
  // The host closes a PTY when its terminal ends (pty_close_seconds 0).
  const start = state.before?.host ?? 0;
  await ctx.until(async () => {
    const r = ptyRow(ctx);
    return r?.host !== null && r?.host !== undefined && r.host <= start + 1;
  }, 60000);
  out.after = ptyRow(ctx);
  const pty = parse(ctx.readBed("node_modules/@lydell/node-pty/package.json"));
  const lock = parse(ctx.readBed("package-lock.json"));
  out.pty = {
    version: pty?.version ?? null,
    lockVersion:
      lock?.packages?.["node_modules/@lydell/node-pty"]?.version ?? null,
    integrity:
      lock?.packages?.["node_modules/@lydell/node-pty"]?.integrity ?? null,
  };
  const cfg =
    ctx.readBed("node_modules/@monster-orange/den/src/shared/den-config.ts") ??
    "";
  out.keys = Object.fromEntries(KEYS.map((k) => [k, cfg.includes(`"${k}"`)]));
  ctx.log?.(
    `PTYs: before ${JSON.stringify(state.before)}; with ${n} open ${JSON.stringify(out.during)}; after ${JSON.stringify(out.after)}`,
  );
  return out;
}

export async function teardown(ctx) {
  await closeAll(ctx);
}

export function expect(r) {
  const res = r ?? {};
  const rows = [];
  const b = res.before;
  const a = res.after;
  const d = res.during;
  if (res.skipped) {
    rows.push({ clause: clauses[0], ok: null, skip: res.skipped });
  } else {
    const opened = res.opened === N;
    const hostBack = b?.host != null && a?.host != null && a.host <= b.host + 1;
    // While open, the count must have risen: proves the row counts PTYs.
    const counted =
      d?.host != null && b?.host != null && d.host >= b.host + N - 1;
    const machineOk =
      b?.machineUsed == null ||
      a?.machineUsed == null ||
      a.machineUsed <= b.machineUsed + 1;
    rows.push({
      clause: clauses[0],
      ok: opened && counted && hostBack && machineOk,
      evidence: ["503-log.txt"],
      ...(opened && counted && hostBack && machineOk
        ? {}
        : {
            note: `opened ${res.opened}/${N}${res.openError ? ` (${res.openError.status})` : ""}; host ${b?.host} → ${d?.host} → ${a?.host}; machine ${b?.machineUsed} → ${a?.machineUsed}`,
          }),
    });
  }
  const row = a ?? b;
  rows.push({
    clause: clauses[1],
    ok: !!row && row.host !== null && row.machineUsed !== null,
    ...(row && row.host !== null && row.machineUsed !== null
      ? {}
      : { note: `doctor's Terminals row: ${row ? row.detail : "missing"}` }),
  });
  const keys = res.keys ?? {};
  rows.push({
    clause: clauses[2],
    ok: KEYS.every((k) => keys[k] === true),
    ...(KEYS.every((k) => keys[k] === true)
      ? {}
      : { note: `keys read: ${JSON.stringify(keys)}` }),
  });
  const p = res.pty ?? {};
  const ptyOk =
    p.version === PTY && p.lockVersion === PTY && p.integrity === INTEGRITY;
  rows.push({
    clause: clauses[3],
    ok: ptyOk,
    ...(ptyOk
      ? {}
      : {
          note: `installed ${p.version}, lock ${p.lockVersion}, integrity ${p.integrity === INTEGRITY ? "matches" : "differs"}`,
        }),
  });
  // The bed can't make the machine refuse a PTY; a fake limit inside Den
  // would be a test-only path in shipped code. The refusal is proven in
  // tests/unit/sessions/host-pty-close.test.ts and pty-close.integration.
  rows.push({ clause: clauses[4], ok: null, skip: "needs-pty-limit" });
  return rows;
}
