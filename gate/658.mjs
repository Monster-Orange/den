// gate/658.mjs: Resume of a conversation that was never written starts the
// agent fresh under the same id, with its last handoff, and never a 502.
//
// Every clause needs an agent whose conversation was never written: a
// start that ends before the runtime writes its transcript (in the issue,
// a No to the folder-trust question). The bed's stub runtime writes its
// transcript the moment it starts, under the id Den gave it, and nothing
// a check can do through ctx stops that or takes the file away (the bed
// is read only to a check). So Den always finds the conversation and
// resumes it, and none of these clauses can be shown. They skip, saying
// what the bed would need: a stub mode that starts without writing its
// transcript and exits non-zero (for example on "No, exit" at a trust
// screen it draws), so that a relaunch from a handoff can end before its
// conversation exists. The red-first tests for each clause are
// tests/unit/agents/resume-never-written.test.ts and
// rotation-relaunch.test.ts (PR 662).
//
// Nothing is started or changed on the bed.
export const issue = 658;
export const clauses = [
  "after a relaunch that exits before its conversation exists, Resume starts the agent with its handoff as the first prompt, never a 502",
  "a relaunch that exits at once leaves handoff.md in place and the rotation due",
  "with no handoff on file, Resume starts fresh under the same id and says it had nothing to continue",
];

const NEEDS =
  "the bed's stub writes its transcript as soon as it starts, so no conversation is ever 'never written'; the bed needs a stub mode that starts without writing one and exits non-zero (a 'No, exit' at a trust screen it draws)";

export async function setup() {
  return {};
}

export async function run() {
  return { stubWritesAtStart: true };
}

export function expect() {
  return clauses.map((clause) => ({
    clause,
    ok: null,
    skip: "needs-stub-unwritten-start",
    detail: NEEDS,
  }));
}
