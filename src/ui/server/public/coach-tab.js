/**
 * Issue 52: the Coach tab on the platform agent's page, as mock v2 draws it
 * (in Hub: "Coach tab: what your agents used this week"). Read-only: it
 * shows the last Coach report and runs one by hand. Findings, Dismiss and
 * Apply come later, from a later mock.
 *
 *   status line   last run (what it cost, agents read), Running… with its
 *                 progress, the last failed run, or Not run yet; Run now
 *                 (disabled while the Coach is off)
 *   tiles         Window, Calls, Output tokens, Compactions (each per day)
 *   toolbar       Show counts as Total | Per day (a person's preference,
 *                 /api/settings coach_counts), the window
 *   table         one row per agent; any header sorts (aria-sort); amber at
 *                 6+ compactions, 40+ polls, 8%+ tool errors; a row opens
 *                 its detail (conversations newest first, model mix, per day)
 *   phone         one card per agent; the detail is its own view
 *
 *   findings      (mock v6) under the table: what was found,
 *                 the agent, why Coach says so (the numbers and the line
 *                 passed), each with Dismiss (dots in the button; no
 *                 reason asked; an Undo toast above the heading); "N
 *                 dismissed · Show" lists them, each with Undo
 *   apply         (issue 110, mock v3) a finding with a proposal says its
 *                 change in words and has Apply beside Dismiss (dots in
 *                 the button); the row then follows its held write:
 *                 Waiting for Allow (Open the bell), Applied, Denied
 *                 (Apply again) or Failed (Try again); a change is read out
 *
 * Every word is a page key (co.*) in en, es and ja. Agents' words never
 * show here; names are escaped, and every number and date follows the
 * page's language and the person's time zone.
 */

import { formatTime } from "/kit/time.js";

const sh = () => globalThis.window?.denShell;
const doc = () => globalThis.document;
const t = (key, vars) => sh()?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** The page's language, for Intl. */
const lang = () =>
  sh()?.lang?.() || globalThis.document?.documentElement?.lang || undefined;

function fmtNum(n, opts) {
  try {
    return new Intl.NumberFormat(lang(), opts).format(n);
  } catch {
    return String(n);
  }
}

/**
 * A date-time in the person's chosen zone and the page's language, by the
 * kit's own formatter (T1: public/ never formats a date itself).
 */
const fmtDate = (iso, style) => formatTime(iso, { style }) || "";

/** "Nov 22, 9:14 AM": a run or a conversation. */
export const when = (iso) => fmtDate(iso, "datetime");
/** "Nov 22": a window's end. */
const day = (iso) => fmtDate(iso, "date");

/**
 * The table's columns, in the mock's order. `count`: Per day shows its
 * `_per_day` form; `kind` picks the format; `amber`: the mock's rule.
 */
export const COLUMNS = [
  { key: "agent" },
  { key: "calls", count: true, kind: "count" },
  { key: "output_M", count: true, kind: "tokens", scale: 1e6 },
  { key: "cache_read_B", count: true, kind: "tokens", scale: 1e9 },
  { key: "avg_context_k_main", kind: "tokens", scale: 1e3 },
  { key: "compactions", count: true, kind: "count", amber: 6 },
  { key: "rotations", count: true, kind: "count" },
  { key: "conversations", kind: "count" },
  { key: "polls", count: true, kind: "count", amber: 40 },
  { key: "denials", count: true, kind: "count" },
  { key: "tool_error_pct", kind: "pct", amber: 8 },
  { key: "correction_pct", kind: "pct" },
];

export const DEFAULT_SORT = { key: "output_M", dir: "desc" };

/** A row's value for column `key`: its total, or its per-day form. */
export function cellValue(row, key, perDay) {
  if (key === "agent") return row.agent;
  if (key === "conversations") return row.conversations?.inWindow ?? 0;
  if (!row.metrics) return null;
  const col = COLUMNS.find((c) => c.key === key);
  if (perDay && col?.count) {
    const v = row.perDay?.[`${key}_per_day`];
    return typeof v === "number" ? v : null;
  }
  const v = row.metrics[key];
  return typeof v === "number" ? v : null;
}

/** Whether a row's total trips the column's amber rule (never per day). */
export function isAmber(row, key) {
  const col = COLUMNS.find((c) => c.key === key);
  if (!col?.amber) return false;
  const v = cellValue(row, key, false);
  return typeof v === "number" && v >= col.amber;
}

/** A value as the column shows it. */
export function fmtCell(key, v, perDay) {
  if (v === null || v === undefined) return "—";
  const col = COLUMNS.find((c) => c.key === key);
  if (!col || col.key === "agent") return String(v);
  if (col.kind === "tokens")
    return fmtNum(v * col.scale, {
      notation: "compact",
      maximumFractionDigits: v * col.scale >= 1e6 ? 2 : 0,
    });
  if (col.kind === "pct")
    return fmtNum(v / 100, { style: "percent", maximumFractionDigits: 1 });
  return fmtNum(v, { maximumFractionDigits: perDay && col.count ? 1 : 0 });
}

/** The rows, sorted; agents with no numbers last, by name. */
export function sortRows(rows, sort = DEFAULT_SORT, perDay = false) {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === "agent")
      return sign * String(a.agent).localeCompare(String(b.agent));
    const x = cellValue(a, sort.key, perDay);
    const y = cellValue(b, sort.key, perDay);
    if (x === null && y === null)
      return String(a.agent).localeCompare(String(b.agent));
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y) || String(a.agent).localeCompare(String(b.agent));
  });
}

/** The next sort after a click on `key`'s header. */
export function nextSort(sort, key) {
  if (sort.key === key)
    return { key, dir: sort.dir === "desc" ? "asc" : "desc" };
  return { key, dir: key === "agent" ? "asc" : "desc" };
}

/** Model calls by family, in percent of all: Opus, Sonnet, Haiku, other. */
export function modelMix(models = {}) {
  const fam = { opus: 0, sonnet: 0, haiku: 0, other: 0 };
  let all = 0;
  for (const [m, n] of Object.entries(models)) {
    const k = /opus/i.test(m)
      ? "opus"
      : /sonnet/i.test(m)
        ? "sonnet"
        : /haiku/i.test(m)
          ? "haiku"
          : "other";
    fam[k] += n;
    all += n;
  }
  if (!all) return null;
  const pct = (n) => Math.round((n / all) * 100);
  return {
    opus: pct(fam.opus),
    sonnet: pct(fam.sonnet),
    haiku: pct(fam.haiku),
    other: pct(fam.other),
  };
}

/** Which state the tab is in (the mock's frames). */
export function coachState(data) {
  if (!data?.settings?.enabled) return "off";
  if (data.running) return "running";
  if (data.failed) return "failed";
  if (!data.report) return "none";
  return "done";
}

const range = (w) =>
  t("co.range", { from: day(w.from), to: day(w.to), days: w.days });

function runBar(data, state) {
  const r = data.report;
  const agents = r?.agents?.length ?? 0;
  let head = "";
  let sub = "";
  let prog = "";
  let btn = `<button type="button" class="den-btn primary" data-act="coach-run">${esc(t("co.run"))}</button>`;
  if (state === "off") {
    head = esc(t("co.off.status"));
    sub = esc(t("co.off.sub"));
    btn = `<button type="button" class="den-btn primary" data-act="coach-run" disabled aria-disabled="true">${esc(t("co.run"))}</button>`;
  } else if (state === "running") {
    head = esc(t("co.running"));
    const p = data.progress;
    sub = esc(
      p && p.total
        ? t("co.running.sub", { done: p.done, total: p.total })
        : t("co.running.start"),
    );
    const w = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
    prog = `<div class="co-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${w}"><i style="width:${w}%"></i></div>`;
    btn = `<button type="button" class="den-btn" data-act="coach-run" disabled aria-disabled="true" aria-busy="true">${esc(t("co.running"))}</button>`;
  } else if (state === "failed") {
    head = `<span class="co-bad">${esc(t("co.failed", { when: when(data.failed.at) }))}</span>`;
    sub =
      esc(data.failed.error) +
      " " +
      esc(
        r
          ? t("co.failed.before", { when: when(r.ranAt) })
          : t("co.failed.none"),
      );
    btn = `<button type="button" class="den-btn primary" data-act="coach-run">${esc(t("co.runAgain"))}</button>`;
  } else if (state === "none") {
    head = esc(t("co.none.h"));
    sub = esc(t("co.none.sub"));
  } else {
    head = esc(t("co.last", { when: when(r.ranAt) }));
    sub = esc(
      r.cost?.tokens
        ? t("co.cost", {
            tokens: fmtNum(r.cost.tokens, { notation: "compact" }),
            model: r.cost.model ?? "",
            n: agents,
          })
        : t("co.costNone", { n: agents }),
    );
  }
  return (
    `<div class="co-runbar" data-state="${state}"><div class="co-st" aria-live="polite"><b>${head}</b><small>${sub}</small>${prog}</div>` +
    `${btn}</div>`
  );
}

function empty(state) {
  if (state === "off")
    return (
      `<div class="co-emp" data-note="coach-off"><h3>${esc(t("co.off.h"))}</h3>` +
      `<p>${esc(t("co.off.p"))}</p><p>${esc(t("co.off.how"))}</p>` +
      `<a class="den-btn" href="/settings#agents">${esc(t("co.openSettings"))}</a></div>`
    );
  if (state === "running")
    return `<div class="co-emp" data-note="coach-running"><h3>${esc(t("co.running.h"))}</h3><p>${esc(t("co.running.p"))}</p></div>`;
  return `<div class="co-emp" data-note="coach-none"><h3>${esc(t("co.empty.h"))}</h3><p>${esc(t("co.empty.p"))}</p></div>`;
}

function tiles(r) {
  const tot = r.totals ?? {};
  const pd = r.totalsPerDay ?? {};
  const tile = (label, big, small) =>
    `<div class="co-tl"><small>${esc(label)}</small><b>${esc(big)}</b><i>${esc(small)}</i></div>`;
  const perDay = (key, v) => t("co.perDayShort", { v: fmtCell(key, v, true) });
  return (
    `<div class="co-tiles">` +
    tile(
      t("co.tile.window"),
      t("co.days", { n: r.window.days }),
      `${day(r.window.from)} – ${day(r.window.to)}`,
    ) +
    tile(
      t("co.col.calls"),
      fmtCell("calls", tot.calls),
      perDay("calls", pd.calls_per_day),
    ) +
    tile(
      t("co.col.output_M"),
      fmtCell("output_M", tot.output_M),
      perDay("output_M", pd.output_M_per_day),
    ) +
    tile(
      t("co.col.compactions"),
      fmtCell("compactions", tot.compactions),
      perDay("compactions", pd.compactions_per_day),
    ) +
    `</div>`
  );
}

function toolbar(r, perDay) {
  const seg = (v, on) =>
    `<button type="button" data-act="coach-counts" data-v="${v}" aria-pressed="${on}"${on ? ' class="on"' : ""}>${esc(t(v === "total" ? "co.total" : "co.perDay"))}</button>`;
  return (
    `<div class="co-tt"><span class="co-tt-l">${esc(t("co.showAs"))}</span>` +
    `<span class="co-seg" role="group" aria-label="${esc(t("co.showAs"))}">${seg("total", !perDay)}${seg("per_day", perDay)}</span>` +
    `<span>${esc(range(r.window))}</span></div>`
  );
}

function table(rows, o) {
  const head = COLUMNS.map((c) => {
    const on = o.sort.key === c.key;
    const aria = on
      ? ` aria-sort="${o.sort.dir === "asc" ? "ascending" : "descending"}"`
      : "";
    const mark = on ? (o.sort.dir === "asc" ? " ▴" : " ▾") : "";
    return `<th scope="col"${aria}><button type="button" data-act="coach-sort" data-key="${c.key}">${esc(t(`co.col.${c.key}`))}${mark}</button></th>`;
  }).join("");
  const body = rows
    .map((row) => {
      const sel = row.agent === o.open;
      const cells = COLUMNS.map((c) => {
        if (c.key === "agent")
          return `<td><b>${esc(row.agent)}</b>${row.why ? ` <small class="co-why">${esc(t("co.noNumbers"))}</small>` : ""}</td>`;
        const v = fmtCell(c.key, cellValue(row, c.key, o.perDay), o.perDay);
        return `<td>${isAmber(row, c.key) ? `<span class="co-hi">${esc(v)}</span>` : esc(v)}</td>`;
      }).join("");
      return `<tr class="co-r${sel ? " sel" : ""}" data-act="coach-open" data-agent="${esc(row.agent)}" tabindex="0" role="button" aria-expanded="${sel}">${cells}</tr>`;
    })
    .join("");
  return (
    `<div class="co-tw"><table class="co-table" data-note="coach-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    `<p class="co-foot">${esc(t("co.foot"))}</p>`
  );
}

function cards(rows, o) {
  const g = (row, key, label) =>
    `<span>${esc(label)} <b>${esc(fmtCell(key, cellValue(row, key, o.perDay), o.perDay))}</b></span>`;
  return (
    `<div class="co-cards" data-note="coach-cards">` +
    rows
      .map(
        (row) =>
          `<button type="button" class="co-ac" data-act="coach-open" data-agent="${esc(row.agent)}">` +
          `<span class="h"><span>${esc(row.agent)}</span><span aria-hidden="true">›</span></span>` +
          `<span class="g">${g(row, "calls", t("co.card.calls"))}${g(row, "output_M", t("co.card.output"))}` +
          `${g(row, "compactions", t("co.col.compactions"))}${g(row, "tool_error_pct", t("co.col.tool_error_pct"))}</span></button>`,
      )
      .join("") +
    `</div>`
  );
}

const WHY = ["start", "fresh", "rotation", "bring-in"];

function mixBar(label, mix, flagged = false) {
  if (!mix)
    return `<div class="co-mix"><b>${esc(label)}</b><small>${esc(t("co.mix.none"))}</small></div>`;
  const parts = ["opus", "sonnet", "haiku", "other"].filter(
    (k) => mix[k] > 0 || k !== "other",
  );
  return (
    `<div class="co-mix"><b>${esc(label)}</b><div class="co-bar" aria-hidden="true">` +
    parts
      .map((k) => `<i class="m-${k}" style="width:${mix[k]}%"></i>`)
      .join("") +
    `</div><small>${esc(
      parts
        .map((k) =>
          t("co.mix.part", {
            model: t(`co.mix.${k}`),
            pct: fmtNum(mix[k] / 100, { style: "percent" }),
          }),
        )
        .join(" · ") +
        // Mock v6: the subagent mix points at its finding under the table.
        (flagged
          ? ` · ${t("co.mix.flagged", { pct: fmtNum(mix.opus / 100, { style: "percent" }) })}`
          : ""),
    )}</small></div>`
  );
}

function detail(row, r, findings = []) {
  const opusFlagged = findings.some(
    (f) => f?.kind === "subagent_opus" && f.agent === row.agent,
  );
  const list = row.conversations?.list ?? [];
  const convs = list.length
    ? list
        .map((c) => {
          const kind = WHY.includes(c.why) ? c.why : "fresh";
          return (
            `<div class="co-cv"><span>${esc(when(c.from))}</span>` +
            `<span><span class="co-kd${kind === "rotation" ? " rot" : ""}">${esc(t(`co.kind.${kind}`))}</span></span>` +
            `<small>${esc(t(`co.why.${kind}`))}${c.backfilled ? ` ${esc(t("co.approx"))}` : ""}</small></div>`
          );
        })
        .join("")
    : `<p class="co-muted">${esc(t("co.noConv"))}</p>`;
  const pd = row.perDay ?? {};
  const perDay = row.metrics
    ? t("co.perDayLine", {
        calls: fmtCell("calls", pd.calls_per_day, true),
        output: fmtCell("output_M", pd.output_M_per_day, true),
        compactions: fmtCell("compactions", pd.compactions_per_day, true),
        rotations: fmtCell("rotations", pd.rotations_per_day, true),
      })
    : t("co.noNumbers");
  return (
    `<section class="co-det" data-note="coach-detail" aria-label="${esc(row.agent)}" tabindex="-1">` +
    `<h4><button type="button" class="co-back" data-act="coach-close">‹ ${esc(row.agent)}</button>` +
    `<span class="co-dname">${esc(row.agent)}</span>` +
    `<span class="co-sp">${esc(t("co.detail.sub", { range: `${day(r.window.from)} – ${day(r.window.to)}`, n: row.conversations?.inWindow ?? 0 }))}</span>` +
    `<button type="button" class="den-btn sm co-close" data-act="coach-close" data-note="coach-close">✕ ${esc(t("co.close"))}</button></h4>` +
    `<div class="co-cols"><div><h5>${esc(t("co.conv.h"))}</h5>${convs}</div>` +
    `<div><h5>${esc(t("co.mix.h"))}</h5>${mixBar(t("co.mix.main"), modelMix(row.models?.main))}` +
    `${mixBar(t("co.mix.sub"), modelMix(row.models?.subagent), opusFlagged)}` +
    `<h5>${esc(t("co.perDayH"))}</h5><p class="co-muted">${esc(perDay)}</p></div></div></section>`
  );
}

/**
 * A finding's words, from its kind and its numbers: the title's key, the
 * reason's key, and their vars (the line it passed from the settings).
 * null for a kind this page doesn't know (it shows the run's own words).
 */
export function findingWords(f, th = {}) {
  const e = f?.evidence ?? {};
  const v = {
    subagent_opus: () => ({
      n: e.subagent_opus_pct,
      calls: e.subagent_calls,
      line: th.subagent_opus_pct,
    }),
    polling: () => ({ n: e.polls_per_day, line: th.polls_per_day }),
    no_rotation: () => ({ n: e.compactions, line: e.after }),
    denials: () => ({ n: e.denials_per_day, line: th.denials_per_day }),
    transcript_size: () => ({ n: e.transcript_mb, line: th.transcript_mb }),
    ask_r12: () => ({
      n: e.asks,
      pct: e.ask_r12_pass_pct,
      line: th.ask_r12_pass_pct,
    }),
    ask_wait: () => ({ n: e.ask_wait_min, line: th.ask_wait_min }),
    msg_repeat: () => ({ n: e.sends_repeated, line: th.sends_repeated }),
    msg_no_reply: () => ({
      n: e.sends,
      pct: e.sends ? Math.round((e.sends_no_reply / e.sends) * 100) : 0,
      line: th.sends_no_reply_pct,
    }),
    repeat_ask: () => ({ n: e.judged_yes }),
    trivial_ask: () => ({ n: e.judged_yes }),
    relay: () => ({ n: e.judged_yes }),
  }[f?.kind];
  if (!v) return null;
  return {
    title: `co.f.${f.kind}.t`,
    why: `co.f.${f.kind}.why`,
    vars: { agent: f.agent ?? agentOf(f.id), ...v() },
  };
}

/** A finding's title and reason as text (escaped later). */
function words(f, th) {
  const w = findingWords(f, th);
  if (!w) return { title: f.title ?? f.id, why: f.proposal ?? "" };
  return { title: t(w.title, w.vars), why: t(w.why, w.vars) };
}

/** Issue 110: a finding's change and what is true after it, as words. */
function applyVars(f) {
  return { persona: f?.apply?.args?.id ?? f?.persona ?? f?.agent ?? "" };
}

/** The decided line's time, in the person's time zone. */
function decidedWhen(a) {
  return a?.decidedAt ? when(a.decidedAt) : "";
}

/**
 * Issue 110 (mock v3): a finding's Apply part. `line` goes under the
 * reason (the change, or what the held write did); `chip` and `buttons`
 * go where Dismiss was. `wide`: the phone's full-width buttons.
 */
function applyParts(f, wide) {
  const dismiss = `<button type="button" class="den-btn ${wide ? "co-fdis-wide" : "sm co-fdis"}" data-act="coach-dismiss" data-id="${esc(f.id)}">${esc(t("co.f.dismiss"))}</button>`;
  const apply = (label) =>
    `<button type="button" class="den-btn primary ${wide ? "co-fdis-wide" : "sm co-fap"}" data-act="coach-apply" data-id="${esc(f.id)}">${esc(t(label))}</button>`;
  if (!f.apply) return { line: "", none: true, chip: "", buttons: dismiss };
  const v = applyVars(f);
  const proposed = `<p class="co-fchg" data-note="coach-change">${esc(t("co.ap.proposed", { change: t(`co.ap.change.${f.kind}`, v) }))}</p>`;
  const a = f.applied;
  const chip = (cls, key) =>
    `<span class="co-chip ${cls}" data-apply-state="${esc(a?.state ?? "")}">${esc(t(key))}</span>`;
  const note = (text) => `<p class="co-apl">${text}</p>`;
  const w = { by: a?.by ?? "", when: decidedWhen(a) };
  switch (a?.state) {
    case "waiting":
      return {
        line:
          proposed +
          note(
            `${esc(t("co.ap.waiting.line"))} <button type="button" class="co-link" data-act="coach-bell">${esc(t("co.ap.openBell"))}</button>`,
          ),
        chip: chip("wait", "co.ap.waiting"),
        buttons: "",
      };
    case "applied":
      return {
        line:
          proposed +
          note(
            esc(
              t(a.by ? "co.ap.applied.by" : "co.ap.applied.at", {
                ...w,
                now: t(`co.ap.now.${f.kind}`, v),
              }),
            ),
          ),
        chip: chip("ok", "co.ap.applied"),
        buttons: "",
      };
    case "denied":
      return {
        line:
          proposed +
          note(esc(t(a.by ? "co.ap.denied.by" : "co.ap.denied.at", w))),
        chip: chip("bad", "co.ap.denied"),
        buttons: apply("co.ap.again") + dismiss,
      };
    case "failed":
      return {
        line:
          proposed +
          note(
            esc(
              a.reason
                ? t("co.ap.failed.line", { reason: a.reason })
                : t("co.ap.failed.none"),
            ),
          ),
        chip: chip("bad", "co.ap.failed"),
        buttons: apply("co.ap.retry") + dismiss,
      };
    default:
      return {
        line: proposed,
        chip: "",
        buttons: apply("co.ap.apply") + dismiss,
      };
  }
}

/**
 * Issue 110: what to read out when a finding's Apply state changed between
 * two GETs (the newest change), or "".
 */
export function applyLiveText(before = [], after = [], th = {}) {
  const was = new Map(
    (before ?? []).map((f) => [f.id, f.applied?.state ?? null]),
  );
  let out = "";
  for (const f of after ?? []) {
    const s = f.applied?.state ?? null;
    if (s && was.has(f.id) && was.get(f.id) !== s)
      out = t(`co.ap.live.${s}`, { title: words(f, th).title });
  }
  return out;
}

const kindOf = (id) => String(id).split(":")[0];
const agentOf = (id) => String(id).slice(String(id).indexOf(":") + 1);

function findingsSection(data, rows, o) {
  const th = data.settings?.findings ?? {};
  const order = new Map(
    sortRows(rows, DEFAULT_SORT).map((r, i) => [r.agent, i]),
  );
  const list = [...(data.findings ?? [])].sort(
    (a, b) =>
      (order.get(a.agent) ?? 1e9) - (order.get(b.agent) ?? 1e9) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const dismissed = data.dismissed ?? [];
  let html = `<section class="co-findings" aria-labelledby="co-f-h">`;
  html +=
    `<h3 class="co-fh" id="co-f-h">${esc(t("co.f.h"))} ` +
    `<span class="co-muted">${esc(t("co.f.count", { n: list.length }))}</span></h3>`;
  if (!list.length)
    html += `<div class="co-fnone" data-note="coach-no-findings">${esc(t("co.f.none"))}</div>`;
  else {
    html +=
      `<div class="co-tw co-ftw"><table class="co-table co-ftable" data-note="coach-findings-table"><thead><tr>` +
      `<th scope="col">${esc(t("co.f.col.finding"))}</th><th scope="col">${esc(t("co.f.col.agent"))}</th>` +
      `<th scope="col">${esc(t("co.f.col.why"))}</th><th scope="col"><span class="co-sr">${esc(t("co.f.dismiss"))}</span></th>` +
      `</tr></thead><tbody>` +
      list
        .map((f) => {
          const w = words(f, th);
          const p = applyParts(f, false);
          const why = p.none ? `${w.why} ${t("co.ap.none")}` : w.why;
          return (
            `<tr class="co-fr" data-id="${esc(f.id)}"><td><b>${esc(w.title)}</b></td><td>${esc(f.agent)}</td>` +
            `<td class="co-fwhy">${esc(why)}${p.line}</td><td class="co-fact">${p.chip}${p.buttons}</td></tr>`
          );
        })
        .join("") +
      `</tbody></table></div>` +
      `<div class="co-fcards" data-note="coach-finding-cards">` +
      list
        .map((f) => {
          const w = words(f, th);
          const first = w.why.split(/(?<=[.。])\s*/)[0];
          const p = applyParts(f, true);
          const why = p.none ? `${first} ${t("co.ap.none")}` : first;
          return (
            `<div class="co-fc" data-id="${esc(f.id)}"><b>${esc(w.title)}</b>` +
            `<small>${esc(f.agent)} · ${esc(why)}</small>${p.line}${p.chip}${p.buttons}</div><!--fc-->`
          );
        })
        .join("") +
      `</div>`;
  }
  if (o.applyFailed) {
    const f = list.find((x) => x.id === o.applyFailed) ?? {
      id: o.applyFailed,
      kind: kindOf(o.applyFailed),
    };
    html += `<p class="co-fail" role="alert">${esc(t("co.ap.fail", { title: words(f, th).title }))}</p>`;
  }
  if (o.dismissFailed) {
    const f = list.find((x) => x.id === o.dismissFailed) ?? {
      id: o.dismissFailed,
      kind: kindOf(o.dismissFailed),
    };
    html += `<p class="co-fail" role="alert">${esc(t("co.f.fail", { title: words(f, th).title }))}</p>`;
  }
  if (dismissed.length) {
    const open = !!o.dismissedOpen;
    html +=
      `<p class="co-fdn">${esc(t("co.f.dismissedN", { n: dismissed.length }))} · ` +
      `<button type="button" class="co-link" data-act="coach-dismissed-toggle" aria-expanded="${open}">${esc(t(open ? "co.f.hide" : "co.f.show"))}</button></p>`;
    if (open)
      html +=
        `<ul class="co-fdl">` +
        dismissed
          .map((d) => {
            const f = { id: d.id, kind: kindOf(d.id), agent: agentOf(d.id) };
            return (
              `<li><b>${esc(words(f, th).title)}</b><span>${esc(f.agent)}</span>` +
              `<span class="co-muted">${esc(t("co.f.dismissedAt", { when: when(d.at) }))}</span>` +
              `<button type="button" class="co-link" data-act="coach-undismiss" data-id="${esc(d.id)}">${esc(t("co.f.undo"))}</button></li>`
            );
          })
          .join("") +
        `</ul>`;
  }
  return html + `</section>`;
}

/**
 * The whole tab's HTML for `data` (GET /api/coach) and the view `o`:
 * { sort, perDay, open, dismissedOpen, dismissFailed, applyFailed }.
 */
export function coachTabView(data, o = {}) {
  const view = {
    applyFailed: o.applyFailed ?? null,
    sort: o.sort ?? DEFAULT_SORT,
    perDay: !!o.perDay,
    open: o.open ?? null,
    dismissedOpen: !!o.dismissedOpen,
    dismissFailed: o.dismissFailed ?? null,
  };
  const state = coachState(data);
  const r = data?.report;
  let html = runBar(data, state);
  if (state === "off" || state === "running" || !r) return html + empty(state);
  if (state === "failed")
    html += `<p class="co-muted" data-note="coach-before">${esc(t("co.failed.table", { when: day(r.ranAt) }))}</p>`;
  const rows = sortRows(r.agents ?? [], view.sort, view.perDay);
  const open = view.open && rows.find((x) => x.agent === view.open);
  html += `<div class="co-report${open ? " co-has-detail" : ""}">`;
  html +=
    tiles(r) +
    toolbar(r, view.perDay) +
    table(rows, view) +
    cards(rows, view) +
    findingsSection(data, r.agents ?? [], view);
  html += `</div>`;
  if (open) html += detail(open, r, data.findings ?? []);
  return html;
}

// ── mounting ───────────────────────────────────────────────────────────

const view = {
  applyFailed: null,
  sort: DEFAULT_SORT,
  perDay: false,
  open: null,
  dismissedOpen: false,
  dismissFailed: null,
};
let data = null;
let el = null;
/** The tab's content, repainted; `live` stays, so a change is read out. */
let body = null;
let live = null;
let again = null;
const RECHECK_MS = 3000;

/** Issue 110: a finding's Apply waits for a person's Allow. */
const anyWaiting = (d) =>
  (d?.findings ?? []).some((f) => f.applied?.state === "waiting");

async function load() {
  const before = data?.findings ?? [];
  try {
    data = await sh().api("GET", "/api/coach");
  } catch (e) {
    sh()?.errorToast?.(e);
    return;
  }
  paint();
  // Issue 110: waiting, denied, applied or failed is read out.
  const said = applyLiveText(
    before,
    data?.findings ?? [],
    data?.settings?.findings ?? {},
  );
  if (said && live) live.textContent = said;
  clearTimeout(again);
  // While a run goes, look again for its progress; stop when it ends.
  // Issue 110: while an Apply waits, look again, so an Allow or a Deny
  // from the bell shows without a reload.
  if ((data?.running || anyWaiting(data)) && !document.hidden)
    again = setTimeout(load, RECHECK_MS);
}

function paint(focus) {
  if (!el || !data) return;
  body.innerHTML = coachTabView(data, view);
  el.setAttribute("aria-busy", "false");
  if (focus === "detail") el.querySelector(".co-det")?.focus();
  else if (focus) el.querySelector(focus)?.focus();
}

async function runNow(button) {
  const wait = sh().busyAction(
    "coach-run",
    (headers) => sh().api("POST", "/api/coach/run", {}, { headers }),
    { button },
  );
  // The run takes a minute or two: show Running… from GET meanwhile.
  setTimeout(load, 300);
  await wait;
  await load();
}

/** How long the Undo toast stays (Den Design, issue 52: about 8 s). */
const UNDO_MS = 8000;

/**
 * A write through the kit's busy action (BUSY-1): its button shows dots at
 * once, and the working pop-up opens only for a slow one (after 3 s). A
 * quick refusal comes back here (quietFail, inlineError); no success toast.
 * true when it worked.
 */
async function write(name, url, body, button) {
  try {
    const res = await sh().busyAction(
      name,
      (headers) => sh().api("POST", url, body, { headers }),
      {
        button,
        toastFast: false,
        quietFail: true,
        inlineError: true,
        skipDone: () => true,
      },
    );
    return res !== null && res !== undefined;
  } catch {
    return false;
  }
}

/** Dismiss: dots in the button, then the row leaves and the Undo toast shows. */
async function dismiss(button) {
  const id = button.dataset.id;
  const f = (data?.findings ?? []).find((x) => x.id === id) ?? {
    id,
    kind: kindOf(id),
    agent: agentOf(id),
  };
  const title = words(f, data?.settings?.findings ?? {}).title;
  if (await write("coach-dismiss", "/api/coach/dismiss", { id }, button)) {
    view.dismissFailed = null;
    await load();
    sh().toastAction(
      t("co.f.toast", { title }),
      t("co.f.undo"),
      () => void undo(id),
      UNDO_MS,
    );
    return;
  }
  view.dismissFailed = id;
  paint(`[data-act="coach-dismiss"][data-id="${CSS.escape(id)}"]`);
}

/**
 * Issue 110: Apply asks for the finding's change as a held write. Dots in
 * the button while Den asks; then the row says Waiting for Allow. Nothing
 * changes until a person allows it in the bell.
 */
async function applyFinding(button) {
  const id = button.dataset.id;
  if (await write("coach-apply", "/api/coach/apply", { id }, button)) {
    view.applyFailed = null;
    await load();
    el.querySelector(
      `tr[data-id="${CSS.escape(id)}"] [data-act="coach-bell"]`,
    )?.focus();
    return;
  }
  view.applyFailed = id;
  paint(`[data-act="coach-apply"][data-id="${CSS.escape(id)}"]`);
}

/** Take a dismissal back; focus goes to its Dismiss again. */
async function undo(id, button) {
  if (await write("coach-undismiss", "/api/coach/undismiss", { id }, button)) {
    await load();
    el.querySelector(
      `[data-act="coach-dismiss"][data-id="${CSS.escape(id)}"]`,
    )?.focus();
    return;
  }
  sh()?.errorToast?.(t("co.undo.fail"));
}

/** Total or Per day: shown at once, kept as the person's preference. */
async function setCounts(v) {
  view.perDay = v === "per_day";
  const sel = `[data-act="coach-counts"][data-v="${v}"]`;
  paint(sel);
  if (
    !(await write(
      "coach-counts",
      "/api/settings",
      { coach_counts: v },
      el.querySelector(sel),
    ))
  )
    sh()?.errorToast?.(t("co.counts.fail"));
}

function onClick(e) {
  const a = e.target.closest?.("[data-act]");
  if (!a || !el.contains(a)) return;
  const act = a.dataset.act;
  if (act === "coach-run" && !a.disabled) void runNow(a);
  else if (act === "coach-counts") void setCounts(a.dataset.v);
  else if (act === "coach-dismiss" && !a.disabled) void dismiss(a);
  else if (act === "coach-apply" && !a.disabled) void applyFinding(a);
  else if (act === "coach-bell") doc().getElementById("den-bell")?.click();
  else if (act === "coach-undismiss" && !a.disabled) void undo(a.dataset.id, a);
  else if (act === "coach-dismissed-toggle") {
    view.dismissedOpen = !view.dismissedOpen;
    paint('[data-act="coach-dismissed-toggle"]');
  } else if (act === "coach-sort") {
    view.sort = nextSort(view.sort, a.dataset.key);
    paint(`[data-act="coach-sort"][data-key="${a.dataset.key}"]`);
  } else if (act === "coach-open") {
    view.open = view.open === a.dataset.agent ? null : a.dataset.agent;
    paint(view.open ? "detail" : null);
  } else if (act === "coach-close") {
    const was = view.open;
    view.open = null;
    paint(was ? `tr[data-agent="${CSS.escape(was)}"]` : null);
  }
}

function onKey(e) {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest?.('tr[data-act="coach-open"]');
  if (!row) return;
  e.preventDefault();
  row.click();
}

/** Mount the tab in `root`, the first time it is shown. */
export async function mountCoachTab(root) {
  if (el) return load();
  el = root;
  el.innerHTML =
    `<div class="co-body"></div>` +
    `<p class="co-sr" aria-live="polite" data-note="coach-apply-live"></p>`;
  body = el.querySelector(".co-body");
  live = el.querySelector("[data-note=coach-apply-live]");
  // Issue 110: an Allow from the bell (on this page) shows at once.
  globalThis.window?.addEventListener?.("den:approval-done", () => {
    if (anyWaiting(data)) void load();
  });
  el.addEventListener("click", onClick);
  el.addEventListener("keydown", onKey);
  try {
    const s = await sh().api("GET", "/api/settings");
    view.perDay = s?.coach_counts === "per_day";
  } catch {
    /* the default, Total */
  }
  return load();
}

/**
 * The page's tabs: Terminal (the agent's page as it was) and Coach. The
 * tab shown is kept in the URL (?tab=coach), so a link opens it.
 */
export function mountTabs(doc = document) {
  const bar = doc.getElementById("sa-tabs");
  const coach = doc.getElementById("sa-coach");
  if (!bar || !coach) return;
  const termEls = ["sa-body", "sa-pane"].map((id) => doc.getElementById(id));
  const show = (tab, push) => {
    const isCoach = tab === "coach";
    for (const b of bar.querySelectorAll("[role=tab]")) {
      const on = b.dataset.tab === tab;
      b.setAttribute("aria-selected", String(on));
      b.classList.toggle("on", on);
      b.tabIndex = on ? 0 : -1;
    }
    coach.hidden = !isCoach;
    for (const x of termEls) if (x) x.hidden = isCoach;
    if (push) {
      const u = new URL(location.href);
      if (isCoach) u.searchParams.set("tab", "coach");
      else u.searchParams.delete("tab");
      history.replaceState(null, "", u);
    }
    if (isCoach) void mountCoachTab(coach);
  };
  bar.addEventListener("click", (e) => {
    const b = e.target.closest?.("[role=tab]");
    if (b) show(b.dataset.tab, true);
  });
  bar.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const tabs = [...bar.querySelectorAll("[role=tab]")];
    const i = tabs.findIndex((b) => b.getAttribute("aria-selected") === "true");
    const next =
      tabs[(i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    show(next.dataset.tab, true);
    next.focus();
  });
  show(
    new URL(location.href).searchParams.get("tab") === "coach"
      ? "coach"
      : "terminal",
  );
}
