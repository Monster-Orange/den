/**
 * Issue 773: the Agents list in four bands, sorted by who needs the
 * person (the approved mock): Needs you, Done not seen, Working, Idle.
 * One list across projects; the kit's one rule orders it
 * (/kit/attention.js: the longest wait first in Needs you and Done, A to Z
 * in Working and Idle). The server says each running agent's state for
 * this person (`attn`, `attnSince`, GET /api/sessions); stopped agents stay
 * in their own group, outside the bands.
 *
 *   rowState(r, seenNow?)    a row's state; Done opened just now is Idle
 *   bandsOf(rows, {seenNow}) [{ state, rows }], only the bands with rows
 *   markHtml(state)          the mark: !, a tick, a halo, a ring
 *   chipHtml(r, seenNow?)    the chip: "Needs you · permission", "Done", …
 *   tagHtml(r, {all, name})  the project tag (All projects), "Server"
 *   attnSub(rows, scope)     the sub-line: each state above zero
 *   railNeeds(rows)          the rail's count: Needs you only
 */
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

/** ON-6: the server agent's scope (no project). */
const SERVER_WS = "den-server";

/**
 * A row's state: a wait (not an idle notice) needs you, whatever else;
 * else the server's state; else Idle.
 */
export function rowState(r, seenNow) {
  let s = r?.attn;
  if (r?.waiting && r.waitingWhy !== "input") s = "needs";
  else if (!ATTENTION_STATES.includes(s)) s = "idle";
  // Opening the agent is seen: Done is Idle at once, before the next list.
  if (s === "done" && seenNow?.has?.(r.id)) {
    // A Map holds the finish it saw: a later finish is Done again.
    if (!(seenNow instanceof Map) || seenNow.get(r.id) === r.attnSince)
      return "idle";
  }
  return s;
}

/** The name a row sorts by: its given name, else its persona, else its id. */
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
    r,
  }));
  const sorted = sortByAttention(items);
  return ATTENTION_STATES.map((state) => ({
    state,
    rows: sorted.filter((i) => i.state === state).map((i) => i.r),
  })).filter((b) => b.rows.length > 0);
}

const MARK = {
  needs: ["need", "!"],
  done: ["done", "✓"],
  working: ["work", ""],
  idle: ["idle", ""],
};

/** The mark: its shape says the state as well as its colour. */
export function markHtml(state) {
  const st = MARK[state] ? state : "idle";
  const [cls, sign] = MARK[st];
  return `<span class="agm ${cls}" data-mark="${st}" aria-hidden="true">${sign}</span>`;
}

/** The chip: the state's word; Needs you says which need. */
export function chipHtml(r, seenNow) {
  const s = rowState(r, seenNow);
  const [cls] = MARK[s] ?? MARK.idle;
  let word;
  if (s === "needs") {
    const k = r.waitingWhy ? `ag.why.${r.waitingWhy}` : "";
    const why = k ? t(k) : "";
    word =
      why && why !== k ? t("ag.chip.needsWhy", { why }) : t("ag.chip.needs");
  } else word = t(`ag.chip.${s}`);
  return `<span class="cp ${cls}" data-attn="${s}">${esc(word)}</span>`;
}

/**
 * The tag before a row's meta: "Server" for the server agent (in every
 * view), else its project's name on All projects; none on one project.
 */
/**
 * @param {BandRow} r
 * @param {{ all?: boolean, name?: (workspace: string) => string }} [opts]
 */
export function tagHtml(r, { all = false, name } = {}) {
  if (r.server || r.workspace === SERVER_WS)
    return `<span class="ptag" data-ptag="server">${esc(t("ag.tag.server"))}</span>`;
  if (!all) return "";
  const n = typeof name === "function" ? name(r.workspace) : r.workspace;
  return `<span class="ptag" data-ptag="project">${esc(n)}</span>`;
}

/**
 * The sub-line: how many agents (and shells), each state above zero, then
 * the scope.
 */
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

/** The rail's Agents count: the agents that need the person. */
export function railNeeds(rows) {
  return attentionCounts((rows ?? []).map((r) => ({ state: rowState(r) })))
    .rail;
}
