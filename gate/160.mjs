/* eslint-env browser */
// Live check for #160: the approval policy is a Settings row (install and project), with watched and critical
// inputs, and only a person changes it. Read only: the agent's claim sends back the value already there,
// so even a wrong acceptance would change nothing.
export const issue = 160;
export const clauses = [
  "each kind of agent write has a policy: auto, notify or ask",
  "ask only when the item is something the person watches or favorited, or it is big or critical",
  "agents decide when to escalate beyond the policy, and say why",
  "settings per install and per project, with permissive defaults",
  "person-only changes to the policy itself always ask",
  "first use: closing a stale or superseded PR after a Hub note (auto unless watched)",
  "first use: agent_import (ask)",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 90000;
const INSTALL = [
  "agents.approvals_policy",
  "agents.approvals_watch",
  "agents.approvals_critical",
];
const PROJECT = [
  "workspace.approvals_policy",
  "workspace.approvals_watch",
  "workspace.approvals_critical",
];
const AGENT_CLAIM = {
  "x-den-actor": "agent",
  "x-den-mcp-agent": "agent:gate-160-claim",
};

export async function setup(ctx) {
  const before = await ctx.api("/api/settings");
  const s = {
    policy: before?.approvals_policy,
    watch: before?.approvals_watch,
    critical: before?.approvals_critical,
  };
  // An agent's claim to change the install's policy: refused. It carries the value already there.
  const claim = await ctx.api("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json", ...AGENT_CLAIM },
    body: JSON.stringify({ approvals_policy: s.policy ?? null }),
  });
  // ctx.api answers with the reply's JSON (the bed's driver) or a Response (the contract's fetch).
  const body =
    typeof claim?.json === "function"
      ? await claim.json().catch(() => ({}))
      : claim;
  s.claimStatus = typeof claim?.json === "function" ? claim.status : null;
  s.claimError = body?.error ?? null;
  s.refused =
    s.claimStatus === 403 ||
    (body?.ok === false && /only a person/.test(String(body?.error)));
  s.after = (await ctx.api("/api/settings"))?.approvals_policy;
  return s;
}

export async function run(ctx, s) {
  await ctx.goto(ctx.page, "/settings");
  await ctx.page
    .waitForSelector(".set-row[data-setting]", { timeout: 15000 })
    .catch(() => {});
  const rows = await ctx.page.evaluate(
    (ids) =>
      Object.fromEntries(
        ids.map((id) => {
          const row = document.querySelector(`.set-row[data-setting="${id}"]`);
          return [
            id,
            row
              ? {
                  options: [...row.querySelectorAll(".seg button[data-v]")].map(
                    (b) => b.getAttribute("data-v"),
                  ),
                  input: !!row.querySelector("input, textarea"),
                }
              : null,
          ];
        }),
      ),
    [...INSTALL, ...PROJECT],
  );
  const at = await ctx.page.locator(
    '.set-row[data-setting="agents.approvals_policy"]',
  );
  await at.scrollIntoViewIfNeeded().catch(() => {});
  await ctx.shot(`install-policy-${ctx.browser}-${ctx.width}`);
  const ws = ctx.page.locator(
    '.set-row[data-setting="workspace.approvals_policy"]',
  );
  if (await ws.count()) {
    await ws.scrollIntoViewIfNeeded().catch(() => {});
    await ctx.shot(`project-policy-${ctx.browser}-${ctx.width}`);
  }
  return { ...s, rows };
}

const KINDS = ["auto", "notify", "ask"];
export function expect(cells) {
  const all = (f) => cells.every(({ result }) => f(result));
  const r0 = cells[0].result;
  const shots = (p) =>
    cells.map(({ cell }) => `${p}-${cell.browser}-${cell.width}.png`);
  const has = (r, id) => !!r.rows[id];
  return [
    {
      clause: clauses[0],
      ok: all((r) =>
        KINDS.every((k) =>
          r.rows["agents.approvals_policy"]?.options.includes(k),
        ),
      ),
      detail: cells
        .map(
          ({ cell, result }) =>
            `${cell.browser}: ${JSON.stringify(result.rows["agents.approvals_policy"]?.options ?? null)}`,
        )
        .join("; "),
      evidence: shots("install-policy"),
    },
    {
      clause: clauses[1],
      ok:
        all(
          (r) =>
            has(r, "agents.approvals_watch") &&
            has(r, "agents.approvals_critical"),
        ) &&
        Array.isArray(r0.watch) &&
        Array.isArray(r0.critical),
      detail: `watched ${JSON.stringify(r0.watch)}, critical ${JSON.stringify(r0.critical)}; rows shown: ${cells.map(({ cell, result }) => `${cell.browser} ${["agents.approvals_watch", "agents.approvals_critical"].filter((id) => has(result, id)).length}/2`).join(", ")}`,
      evidence: shots("install-policy"),
    },
    {
      clause: clauses[2],
      ok: null,
      skip: "needs-real-agent",
      detail:
        "an escalation is a real agent's own call; the bed's stub agents make none",
    },
    {
      clause: clauses[3],
      ok: all(
        (r) =>
          INSTALL.every((id) => has(r, id)) &&
          PROJECT.every((id) => has(r, id)),
      ),
      detail:
        `install policy ${JSON.stringify(r0.policy)} (unset is notify); ` +
        cells
          .map(
            ({ cell, result }) =>
              `${cell.browser}: install ${INSTALL.filter((id) => has(result, id)).length}/3, project ${PROJECT.filter((id) => has(result, id)).length}/3`,
          )
          .join("; "),
      evidence: [...shots("install-policy"), ...shots("project-policy")],
    },
    {
      clause: clauses[4],
      ok: r0.refused && JSON.stringify(r0.after) === JSON.stringify(r0.policy),
      detail: `an agent's POST /api/settings approvals_policy: ${r0.claimStatus ?? ""} ${r0.claimError ?? ""}; policy ${JSON.stringify(r0.policy)} → ${JSON.stringify(r0.after)}`,
    },
    {
      clause: clauses[5],
      ok: null,
      skip: "needs-hub",
      detail: "needs a Hub note on a stale pull request",
    },
    {
      clause: clauses[6],
      ok: null,
      skip: "person",
      detail: "agent_import's held write waits on a person's Allow",
    },
  ];
}
