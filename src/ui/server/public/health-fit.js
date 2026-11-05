/**
 * The header's health row on one line (an interim until the slice-3 status
 * chip): problems first, only whole items, and a "+N" chip for the rest.
 *
 * A unit is one top-level item of the row: a repo, or an application's box
 * of repos. Its state is its worst repo's: "err" (down), "running"
 * (degraded), "" (unknown, no health check) or "ok".
 *
 *   orderByProblem(units)   down, degraded, unknown, then healthy; stable
 *   fitUnits(widths, avail, { gap, chipWidth })
 *                           how many units (in order) fit whole
 *   moreChip(hidden)        the chip's text and accessible name
 *   mountMoreChip(doc, …)   the chip, and the list it opens
 *
 * The pure parts take plain data, so tests need no browser.
 */

const RANK = { err: 0, running: 1, "": 2, ok: 3 };

/** Problems first; equal states keep their order (the server's graph rank). */
export function orderByProblem(units) {
  return units
    .map((u, i) => ({ u, i }))
    .sort(
      (a, b) =>
        (RANK[a.u.state ?? ""] ?? 2) - (RANK[b.u.state ?? ""] ?? 2) ||
        a.i - b.i,
    )
    .map((x) => x.u);
}

/**
 * How many units, taken in order, fit whole in `avail` px. When all of them
 * fit, all show and there is no chip. Otherwise room is kept for the chip
 * and the first unit that doesn't fit ends the row: a later, smaller unit
 * never jumps ahead of it, so a problem is never hidden behind a healthy
 * repo.
 */
export function fitUnits(widths, avail, { gap = 0, chipWidth = 0 } = {}) {
  const total =
    widths.reduce((a, w) => a + w, 0) + gap * Math.max(0, widths.length - 1);
  if (total <= avail) return widths.length;
  let used = chipWidth;
  let n = 0;
  for (const w of widths) {
    if (used + w + gap > avail) break;
    used += w + gap;
    n++;
  }
  return n;
}

/** "+3, 1 down" / "3 more repos, 1 down": what the hidden repos hold. */
export function moreChip(hidden) {
  const repos = hidden.reduce((a, u) => a + (u.repos ?? 1), 0);
  const down = hidden.reduce((a, u) => a + (u.down ?? 0), 0);
  const degraded = hidden.reduce((a, u) => a + (u.degraded ?? 0), 0);
  const problems = [
    down ? `${down} down` : "",
    degraded ? `${degraded} degraded` : "",
  ].filter(Boolean);
  const tail = problems.length ? `, ${problems.join(", ")}` : "";
  return {
    text: `+${repos}${tail}`,
    label: `${repos} more ${repos === 1 ? "repo" : "repos"}${tail}`,
    problem: problems.length > 0,
  };
}

const LIST_ID = "health-more-list";

/**
 * The "+N" chip: a button that opens the hidden units in a list. Escape or
 * a click elsewhere closes it, and Escape returns focus to the chip. The list
 * lives in <body> so the row's overflow never clips it.
 */
export function mountMoreChip(doc, hidden, renderList) {
  const { text, label, problem } = moreChip(hidden);
  const chip = doc.createElement("button");
  chip.id = "health-more";
  chip.type = "button";
  chip.className = `health-more${problem ? " problem" : ""}`;
  chip.textContent = text;
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
