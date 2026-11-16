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
 *
 * Issue 210:
 *   S2  Plan and Allow (?plan=<env>, or ?allow=<held id> for an agent's
 *       ask): the scope switch, what runs in order with each mark and
 *       estimate, the hosts it reaches, what can't run and why, and Allow
 *       and Decline (on local, Run). Allow is Den's held action: the page
 *       asks and allows it, or decides the agent's ask; never a second flow
 *   S3  Running and cancelled (?run=<id>): progress, each module's state
 *       (a queued one says what it waits for), Cancel with one confirm.
 *       Cancelled is never shown as a pass
 *
 * Issue 212:
 *   S5  History (?history=<module id>&env=): since when it fails, a strip
 *       of runs (each opens its run), the first failing range with its
 *       commits, and the flaky mark with every attempt
 *   S6  Findings (?findings=<run id>&module=<module id>): the answer, the
 *       threshold, counts by severity, each finding with the version that
 *       fixes it, and the SARIF report
 *
 * Issue 211:
 *   S1b All environments (?tab=board): every environment across, every
 *       layer down; a cell opens a panel of its checks with their recent
 *       results (a full sheet when narrow), focus moves in, and Close or
 *       Esc returns it to the cell
 *
 * Reads GET /api/verify/overview (verify-routes.ts). The views are pure
 * (HTML from that JSON), so tests need no server. Words come from the
 * shell's catalog ("v.*"); environment and module names stay as they are.
 */

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
  queued: { word: "v.s_queued", tone: "neutral", mark: "○" },
  running: { word: "v.s_running", tone: "info", mark: "◐" },
  cancelled: { word: "v.s_cancelled", tone: "neutral", mark: "⊘" },
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
  return `<span class="vf-badge vf-${a.tone}"><span class="vf-dot" aria-hidden="true"></span>${esc(t(word ?? a.word))}</span>`;
}

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleString(
      globalThis.document?.documentElement?.lang || undefined,
      {
        dateStyle: "medium",
        timeStyle: "short",
      },
    );
  } catch {
    return d.toISOString();
  }
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

function card(e) {
  const a = ANSWER[e.answer] ?? ANSWER.notrun;
  const env = encodeURIComponent(e.env);
  const plan = `<a class="den-btn vf-plan" href="?plan=${env}" data-nav>${esc(t("v.plan_btn"))}</a>`;
  const why =
    `<div class="vf-btns">` +
    (e.answer === "failed"
      ? `<a class="den-btn primary vf-why" href="?why=${env}" data-why="${esc(e.env)}">${esc(t("v.b_why"))}</a>`
      : "") +
    `${plan}</div>`;
  return (
    `<section class="vf-ans vf-${a.tone}" data-env="${esc(e.env)}" data-answer="${esc(e.answer)}" aria-label="${esc(envName(e.env))}">` +
    `<div class="vf-env"><b>${esc(envName(e.env))}</b>${badge(e.answer)}</div>` +
    `<p class="vf-say">${esc(answerSentence(e))}</p>` +
    (e.run ? `<p class="vf-meta">${esc(metaLine(e.run))}</p>` : "") +
    why +
    `</section>`
  );
}

function actorName(a) {
  if (a?.kind === "agent") return a.name ?? t("v.actor_agent");
  if (a?.kind === "den") return "Den";
  return t("v.who_person");
}

function avatar(a) {
  const kind =
    a?.kind === "agent" ? "agent" : a?.kind === "den" ? "den" : "person";
  const letter = actorName(a).trim().charAt(0).toUpperCase() || "?";
  return `<span class="vf-av vf-av-${kind}" aria-hidden="true">${esc(letter)}</span>`;
}

function feedItem(actor, text, at) {
  const kind =
    actor?.kind === "agent"
      ? "agent"
      : actor?.kind === "den"
        ? "den"
        : "person";
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
    if (r.startedBy)
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
    `<p class="vf-say">${esc(t("v.em_p"))}</p><pre class="vf-pre">${esc(SNIPPET)}</pre>` +
    `<p class="vf-meta">${esc(t("v.em_where"))}</p></section>`
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
  if (!ov.modules)
    return `${head}<div class="vf-cols"><div class="vf-main">${emptyView()}${oldKinds()}</div>${feedView(ov.activity)}</div>`;
  const cards = worstFirst(ov.envs).map(card).join("");
  return (
    `${head}<div class="vf-cols"><div class="vf-main">${cards}${allChecks(ov, wide)}${oldKinds()}</div>` +
    `${feedView(ov.activity)}</div>`
  );
}

/** Issue 211: the two tabs, the open one pressed (kept as ?tab=board). */
export function tabsView(tab) {
  const b = (id, key) =>
    `<button type="button" class="vf-tab" data-vf-tab="${id}" aria-pressed="${tab === id}">${esc(t(key))}</button>`;
  return `<div class="vf-tabs" role="group" aria-label="${esc(t("v.tabs"))}">${b("answer", "v.tab_answer")}${b("board", "v.tab_board")}</div>`;
}

/** A cell's word and tone, from its checks' states (worst first). */
const CELL = {
  failed: { word: "v.bd_failed", tone: "bad", mark: "✕" },
  error: { word: "v.bd_error", tone: "bad", mark: "!" },
  blocked: { word: "v.bd_blocked", tone: "warn", mark: "‖" },
  cancelled: { word: "v.bd_cancelled", tone: "neutral", mark: "⊘" },
  partly: { word: "v.bd_partly", tone: "warn", mark: "◑" },
  passed: { word: "v.bd_passed", tone: "ok", mark: "✓" },
  scanned: { word: "v.bd_scan", tone: "ok", mark: "✓" },
  none: { word: "v.bd_none", tone: "neutral", mark: "–" },
  notset: { word: "v.bd_notset", tone: "neutral", mark: "·" },
};

/** The layers, in the order their checks come (the manifest's). */
function layersOf(ov) {
  return [...new Set((ov.checks ?? []).map((c) => c.layer))];
}

/**
 * One cell: an environment's checks in one layer. `state` is its key in
 * CELL; `word` and `counts` are in the page's language. A code scan whose
 * result is not from this environment's latest run says where it was
 * scanned (S1b), never "Passed".
 */
export function cellOf(ov, env, layer) {
  const rows = (ov.checks ?? []).filter(
    (c) => c.layer === layer && (c.states?.[env] ?? "off") !== "off",
  );
  const n = (st) => rows.filter((c) => c.states[env] === st).length;
  let state;
  let counts = "";
  let commit = "";
  if (!rows.length) state = "notset";
  else if (n("failed") || n("error")) {
    state = n("failed") ? "failed" : "error";
    counts = t("v.bd_n_fail", { n: n("failed") + n("error") });
  } else if (n("blocked")) {
    state = "blocked";
    counts = t("v.bd_n_block", { n: n("blocked") });
  } else if (n("cancelled")) {
    state = "cancelled";
    counts = t("v.bd_n_cancel", { n: n("cancelled") });
  } else if (!n("passed")) state = "none";
  else {
    state = n("none") ? "partly" : "passed";
    counts = t("v.bd_n_pass", { a: n("passed"), b: rows.length });
    if (n("none")) counts += ` · ${t("v.bd_n_notyet", { n: n("none") })}`;
    const latest = (ov.envs ?? []).find((e) => e.env === env)?.run?.runId;
    const scans = rows.every((c) => c.mark === "reads-code-only");
    const old = rows.find((c) => c.from?.[env]?.runId !== latest);
    if (state === "passed" && scans && old) {
      state = "scanned";
      commit = old.from?.[env]?.commit ?? "";
      if (!commit) state = "passed";
    }
  }
  const c = CELL[state];
  return {
    state,
    tone: c.tone,
    mark: c.mark,
    word: t(c.word, { c: commit }),
    counts,
    rows,
  };
}

/** A check's recent results: marks with one name for screen readers. */
function stripOf(states) {
  if (!states?.length)
    return `<span class="vf-k">${esc(t("v.bd_nohist"))}</span>`;
  const list = states.map((s) => t((STATE[s] ?? STATE.none).word)).join(", ");
  return (
    `<span class="vf-strip" role="img" aria-label="${esc(t("v.bd_strip", { n: states.length, list }))}">` +
    states
      .map((s) => {
        const x = STATE[s] ?? STATE.none;
        return `<i class="vf-${x.tone}" aria-hidden="true">${x.mark}</i>`;
      })
      .join("") +
    `</span>`
  );
}

function panelView(ov, env, layer) {
  const cell = cellOf(ov, env, layer);
  const title = t("v.bd_panel", { l: layer, e: envName(env) });
  const rows = cell.rows
    .map((c) => {
      const st = c.states[env];
      const note =
        st === "blocked" && c.dependsOn?.length
          ? `<span class="vf-k">${esc(t("v.bd_waits", { l: c.dependsOn.join(", ") }))}</span>`
          : st === "failed" || st === "error"
            ? `<a href="?why=${encodeURIComponent(env)}" data-why>${esc(t("v.bd_why"))}</a>`
            : "";
      // Issue 212: since when (S5), and a scan's findings (S6).
      const id = c.id ?? c.module;
      const scanRun = c.kind === "security" ? c.from?.[env]?.runId : "";
      const links =
        `<span class="vf-plinks"><a href="?history=${encodeURIComponent(id)}&amp;env=${encodeURIComponent(env)}" data-nav>${esc(t("v.b_hist"))}</a>` +
        (scanRun
          ? `<a href="?findings=${encodeURIComponent(scanRun)}&amp;module=${encodeURIComponent(id)}" data-nav>${esc(t("v.b_findings"))}</a>`
          : "") +
        `</span>`;
      return (
        `<li class="vf-pr"><div class="vf-pra"><span><code>${esc(c.module)}</code> <span class="vf-k">${esc(kindWord(c.kind))}</span></span>${stateTag(st)}</div>` +
        `${note}${stripOf(c.recent?.[env])}${links}</li>`
      );
    })
    .join("");
  return (
    `<section class="vf-panel" aria-labelledby="vf-panel-h"><div class="vf-ph">` +
    `<h2 id="vf-panel-h" tabindex="-1">${esc(title)}</h2>` +
    `<button type="button" class="den-btn" data-vf-close>${esc(t("v.bd_close"))}</button></div>` +
    `<p class="vf-pmeta">${stateTagCell(cell)} <span class="vf-k">${esc(t("v.bd_n_checks", { n: cell.rows.length }))}</span></p>` +
    `<ul class="vf-plist">${rows}</ul></section>`
  );
}

function stateTagCell(cell) {
  return `<span class="vf-st vf-${cell.tone}"><span class="vf-mk" aria-hidden="true">${cell.mark}</span>${esc(cell.word)}</span>`;
}

/**
 * S1b: every environment across, every layer down. One column per
 * environment, so a narrow screen stacks them into one block each.
 * `open` is the cell whose panel shows ({ env, layer }).
 */
export function boardView(ov, { open } = {}) {
  const head =
    `<div class="vf-head"><div><h2 tabindex="-1">${esc(t("v.bd_t"))}</h2>` +
    `<p class="vf-lede">${esc(t("v.bd_s"))}</p></div></div>`;
  if (!ov.modules) return `${head}${emptyView()}`;
  const order = ov.envOrder ?? (ov.envs ?? []).map((e) => e.env);
  const layers = layersOf(ov);
  const byEnv = new Map((ov.envs ?? []).map((e) => [e.env, e]));
  const labels =
    `<div class="vf-bcol vf-blabels" aria-hidden="true"><div class="vf-beh"></div>` +
    layers.map((l) => `<div class="vf-bl">${esc(l)}</div>`).join("") +
    `</div>`;
  const cols = order
    .map((env) => {
      const e = byEnv.get(env);
      const cells = layers
        .map((l) => {
          const c = cellOf(ov, env, l);
          const body =
            `<span class="vf-cl">${esc(l)}</span>${stateTagCell(c)}` +
            (c.counts ? `<span class="vf-cn">${esc(c.counts)}</span>` : "");
          if (c.state === "notset")
            return `<div class="vf-cell vf-empty">${body}</div>`;
          const name = c.counts
            ? t("v.bd_cell", { l, e: envName(env), s: c.word, c: c.counts })
            : t("v.bd_cell_n", { l, e: envName(env), s: c.word });
          const on = open && open.env === env && open.layer === l;
          return `<button type="button" class="vf-cell vf-t-${c.tone}" data-vf-cell="${esc(env)}|${esc(l)}" aria-label="${esc(name)}" aria-expanded="${on ? "true" : "false"}">${body}</button>`;
        })
        .join("");
      return (
        `<div class="vf-bcol" data-vf-env="${esc(env)}"><div class="vf-beh"><b>${esc(envName(env))}</b>` +
        `${e ? badge(e.answer) : ""}<a class="vf-plan" href="?plan=${encodeURIComponent(env)}" data-nav>${esc(t("v.plan_btn"))}</a></div>` +
        `${cells}</div>`
      );
    })
    .join("");
  const panel =
    open && layers.includes(open.layer) && order.includes(open.env)
      ? panelView(ov, open.env, open.layer)
      : "";
  return `${head}<div class="vf-stage${panel ? " vf-open" : ""}"><div class="vf-board" style="--rows:${layers.length}">${labels}${cols}</div>${panel}</div>`;
}

/** Issue 212: a run in a history strip: its symbol (↻ passed after a retry). */
function runMark(r) {
  if (r.state === "passed" && r.flaky) return { mark: "↻", tone: "warn" };
  const s = STATE[r.state] ?? STATE.none;
  return { mark: s.mark, tone: s.tone };
}

/** The answer of S5: since when it fails, or how long it has passed. */
function historySay(h) {
  const m = h.name ?? h.module;
  const s = h.streak;
  if (!s) return "";
  if (s.state === "passed") return t("v.h_pass", { m, n: s.runs });
  if (!s.passedBefore) return t("v.h_failall", { m });
  const b = h.range?.firstFailed?.commit ?? t("v.h_nocommit");
  let say = t("v.h_fail", { m, n: s.passedBefore, b });
  if (h.commits?.length && h.range?.lastPassed?.commit)
    say += ` ${t("v.h_fail_k", { k: h.commits.length, a: h.range.lastPassed.commit })}`;
  return say;
}

/**
 * S5: one check's history on one environment. Each run in the strip is a
 * button (data-vf-run) that opens it; the flaky card lists every attempt.
 */
export function historyView(h) {
  const m = h.name ?? h.module;
  const env = envName(h.env);
  const back = `<p class="vf-back"><a href="?tab=board">${esc(t("v.bd_back"))}</a></p>`;
  const head = `<div class="vf-head"><div><h2 tabindex="-1">${esc(t("v.h_t", { m, e: env }))}</h2></div></div>`;
  const runs = h.runs ?? [];
  if (!runs.length)
    return `${back}${head}<section class="vf-card"><p class="vf-say">${esc(t("v.h_none"))}</p></section>`;
  const label = t("v.h_strip", { n: runs.length, e: env });
  const strip =
    `<div class="vf-hstrip" role="group" aria-label="${esc(label)}">` +
    runs
      .map((r) => {
        const k = runMark(r);
        const word =
          r.state === "passed" && r.flaky
            ? t("v.s_flaky")
            : t((STATE[r.state] ?? STATE.none).word);
        const name = t("v.h_run", {
          s: word,
          c: r.commit ?? t("v.h_nocommit"),
          t: when(r.endedAt),
        });
        return `<button type="button" class="vf-hrun vf-${k.tone}" data-vf-run="${esc(r.runId)}" aria-label="${esc(name)}"><span aria-hidden="true">${k.mark}</span></button>`;
      })
      .join("") +
    `</div>`;
  const range = h.range
    ? `<dl class="vf-dl"><dt>${esc(t("v.h_range"))}</dt><dd>` +
      (h.range.lastPassed?.commit
        ? `<code>${esc(h.range.lastPassed.commit)}</code> … `
        : "") +
      `<code>${esc(h.range.firstFailed.commit ?? t("v.h_nocommit"))}</code></dd></dl>` +
      (h.commits?.length
        ? `<ul class="vf-commits">${h.commits.map((c) => `<li><code>${esc(c.commit)}</code> ${esc(c.subject)}</li>`).join("")}</ul>`
        : "") +
      `<div class="vf-btns"><a class="den-btn primary" href="?run=${encodeURIComponent(h.range.firstFailed.runId)}" data-nav>${esc(t("v.h_open"))}</a></div>`
    : "";
  const tries = runs
    .filter((r) => r.flaky && r.attempts?.length)
    .map(
      (r) =>
        `<li>${esc(t("v.fl_run", { c: r.commit ?? t("v.h_nocommit") }))}<ol>` +
        r.attempts
          .map(
            (a, i) =>
              `<li>${esc(t("v.fl_try", { i: i + 1, s: t((STATE[a.state] ?? STATE.none).word) }))}${a.message ? `: <span class="vf-k">${esc(a.message)}</span>` : ""}</li>`,
          )
          .join("") +
        `</ol></li>`,
    )
    .join("");
  const flaky = h.flaky?.mark
    ? `<section class="vf-card vf-flaky"><h3><code>${esc(m)}</code> <span class="vf-st vf-warn"><span class="vf-mk" aria-hidden="true">↻</span>${esc(t("v.s_flaky"))}</span></h3>` +
      `<p class="vf-say">${esc(t("v.fl_a", { n: h.flaky.count, w: h.flaky.window }))}</p>` +
      (tries
        ? `<details class="vf-tries"><summary>${esc(t("v.fl_btn"))}</summary><ul>${tries}</ul></details>`
        : "") +
      `</section>`
    : "";
  return (
    back +
    head +
    `<section class="vf-card"><p class="vf-say">${esc(historySay(h))}</p>${strip}` +
    `<p class="vf-meta">${esc(label)}</p><p class="vf-meta">${esc(t("v.h_lg"))}</p>${range}</section>` +
    flaky
  );
}

const SEVS = ["critical", "high", "medium", "low"];

/** S6: a scan's findings in one run, with the threshold that decides. */
export function findingsView(rec, moduleId) {
  const mod = (rec.modules ?? []).find(
    (x) => x.id === moduleId || x.name === moduleId,
  );
  const name = mod?.name ?? moduleId;
  const back = `<p class="vf-back"><a href="?tab=board">${esc(t("v.bd_back"))}</a></p>`;
  const head = `<div class="vf-head"><div><h2 tabindex="-1">${esc(t("v.sc_t", { m: name }))}</h2></div>${mod?.findings ? badge(mod.state === "passed" ? "ready" : "failed", mod.state === "passed" ? "v.s_passed" : "v.s_failed") : ""}</div>`;
  const f = mod?.findings;
  if (!f)
    return `${back}${head}<section class="vf-card"><p class="vf-say">${esc(t("v.sc_none", { m: name }))}</p></section>`;
  const th = f.failOn ?? "high";
  const thWord = t(`v.sev_${th}`);
  const failing = SEVS.slice(0, SEVS.indexOf(th) + 1).reduce(
    (n, s) => n + (f.counts?.[s] ?? 0),
    0,
  );
  const say = failing
    ? t("v.sc_bad", { n: failing, th: thWord })
    : t("v.sc_ok", { th: thWord });
  const counts =
    `<section class="vf-card"><h3>${esc(t("v.sc_counts"))}</h3><ul class="vf-sevs">` +
    SEVS.map(
      (s) =>
        `<li class="vf-sev"><span>${esc(t(`v.sev_${s}`))}</span><b>${f.counts?.[s] ?? 0}</b></li>` +
        (s === th
          ? `<li class="vf-thr">${esc(t("v.sc_th", { th: thWord }))}</li>`
          : ""),
    ).join("") +
    `</ul></section>`;
  const groups = SEVS.map((s) => {
    const list = (f.list ?? []).filter((x) => x.severity === s);
    if (!list.length) return "";
    const belowTh = SEVS.indexOf(s) > SEVS.indexOf(th);
    return (
      `<section class="vf-card"><h3>${esc(t("v.sc_group", { n: f.counts?.[s] ?? list.length, sev: t(`v.sev_${s}`) }))}</h3>` +
      (belowTh ? `<p class="vf-meta">${esc(t("v.sc_below"))}</p>` : "") +
      `<ul class="vf-finds">` +
      list
        .map((x) =>
          x.package
            ? `<li><code>${esc(x.version ? `${x.package} ${x.version}` : x.package)}</code>` +
              (x.fixedIn
                ? ` · ${esc(t("v.sc_fix", { v: "{v}" })).replace("{v}", `<code>${esc(x.fixedIn)}</code>`)}`
                : "") +
              `</li>`
            : `<li>${esc(x.message)}</li>`,
        )
        .join("") +
      `</ul></section>`
    );
  }).join("");
  const rep = `/api/verify/runs/${encodeURIComponent(rec.runId)}/report?project=${encodeURIComponent(rec.project)}&module=${encodeURIComponent(mod.id ?? moduleId)}&kind=sarif`;
  return (
    back +
    head +
    `<section class="vf-card"><p class="vf-say">${esc(say)}</p>` +
    (rec.commit
      ? `<p class="vf-meta">${esc(t("v.sc_commit", { c: rec.commit }))}</p>`
      : "") +
    `</section>` +
    counts +
    groups +
    `<p><a class="den-btn vf-report" href="${esc(rep)}" target="_blank" rel="noopener">${esc(t("v.sc_rep"))}</a></p>`
  );
}

function reportHref(project, f) {
  return `/api/verify/runs/${encodeURIComponent(f.runId)}/report?project=${encodeURIComponent(project)}&module=${encodeURIComponent(f.module)}`;
}

/** S4: why an environment is not ready, down to each failure's report. */
export function whyView(ov, env) {
  const e = (ov.envs ?? []).find((x) => x.env === env);
  const back = `<p class="vf-back"><a href="?">${esc(t("v.back"))}</a></p>`;
  if (!e) return back;
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
    `<p class="vf-say">${esc(answerSentence(e))}</p>` +
    (e.run ? `<p class="vf-meta">${esc(metaLine(e.run))}</p>` : "") +
    `<section class="vf-card vf-why-card" role="alert"><h2>${esc(t("v.why_t"))}</h2><ol class="vf-why">${fails}${waits}${rest}</ol></section>`
  );
}

const MARK_WORD = {
  enforced: "v.mk_enforced",
  "declared-read-only": "v.mk_declared",
  "reads-code-only": "v.mk_code",
  "declared-by-service": "v.mk_service",
};

function lang() {
  return globalThis.document?.documentElement?.lang || undefined;
}

/** A duration in the page's language: "45 s", "3 min", "1 h 5 min". */
export function duration(ms) {
  const fmt = (n, unit) => {
    try {
      return new Intl.NumberFormat(lang(), {
        style: "unit",
        unit,
        unitDisplay: "short",
      }).format(n);
    } catch {
      return `${n} ${unit}`;
    }
  };
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  if (s < 60) return fmt(s, "second");
  const m = Math.round(s / 60);
  if (m < 60) return fmt(m, "minute");
  return `${fmt(Math.floor(m / 60), "hour")} ${fmt(m % 60, "minute")}`;
}

function hostsOf(plan) {
  const out = new Set();
  for (const m of plan.modules ?? [])
    for (const u of m.healthUrls?.[plan.env] ?? []) {
      try {
        out.add(new URL(u).host);
      } catch {
        /* not a URL: left out */
      }
    }
  return [...out];
}

function cantLine(c, env) {
  switch (c.reason) {
    case "environment":
      return t("v.cant_environment", {
        m: c.name,
        l:
          c.environments === "all"
            ? ""
            : c.environments.map((x) => envName(x)).join(", "),
      });
    case "production":
      return t("v.cant_production", { m: c.name });
    case "adapter-later":
      return t("v.cant_adapter", { m: c.name, x: c.adapter });
    default:
      return t("v.cant_nohealth", { m: c.name, e: envName(env) });
  }
}

const SCOPES = [
  ["changed", "v.sc_changed", "v.sc_changed_h"],
  ["all", "v.sc_all", "v.sc_all_h"],
];

/**
 * S2: the plan, and Allow or Decline (Run on local). `v`:
 *   plan       POST /api/verify/plan's answer (with `estimates`)
 *   asker      the agent that asked (an agent's ask), or none (the person's)
 *   state      ready | waiting | busy | declined | expired | decided | going
 *   error      a line for a refusal
 *   going      the run already going on this environment (its id)
 *   fixed      true for an agent's ask: the plan is what it asked, no switch
 */
export function planView(v) {
  const p = v.plan;
  const env = envName(p.env);
  const n = p.modules.length;
  const local = !p.shared;
  const back = `<p class="vf-back"><a href="?" data-nav>${esc(t("v.back"))}</a></p>`;
  const title = v.asker
    ? t("v.pr_t", { a: v.asker, n, e: env })
    : t("v.pr_t_me", { n, e: env });
  const scope = v.fixed
    ? ""
    : `<div class="vf-seg" role="group" aria-label="${esc(t("v.sc_label"))}">` +
      SCOPES.map(
        ([k, w]) =>
          `<button type="button" class="den-btn vf-segb" data-vf-scope="${k}" aria-pressed="${p.scope === k && !p.chosen}">${esc(t(w))}</button>`,
      ).join("") +
      `</div><p class="vf-muted vf-sch">${esc(t(SCOPES.find((x) => x[0] === p.scope)?.[2] ?? "v.sc_changed_h"))}</p>`;
  if (p.nothingToRun)
    return (
      back +
      `<div class="vf-head"><div><h2 tabindex="-1">${esc(t("v.pr_none_t", { e: env }))}</h2></div></div>` +
      scope +
      `<section class="vf-card vf-plan-card"><p class="vf-say">${esc(
        t(
          p.reason === "unchanged"
            ? "v.pr_unchanged"
            : p.reason === "none-declared"
              ? "v.pr_nonedeclared"
              : "v.pr_nonehere",
          { e: env },
        ),
      )}</p></section>`
    );
  const est = v.plan.estimates ?? {};
  const known = p.modules.filter((m) => est[m.id] > 0);
  const total = known.reduce((a, m) => a + est[m.id], 0);
  const row = (m, i) =>
    `<li class="vf-prow"><span class="vf-pn">${i + 1}</span><div class="vf-pm"><code>${esc(m.name)}</code>` +
    `<span class="vf-muted"> ${esc(kindWord(m.kind))}</span></div>` +
    `<span class="vf-mark vf-mark-${esc(m.mark)}">${esc(t(MARK_WORD[m.mark] ?? "v.mk_declared"))}</span>` +
    (est[m.id] > 0
      ? `<span class="vf-est">${esc(t("v.est_mod", { d: duration(est[m.id]) }))}</span>`
      : "") +
    `</li>`;
  // The order in groups, as it runs: smoke, a layer, the code scans.
  const groups = [];
  p.modules.forEach((m, i) => {
    const key =
      m.mark === "reads-code-only"
        ? "code"
        : m.kind === "smoke"
          ? "smoke"
          : `l:${m.layer}`;
    const last = groups.at(-1);
    if (last?.key === key) last.rows.push(row(m, i));
    else groups.push({ key, layer: m.layer, rows: [row(m, i)] });
  });
  const groupHead = (g) => {
    if (g.key === "code") return t("v.g_code", { e: env });
    if (g.key === "smoke") return t("v.g_smoke");
    const deps = p.layers?.[g.layer] ?? [];
    return deps.length
      ? t("v.g_after", { l: g.layer, d: deps.join(", ") })
      : t("v.g_layer", { l: g.layer });
  };
  const rows = groups
    .map(
      (g) =>
        `<li class="vf-pg"><p class="vf-pgh">${esc(groupHead(g))}</p><ol class="vf-plist">${g.rows.join("")}</ol></li>`,
    )
    .join("");
  const hosts = hostsOf(p);
  const writers = p.modules.filter((m) => m.writes).map((m) => m.name);
  const touch =
    `<section class="vf-card vf-guard"><h3>${esc(t("v.touch_t"))}</h3><dl class="vf-dl">` +
    `<dt>${esc(t("v.hosts"))}</dt><dd>${
      hosts.length
        ? hosts.map((h) => `<code>${esc(h)}</code>`).join(" ")
        : esc(t("v.hosts_none"))
    }</dd>` +
    `<dt>${esc(t("v.rate"))}</dt><dd>${esc(t("v.rate_none"))}</dd>` +
    `<dt>${esc(t("v.writes"))}</dt><dd>${esc(
      writers.length
        ? t("v.writes_some", { m: writers.join(", ") })
        : t("v.writes_none"),
    )}</dd></dl></section>`;
  const cant = p.cantRun?.length
    ? `<section class="vf-card vf-cant" role="note"><h3>${esc(t("v.cant_t", { n: p.cantRun.length }))}</h3><ul>` +
      p.cantRun.map((c) => `<li>${esc(cantLine(c, p.env))}</li>`).join("") +
      `</ul></section>`
    : "";
  const status =
    {
      waiting: `<p class="vf-status" role="status">${esc(t("v.pr_wait"))}</p>`,
      busy: `<p class="vf-status" role="status">${esc(t("v.pr_busy"))}</p>`,
      declined: `<p class="vf-status" role="status">${esc(t("v.pr_declined"))}</p>`,
      expired: `<p class="vf-err" role="alert">${esc(t("v.pr_expired"))}</p>`,
      decided: `<p class="vf-status" role="status">${esc(t("v.pr_decided"))}</p>`,
      going: `<p class="vf-status" role="status">${esc(t("v.pr_going", { e: env }))} <a href="?run=${encodeURIComponent(v.going ?? "")}" data-nav>${esc(t("v.b_see_run"))}</a></p>`,
    }[v.state] ?? "";
  const err = v.error
    ? `<p class="vf-err" role="alert">${esc(v.error)}</p>`
    : "";
  const open = v.state === "ready" || v.state === "waiting";
  const busy = v.state === "busy";
  const btns =
    open || busy
      ? `<div class="vf-btns vf-decide">` +
        (local
          ? `<button type="button" class="den-btn primary" data-act="run"${busy ? " disabled" : ""}>${esc(t("v.run"))}</button>`
          : `<button type="button" class="den-btn primary" data-act="allow"${busy ? " disabled" : ""}>${esc(t("v.allow"))}</button>` +
            `<button type="button" class="den-btn" data-act="decline"${busy ? " disabled" : ""}>${esc(t("v.decline"))}</button>`) +
        `</div>` +
        (local
          ? ""
          : `<p class="vf-muted">${esc(v.asker ? t("v.allow_note", { a: v.asker }) : t("v.allow_note_me"))}</p>`)
      : "";
  // The mock (frame 2a): the waiting tag first, then who asks and what.
  const top = v.state === "waiting" ? status : "";
  return (
    back +
    top +
    `<div class="vf-head">${v.asker ? avatar({ kind: "agent", name: v.asker }) : ""}<div><h2 tabindex="-1">${esc(title)}</h2><p class="vf-lede">${esc(t("v.pr_s"))}</p></div></div>` +
    scope +
    touch +
    `<section class="vf-card vf-plan-card" aria-label="${esc(t("v.pr_order"))}"><h3>${esc(t("v.pr_order"))}</h3><ol class="vf-pgs">${rows}</ol>` +
    `<p class="vf-muted">${esc(t("v.mk_help"))}</p>` +
    (known.length
      ? `<p class="vf-muted">${esc(t("v.est_total", { d: duration(total) }))}</p>`
      : "") +
    `</section>${cant}${top ? "" : status}${err}${btns}`
  );
}

/** Planning: a skeleton (S2's first state). */
export function planningView() {
  return (
    `<div class="vf-head"><div><h2 tabindex="-1">${esc(t("v.plan_btn"))}</h2><p class="vf-lede">${esc(t("v.pr_planning"))}</p></div></div>` +
    `<div class="vf-skel" aria-hidden="true"></div><div class="vf-skel" aria-hidden="true"></div>`
  );
}

/** The plan couldn't be made: why, and the way back. */
export function planFailedView(reason) {
  return (
    `<p class="vf-back"><a href="?" data-nav>${esc(t("v.back"))}</a></p>` +
    `<div class="vf-head"><div><h2 tabindex="-1">${esc(t("v.plan_btn"))}</h2></div></div>` +
    `<div class="vf-err" role="alert">${esc(t("v.pr_fail", { x: reason }))}</div>`
  );
}

function whoWord(a) {
  if (a?.kind === "agent") return a.name ?? t("v.actor_agent");
  if (a?.kind === "den") return "Den";
  return t("v.who_person");
}

function clock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleTimeString(lang(), { timeStyle: "short" });
  } catch {
    return d.toISOString();
  }
}

/**
 * S3: a run going on, or how it ended. `v`: confirming (Cancel asked once),
 * reconnecting (a read failed: refetching), now (ms, for the time so far).
 */
export function runView(rec, v = {}) {
  const env = envName(rec.env);
  const mods = rec.modules ?? [];
  const n = mods.length;
  const ended = rec.verdict !== "running";
  const lost = !ended && rec.live === false;
  const done = mods.filter(
    (m) => m.state !== "queued" && m.state !== "running",
  ).length;
  const failed = mods.filter((m) =>
    ["failed", "error", "blocked"].includes(m.state),
  ).length;
  const since = Math.max(
    0,
    (v.now ?? Date.now()) - new Date(rec.startedAt).getTime(),
  );
  const back = `<p class="vf-back"><a href="?" data-nav>${esc(t("v.back"))}</a></p>`;
  const title = ended
    ? rec.verdict === "cancelled"
      ? t("v.v_cancelled")
      : t("v.rn_done_t", { e: env })
    : t("v.rn_t", { e: env });
  const verdictTag = ended
    ? badge(
        rec.verdict === "passed"
          ? "ready"
          : rec.verdict === "failed"
            ? "failed"
            : "nothing",
        VERDICT_WORD[rec.verdict] ?? "v.s_failed",
      )
    : "";
  let line;
  if (lost) line = `<p class="vf-err" role="alert">${esc(t("v.rn_lost"))}</p>`;
  else if (!ended)
    line =
      `<p class="vf-status" role="status">${esc(
        [
          t("v.rn_p", { d: done, n }),
          failed ? t("v.rn_bad", { n: failed }) : t("v.rn_ok"),
          t("v.rn_time", { s: duration(since) }),
        ].join(" "),
      )}</p>` +
      `<progress class="vf-prog" max="${n}" value="${done}" aria-label="${esc(t("v.rn_pb", { d: done, n }))}"></progress>`;
  else if (rec.verdict === "cancelled") {
    const stopped = mods.filter((m) => m.state === "cancelled").length;
    line = `<p class="vf-status" role="status">${esc(
      [
        rec.cancelledBy
          ? t("v.cn_by", {
              w: whoWord(rec.cancelledBy),
              t: clock(rec.cancelledAt),
            })
          : "",
        t("v.cn_counts", { d: n - stopped, s: stopped }),
        t("v.cn_not"),
      ]
        .filter(Boolean)
        .join(" "),
    )}</p>`;
  } else
    line = `<p class="vf-status" role="status">${esc(t("v.rn_end", { v: t(VERDICT_WORD[rec.verdict] ?? "v.s_failed") }))}</p>`;
  const rows = mods
    .map((m) => {
      const note =
        m.state === "queued"
          ? m.waitsFor
            ? t("v.q_api", { l: m.waitsFor })
            : t("v.s_queued")
          : m.state === "running"
            ? t("v.q_runs")
            : m.state === "cancelled" && !m.ms
              ? t("v.cn_stopped")
              : m.state === "passed"
                ? t("v.q_done")
                : m.message || "";
      return (
        `<li class="vf-rrow" data-state="${esc(m.state)}"><code>${esc(m.name)}</code>${stateTag(m.state)}` +
        (note && note !== t(STATE[m.state]?.word ?? "")
          ? `<span class="vf-muted vf-rnote">${esc(note)}</span>`
          : "") +
        `</li>`
      );
    })
    .join("");
  const reconnect = v.reconnecting
    ? `<p class="vf-status" role="status">${esc(t("v.reconnect"))}</p>`
    : "";
  const going = !ended && !lost;
  // The mock (frame 3a): Cancel run in the header; it asks once below.
  const cancelBtn =
    going && !v.confirming
      ? `<button type="button" class="den-btn vf-cancel" data-act="cancel">${esc(t("v.cancel"))}</button>`
      : "";
  const confirm =
    going && v.confirming
      ? `<div class="vf-confirm" role="group" aria-label="${esc(t("v.cancel"))}"><p>${esc(t("v.cancel_q"))}</p><div class="vf-btns">` +
        `<button type="button" class="den-btn danger" data-act="cancel-yes">${esc(t("v.cancel_yes"))}</button>` +
        `<button type="button" class="den-btn" data-act="cancel-no">${esc(t("v.cancel_no"))}</button></div></div>`
      : "";
  return (
    back +
    `<div class="vf-head"><div><h2 tabindex="-1">${esc(title)}</h2></div>${verdictTag}${cancelBtn}</div>` +
    confirm +
    `<section class="vf-card vf-run-status">${line}${reconnect}` +
    `<p class="vf-meta">${esc(metaLine(ended ? rec : { ...rec, endedAt: undefined }))}</p></section>` +
    `<section class="vf-card vf-run-card"><ol class="vf-rlist">${rows}</ol></section>`
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

/** Mounts the page in `root`: the answer, why, a plan, or a run, by the URL. */
export async function mountVerify(
  root,
  { fetchImpl = globalThis.fetch, pollMs = 1500 } = {},
) {
  const narrow = () =>
    globalThis.matchMedia?.("(max-width: 700px)")?.matches ?? false;
  const params = () => new URLSearchParams(globalThis.location?.search ?? "");
  const project = () => params().get("project");
  const withProject = (url) => {
    const p = project();
    return p
      ? `${url}${url.includes("?") ? "&" : "?"}project=${encodeURIComponent(p)}`
      : url;
  };
  const json = async (url, init) => {
    const res = await fetchImpl(withProject(url), {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    return { res, body };
  };
  let ov = null;
  /** S2's state: { plan, asker, heldId, state, error, going, fixed, ask }. */
  let pv = null;
  /** S3's state. */
  let rv = { rec: null, confirming: false, reconnecting: false, timer: 0 };
  let view = "";
  const busy = (on) => root.setAttribute("aria-busy", on ? "true" : "false");
  const focusHead = () => root.querySelector(".vf-head h2")?.focus?.();
  const stopPoll = () => {
    if (rv.timer) globalThis.clearTimeout(rv.timer);
    rv.timer = 0;
  };

  /** Issue 211: the board's open cell ({ env, layer }), or null. */
  let open = null;
  const tab = () => (params().get("tab") === "board" ? "board" : "answer");
  const drawAnswer = () => {
    if (!ov) return;
    const why = params().get("why");
    if (why) open = null;
    root.innerHTML = why
      ? whyView(ov, why)
      : tabsView(tab()) +
        (tab() === "board"
          ? boardView(ov, { open })
          : answerView(ov, { wide: !narrow() }));
    busy(false);
  };
  const cellButton = (c) =>
    c
      ? [...root.querySelectorAll("[data-vf-cell]")].find(
          (b) => b.getAttribute("data-vf-cell") === `${c.env}|${c.layer}`,
        )
      : null;
  /** Closes the board's panel, and focus goes back to its cell. */
  const closePanel = () => {
    const was = open;
    open = null;
    drawAnswer();
    cellButton(was)?.focus?.();
  };
  const loadAnswer = async () => {
    busy(true);
    root.innerHTML = loadingView();
    try {
      const { res, body } = await json("/api/verify/overview");
      if (!res.ok || !body.ok) throw new Error(body.error ?? res.status);
      ov = body;
      drawAnswer();
    } catch {
      root.innerHTML = errorView();
      busy(false);
    }
  };

  const drawPlan = () => {
    root.innerHTML = planView(pv);
    busy(false);
  };
  const plan = async (ask) => {
    busy(true);
    root.innerHTML = planningView();
    // A POST that runs nothing, on the working pop-up all the same: a
    // slow plan says it is working (BUSY-1).
    let body = null;
    let why = "";
    try {
      body = await write("verify-plan", "/api/verify/plan", ask);
    } catch (err) {
      why = err?.message ?? "";
    }
    if (!body?.ok) {
      root.innerHTML = planFailedView(why || t("v.err_load"));
      busy(false);
      return null;
    }
    return body;
  };
  const loadPlan = async () => {
    const q = params();
    const heldId = q.get("allow");
    if (heldId) {
      // An agent's ask: the plan it asked for, read as the person.
      globalThis.window?.denShell?.approvalHere?.(heldId);
      busy(true);
      root.innerHTML = planningView();
      const a = await globalThis.window?.denShell?.approval?.(heldId);
      if (!a?.ok || a.action !== "verify_run") {
        root.innerHTML = planFailedView(a?.error ?? t("v.pr_gone"));
        busy(false);
        return;
      }
      const ask = {
        ...(a.params?.project ? { project: a.params.project } : {}),
        env: a.params?.env,
        modules: String(a.params?.list ?? "")
          .split(", ")
          .filter(Boolean),
      };
      const p = await plan(ask);
      if (!p) return;
      pv = {
        plan: p,
        asker: a.agent,
        heldId,
        fixed: true,
        ask,
        state:
          a.state === "pending"
            ? "waiting"
            : a.state === "expired"
              ? "expired"
              : a.state === "denied"
                ? "declined"
                : "decided",
      };
      if (a.state === "done" && a.result?.runId) return go(a.result.runId);
      drawPlan();
      return;
    }
    const ask = {
      env: q.get("plan"),
      ...(q.get("scope") ? { scope: q.get("scope") } : {}),
    };
    const p = await plan(ask);
    if (!p) return;
    pv = { plan: p, ask, state: "ready", fixed: false };
    drawPlan();
  };

  const go = (runId) => {
    globalThis.history?.pushState(
      null,
      "",
      `?run=${encodeURIComponent(runId)}${project() ? `&project=${encodeURIComponent(project())}` : ""}`,
    );
    return route();
  };

  /**
   * A write, on the working pop-up (BUSY-1): the answer's JSON, or null
   * when the pop-up said it failed. A quick refusal comes back as a throw
   * (its `code` and `data`), for the page to say inline.
   */
  const write = (name, url, body, button) => {
    const sh = globalThis.window?.denShell;
    return sh.busyAction(
      name,
      (headers) => sh.api("POST", withProject(url), body ?? {}, { headers }),
      { button, quietFail: true, inlineError: true, toastFast: false },
    );
  };

  /** Allow, Decline or Run, from S2. */
  const decide = async (act, button) => {
    if (!pv) return;
    const p = pv.plan;
    const was = pv.state;
    pv.error = "";
    const back = () => {
      pv.state = was;
      drawPlan();
    };
    const fail = (err) => {
      const code = err?.code ?? err?.data?.code;
      if (code === "run_going") {
        pv.state = "going";
        pv.going = err?.data?.runId;
      } else if (code === "expired") pv.state = "expired";
      else if (code === "already_decided") pv.state = "decided";
      else {
        pv.state = was;
        pv.error = err?.message ?? t("v.err_load");
      }
      drawPlan();
    };
    try {
      if (act === "run") {
        const r = await write(
          "verify-run",
          "/api/verify/run",
          { ...pv.ask, background: true },
          button,
        );
        return r ? go(r.runId) : back();
      }
      let id = pv.heldId;
      if (!id) {
        // The person's own run on a shared environment: Den's held action,
        // asked and allowed here (never a second approval flow).
        const asked = await write(
          "verify-ask",
          "/api/approvals",
          {
            action: "verify_run",
            args: {
              project: p.project,
              env: p.env,
              scope: p.scope,
              modules: p.modules.map((m) => m.id),
            },
          },
          button,
        );
        if (!asked?.id) return back();
        id = asked.id;
        pv.heldId = id;
        globalThis.window?.denShell?.approvalHere?.(id);
      }
      const r = await write(
        act === "allow" ? "verify-allow" : "verify-decline",
        `/api/approvals/${encodeURIComponent(id)}/decide`,
        { decision: act === "allow" ? "allow" : "deny" },
        button,
      );
      if (!r) return back();
      if (act !== "allow") {
        pv.state = "declined";
        return drawPlan();
      }
      const res = r.approval?.result;
      if (res?.ok && res.runId) return go(res.runId);
      return fail({ code: res?.code, data: res, message: res?.error });
    } catch (err) {
      return fail(err);
    }
  };

  const drawRun = () => {
    if (!rv.rec) return;
    root.innerHTML = runView(rv.rec, {
      confirming: rv.confirming,
      reconnecting: rv.reconnecting,
    });
    busy(false);
  };
  const readRun = async (runId) => {
    stopPoll();
    try {
      const { res, body } = await json(
        `/api/verify/runs/${encodeURIComponent(runId)}`,
      );
      if (!res.ok || !body.ok) {
        if (res.status === 404 && !rv.rec) {
          root.innerHTML = planFailedView(body.error ?? "");
          busy(false);
          return;
        }
        throw new Error(body.error ?? String(res.status));
      }
      rv.rec = body;
      rv.reconnecting = false;
    } catch {
      // Lost the server: say so, then read the run again (never guess).
      rv.reconnecting = true;
    }
    if (view !== `run:${runId}`) return;
    // The confirm stays put while it is open: the list redraws under it.
    if (!rv.confirming) drawRun();
    else {
      const card = root.querySelector(".vf-run-card");
      const tpl = root.ownerDocument.createElement("template");
      if (rv.rec) tpl.innerHTML = runView(rv.rec);
      const fresh = tpl.content.querySelector(".vf-run-card");
      if (card && fresh) card.replaceWith(fresh);
    }
    if (
      rv.reconnecting ||
      (rv.rec?.verdict === "running" && rv.rec.live !== false)
    )
      rv.timer = globalThis.setTimeout(() => void readRun(runId), pollMs);
  };

  const route = async () => {
    stopPoll();
    const q = params();
    if (q.get("run")) {
      const id = q.get("run");
      view = `run:${id}`;
      rv = { rec: null, confirming: false, reconnecting: false, timer: 0 };
      busy(true);
      root.innerHTML = planningView();
      await readRun(id);
    } else if (q.get("plan") || q.get("allow")) {
      view = "plan";
      await loadPlan();
    } else if (q.get("history") || q.get("findings")) {
      // Issue 212: S5 and S6, each read when it opens.
      view = "detail";
      busy(true);
      root.innerHTML = loadingView();
      const hist = q.get("history");
      const url = hist
        ? `/api/verify/modules/${encodeURIComponent(hist)}/history?env=${encodeURIComponent(q.get("env") ?? "local")}`
        : `/api/verify/runs/${encodeURIComponent(q.get("findings"))}`;
      try {
        const { res, body } = await json(url);
        if (!res.ok || !body.ok) throw new Error(body.error ?? res.status);
        root.innerHTML = hist
          ? historyView(body)
          : findingsView(body, q.get("module") ?? "");
      } catch {
        root.innerHTML = errorView();
      }
      busy(false);
    } else {
      const was = view;
      view = "answer";
      if (ov && was === "answer") drawAnswer();
      else await loadAnswer();
    }
    focusHead();
  };

  root.addEventListener("click", (ev) => {
    const el = ev.target instanceof globalThis.Element ? ev.target : null;
    if (!el) return;
    if (el.closest("[data-retry]")) {
      void loadAnswer();
      return;
    }
    // Issue 211: the tabs, kept in the URL so a reload keeps the board.
    const tb = el.closest("[data-vf-tab]")?.getAttribute("data-vf-tab");
    if (tb) {
      if (tb !== tab()) {
        const q = params();
        if (tb === "board") q.set("tab", "board");
        else q.delete("tab");
        const qs = q.toString();
        globalThis.history?.pushState(null, "", qs ? `?${qs}` : "?");
        open = null;
        drawAnswer();
      }
      root.querySelector(`[data-vf-tab="${tb}"]`)?.focus?.();
      return;
    }
    // Issue 212: a run in a history strip opens that run.
    const hr = el.closest("[data-vf-run]")?.getAttribute("data-vf-run");
    if (hr) {
      const keep = project();
      globalThis.history?.pushState(
        null,
        "",
        `?run=${encodeURIComponent(hr)}${keep ? `&project=${encodeURIComponent(keep)}` : ""}`,
      );
      void route();
      return;
    }
    const cell = el.closest("[data-vf-cell]")?.getAttribute("data-vf-cell");
    if (cell) {
      const [env, layer] = cell.split("|");
      if (open && open.env === env && open.layer === layer) closePanel();
      else {
        open = { env, layer };
        drawAnswer();
        root.querySelector("#vf-panel-h")?.focus?.();
      }
      return;
    }
    if (el.closest("[data-vf-close]")) {
      closePanel();
      return;
    }
    const act = el.closest("[data-act]")?.getAttribute("data-act");
    if (act === "allow" || act === "decline" || act === "run") {
      void decide(act, el.closest("[data-act]"));
      return;
    }
    if (act === "cancel" || act === "cancel-no") {
      rv.confirming = act === "cancel";
      drawRun();
      root
        .querySelector(
          rv.confirming ? "[data-act=cancel-no]" : "[data-act=cancel]",
        )
        ?.focus?.();
      return;
    }
    if (act === "cancel-yes" && rv.rec) {
      const id = rv.rec.runId;
      const button = el.closest("[data-act]");
      void write(
        "verify-cancel",
        `/api/verify/runs/${encodeURIComponent(id)}/cancel`,
        {},
        button,
      )
        .catch(() => null)
        .then(() => {
          rv.confirming = false;
          return readRun(id);
        });
      return;
    }
    const scope = el.closest("[data-vf-scope]")?.getAttribute("data-vf-scope");
    if (scope && pv && !pv.fixed) {
      const q = params();
      q.set("scope", scope);
      globalThis.history?.replaceState(null, "", `?${q}`);
      void loadPlan();
      return;
    }
    const a = el.closest("a[data-why], a[data-nav], .vf-back a");
    if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    ev.preventDefault();
    const href = a.getAttribute("href");
    const keep = project();
    globalThis.history?.pushState(
      null,
      "",
      keep && !href.includes("project=")
        ? `${href}${href === "?" ? "" : "&"}project=${encodeURIComponent(keep)}`
        : href,
    );
    if (a.matches("a[data-why]")) {
      drawAnswer();
      focusHead();
    } else void route();
  });
  root.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && open && root.querySelector(".vf-panel")) {
      ev.preventDefault();
      closePanel();
    }
  });
  globalThis.addEventListener?.("popstate", () => {
    open = null;
    void route();
  });
  await route();
}
