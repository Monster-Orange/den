/**
 * The Verify page (issue 209; VERIFY-SPEC section 12, direction C "Can we
 * ship?"): one plain answer for each environment, worst first, and why.
 *
 *   S1  the answer: a card per environment (a status dot and word, one
 *       sentence, who started and allowed the last run, its commit), the
 *       activity beside it, and every check folded under "All checks"
 *   S4  why (?why=<env>): what failed with its first line and its report,
 *       what waits on it, and what passed; answer → why → report is two
 *       clicks
 *   S7  empty: no checks declared yet, with the three lines to add one
 *   S8  nothing ran, or no check runs on an environment: never a pass
 *   S9  an agent's run says the agent started it and a person allowed it
 *   441 an imported environment (an outside runner's gate results, such
 *       as "bed"): the tag's answer and its clause counts; failed, couldn't
 *       run and needs you; each check as one row; ?why=<env> adds a
 *       clauses table per check. A runner's text is untrusted: esc() only
 *
 * Reads GET /api/verify/overview (verify-routes.ts). The views are pure
 * (HTML from that JSON), so tests need no server. Words come from the
 * shell's catalog ("v.*"); environment and module names stay as they are.
 */
import { formatTime } from "/kit/time.js";

const t = (key, vars) => globalThis.window?.denShell?.t?.(key, vars) ?? key;

function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/** An environment's name: the three Den knows, in the page's language. */
export function envName(env) {
  const k = {
    local: "v.env_local",
    staging: "v.env_staging",
    production: "v.env_prod",
  }[env];
  return k ? t(k) : String(env);
}

/** Each answer's badge word and its tone (worst first). */
const ANSWER = {
  failed: { word: "v.v_notready", tone: "bad" },
  nothing: { word: "v.v_nothing", tone: "neutral" },
  notrun: { word: "v.v_notrun", tone: "neutral" },
  partly: { word: "v.v_partly", tone: "warn" },
  ready: { word: "v.v_ready", tone: "ok" },
};
const RANK = Object.keys(ANSWER);

/** Environments worst first (the server sends them so; this keeps it). */
export function worstFirst(envs) {
  return [...(envs ?? [])]
    .map((e, i) => ({ e, i }))
    .sort(
      (a, b) =>
        RANK.indexOf(a.e.answer) - RANK.indexOf(b.e.answer) || a.i - b.i,
    )
    .map((x) => x.e);
}

const STATE = {
  passed: { word: "v.s_passed", tone: "ok", mark: "✓" },
  failed: { word: "v.s_failed", tone: "bad", mark: "✕" },
  error: { word: "v.s_error", tone: "bad", mark: "!" },
  blocked: { word: "v.s_blocked", tone: "warn", mark: "‖" },
  none: { word: "v.s_none", tone: "neutral", mark: "–" },
  off: { word: "v.s_off", tone: "neutral", mark: "·" },
};

/** A state as a dot and a word: never colour alone. */
export function stateTag(state) {
  const s = STATE[state] ?? STATE.none;
  return `<span class="vf-st vf-${s.tone}"><span class="vf-mk" aria-hidden="true">${s.mark}</span>${esc(t(s.word))}</span>`;
}

function badge(answer, word) {
  const a = ANSWER[answer] ?? ANSWER.notrun;
  return `<span class="vf-badge vf-${a.tone}" data-badge="${esc(answer)}"><span class="vf-dot" aria-hidden="true"></span>${esc(t(word ?? a.word))}</span>`;
}

/** In the person's chosen zone and the page's language (issue 668). */
function when(iso) {
  return formatTime(iso);
}

/** The one sentence on an environment's card. */
export function answerSentence(e) {
  const env = envName(e.env);
  const c = e.counts ?? {};
  switch (e.answer) {
    case "failed": {
      const f = e.failures ?? [];
      const waiting = (e.blocked ?? []).length;
      const head =
        f.length === 1
          ? t("v.a_fail1", { e: env, m: f[0].module })
          : f.length
            ? t("v.a_failn", { e: env, n: f.length })
            : t("v.a_blockedonly", { e: env, n: waiting });
      return f.length && waiting
        ? `${head} ${t("v.a_waiting", { n: waiting })}`
        : head;
    }
    case "nothing":
      return e.nothing === "nothing-ran"
        ? t("v.a_nothingran", { e: env })
        : t("v.a_nonehere", { e: env });
    case "partly":
      return t("v.a_partly", { e: env, p: c.passed ?? 0, n: c.total ?? 0 });
    case "ready":
      return t("v.a_ready", { e: env, n: c.total ?? 0 });
    default:
      return t("v.a_notrun", { e: env });
  }
}

/** Who started the last run, who allowed it, its commit and when (S9). */
export function metaLine(run) {
  if (!run) return "";
  const parts = [];
  const by = run.startedBy;
  if (by?.kind === "runner") return runnerMeta(run);
  if (by?.kind === "agent") parts.push(t("v.m_agent", { a: by.name ?? "" }));
  else if (by?.kind === "person") parts.push(t("v.m_person"));
  if (run.allowedBy?.kind === "person") parts.push(t("v.m_allowed"));
  else if (run.allowedBy?.kind === "den") parts.push(t("v.m_allowed_den"));
  if (run.commit)
    parts.push(t("v.m_commit", { c: String(run.commit).slice(0, 7) }));
  const at = when(run.endedAt);
  if (at) parts.push(t("v.m_when", { t: at }));
  return parts.join(" ");
}

/** A time of day alone (the end of an imported run's span), in the chosen zone (issue 668). */
function clock(iso) {
  return formatTime(iso, { style: "time" });
}

/** Issue 441: an import's line: its commit, when it ran, where it came from. */
function runnerMeta(run) {
  const parts = [];
  if (run.commit)
    parts.push(t("v.m_commit", { c: String(run.commit).slice(0, 7) }));
  const from = run.startedAt ? when(run.startedAt) : "";
  const to = run.startedAt ? clock(run.endedAt) : when(run.endedAt);
  if (from && to) parts.push(t("v.m_ran", { a: from, b: to }));
  else if (to) parts.push(t("v.m_when", { t: to }));
  parts.push(t("v.m_runner"));
  return parts.join(" ");
}

/** An imported environment's answer: the tag, bold; the rest plain text. */
function importedSentence(e) {
  const env = envName(e.env);
  const c = e.clauses ?? {};
  const bad = (c.failed ?? 0) + (c.error ?? 0);
  const key =
    e.answer === "failed"
      ? "v.i_fail"
      : e.answer === "ready"
        ? "v.i_pass"
        : e.answer === "nothing"
          ? "v.i_nothing"
          : null;
  if (!key || !e.run) return esc(t("v.a_notrun", { e: env }));
  const MARK = "\u0000";
  return esc(t(key, { t: MARK, e: env, n: bad })).replace(
    MARK,
    `<b>${esc(e.run.tag ?? e.run.runId)}</b>`,
  );
}

const CLAUSE = {
  passed: { word: "v.c_passed", tone: "ok", mark: "✓" },
  failed: { word: "v.c_failed", tone: "bad", mark: "✕" },
  error: { word: "v.c_error", tone: "bad", mark: "!" },
  "needs-person": { word: "v.c_needs", tone: "warn", mark: "●" },
  "cant-run": { word: "v.c_cantrun", tone: "neutral", mark: "‖" },
};

/** The issue a gate check is for ("gate/327" → "issue 327"). */
function issueOf(check) {
  const m = /^gate\/(\d+)$/.exec(String(check ?? ""));
  return m ? t("v.i_issue", { n: m[1] }) : String(check ?? "");
}

/** Failed, couldn't run or needs you: each clause with its note. */
function clauseList(title, items, lede) {
  if (!items?.length) return "";
  const rows = items
    .map((x) => {
      const c = CLAUSE[x.result] ?? CLAUSE["cant-run"];
      return (
        `<li><span class="vf-mk vf-${c.tone}" aria-hidden="true">${c.mark}</span>` +
        `<span class="vf-grow">${esc(x.clause)} <span class="vf-muted">· ${esc(issueOf(x.check))}</span>` +
        (x.note ? `<br><span class="vf-muted">${esc(x.note)}</span>` : "") +
        `</span></li>`
      );
    })
    .join("");
  return (
    `<div class="vf-clist" data-part="list"><h3>${esc(t(title, { n: items.length }))}</h3>` +
    (lede ? `<p class="vf-meta" data-part="meta">${esc(lede)}</p>` : "") +
    `<ul class="vf-rows">${rows}</ul></div>`
  );
}

/** The clause counts: passed, failed, needs you, couldn't run. */
function clauseCounts(c) {
  const item = (k, n, tone, word) =>
    `<li data-count="${k}"><b class="vf-${tone}">${esc(n ?? 0)}</b>${esc(t(word))}</li>`;
  return (
    `<ul class="vf-counts">` +
    item("passed", c.passed, "ok", "v.n_passed") +
    item("failed", (c.failed ?? 0) + (c.error ?? 0), "bad", "v.n_failed") +
    item("needs-person", c.needsPerson, "warn", "v.n_needs") +
    item("cant-run", c.cantRun, "neutral", "v.n_cantrun") +
    `</ul>`
  );
}

/** The three lists, failed first. */
function clauseLists(e) {
  return (
    clauseList("v.i_failed_h", e.clauseFailures) +
    clauseList("v.i_cantrun_h", e.cantRun) +
    clauseList(
      "v.i_needs_h",
      e.needsPerson,
      t("v.i_needs_p", { e: envName(e.env) }),
    )
  );
}

/** A check's DOM id on the why view ("gate/327" → "gate-327"). */
function checkId(module) {
  return String(module).replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** One row a check: the whole row opens its clauses. */
function checkRows(e) {
  if (!e.gateChecks?.length) return "";
  const rows = e.gateChecks
    .map((g) => {
      const n = g.clauses.length;
      const p = g.clauses.filter((c) => c.result === "passed").length;
      const need = g.clauses.filter((c) => c.result === "needs-person").length;
      const say =
        t("v.i_chk", { p, n }) + (need ? t("v.i_chk_needs", { n: need }) : "");
      const s = STATE[g.state] ?? STATE.none;
      return (
        `<li><a class="vf-row" href="?why=${encodeURIComponent(e.env)}#${esc(checkId(g.module))}" data-why="${esc(e.env)}" data-check="${esc(g.module)}">` +
        `<span class="vf-mk vf-${s.tone}" aria-hidden="true">${s.mark}</span>` +
        `<span class="vf-grow"><code>${esc(g.module)}</code> · ${esc(say)}</span></a></li>`
      );
    })
    .join("");
  return `<div class="vf-clist"><h3>${esc(t("v.i_checks_h"))}</h3><ul class="vf-rows">${rows}</ul></div>`;
}

/** The badge on an imported environment: what the tag did. */
function importedBadge(e) {
  if (e.answer === "failed") return badge("failed", "v.i_b_failed");
  if (e.answer === "ready") return badge("ready", "v.i_b_passed");
  return badge(e.answer);
}

/** The card's top: the answer, the meta line, the counts. */
function importedTop(e) {
  if (!e.run) return `<p class="vf-say" data-part="say">${importedSentence(e)}</p>`;
  const c = e.clauses ?? {};
  return (
    `<p class="vf-say" data-part="say">${importedSentence(e)}</p>` +
    `<p class="vf-meta" data-part="meta">${esc(metaLine(e.run))} ${esc(t("v.i_sizes", { a: t("v.i_nchecks", { n: e.run.checks ?? 0 }), b: t("v.i_nclauses", { n: c.total ?? 0 }) }))}</p>` +
    clauseCounts(c)
  );
}

/** Issue 441: an imported environment's card. */
function importedCard(e) {
  const a = ANSWER[e.answer] ?? ANSWER.notrun;
  return (
    `<section class="vf-ans vf-${a.tone}" data-env="${esc(e.env)}" data-answer="${esc(e.answer)}" data-imported aria-label="${esc(envName(e.env))}">` +
    `<div class="vf-env"><b>${esc(envName(e.env))}</b>${importedBadge(e)}</div>` +
    importedTop(e) +
    (e.run ? clauseLists(e) + checkRows(e) : "") +
    `</section>`
  );
}

/** A clause's time: ms under a second, else seconds. */
function took(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return t("v.t_ms", { n: Math.round(ms) });
  // Under ten seconds, one decimal (1.3 s); after that, whole seconds.
  const sec = ms / 1000;
  let n = String(Math.round(sec));
  try {
    n = new Intl.NumberFormat(
      globalThis.document?.documentElement?.lang || undefined,
      { maximumFractionDigits: sec < 10 ? 1 : 0 },
    ).format(sec);
  } catch {
    // An unknown language: whole seconds, as above.
  }
  return t("v.t_s", { n });
}

/** Issue 441: one check's clauses on the why view. */
function clauseTable(e, g) {
  const rows = g.clauses
    .map((c) => {
      const r = CLAUSE[c.result] ?? CLAUSE["cant-run"];
      const tag =
        c.result === "needs-person"
          ? ` <b class="vf-warn">${esc(t("v.c_needs"))}</b>`
          : "";
      return (
        `<tr data-result="${esc(c.result)}"><td class="vf-${r.tone}" data-l="${esc(t("v.ct_result"))}"><span aria-hidden="true">${r.mark}</span> <span class="vf-sr">${esc(t(r.word))}</span></td>` +
        `<td data-l="${esc(t("v.ct_clause"))}">${esc(c.clause)}${tag}</td>` +
        `<td class="vf-muted" data-l="${esc(t("v.ct_note"))}">${esc(c.note ?? "")}</td>` +
        `<td class="vf-muted" data-l="${esc(t("v.ct_time"))}">${esc(took(c.ms))}</td></tr>`
      );
    })
    .join("");
  return (
    `<section class="vf-card vf-gate" id="${esc(checkId(g.module))}" tabindex="-1">` +
    `<div class="vf-head"><h3><code>${esc(g.module)}</code> ${esc(t("v.i_on", { t: e.run?.tag ?? e.run?.runId ?? "" }))}</h3>${stateTag(g.state)}</div>` +
    `<div class="vf-tablewrap"><table class="vf-checks vf-clauses"><thead><tr><th scope="col">${esc(t("v.ct_result"))}</th><th scope="col">${esc(t("v.ct_clause"))}</th><th scope="col">${esc(t("v.ct_note"))}</th><th scope="col">${esc(t("v.ct_time"))}</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div></section>`
  );
}

/** Issue 441: why an imported environment says what it says. */
function importedWhy(e) {
  const back = `<p class="vf-back" data-part="back"><a href="?">${esc(t("v.back"))}</a></p>`;
  return (
    back +
    `<div class="vf-head"><div><h2 tabindex="-1">${esc(envName(e.env))}</h2></div>${importedBadge(e)}</div>` +
    `<section class="vf-ans vf-${(ANSWER[e.answer] ?? ANSWER.notrun).tone}" data-imported>${importedTop(e)}</section>` +
    (e.run
      ? `<section class="vf-card vf-why-card"${e.answer === "failed" ? ' role="alert"' : ""}>${clauseLists(e) || `<p class="vf-muted">${esc(t("v.i_allran"))}</p>`}</section>` +
        (e.gateChecks ?? []).map((g) => clauseTable(e, g)).join("")
      : "")
  );
}

function card(e) {
  if (e.imported) return importedCard(e);
  const a = ANSWER[e.answer] ?? ANSWER.notrun;
  const why =
    e.answer === "failed"
      ? `<div class="vf-btns"><a class="den-btn primary vf-why" href="?why=${encodeURIComponent(e.env)}" data-why="${esc(e.env)}">${esc(t("v.b_why"))}</a></div>`
      : "";
  return (
    `<section class="vf-ans vf-${a.tone}" data-env="${esc(e.env)}" data-answer="${esc(e.answer)}" aria-label="${esc(envName(e.env))}">` +
    `<div class="vf-env"><b>${esc(envName(e.env))}</b>${badge(e.answer)}</div>` +
    `<p class="vf-say" data-part="say">${esc(answerSentence(e))}</p>` +
    (e.run ? `<p class="vf-meta" data-part="meta">${esc(metaLine(e.run))}</p>` : "") +
    why +
    `</section>`
  );
}

function actorKind(a) {
  return a?.kind === "agent" || a?.kind === "den" || a?.kind === "runner"
    ? a.kind
    : "person";
}

function actorName(a) {
  if (a?.kind === "runner") return t("v.who_runner");
  if (a?.kind === "agent") return a.name ?? t("v.actor_agent");
  if (a?.kind === "den") return "Den";
  return t("v.who_person");
}

function avatar(a) {
  const kind = actorKind(a);
  const letter = actorName(a).trim().charAt(0).toUpperCase() || "?";
  return `<span class="vf-av vf-av-${kind}" aria-hidden="true">${esc(letter)}</span>`;
}

function feedItem(actor, text, at) {
  const kind = actorKind(actor);
  return (
    `<li>${avatar(actor)}<div class="vf-tx"><b>${esc(actorName(actor))}</b>` +
    `<span class="vf-role">${esc(t(`v.actor_${kind}`))}</span> ${esc(text)}` +
    `<small>${esc(when(at))}</small></div></li>`
  );
}

const VERDICT_WORD = {
  passed: "v.s_passed",
  failed: "v.s_failed",
  "nothing ran": "v.v_nothing",
  cancelled: "v.v_cancelled",
};

/** The activity beside the answers: each run, newest first. */
export function feedView(activity) {
  const items = [];
  for (const r of activity ?? []) {
    const env = envName(r.env);
    items.push(
      feedItem(
        { kind: "den" },
        t("v.fd_finished", {
          e: env,
          v: t(VERDICT_WORD[r.verdict] ?? "v.s_failed"),
        }),
        r.endedAt,
      ),
    );
    if (r.allowedBy)
      items.push(
        feedItem(r.allowedBy, t("v.fd_allowed", { e: env }), r.endedAt),
      );
    if (r.startedBy?.kind === "runner")
      items.push(
        feedItem(
          r.startedBy,
          t("v.fd_imported", { t: r.runId, e: env }),
          r.endedAt,
        ),
      );
    else if (r.startedBy)
      items.push(
        feedItem(
          r.startedBy,
          t("v.fd_asked", { e: env, n: r.checks ?? 0 }),
          r.startedAt ?? r.endedAt,
        ),
      );
  }
  return (
    `<aside class="vf-feed" aria-label="${esc(t("v.fd_t"))}"><h2>${esc(t("v.fd_t"))}</h2>` +
    (items.length
      ? `<ol>${items.slice(0, 12).join("")}</ol>`
      : `<p class="vf-muted">${esc(t("v.fd_none"))}</p>`) +
    `</aside>`
  );
}

function kindWord(k) {
  return t(`v.k_${k}`);
}

/** Every check, folded: its kind and its state on each environment. */
export function allChecks(ov, open) {
  const order = ov.envOrder ?? (ov.envs ?? []).map((e) => e.env);
  const rows = (ov.checks ?? [])
    .map(
      (c) =>
        `<tr><th scope="row"><code>${esc(c.module)}</code>` +
        (c.dependsOn?.length
          ? `<div class="vf-dep">${esc(t("v.dep_on", { l: c.dependsOn.join(", ") }))}</div>`
          : "") +
        `</th><td data-l="${esc(t("v.ac_kind"))}">${esc(kindWord(c.kind))}</td>` +
        order
          .map(
            (e) =>
              `<td data-l="${esc(envName(e))}">${stateTag(c.states?.[e])}</td>`,
          )
          .join("") +
        `</tr>`,
    )
    .join("");
  return (
    `<details class="vf-all"${open ? " open" : ""}><summary>${esc(t("v.ac_n", { n: ov.checks?.length ?? 0 }))}</summary>` +
    `<div class="vf-tablewrap"><table class="vf-checks"><thead><tr><th scope="col">${esc(t("v.ac_mod"))}</th><th scope="col">${esc(t("v.ac_kind"))}</th>` +
    order.map((e) => `<th scope="col">${esc(envName(e))}</th>`).join("") +
    `</tr></thead><tbody>${rows}</tbody></table></div></details>`
  );
}

const SNIPPET = `verify:
  modules:
    api/smoke: { kind: smoke }`;

/** S7: no checks declared yet. */
export function emptyView() {
  return (
    `<section class="vf-ans vf-neutral" data-answer="empty"><div class="vf-env"><b>${esc(t("v.em_h"))}</b>${badge("notrun", "v.v_none")}</div>` +
    `<p class="vf-say" data-part="say">${esc(t("v.em_p"))}</p><pre class="vf-pre">${esc(SNIPPET)}</pre>` +
    `<p class="vf-meta" data-part="meta">${esc(t("v.em_where"))}</p></section>`
  );
}

function oldKinds() {
  return `<p class="vf-old">${esc(t("v.old_t"))} <a href="/test-runs">${esc(t("v.old_link"))}</a></p>`;
}

/** S1: the answer on each environment, the activity, every check. */
export function answerView(ov, { wide = true } = {}) {
  const head =
    `<div class="vf-head"><div><h2 tabindex="-1">${esc(t("v.ov_t"))}</h2>` +
    `<p class="vf-lede">${esc(t("v.ov_s"))}</p></div></div>`;
  if (!ov.modules && !(ov.envs ?? []).some((e) => e.imported))
    return `${head}<div class="vf-cols"><div class="vf-main">${emptyView()}${oldKinds()}</div>${feedView(ov.activity)}</div>`;
  const cards = worstFirst(ov.envs).map(card).join("");
  return (
    `${head}<div class="vf-cols"><div class="vf-main">${cards}${allChecks(ov, wide)}${oldKinds()}</div>` +
    `${feedView(ov.activity)}</div>`
  );
}

function reportHref(project, f) {
  return `/api/verify/runs/${encodeURIComponent(f.runId)}/report?project=${encodeURIComponent(project)}&module=${encodeURIComponent(f.module)}`;
}

/** S4: why an environment is not ready, down to each failure's report. */
export function whyView(ov, env) {
  const e = (ov.envs ?? []).find((x) => x.env === env);
  const back = `<p class="vf-back" data-part="back"><a href="?">${esc(t("v.back"))}</a></p>`;
  if (!e) return back;
  if (e.imported) return importedWhy(e);
  const fails = (e.failures ?? [])
    .map((f) => {
      const line = f.message
        ? t(f.state === "error" ? "v.why_err" : "v.why_fail", {
            m: f.module,
            x: f.message,
          })
        : t(f.state === "error" ? "v.why_errq" : "v.why_failq", {
            m: f.module,
          });
      const rep =
        f.report && f.runId
          ? `<a class="den-btn vf-report" href="${esc(reportHref(ov.project, f))}" target="_blank" rel="noopener">${esc(t("v.b_report"))}</a>`
          : `<span class="vf-muted">${esc(t("v.no_report"))}</span>`;
      return `<li><span class="vf-line">${stateTag(f.state)} ${esc(line)}</span><div class="vf-sub">${rep}</div></li>`;
    })
    .join("");
  const groups = new Map();
  for (const b of e.blocked ?? []) {
    const k = b.blockedBy || "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b.module);
  }
  const waits = [...groups]
    .map(
      ([by, mods]) =>
        `<li>${esc(by === "smoke" ? t("v.why_wait_smoke") : t("v.why_wait", { l: by }))}<ul>` +
        mods
          .map((m) => `<li><code>${esc(m)}</code> ${stateTag("blocked")}</li>`)
          .join("") +
        `</ul></li>`,
    )
    .join("");
  const passed = e.counts?.passed ?? 0;
  const rest = passed ? `<li>${esc(t("v.why_rest", { n: passed }))}</li>` : "";
  return (
    back +
    `<div class="vf-head"><div><h2 tabindex="-1">${esc(envName(e.env))}</h2></div>${badge(e.answer)}</div>` +
    `<p class="vf-say" data-part="say">${esc(answerSentence(e))}</p>` +
    (e.run ? `<p class="vf-meta" data-part="meta">${esc(metaLine(e.run))}</p>` : "") +
    `<section class="vf-card vf-why-card" role="alert"><h2>${esc(t("v.why_t"))}</h2><ol class="vf-why">${fails}${waits}${rest}</ol></section>`
  );
}

export function loadingView() {
  return (
    `<div class="vf-head"><div><h2 tabindex="-1">${esc(t("v.ov_t"))}</h2><p class="vf-lede">${esc(t("v.loading"))}</p></div></div>` +
    `<div class="vf-skel" aria-hidden="true"></div><div class="vf-skel" aria-hidden="true"></div>`
  );
}

export function errorView() {
  return (
    `<div class="vf-head"><div><h2 tabindex="-1">${esc(t("v.ov_t"))}</h2></div></div>` +
    `<div class="vf-err" role="alert"><span>${esc(t("v.err_load"))}</span> <button type="button" class="den-btn" data-retry>${esc(t("v.retry"))}</button></div>`
  );
}

/** Mounts the page in `root`, reading the overview and following ?why=. */
export async function mountVerify(root, { fetchImpl = globalThis.fetch } = {}) {
  const narrow = () =>
    globalThis.matchMedia?.("(max-width: 700px)")?.matches ?? false;
  let ov = null;
  const draw = () => {
    if (!ov) return;
    const why = new URLSearchParams(globalThis.location?.search ?? "").get(
      "why",
    );
    root.innerHTML = why
      ? whyView(ov, why)
      : answerView(ov, { wide: !narrow() });
    root.setAttribute("aria-busy", "false");
  };
  const load = async () => {
    root.setAttribute("aria-busy", "true");
    root.innerHTML = loadingView();
    try {
      const res = await fetchImpl("/api/verify/overview", {
        headers: { Accept: "application/json" },
      });
      const body = await res.json();
      if (!res.ok || !body.ok)
        throw new Error(body.error ?? String(res.status));
      ov = body;
      draw();
    } catch {
      root.innerHTML = errorView();
      root.setAttribute("aria-busy", "false");
    }
  };
  root.addEventListener("click", (ev) => {
    const el = ev.target instanceof globalThis.Element ? ev.target : null;
    if (el?.closest("[data-retry]")) {
      void load();
      return;
    }
    const a = el?.closest("a[data-why], .vf-back a");
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    ev.preventDefault();
    globalThis.history?.pushState(null, "", a.getAttribute("href"));
    draw();
    focusTarget();
  });
  // A check's row opens the why view at that check's clauses.
  const focusTarget = () => {
    const id = decodeURIComponent(
      String(globalThis.location?.hash ?? "").slice(1),
    );
    const at = id ? globalThis.document?.getElementById(id) : null;
    if (at && root.contains(at)) {
      at.scrollIntoView?.({ block: "start" });
      at.focus?.({ preventScroll: true });
    } else root.querySelector(".vf-head h2")?.focus?.();
  };
  globalThis.addEventListener?.("popstate", draw);
  await load();
  if (globalThis.location?.hash) focusTarget();
}
