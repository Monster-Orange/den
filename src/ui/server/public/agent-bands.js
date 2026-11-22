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
 *   sinceShort(iso, now?)    "3 min", "2 h": Needs you's and Working's time
 *   needsWhy(r)              "asks to run a command", "asked you a question"
 *   metaHtml({runtime, detail, time})  line 2, its parts marked for a phone
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
    // Mock v3: the reason on a wide screen; a phone's card says just
    // "Needs you" (CSS shows one of the two).
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

/**
 * Mock v3: how long a row has been in Needs you or Working, without
 * "ago" ("3 min", "2 h"); the bell's own words.
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
 * Mock v3: what a Needs you row waits on, on its second line: a
 * permission for Bash "asks to run a command", for another tool "asks to
 * use <tool>"; else the wait's own words ("asked you a question").
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
 * A row's line 2 after its tag: the runtime, what its state is about and
 * (Needs you) how long. Mock v3's phone card drops the runtime (.mrt) and
 * Needs you's time (.mtm); a wide screen shows "Claude · asks to run a
 * command · 3 min".
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

/** The rail's Agents count: the agents that need the person. */
export function railNeeds(rows) {
  return attentionCounts((rows ?? []).map((r) => ({ state: rowState(r) })))
    .rail;
}
