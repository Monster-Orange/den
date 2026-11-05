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
 * `row.flat` order.
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
  return {
    ...planRow({
      boxed,
      flat: row.flat.map((r, i) => ({
        key: r.repo,
        state: r.state,
        width: widths[i],
      })),
      avail,
      gap,
      chipWidth,
    }),
    retry: false,
  };
}

/**
 * "+3, 1 down" / "3 more repos, 1 down": what the hidden repos hold.
 * `hidden` is the hidden repos, each `{ state }`.
 */
export function moreChip(hidden) {
  const repos = hidden.length;
  const down = hidden.filter((h) => h.state === "down").length;
  const degraded = hidden.filter((h) => h.state === "degraded").length;
  const problems = [
    down ? `${down} down` : "",
    degraded ? `${degraded} degraded` : "",
  ].filter(Boolean);
  const tail = problems.length ? `, ${problems.join(", ")}` : "";
  // Richest first: every problem, the worst one, none. The header shows the
  // richest that fits; the name always has it all.
  const forms = [
    ...new Set([
      `+${repos}${tail}`,
      problems.length ? `+${repos}, ${problems[0]}` : `+${repos}`,
      `+${repos}`,
    ]),
  ];
  return {
    text: forms[0],
    forms,
    short: `+${repos}`,
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
export function mountMoreChip(doc, hidden, renderList, { form = 0 } = {}) {
  const { text, label, problem } = moreChip(hidden);
  const chip = doc.createElement("button");
  chip.id = "health-more";
  chip.type = "button";
  chip.className = `health-more${problem ? " problem" : ""}`;
  // A shorter form when the row has no room for all the detail; the name
  // and tooltip always carry it.
  const { forms } = moreChip(hidden);
  chip.textContent = forms[Math.min(form, forms.length - 1)] ?? text;
  chip.title = label;
  chip.setAttribute("aria-label", label);
  chip.setAttribute("aria-haspopup", "true");
  chip.setAttribute("aria-controls", LIST_ID);
  const open = !!doc.getElementById(LIST_ID);
  chip.setAttribute("aria-expanded", String(open));
  chip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (doc.getElementById(LIST_ID)) closeMoreList(doc);
    else openMoreList(doc, chip, renderList);
  });
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
