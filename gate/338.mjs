// Live check for #338: a runtime with no sign-in data says so in doctor, plainly, and nothing is guessed.
// The line shows only under the always-on service with an agent on such a runtime; otherwise not run.
// Read only.
export const issue = 338;
export const clauses = [
  "a runtime catalog entry can carry sign-in data, and Claude Code moves onto it with no change in behaviour",
  "a vendor added in agents.runtime_catalog with sign-in data gets its token, in its own agents only",
  "an entry with no sign-in data: doctor says plainly that this agent cannot sign in after logout and will stop",
];
export const timeoutMs = 90000;

// Read only (issue 845): reads doctor's sign-in line.
export const readOnly = true;

export async function setup() {
  return {};
}

export async function run(ctx) {
  // Issue 840: doctor --json's where: checks. The sign-in row is
  // where:runtime-sign-in; the service's mode leads where:service.
  const d = ctx.cli(["doctor", "--json"]);
  let checks = [];
  try {
    checks = JSON.parse(String(d.out ?? "")).checks ?? [];
  } catch {
    checks = [];
  }
  const byId = (id) => checks.find((c) => c?.id === id) ?? null;
  const signIn = byId("where:runtime-sign-in");
  return {
    code: d.code,
    line: signIn ? String(signIn.detail ?? "") : null,
    always: /^always\b/.test(String(byId("where:service")?.detail ?? "")),
  };
}

export function expect(r) {
  return [
    {
      clause: clauses[0],
      ok: null,
      skip: "needs-signed-in-cli",
      detail:
        "Claude Code's token reaching its agent needs a real signed-in vendor CLI",
    },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-vendor-catalog-entry",
      detail:
        "needs a vendor with sign-in data in the bed's agents.runtime_catalog",
    },
    r.line
      ? {
          clause: clauses[2],
          ok: /: this agent cannot sign in after logout; it will stop\. Its runtime has no sign-in data \(agents\.runtime_catalog, signIn\)/.test(
            r.line,
          ),
          detail: r.line,
        }
      : {
          clause: clauses[2],
          ok: null,
          skip: "needs-always-on-service",
          detail:
            "doctor names it only under the always-on service, for an agent on a runtime with no sign-in data",
        },
  ];
}
