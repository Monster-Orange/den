/**
 * Who needs the person, one rule for Den and Hub. Four states,
 * each a row of one table (data, so a person's own mapping can override it,
 * and the bell, alerts and sounds read the same table):
 *
 *   needs    Needs you: stopped on a permission, a question or an Allow
 *   done     Done, not seen: finished after the person last looked
 *   working  in a turn
 *   idle     none of these
 *
 * `rank`: the higher first. `order` within a state: "oldest" (the longest
 * wait first, then the name) or "name" (A to Z). `rail`: counted on the
 * rail's item; `bell`: counted on the bell; `alert`: a new one alerts.
 *
 *   attentionTable(override?)    the table, with a person's override
 *   attentionState({needs, working, done})
 *   compareAttention(a, b, table?), sortByAttention(items, table?)
 *     items: { state, since?, name?, id?, group?, place? } (since: an ISO
 *     time; group and place: the person's own order)
 *   inPersonOrder(sorted, table?) the person's order inside Working and Idle
 *   attentionCounts(items, table?)  { needs, done, working, idle, rail, bell }
 */

export const ATTENTION_STATES = Object.freeze([
  "needs",
  "done",
  "working",
  "idle",
]);

export const ATTENTION_TABLE = Object.freeze({
  needs: Object.freeze({
    rank: 4,
    order: "oldest",
    rail: true,
    bell: true,
    alert: true,
  }),
  done: Object.freeze({
    rank: 3,
    order: "oldest",
    rail: false,
    bell: true,
    alert: false,
  }),
  working: Object.freeze({
    rank: 2,
    order: "name",
    rail: false,
    bell: false,
    alert: false,
  }),
  idle: Object.freeze({
    rank: 1,
    order: "name",
    rail: false,
    bell: false,
    alert: false,
  }),
});

const FIELDS = {
  rank: (v) => typeof v === "number" && Number.isFinite(v),
  order: (v) => v === "oldest" || v === "name",
  rail: (v) => typeof v === "boolean",
  bell: (v) => typeof v === "boolean",
  alert: (v) => typeof v === "boolean",
};

/** The table, with `override`'s known states and valid fields over it. */
export function attentionTable(override) {
  const out = {};
  for (const s of ATTENTION_STATES) {
    const row = { ...ATTENTION_TABLE[s] };
    const o = override && typeof override === "object" ? override[s] : null;
    if (o && typeof o === "object")
      for (const [k, ok] of Object.entries(FIELDS))
        if (k in o && ok(o[k])) row[k] = o[k];
    out[s] = row;
  }
  return out;
}

/** An agent's state: a need first, then a turn under way, then unseen work. */
export function attentionState({ needs, working, done } = {}) {
  if (needs) return "needs";
  if (working) return "working";
  if (done) return "done";
  return "idle";
}

const rowOf = (table, state) => table[state] ?? table.idle;
const timeOf = (since) => {
  const t = typeof since === "string" ? Date.parse(since) : NaN;
  return Number.isFinite(t) ? t : Infinity;
};
const text = (v) => (typeof v === "string" ? v : String(v ?? ""));
const byName = (a, b) =>
  text(a.name).localeCompare(text(b.name), "en", { sensitivity: "base" });
const byId = (a, b) => {
  const x = text(a.id);
  const y = text(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Needs you, then Done, then Working, then Idle; inside an "oldest" state
 * the longest wait first (a time not known last), then the name; inside a
 * "name" state A to Z; then the id, so the same input sorts the same.
 */
export function compareAttention(a, b, table = ATTENTION_TABLE) {
  const ra = rowOf(table, a.state);
  const rb = rowOf(table, b.state);
  if (ra.rank !== rb.rank) return rb.rank - ra.rank;
  if (ra.order === "oldest") {
    const ta = timeOf(a.since);
    const tb = timeOf(b.since);
    if (ta !== tb) return ta < tb ? -1 : 1;
  }
  return byName(a, b) || byId(a, b);
}

/**
 * A sorted copy of `items`: compareAttention, then the person's own order
 * inside each band (inPersonOrder).
 */
export function sortByAttention(items, table = ATTENTION_TABLE) {
  return inPersonOrder(
    [...(items ?? [])].sort((a, b) => compareAttention(a, b, table)),
    table,
  );
}

const placed = (i) =>
  typeof i.place === "number" && Number.isFinite(i.place) && i.group != null;

/**
 * The person's order holds inside a band. In each band of
 * `sorted` (by state), the slots held by one group's placed items (those
 * with a `place` in their `group`, a project) are filled by those items in
 * the person's order. Other groups' items, and unplaced ones, keep their
 * slots, and the bands keep their order. Only in a "name"
 * band (Working, Idle); an "oldest" band (Needs you, Done) keeps the
 * longest wait first.
 */
export function inPersonOrder(sorted, table = ATTENTION_TABLE) {
  const out = [...sorted];
  const slots = new Map();
  sorted.forEach((i, n) => {
    if (!placed(i) || rowOf(table, i.state).order !== "name") return;
    const k = `${i.state}\0${i.group}`;
    const at = slots.get(k) ?? [];
    at.push(n);
    slots.set(k, at);
  });
  for (const at of slots.values()) {
    const mine = at
      .map((n) => sorted[n])
      .sort((a, b) => a.place - b.place || byName(a, b) || byId(a, b));
    at.forEach((n, j) => (out[n] = mine[j]));
  }
  return out;
}

/** How many of each state, and the rail's and the bell's counts. */
export function attentionCounts(items, table = ATTENTION_TABLE) {
  const out = { needs: 0, done: 0, working: 0, idle: 0, rail: 0, bell: 0 };
  for (const i of items ?? []) {
    const s = ATTENTION_STATES.includes(i.state) ? i.state : "idle";
    out[s] += 1;
    if (table[s]?.rail) out.rail += 1;
    if (table[s]?.bell) out.bell += 1;
  }
  return out;
}
