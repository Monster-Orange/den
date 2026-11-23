// Live check for #340: the account an agent runs on is shown by its label, never an email. Picking among
// accounts happens only under the always-on service with tokens set, so those clauses are not run.
// Read only.
import { doctorChecks, readJson } from "./lib/read-json.mjs";
export const issue = 340;
export const clauses = [
  "the account an agent runs on is shown on the agent (its label, never an email)",
  "with no source, the first account in order is used, and a capped account is skipped",
  "two agents in different projects can run on different accounts",
  "no account with a token: the agent starts as today and doctor says why",
];
export const timeoutMs = 90000;
const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

// Read only (issue 845): reads `agents list --json` and doctor.
export const readOnly = true;

export async function setup() {
  return {};
}

export async function run(ctx) {
  const l = ctx.cli(["agents", "list", "--json"]);
  const rows = readJson(l, "agents list");
  const labels = (Array.isArray(rows) ? rows : [])
    .filter((a) => a && "signIn" in a)
    .map((a) => ({ agent: a.agent ?? a.id, signIn: a.signIn }));
  // Issue 840: doctor --json's checks that point at set-token (the
  // where: sign-in rows), read by field.
  const d = ctx.cli(["doctor", "--json"]);
  const checks = doctorChecks(d);
  const why = checks
    .filter((c) => /agents accounts set-token/.test(String(c?.detail ?? "")))
    .map((c) => `${c.id}: ${c.detail}`);
  return {
    code: l.code,
    agents: Array.isArray(rows) ? rows.length : null,
    labels,
    why,
  };
}

export function expect(r) {
  return [
    r.labels.length
      ? {
          clause: clauses[0],
          ok: r.labels.every(
            (x) =>
              typeof x.signIn === "string" &&
              x.signIn.length > 0 &&
              !EMAIL.test(x.signIn),
          ),
          detail: r.labels.map((x) => `${x.agent}: ${x.signIn}`).join(", "),
        }
      : {
          clause: clauses[0],
          ok: null,
          skip: "needs-always-on-service",
          detail: `${r.agents} agents listed, none started on a vendor account`,
        },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-signed-in-cli",
      detail: "needs two vendor accounts with tokens, one capped",
    },
    {
      clause: clauses[2],
      ok: null,
      skip: "needs-signed-in-cli",
      detail: "needs two vendor accounts with tokens",
    },
    r.why.length
      ? {
          clause: clauses[3],
          ok: r.why.every((l) => !EMAIL.test(l)),
          detail: r.why.join(" | "),
        }
      : {
          clause: clauses[3],
          ok: null,
          skip: "needs-always-on-service",
          detail:
            "doctor says why only under the always-on service with more than one account",
        },
  ];
}
