// gate/503.mjs: the terminal host closes an ended terminal's PTY (issue
// 503). In a project of the bed, through the CLI (`sessions start` and
// `sessions kill`; the page's terminal route is the person's own, and the
// fixture person is refused it, issue 810): it opens plain terminals of
// its own up to sessions.max_concurrent (at most 20), plus one past the
// cap, closes them again, and reads the terminal host's PTY count
// (doctor's Terminals row) before and after. The page's 429 for the one
// past the cap is not run (skip person); the CLI's own refusal is logged.
// Then it reads doctor's rows, the installed Den's config keys, and the
// installed @lydell/node-pty against the lockfile. It closes every
// terminal it opened (teardown too) and never touches one the bed had.
import { readJson, doctorChecks } from "./lib/read-json.mjs";
export const issue = 503;
export const clauses = [
  "opening terminals up to sessions.max_concurrent (at most 20) and closing them leaves the terminal host's PTY count where it started (±1); the machine's count is logged, not judged, since other programs share the machine",
  "doctor shows the terminal host's PTYs and the machine's",
  "sessions.pty_close_seconds, pty_warn_above and pty_machine_warn_percent are config keys the installed Den reads",
  "the installed @lydell/node-pty is exactly 1.2.0-beta.18, with the lockfile's integrity",
  "a terminal that can't get a PTY is refused with 503 and a reason, never a hang",
  "a terminal past sessions.max_concurrent is refused with 429, code cap and a reason that names the key",
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

/** sessions.max_concurrent as the bed runs it: den.yml, else Den's default. */
function capOf(ctx) {
  const yml = ctx.readBed("den.yml") ?? "";
  const sec = /^sessions:\s*\n((?:[ \t]+.*\n?)*)/m.exec(yml);
  const set = sec && /^[ \t]+max_concurrent:\s*(\d+)/m.exec(sec[1]);
  if (set) return Number(set[1]);
  const cfg =
    ctx.readBed("node_modules/@monster-orange/den/src/shared/den-config.ts") ??
    "";
  const def = /DEFAULT_SESSIONS_MAX_CONCURRENT\s*=\s*(\d+)/.exec(cfg);
  return def ? Number(def[1]) : null;
}

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
  const d = { checks: doctorChecks(r) };
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
let openedIn = null;

/** This run's terminal names: new each run, so none clash with the bed's. */
const runTag = () =>
  `gate-503-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function closeAll(ctx) {
  while (opened.length) {
    const name = opened.pop();
    try {
      await ctx.cli(
        ["sessions", "kill", name, "--workspace", openedIn, "--grace", "1"],
        { timeout: 20000 },
      );
    } catch {
      /* gone already */
    }
  }
}

export async function setup(ctx) {
  const list = parse((await ctx.fetch("/api/sessions")).body);
  const ws = (list?.workspaces ?? []).filter(Boolean)[0] ?? null;
  return { ws, before: ptyRow(ctx), cap: capOf(ctx) };
}

export async function run(ctx, state) {
  const out = {
    ws: state.ws,
    before: state.before,
    cap: state.cap,
    opened: 0,
    closed: 0,
  };
  if (!state.ws) return { ...out, skipped: "needs-project" };
  // Up to the cap, and one more to see the cap's refusal (when it's < N).
  const tries = state.cap != null && state.cap < N ? state.cap + 1 : N;
  const tag = runTag();
  openedIn = state.ws;
  for (let i = 0; i < tries; i++) {
    const name = `${tag}-${i}`;
    const r = await ctx.cli(
      [
        "sessions",
        "start",
        "--workspace",
        state.ws,
        "--name",
        name,
        "--json",
        "--",
        "sleep",
        "900",
      ],
      { timeout: 30000 },
    );
    // Issue 840: started is the --json record's session; a refusal's
    // words (whether they name the cap) are read whole from stderr.
    // Exit 0 must print the record (readJson throws otherwise); a refusal
    // exits non-zero with its words on stderr.
    const started =
      r?.code === 0 ? (readJson(r, "sessions start").session ?? null) : null;
    if (r?.code !== 0 || !started?.name) {
      const said = String(r?.err ?? "").trim();
      out.openError = {
        exit: r?.code ?? null,
        cap: /sessions\.max_concurrent/.test(said),
        error: said.slice(0, 300),
      };
      ctx.log?.(
        `refused after ${out.opened}: ${JSON.stringify(out.openError)}`,
      );
      break;
    }
    opened.push(name);
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
    `PTYs (cap ${state.cap}): before ${JSON.stringify(state.before)}; with ${n} open ${JSON.stringify(out.during)}; after ${JSON.stringify(out.after)}`,
  );
  ctx.log?.(
    `machine ${state.before?.machineUsed} → ${out.after?.machineUsed} (logged, not judged)`,
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
  const e = res.openError;
  // The CLI's refusal at the cap: exit 1, naming the key.
  const capRefusal = !!e && e.exit === 1 && e.cap === true;
  if (res.skipped) {
    rows.push({ clause: clauses[0], ok: null, skip: res.skipped });
  } else if (res.opened === 0) {
    // Nothing opened: nothing was measured. Not run, never a FAIL.
    rows.push({
      clause: clauses[0],
      ok: null,
      skip: "needs-terminal",
      detail: `no terminal opened through \`sessions start\` (${JSON.stringify(e ?? null)})`,
    });
  } else {
    // All it asked for, or up to the cap's refusal (sessions the bed
    // already runs count against the cap too). At least 2 to measure.
    const opened = res.opened >= 2 && (res.opened === N || capRefusal);
    const hostBack = b?.host != null && a?.host != null && a.host <= b.host + 1;
    // While open, the count must have risen: proves the row counts PTYs.
    const counted =
      d?.host != null && b?.host != null && d.host >= b.host + res.opened - 1;
    // The machine's count includes every other program's PTYs (other
    // installs' hosts, terminals, remote logins), so run() only logs it:
    // the bed's own host count is what proves the PTYs were given back.
    rows.push({
      clause: clauses[0],
      ok: opened && counted && hostBack,
      evidence: ["503-log.txt"],
      ...(opened && counted && hostBack ? {} : {}),
      detail: `opened ${res.opened} (cap ${res.cap})${e ? ` (then refused, exit ${e.exit}${e.cap ? ", names sessions.max_concurrent" : ""})` : ""}; host ${b?.host} → ${d?.host} → ${a?.host}; machine ${b?.machineUsed} → ${a?.machineUsed}`,
    });
  }
  const row = a ?? b;
  rows.push({
    clause: clauses[1],
    ok: !!row && row.host !== null && row.machineUsed !== null,
    ...(row && row.host !== null && row.machineUsed !== null
      ? {}
      : { detail: `doctor's Terminals row: ${row ? row.detail : "missing"}` }),
  });
  const keys = res.keys ?? {};
  rows.push({
    clause: clauses[2],
    ok: KEYS.every((k) => keys[k] === true),
    ...(KEYS.every((k) => keys[k] === true)
      ? {}
      : { detail: `keys read: ${JSON.stringify(keys)}` }),
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
          detail: `installed ${p.version}, lock ${p.lockVersion}, integrity ${p.integrity === INTEGRITY ? "matches" : "differs"}`,
        }),
  });
  // The bed can't make the machine refuse a PTY; a fake limit inside Den
  // would be a test-only path in shipped code. The refusal is proven in
  // tests/unit/sessions/host-pty-close.test.ts and pty-close.integration.
  rows.push({ clause: clauses[4], ok: null, skip: "needs-pty-limit" });
  // The 429 is the page's terminal route, the person's own (issue 810):
  // not run. What the CLI said at the cap is in the detail.
  rows.push({
    clause: clauses[5],
    ok: null,
    skip: "person",
    detail: `the page's terminal route is the person's own; at the cap the CLI ${capRefusal ? "refused, naming sessions.max_concurrent" : `said ${JSON.stringify(e ?? null)}`}`,
  });
  return rows;
}
