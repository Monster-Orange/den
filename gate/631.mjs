// gate/631.mjs: a terminal host restart loses no agent (issue 631).
//
// The bed installs the new Den over the last one and, for a tag marked
// `bed: keep-host`, leaves the last one's terminal host running, with the
// agents it ran (BG_HOST_BEFORE). The new web server's start restarts that
// host only when its code or terminal module changed (issue 597); else it
// keeps it ("host kept: code unchanged") and there is no restart to check.
//
// When it restarted, the check reads the audit row (verb terminal-host,
// "terminal host restarted") and its `agents` lists, and each listed
// agent's record:
//   1. the counts in the row's detail match its lists; every agent cut
//      mid-turn is also resumed or failed; every agent whose record says it
//      ended or was interrupted after the restart is on a list; each
//      resumed one runs in a session started after the stop.
//   3. each failed one has its reason in the row, is marked in its record
//      (restartFailed, with the reason) and has a "needs you" bell item.
//   4. each failed one's row on the Agents page has restartFailed and why.
// Clause 2 (an agent that relaunched from its handoff before the update)
// needs an agent to rotate on the bed before the update; the bed can't, so
// it skips, and the PR's tests prove it (host-restart-relaunched.test.ts).
// Clauses 3 and 4 skip when no resume failed on the bed.
export const issue = 631;
export const clauses = [
  "every agent running before a terminal host restart is in the row's resumed, failed or cut list; none goes missing",
  "an agent that relaunched itself from its handoff is resumed in its new conversation",
  "a resume that fails is counted in failed, with its reason, and the bell says so",
  "the Agents page shows an agent that ended during a host restart, and why",
];
export const timeoutMs = 240000;

const ROW = /"verb":"terminal-host"/;

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

/** The last terminal-host audit row, parsed, or null. */
function hostRow(ctx) {
  const lines = (ctx.readBed("state:audit.jsonl") ?? "")
    .split("\n")
    .filter((l) => ROW.test(l));
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = parse(lines[i]);
    if (r) return r;
  }
  return null;
}

const recordOf = (ctx, id) => parse(ctx.readBed(`state:agents/${id}.json`));

/** The bell's "needs you" item for agent `id`. */
async function bellHas(ctx, id) {
  const n = await ctx.api("/api/notifications").catch(() => ({}));
  return [
    ...(n?.groups ?? []),
    ...(n?.updates?.groups ?? []),
    ...(n?.older?.groups ?? []),
  ]
    .flatMap((g) => g?.subjects ?? [])
    .filter((x) => x?.subject === `agent:${id}`)
    .flatMap((x) => x?.items ?? [])
    .some((i) => i?.kind === "waiting");
}

/** Agent `id`'s row as the Agents page gets it. */
async function pageRow(ctx, ws, id) {
  const rows = await ctx
    .api(`/api/workspaces/${encodeURIComponent(ws)}/agents`)
    .catch(() => null);
  const list = Array.isArray(rows) ? rows : (rows?.agents ?? []);
  return list.find((r) => r?.agent === id) ?? null;
}

export async function setup() {
  const raw = (process.env.BG_HOST_BEFORE ?? "").trim();
  if (!raw) return { skip: "needs-keep-host" };
  return { before: raw };
}

export async function run(ctx, s) {
  if (s?.skip) return { skip: s.skip };
  const out = { before: s.before };
  // The web start may wait out agents mid-turn, then look again after its
  // resumes (sessions.host_restart_check_seconds): give it time.
  await ctx.until(() => hostRow(ctx) !== null, 200000);
  const row = hostRow(ctx);
  out.detail = String(row?.detail ?? "").slice(0, 400);
  out.ts = row?.ts ?? null;
  out.kept = /^host kept: code unchanged/.test(out.detail);
  out.restarted = /^terminal host restarted/.test(out.detail);
  if (!out.restarted) return out;
  const a = row?.agents ?? {};
  out.lists = {
    resumed: Array.isArray(a.resumed) ? a.resumed : [],
    failed: Array.isArray(a.failed) ? a.failed : [],
    cut: Array.isArray(a.cut) ? a.cut : [],
  };
  const m =
    /resumed (\d+), failed (\d+), cut mid-turn (\d+)/.exec(out.detail) ?? [];
  out.counts = { resumed: +m[1], failed: +m[2], cut: +m[3] };
  const at = Date.parse(out.ts ?? "");
  out.records = {};
  for (const id of out.lists.resumed) {
    const rec = recordOf(ctx, id);
    out.records[id] = {
      startedAt: rec?.startedAt ?? null,
      endedAt: rec?.endedAt ?? null,
      restartFailed: rec?.restartFailed ?? null,
    };
  }
  out.failedSeen = [];
  for (const f of out.lists.failed) {
    const rec = recordOf(ctx, f.agent);
    out.failedSeen.push({
      agent: f.agent,
      why: f.why ?? null,
      marked: rec?.restartFailed?.why ?? null,
      bell: await bellHas(ctx, f.agent),
      page: rec?.workspace
        ? ((await pageRow(ctx, rec.workspace, f.agent))?.restartFailed?.why ??
          null)
        : null,
    });
  }
  // Agents whose records say they ended or were interrupted after the
  // restart: each must be on a list.
  out.listed = [...out.lists.resumed, ...out.lists.failed.map((f) => f.agent)];
  out.endedAfter = [];
  const ids = (ctx.listBed?.("state:agents") ?? [])
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
  for (const id of ids) {
    const rec = recordOf(ctx, id);
    const t = Date.parse(
      rec?.endedAt ?? rec?.interruptedAt ?? rec?.restartFailed?.at ?? "",
    );
    if (Number.isFinite(t) && Number.isFinite(at) && t >= at - 120000)
      out.endedAfter.push(id);
  }
  out.agentsListed = ids.length;
  ctx.log?.(`631: ${JSON.stringify(out)}`);
  return out;
}

export function expect(r) {
  const res = r ?? {};
  if (res.skip)
    return clauses.map((clause) => ({ clause, ok: null, skip: res.skip }));
  if (!res.restarted) {
    const why = res.kept
      ? "the web start kept the terminal host (its code unchanged): no restart to check"
      : `no terminal host restart row (${res.detail || "none"})`;
    return clauses.map((clause) => ({
      clause,
      ok: res.kept ? null : false,
      ...(res.kept ? { skip: "needs-host-restart" } : {}),
      detail: why,
    }));
  }
  const L = res.lists;
  const c = res.counts ?? {};
  const listed = new Set(res.listed ?? []);
  const at = Date.parse(res.ts ?? "");
  const missing = (res.endedAfter ?? []).filter((id) => !listed.has(id));
  const cutOff = L.cut.filter((id) => !listed.has(id));
  const notBack = L.resumed.filter((id) => {
    const x = res.records?.[id] ?? {};
    const t = Date.parse(x.startedAt ?? "");
    return (
      !(Number.isFinite(t) && t >= at - 600000) || x.endedAt || x.restartFailed
    );
  });
  const c1 =
    c.resumed === L.resumed.length &&
    c.failed === L.failed.length &&
    c.cut === L.cut.length &&
    !cutOff.length &&
    !missing.length &&
    !notBack.length;
  const d1 = `counts ${JSON.stringify(c)}; lists ${L.resumed.length}/${L.failed.length}/${L.cut.length}; cut not resumed or failed ${JSON.stringify(cutOff)}; ended after the restart and on no list ${JSON.stringify(missing)} (of ${res.agentsListed} records); resumed but not running since ${JSON.stringify(notBack)}`;
  const failed = res.failedSeen ?? [];
  const none = !failed.length;
  const c3 = failed.every(
    (f) => !!f.why && !!f.marked && f.marked.includes(f.why) && f.bell === true,
  );
  const c4 = failed.every((f) => !!f.page && f.page.includes(f.why ?? ""));
  const d34 = JSON.stringify(failed).slice(0, 600);
  return [
    { clause: clauses[0], ok: c1, detail: d1 },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-rotation-before-update",
      detail:
        "the bed can't have an agent relaunch from its handoff before the update; the PR's tests prove it",
    },
    none
      ? {
          clause: clauses[2],
          ok: null,
          skip: "needs-a-failed-resume",
          detail: "no resume failed on this bed",
        }
      : { clause: clauses[2], ok: c3, detail: d34 },
    none
      ? {
          clause: clauses[3],
          ok: null,
          skip: "needs-a-failed-resume",
          detail: "no resume failed on this bed",
        }
      : { clause: clauses[3], ok: c4, detail: d34 },
  ];
}
