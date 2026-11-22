// gate/739.mjs: a CI runner asks for release priority over HTTP, with its
// runner token (issue 739).
// Read only: it reads nothing and changes nothing, and asks for no slot.
// Its clauses go through the bed's Den server (POST /api/gate-slots/ask
// with a runner token). Two things are missing on the bed: the bed's
// server keeps its slots in the machine's shared gate folder (it sets no
// DEN_GATE_DIR), so a priority ask would jump every other run on the
// machine; and a runner token is made only with a person's Allow (a
// fixture session counts as an agent there). So each clause reports "not
// run" until the bed's server has a gate folder of its own and a token
// a person made for it.
export const readOnly = true;

export const issue = 739;
// Issue 866 asked for this live check (739 shipped with unit tests only).
export const items = [739, 866];
export const clauses = [
  "a runner's request with priority release and a reason goes ahead of plain waiting runs of its kind, and the slot log names the runner and the reason",
  "without a reason it's refused (400), and nothing is queued",
  "with runners not allowed to ask, the request is refused, and the run waits in the normal queue",
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
      "the bed's Den server keeps gate slots in the machine's shared folder (no DEN_GATE_DIR of its own), so a runner's priority ask from this check would jump every other run on the machine; and a runner token needs a person's Allow (skip: person). Not asked",
  }));
}
