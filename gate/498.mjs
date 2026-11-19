// gate/498.mjs: the reserved release slot (issue 498). Read only: the
// machine's gate queue is live and shared, so this check never asks for a
// slot. It reads `gate status --json`, the gate-slots route and `gate
// settings`, and tries a release run that has no proof, which is refused
// before it asks (nothing joins the queue). The queue's own behaviour (a
// release run goes first, ordinary grants pause, the quiet wait, the load
// record) needs a release candidate's real run: those clauses are proved by
// the unit tests and say so here.
export const issue = 498;
export const clauses = [
  "a release slot kind with its own reserved capacity (a Setting, default 1); only a release-candidate run may take it",
  "while a release slot is held, new ordinary grants pause; running holds finish first, up to a Setting (default 10 min), then it runs anyway and records the load",
  "gate status shows the release slot and who holds it",
  "each verdict records the load average and the browser jobs running at its start and end",
];
export const timeoutMs = 60000;

const parse = (b) => {
  if (b && typeof b === "object") return b;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
};

export async function setup() {
  return {};
}

export async function run(ctx) {
  const status = ctx.cli(["gate", "status", "--json"]);
  const view = parse(status.out);
  const route = await ctx.fetch("/api/gate-slots");
  const settings = ctx.cli(["gate", "settings"]);
  // No proof: refused before it asks, so nothing joins the queue.
  const noTag = ctx.cli(["gate", "run", "--kind", "release", "--", "true"]);
  const badTag = ctx.cli([
    "gate",
    "run",
    "--kind",
    "release",
    "--tag",
    "not-a-candidate",
    "--",
    "true",
  ]);
  const human = ctx.cli(["gate", "status"]);
  return {
    statusCode: status.code,
    view,
    routeStatus: route.status,
    routeBody: parse(route.body),
    settingsCode: settings.code,
    settingsOut: String(settings.out),
    noTag: { code: noTag.code, err: String(noTag.err) },
    badTag: { code: badTag.code, err: String(badTag.err) },
    human: { code: human.code, out: String(human.out) },
  };
}

export function expect(cells) {
  const r = cells[0].result;
  const s = r.view?.settings ?? {};
  const rs = r.routeBody?.settings ?? {};
  const releaseHeld = r.view?.release?.held ?? [];
  return [
    {
      clause: clauses[0],
      ok:
        r.statusCode === 0 &&
        s.releaseSlots >= 1 &&
        rs.releaseSlots === s.releaseSlots &&
        r.noTag.code === 2 &&
        /--tag/.test(r.noTag.err) &&
        r.badTag.code === 2 &&
        /not a release candidate/.test(r.badTag.err),
      detail: `release_slots ${s.releaseSlots} (route ${rs.releaseSlots}); no tag: ${r.noTag.code} ${r.noTag.err.trim().slice(0, 100)}; bad tag: ${r.badTag.code} ${r.badTag.err.trim().slice(0, 120)}`,
    },
    {
      clause: clauses[1],
      ok:
        typeof s.releaseQuietWaitMinutes === "number" &&
        /release waits \d+(\.\d+)? min for quiet/.test(r.settingsOut)
          ? null
          : false,
      skip: "needs-release-candidate-run",
      detail: `release_quiet_wait_minutes ${s.releaseQuietWaitMinutes} is a setting; the pause and the quiet wait need a real release run beside ordinary ones (unit tests: release-slot.test.ts)`,
    },
    {
      clause: clauses[2],
      ok: r.view?.release
        ? releaseHeld.length > 0
          ? new RegExp("Release slot: held by").test(r.human.out)
          : null
        : false,
      ...(r.view?.release && releaseHeld.length === 0
        ? { skip: "needs-release-candidate-run" }
        : {}),
      detail: `status --json release: ${JSON.stringify(r.view?.release ?? null)}`,
    },
    {
      clause: clauses[3],
      ok: null,
      skip: "needs-release-candidate-run",
      detail:
        "the slot log's granted and released rows carry load and alongside for a release run; read events.jsonl after a candidate's run",
    },
  ];
}
