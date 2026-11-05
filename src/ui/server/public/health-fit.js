/**
 * The header's health row on one line (an interim until the slice-3 status
 * chip): problems first, only whole items, and a "+N" chip for the rest.
 *
 * Each repo's state comes from health-rollup.js, the rule the graph and
 * `<cli> status` use too: "down", "degraded", "unknown" (nothing checked)
 * or "ok".
 *
 *   buildRow(rows, groups)  the row's model: application boxes, and every
 *                           repo flat, each in problem-first order
 *   planRow(…)              boxes when everything fits; otherwise repos flat,
 *                           problems placed first, as many as fit
 *   fitPlan(row, measured)  planRow guarded for the first frames: a
 *                           placeholder before data, everything (and a
 *                           retry) before the row has real widths
 *   moreChip(hidden)        the chip's text and accessible name
 *   mountMoreChip(doc, …)   the chip, and the list it opens
 *   paintGate(…)            when health data repaints the row: once per
 *                           first cycle, then debounced
 *
 * The pure parts take plain data, so tests need no browser.
 */
import { compareRepos, rollupRepo } from "./health-rollup.js";

const PROBLEM = new Set(["down", "degraded"]);

/**
 * The row's model from /api/health rows and the application grouping
 * (`[{ app, repos }]`, app null for repos with no box of their own).
 * Repos sort down, degraded, ok, then unknown; within a state the
 * focused workspace's first, then by name. A box sorts by its worst repo.
 */
export function buildRow(rows, groups) {
  const byRepo = new Map();
  for (const r of rows || []) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo).push(r);
  }
  const repoOf = new Map(
    [...byRepo].map(([repo, signals]) => {
      const rollup = rollupRepo(repo, signals);
      return [
        repo,
        {
          repo,
          state: rollup.state,
          rollup,
          focused: signals.some((s) => s.focused),
          items: signals,
        },
      ];
    }),
  );
  const flat = [...repoOf.values()].sort(compareRepos);
  const units = [];
  for (const { app, repos } of groups || [
    { app: null, repos: [...repoOf.keys()] },
  ]) {
    const members = repos
      .map((r) => repoOf.get(r))
      .filter(Boolean)
      .sort(compareRepos);
    if (!members.length) continue;
    if (!app)
      for (const m of members) units.push({ app: null, repos: [m], ...key(m) });
    else
      units.push({
        app,
        repos: members,
        ...key({
          state: members[0].state,
          focused: members.some((m) => m.focused),
          repo: app.name,
        }),
      });
  }
  units.sort(compareRepos);
  return { units, flat };
}

const key = (x) => ({ state: x.state, focused: x.focused, repo: x.repo });

/**
 * What the row shows in `avail` px.
 * - `boxed` (the width of every unit, boxes and all) fits: everything, boxed.
 * - Otherwise repos flat (`flat`: `{ key, state, width }` in row order). When
 *   they all fit, all of them; else, with room kept for the chip, first every
 *   down or degraded repo that fits (one too wide never blocks a later
 *   problem), and only then the rest in order, up to the first that doesn't
 *   fit. So a problem is never hidden while a healthy repo shows.
 * `chipWidth` is the chip's short form ("+N"): problems outrank the chip's
 * detail, which the header adds only if what's left has room for it.
 * Returns `{ mode: "boxed" | "flat", show: Set<key>, used }` (px taken,
 * chip included).
 */
export function planRow({ boxed, flat, avail, gap = 0, chipWidth = 0 }) {
  const all = new Set(flat.map((f) => f.key));
  if (boxed <= avail) return { mode: "boxed", show: all, used: boxed };
  const total =
    flat.reduce((a, f) => a + f.width, 0) + gap * Math.max(0, flat.length - 1);
  if (total <= avail) return { mode: "flat", show: all, used: total };
  const show = new Set();
  let used = chipWidth;
  const fits = (f) => used + f.width + gap <= avail;
  const problems = flat.filter((f) => PROBLEM.has(f.state));
  for (const f of problems)
    if (fits(f)) {
      show.add(f.key);
      used += f.width + gap;
    }
  if (show.size === problems.length)
    for (const f of flat) {
      if (PROBLEM.has(f.state)) continue;
      if (!fits(f)) break;
      show.add(f.key);
      used += f.width + gap;
    }
  return { mode: "flat", show, used };
}

/**
 * What the row shows given what the header measured, guarded for the first
 * frames of a cold load, so the row is never an empty box:
 * - no data yet (`row` null): `{ mode: "placeholder" }`, a neutral "…"
 *   beside the refresh button;
 * - nothing measured yet (no width for the row, or any repo 0px wide:
 *   not laid out yet): everything boxed, and `retry` so the header lays
 *   out again on the next frame;
 * - otherwise planRow, whose "flat" result always shows items or hides
 *   some behind the chip.
 * `measured` is `{ avail, boxed, widths, gap, chipWidth }`, `widths` in
 * `row.flat` order. With `chipWidthOf(text)` (the chip's width with that
 * text, gap included) instead of `chipWidth`, the plan sizes the chip
 * itself and also returns `hidden` and `form`, the richest chip text that
 * fits (an index into moreChip(hidden).forms; -1 when nothing is hidden).
 */
export function fitPlan(row, measured) {
  if (!row || !row.flat || !row.flat.length)
    return { mode: "placeholder", show: new Set(), used: 0, retry: false };
  const { avail, boxed, widths = [], gap = 0, chipWidth = 0 } = measured;
  const all = new Set(row.flat.map((r) => r.repo));
  const unmeasured =
    !(avail > 0) ||
    !(boxed > 0) ||
    widths.length !== row.flat.length ||
    widths.some((w) => !(w > 0));
  if (unmeasured) return { mode: "boxed", show: all, used: 0, retry: true };
  const plan = (cw) =>
    planRow({
      boxed,
      flat: row.flat.map((r, i) => ({
        key: r.repo,
        state: r.state,
        width: widths[i],
      })),
      avail,
      gap,
      chipWidth: cw,
    });
  const { chipWidthOf } = measured;
  if (typeof chipWidthOf !== "function")
    return { ...plan(chipWidth), retry: false };
  // The chip's room: bare "+N" first; when what that hides includes a
  // problem, plan again with room for the form that names it, so the chip
  // never hides a problem behind colour alone.
  const hiddenOf = (p) => row.flat.filter((r) => !p.show.has(r.repo));
  let cw = chipWidthOf(`+${row.flat.length}`);
  let p = plan(cw);
  for (let i = 0; i < 4; i++) {
    const hidden = hiddenOf(p);
    if (!hidden.length) break;
    const need = chipWidthOf(moreChip(hidden).short);
    if (need <= cw) break;
    cw = need;
    p = plan(cw);
  }
  const hidden = hiddenOf(p);
  let form = -1;
  if (hidden.length) {
    const { forms } = moreChip(hidden);
    form = forms.findIndex((t) => p.used - cw + chipWidthOf(t) <= avail);
    if (form < 0) form = forms.length - 1;
  }
  return { ...p, retry: false, hidden, form };
}

/**
 * "+3 · 1 down" / "3 more repos, 1 down": what the hidden repos hold.
 * `hidden` is the hidden repos, each `{ state }`.
 *
 * `forms` is the visible-text ladder, richest first: every hidden problem
 * ("+11 · 1 down, 1 degraded"), then the worst one ("+11 · 1 down"), then
 * compact ("+11 · ⚠2", every hidden problem counted). Down and degraded
 * are named the same way, never by colour alone; bare "+N" only when no
 * problem is hidden (0.3.0-dev.12, compact 0.3.0-dev.13). `short` is the
 * shortest form. The name and tooltip (`label`) always say it in full.
 */
export function moreChip(hidden) {
  const repos = hidden.length;
  const down = hidden.filter((h) => h.state === "down").length;
  const degraded = hidden.filter((h) => h.state === "degraded").length;
  const problems = [
    down ? `${down} down` : "",
    degraded ? `${degraded} degraded` : "",
  ].filter(Boolean);
  const forms = problems.length
    ? [
        ...new Set([
          `+${repos} · ${problems.join(", ")}`,
          `+${repos} · ${problems[0]}`,
          // Compact, for a row with room for little more than "+N" and the
          // refresh button: still never colour alone (0.3.0-dev.13).
          `+${repos} · ⚠${down + degraded}`,
        ]),
      ]
    : [`+${repos}`];
  const tail = problems.length ? `, ${problems.join(", ")}` : "";
  return {
    text: forms[0],
    forms,
    short: forms[forms.length - 1],
    label: `${repos} more ${repos === 1 ? "repo" : "repos"}${tail}`,
    problem: problems.length > 0,
  };
}

const LIST_ID = "health-more-list";

/**
 * The "+N" chip: a button that opens the hidden repos in a list. Escape or
 * a click elsewhere closes it, and Escape returns focus to the chip. The list
 * lives in <body> so the row's overflow never clips it.
 */
export function mountMoreChip(
  doc,
  hidden,
  renderList,
  { form = 0, reuse = null } = {},
) {
  const { text, forms, label, problem } = moreChip(hidden);
  // One chip node across re-fits (0.3.0-dev.12): a health tick or a font
  // load lays the row out again, and a new node would drop the focus and
  // the open list's anchor. The header hands back the chip it had.
  const chip =
    reuse ?? doc.getElementById("health-more") ?? doc.createElement("button");
  chip.id = "health-more";
  chip.type = "button";
  chip.className = `health-more${problem ? " problem" : ""}`;
  // A shorter form when the row has no room for all the detail; the name
  // and tooltip always carry it.
  chip.textContent =
    forms[Math.min(Math.max(form, 0), forms.length - 1)] ?? text;
  chip.title = label;
  chip.setAttribute("aria-label", label);
  chip.setAttribute("aria-haspopup", "true");
  chip.setAttribute("aria-controls", LIST_ID);
  const open = !!doc.getElementById(LIST_ID);
  chip.setAttribute("aria-expanded", String(open));
  chip._renderList = renderList;
  if (!chip._wired) {
    chip._wired = true;
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (doc.getElementById(LIST_ID)) closeMoreList(doc);
      else openMoreList(doc, chip, chip._renderList);
    });
  }
  // A repaint while the list is open keeps it open, with the new contents.
  if (open) openMoreList(doc, chip, renderList);
  return chip;
}

let _onKey = null;
let _onClick = null;

function openMoreList(doc, chip, renderList) {
  let list = doc.getElementById(LIST_ID);
  if (!list) {
    list = doc.createElement("div");
    list.id = LIST_ID;
    list.className = "health-more-list";
    list.setAttribute("role", "dialog");
    doc.body.appendChild(list);
  }
  list.setAttribute("aria-label", chip.getAttribute("aria-label"));
  renderList(list);
  const r = chip.getBoundingClientRect?.();
  if (r && list.style) {
    list.style.top = `${Math.round(r.bottom + 4)}px`;
    list.style.right = `${Math.max(8, Math.round((doc.documentElement.clientWidth ?? 0) - r.right))}px`;
  }
  chip.setAttribute("aria-expanded", "true");
  if (!_onKey) {
    _onKey = (e) => {
      if (e.key !== "Escape") return;
      closeMoreList(doc);
      doc.getElementById("health-more")?.focus();
    };
    _onClick = (e) => {
      const l = doc.getElementById(LIST_ID);
      const c = doc.getElementById("health-more");
      if (l && !l.contains(e.target) && !c?.contains(e.target))
        closeMoreList(doc);
    };
    doc.addEventListener("keydown", _onKey);
    doc.addEventListener("click", _onClick);
  }
}

/** Close the list (if open). */
export function closeMoreList(doc) {
  doc.getElementById(LIST_ID)?.remove();
  doc.getElementById("health-more")?.setAttribute("aria-expanded", "false");
  if (_onKey) {
    doc.removeEventListener?.("keydown", _onKey);
    doc.removeEventListener?.("click", _onClick);
    _onKey = _onClick = null;
  }
}

/**
 * When the header repaints the row from health data (0.3.0-dev.13). A
 * fresh load streamed results in batches and the row reshuffled with each
 * one, three or four times in as many seconds. Now:
 * - `hold()` starts a first cycle (a page load, an environment switch):
 *   data paints nothing (the row keeps its placeholder) until `done()`
 *   ends the cycle, or `cap` ms pass with a slow probe still out;
 * - after that, data paints at most once per `delay` ms of quiet (a
 *   trailing debounce), and so does the end of a later cycle.
 * Each call hands in the latest paint; only the last one runs. Resize and
 * font re-fits don't come through here: they lay the row out at once.
 * `timers` is `{ setTimeout, clearTimeout }`, globalThis by default, so
 * tests can use a fake clock.
 */
export function paintGate({
  delay = 300,
  cap = 8000,
  timers = globalThis,
} = {}) {
  let ready = true;
  let pending = null;
  let timer = null;
  let capTimer = null;
  const stop = (t) => t !== null && timers.clearTimeout(t);
  const fire = () => {
    stop(timer);
    timer = null;
    const paint = pending;
    pending = null;
    paint?.();
  };
  const settle = () => {
    stop(capTimer);
    capTimer = null;
    ready = true;
    fire();
  };
  return {
    get ready() {
      return ready;
    },
    hold() {
      ready = false;
      stop(timer);
      timer = null;
      stop(capTimer);
      capTimer = timers.setTimeout(settle, cap);
    },
    data(paint) {
      pending = paint;
      if (!ready) return;
      stop(timer);
      timer = timers.setTimeout(fire, delay);
    },
    done(paint) {
      if (paint) pending = paint;
      if (!ready) return settle();
      if (!pending) return;
      stop(timer);
      timer = timers.setTimeout(fire, delay);
    },
  };
}
