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
  "the policy's settings have en, es and ja text",
];
const LANGS = ["en", "es", "ja"];
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
  const claim = await ctx.fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json", ...AGENT_CLAIM },
    body: JSON.stringify({ approvals_policy: s.policy ?? null }),
  });
  s.claimStatus = claim.status;
  s.claimError = claim.body?.error ?? null;
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
  // The install's three rows in en, es and ja (Den's language, put back).
  const words = {};
  let was = null;
  try {
    was = (await settingsApi(ctx))?.language ?? null;
    for (const lang of LANGS) {
      await settingsApi(ctx, { language: lang });
      await ctx.goto(ctx.page, "/settings");
      await ctx.page
        .waitForSelector('.set-row[data-setting="agents.approvals_policy"]', {
          timeout: 15000,
        })
        .catch(() => {});
      words[lang] = await ctx.page.evaluate((ids) => {
        const text = (e) => (e?.textContent || "").trim();
        return {
          html: document.documentElement.lang || null,
          rows: Object.fromEntries(
            ids.map((id) => {
              const row = document.querySelector(
                `.set-row[data-setting="${id}"]`,
              );
              return [
                id,
                row
                  ? {
                      label: text(row.querySelector(".l")),
                      desc: text(row.querySelector(".d")),
                      options: [
                        ...row.querySelectorAll(".seg button[data-v]"),
                      ].map(text),
                    }
                  : null,
              ];
            }),
          ),
        };
      }, INSTALL);
      await ctx.shot(`words-${lang}-${ctx.browser}-${ctx.width}`);
    }
  } catch (e) {
    words.error = String(e?.message ?? e);
  } finally {
    await settingsApi(ctx, { language: was }).catch(() => {});
  }
  return { ...s, rows, words };
}

/** Den's settings through the bed's signed-in API (the person's token). */
async function settingsApi(ctx, body) {
  const r = await ctx.api(
    "/api/settings",
    body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : undefined,
  );
  if (r && r.ok === false) throw new Error(`/api/settings: HTTP ${r.status}`);
  return typeof r?.json === "function" ? r.json() : r;
}

/**
 * The words row: in each language the page is in it, each row's label,
 * description and options have words, and es and ja are not English.
 */
function wordsRow(cells) {
  const bad = [];
  for (const { cell, result } of cells) {
    const w = result.words ?? {};
    if (w.error) bad.push(`${cell.browser}: ${w.error}`);
    for (const lang of LANGS) {
      const at = w[lang];
      if (!at) {
        bad.push(`${cell.browser} ${lang}: not read`);
        continue;
      }
      if (at.html !== lang)
        bad.push(`${cell.browser} ${lang}: page in ${at.html}`);
      for (const id of INSTALL) {
        const r = at.rows?.[id];
        const en = w.en?.rows?.[id];
        if (!r || !r.label || !r.desc) {
          bad.push(`${cell.browser} ${lang} ${id}: no words`);
          continue;
        }
        if (lang === "en") continue;
        if (r.label === en?.label || r.desc === en?.desc)
          bad.push(`${cell.browser} ${lang} ${id}: English ("${r.label}")`);
        const same = r.options.filter((o, i) => o && o === en?.options?.[i]);
        if (same.length)
          bad.push(
            `${cell.browser} ${lang} ${id}: options ${same.join(", ")} in English`,
          );
      }
    }
  }
  return {
    clause: clauses[7],
    ok: bad.length === 0,
    detail: bad.length
      ? bad.join("; ")
      : "Agent writes, watched and critical rows: label, description and options in en, es and ja",
    evidence: cells.flatMap(({ cell }) =>
      LANGS.map((l) => `words-${l}-${cell.browser}-${cell.width}.png`),
    ),
  };
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
      ok:
        r0.claimStatus === 403 &&
        JSON.stringify(r0.after) === JSON.stringify(r0.policy),
      detail: `an agent's POST /api/settings approvals_policy: ${r0.claimStatus} ${r0.claimError ?? ""}; policy ${JSON.stringify(r0.policy)} → ${JSON.stringify(r0.after)}`,
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
    wordsRow(cells),
  ];
}
