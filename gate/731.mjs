// gate/731.mjs: doctor's terminal host row never tells a person to run a
// command that stops every agent (issue 731). The web start records its
// refresh of the terminal host (state:host-refresh.json) for doctor to
// read. While that refresh waits for agents mid-turn, the row says Den
// restarts it when agents are idle, with no fix; after a failed refresh,
// or with none known, the fix is the held write host_restart.
//
// The bed shows the waiting row only when it catches the web start
// waiting out an agent mid-turn, and the held-write row only when the
// host is stale with no refresh under way: either is read when seen, else
// skipped. The red-first tests (host-restart-row-731.test.ts) prove both,
// and the held write's wait, restart and resume after an Allow, with fakes.
import { doctorChecks } from "./lib/read-json.mjs";
export const issue = 731;
export const clauses = [
  "doctor's terminal host row, its text and its fix never name the command that stops every agent",
  "the web start records its terminal host refresh where doctor reads it",
  "while Den's refresh waits, the row says Den restarts it when agents are idle (since when, at most how long), with no fix",
  "after a failed refresh, or with none known, the row's fix is the held write host_restart",
  "the held write, on the person's Allow, waits for idle, restarts the host and resumes the agents",
];
export const timeoutMs = 60000;

const STOP_ALL = /sessions host --stop/;

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

// Read only (issue 845): reads the host refresh state file and doctor.
export const readOnly = true;

export async function setup() {
  return {};
}

export async function run(ctx) {
  const out = {};
  // The web start's refresh writes its state once it knows (any outcome).
  out.stateMs = await ctx.until(
    () => !!parse(ctx.readBed("state:host-refresh.json")),
    30000,
  );
  const st = parse(ctx.readBed("state:host-refresh.json"));
  out.state = st
    ? {
        state: st.state,
        startedAt: st.startedAt,
        waitSeconds: st.waitSeconds,
        pid: typeof st.pid === "number",
      }
    : null;
  const json = { checks: doctorChecks(ctx.cli(["doctor", "--json"])) };
  const row = (Array.isArray(json?.checks) ? json.checks : []).find(
    (x) => x?.id === "terminal_host_module",
  );
  out.row = row
    ? {
        status: row.status,
        detail: String(row.detail ?? ""),
        fix: row.fix ?? null,
        held: row.held ?? null,
        refresh: row.refresh ?? null,
      }
    : null;
  // No secret in the words a person reads is under test here, so this
  // stays on the text form (issue 840), read whole: the Host row by a
  // regex over all of it, never a line by position.
  const said = /^[ \t]+Host[ \t].*$/m.exec(
    String(ctx.cli(["doctor"]).out ?? ""),
  );
  out.hostLine = said ? said[0] : null;
  return out;
}

export function expect(r) {
  const res = r ?? {};
  const row = res.row;
  const all = JSON.stringify(row ?? "") + "\n" + (res.hostLine ?? "");
  const c1 = !!row && !STOP_ALL.test(all);
  const st = res.state;
  const c2 =
    !!st &&
    ["waiting", "restarted", "failed", "kept", "current", "none"].includes(
      st.state,
    ) &&
    typeof st.startedAt === "string" &&
    typeof st.waitSeconds === "number" &&
    st.pid === true;
  const waiting = row?.refresh?.state === "waiting";
  const stale = row?.status === "fail";
  const rows = [
    {
      clause: clauses[0],
      ok: c1,
      detail: `row ${row?.status}: ${row?.detail}; fix ${row?.fix}; text ${res.hostLine}`,
    },
    {
      clause: clauses[1],
      ok: c2,
      detail: `state ${JSON.stringify(st)} after ${res.stateMs} ms`,
    },
  ];
  if (waiting) {
    const ok =
      row.status === "warn" &&
      !row.fix &&
      !row.held &&
      /Den restarts it when agents are idle \(waiting since .+, at most \d+ min\)/.test(
        row.detail,
      );
    rows.push({ clause: clauses[2], ok, detail: row.detail });
  } else
    rows.push({
      clause: clauses[2],
      ok: null,
      skip: "needs-host-refresh-wait",
    });
  if (stale) {
    const ok =
      row.held?.action === "host_restart" &&
      typeof row.fix === "string" &&
      row.fix.includes("host_restart");
    rows.push({
      clause: clauses[3],
      ok,
      detail: `held ${JSON.stringify(row.held)}; fix ${row.fix}`,
    });
  } else rows.push({ clause: clauses[3], ok: null, skip: "needs-stale-host" });
  // An Allow is the person's own act.
  rows.push({ clause: clauses[4], ok: null, skip: "person" });
  return rows;
}
