// gate/585.mjs: `<cli> gate cancel <id>` (issue 585). Read only: the
// machine's gate queue is live and shared, so this check never asks for a
// slot and never cancels one. It cancels an id no slot has (refused, and
// nothing changes), as a person over the route and on the CLI, and reads
// the cancel grace setting. Stopping a real run's process group needs a
// run of the check's own in a queue of its own: the unit tests prove it.
export const issue = 585;
export const clauses = [
  "the owner or a person cancels; anyone else gets 403",
  "a queued ask is removed; its gate run exits non-zero with cancelled by <who> and never starts <cmd>",
  "a running slot: TERM to the process group, a grace (a setting), then KILL; released only when the group is gone",
  "an audit row and a slot-log event cancelled, naming who and whether it was queued or running",
  "POST /api/gate-slots/cancel {id} with the same rule",
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

const NO_SLOT = "cpu-0000000000";

export async function setup() {
  return {};
}

export async function run(ctx) {
  const before = parse(ctx.cli(["gate", "status", "--json"]).out);
  const cli = ctx.cli(["gate", "cancel", NO_SLOT]);
  const route = await ctx.fetch("/api/gate-slots/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: NO_SLOT }),
  });
  const empty = await ctx.fetch("/api/gate-slots/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const after = parse(ctx.cli(["gate", "status", "--json"]).out);
  return {
    before,
    after,
    cli: { code: cli.code, err: String(cli.err) },
    route: { status: route.status, body: parse(route.body) },
    empty: empty.status,
  };
}

export function expect(cells) {
  const r = cells[0].result;
  const grace = r.after?.settings?.cancelGraceSeconds;
  return [
    {
      clause: clauses[0],
      ok: null,
      skip: "needs-second-agent",
      detail:
        "a refusal needs another agent's token against a slot this check owns; unit tests: gate-cancel.test.ts",
    },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-own-gate-queue",
      detail: `cancel of a slot that isn't there: ${r.cli.code} ${r.cli.err.trim().slice(0, 100)}`,
    },
    {
      clause: clauses[2],
      ok: typeof grace === "number" ? null : false,
      skip: "needs-own-gate-queue",
      detail: `cancel_grace_seconds ${grace}`,
    },
    {
      clause: clauses[3],
      ok: null,
      skip: "needs-own-gate-queue",
      detail: "read events.jsonl and the audit after a real cancel",
    },
    {
      clause: clauses[4],
      ok:
        r.route.status === 404 &&
        r.empty === 400 &&
        r.cli.code === 1 &&
        /no slot/.test(r.cli.err),
      detail: `route: ${r.route.status} ${JSON.stringify(r.route.body)}; no id: ${r.empty}; cli: ${r.cli.code}`,
    },
  ];
}
