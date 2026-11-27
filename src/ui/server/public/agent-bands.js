import {
  ATTENTION_STATES,
  ATTENTION_TABLE,
  attentionCounts,
  sortByAttention,
} from "/kit/attention.js";

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const SERVER_WS = "den-server";

export function rowState(r, seenNow) {
  let s = r?.attn;
  if (r?.waiting && r.waitingWhy !== "input") s = "needs";
  else if (!ATTENTION_STATES.includes(s)) s = "idle";
  if (s === "done" && seenNow?.has?.(r.id)) {
    if (!(seenNow instanceof Map) || seenNow.get(r.id) === r.attnSince)
      return "idle";
  }
  return s;
}

const sortName = (r) =>
  r.kind === "agent"
    ? r.displayName || r.agent || r.label || ""
    : r.label || r.id || "";

/**
 * @typedef {Record<string, any>} BandRow A session row from /api/sessions.
 * @typedef {{ state: string, rows: BandRow[] }} Band
 */

/**
 * The bands in order, each with its rows sorted; empty bands left out.
 * @param {BandRow[] | null | undefined} rows
 * @param {{ seenNow?: Map<string, unknown> | Set<string> }} [opts]
 * @returns {Band[]}
 */
export function bandsOf(rows, { seenNow } = {}) {
  const items = (rows ?? []).map((r) => ({
    state: rowState(r, seenNow),
    since: r.attnSince,
    name: sortName(r),
    id: r.id,
    group: r.workspace,
    ...(typeof r.place === "number" ? { place: r.place } : {}),
    r,
  }));
  const sorted = sortByAttention(items);
  return ATTENTION_STATES.map((state) => ({
    state,
    rows: sorted.filter((i) => i.state === state).map((i) => i.r),
  })).filter((b) => b.rows.length > 0);
}

export function byNeed(rows, { seenNow } = {}) {
  return bandsOf(rows, { seenNow }).flatMap((b) => b.rows);
}

export function bandGroup(rows, r, { seenNow } = {}) {
  if (!r || r.kind !== "agent" || !r.agent) return [];
  const state = rowState(r, seenNow);
  if (!personOrdered(state)) return [];
  const band = bandsOf(rows, { seenNow }).find((b) => b.state === state);
  return (band?.rows ?? [])
    .filter((s) => s.kind === "agent" && s.agent && s.workspace === r.workspace)
    .map((s) => s.agent);
}

export const personOrdered = (state) =>
  ATTENTION_TABLE[state]?.order === "name";

const MARK = {
  needs: ["need", "!"],
  done: ["done", "✓"],
  working: ["work", ""],
  idle: ["idle", ""],
};

export function markHtml(state) {
  const st = MARK[state] ? state : "idle";
  const [cls, sign] = MARK[st];
  return `<span class="agm ${cls}" data-mark="${st}" aria-hidden="true">${sign}</span>`;
}

export function chipHtml(r, seenNow) {
  const s = rowState(r, seenNow);
  const [cls] = MARK[s] ?? MARK.idle;
  let word;
  if (s === "needs") {
    const k = r.waitingWhy ? `ag.why.${r.waitingWhy}` : "";
    const why = k ? t(k) : "";
    if (why && why !== k)
      return (
        `<span class="cp ${cls}" data-attn="${s}">` +
        `<span class="cpw">${esc(t("ag.chip.needsWhy", { why }))}</span>` +
        `<span class="cpn">${esc(t("ag.chip.needs"))}</span></span>`
      );
    word = t("ag.chip.needs");
  } else word = t(`ag.chip.${s}`);
  return `<span class="cp ${cls}" data-attn="${s}">${esc(word)}</span>`;
}

/**
 * @param {BandRow} r
 * @param {{ all?: boolean, name?: (workspace: string) => string, pc?: (workspace: string) => string | null | undefined }} [opts]
 */
export function tagHtml(r, { all = false, name, pc } = {}) {
  if (r.server || r.workspace === SERVER_WS)
    return `<span class="ptag" data-ptag="server">${esc(t("ag.tag.server"))}</span>`;
  if (!all) return "";
  const n = typeof name === "function" ? name(r.workspace) : r.workspace;
  const c = typeof pc === "function" ? pc(r.workspace) : "";
  const at = c ? ` data-pc="${esc(c)}"` : "";
  return `<span class="ptag" data-ptag="project"${at}>${esc(n)}</span>`;
}

export function attnSub(rows, scope, seenNow) {
  const list = rows ?? [];
  const agents = list.filter((r) => r.kind === "agent").length;
  const shells = list.length - agents;
  const parts = [];
  if (agents || !shells)
    parts.push(
      t(agents === 1 ? "ag.sub.agent" : "ag.sub.agents", { n: agents }),
    );
  if (shells)
    parts.push(
      t(shells === 1 ? "ag.sub.shell" : "ag.sub.shells", { n: shells }),
    );
  const c = attentionCounts(list.map((r) => ({ state: rowState(r, seenNow) })));
  for (const s of ATTENTION_STATES)
    if (c[s] > 0)
      parts.push(
        t(c[s] === 1 && s !== "working" ? `ag.sub.${s}One` : `ag.sub.${s}`, {
          n: c[s],
        }),
      );
  if (scope) parts.push(scope);
  return parts.join(" · ");
}

/**
 * @param {string | undefined} iso
 * @param {number} [now]
 */
export function sinceShort(iso, now = Date.now()) {
  const ms = now - Date.parse(String(iso ?? ""));
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return t("bell.now");
  if (m < 60) return t("bell.min", { n: m });
  return t("bell.h", { n: Math.round(m / 60) });
}

/**
 * @param {BandRow} r
 */
export function needsWhy(r) {
  const why = r?.waitingWhy;
  if (!why) return "";
  if (why === "permission" && r.attnWhat)
    return r.attnWhat === "Bash"
      ? t("ag.whyLong.command")
      : t("ag.whyLong.tool", { tool: r.attnWhat });
  return t(`ag.whyLong.${why}`);
}

/**
 * @param {{ runtime?: string, detail?: string, time?: string }} p
 */
export function metaHtml({ runtime, detail, time } = {}) {
  const body =
    detail && time
      ? `${esc(detail)}<span class="mtm"> · ${esc(time)}</span>`
      : esc(detail || time || "");
  if (!body) return runtime ? esc(runtime) : "";
  return (runtime ? `<span class="mrt">${esc(runtime)} · </span>` : "") + body;
}

export function railNeeds(rows) {
  return attentionCounts((rows ?? []).map((r) => ({ state: rowState(r) })))
    .rail;
}
