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
  const why =
    e.answer === "failed"
      ? `<div class="vf-btns"><a class="den-btn primary vf-why" href="?why=${encodeURIComponent(e.env)}" data-why="${esc(e.env)}">${esc(t("v.b_why"))}</a></div>`
      : "";
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
    root.querySelector(".vf-head h2")?.focus?.();
  });
  globalThis.addEventListener?.("popstate", draw);
  await load();
}
