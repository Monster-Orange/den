// gate/739.mjs: a CI runner asks for release priority over HTTP, with its
// runner token (issue 739).
// Read only: it reads nothing and changes nothing, and asks for no slot.
// Its clauses go through the bed's Den server (POST /api/gate-slots/ask
// with a runner token). The bed's server has its own gate folder now
// (the bed-gate-dir proof on v0.4.85), so a priority ask there no
// longer jumps the machine's line. A runner token is still made only with
// a person's Allow (a fixture session counts as an agent there), so each
// clause reports "not run" (person) until a person makes one for the bed.
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
    skip: "person",
    detail:
      "a runner token is made only with a person's Allow, and a fixture session counts as an agent there. Not asked",
  }));
}
