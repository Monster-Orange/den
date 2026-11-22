// gate/714.mjs: gate slots held over MCP: told on grant, passed on when
// unclaimed, and leased (issue 714).
// Read only: it reads nothing and changes nothing, and asks for no slot.
// Its clauses go through the bed's Den server (the MCP tool
// gate_slot_request), and the bed's server keeps its slots in the
// machine's shared gate folder (it sets no DEN_GATE_DIR). An ask from
// this check would wait in, or jump, every other run's line on the
// machine. So each clause reports "not run" until the bed's server has a
// gate folder of its own; then this check asks there.
export const readOnly = true;

export const issue = 714;
// Issue 866 asked for this live check (714 shipped with unit tests only).
export const items = [714, 866];
export const clauses = [
  "a queued agent that idles is woken by the grant message; unclaimed after claim_minutes, the slot goes to the next in line, and the agent is re-queued and told",
  "an MCP slot not renewed and past its estimate lapses within the lapse time, and the next holder starts",
  "a renewed slot past its estimate keeps holding",
  "the lapse shows in the slot log and the bell, and the agent's next gate call says so",
];

export async function setup() {
  return {};
}

export async function run() {
  return {};
}

export function expect() {
  return clauses.map((clause) => ({
    clause,
    ok: null,
    skip: "needs-bed-gate-dir",
    detail:
      "the bed's Den server keeps gate slots in the machine's shared folder (no DEN_GATE_DIR of its own), so an MCP ask from this check would change every other run's place; not asked",
  }));
}
