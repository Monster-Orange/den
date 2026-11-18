/**
 * Issue 81: the Report sweep's page side (report-sweep-lib.ts runs these
 * in the page with page.evaluate). Plain JavaScript: they touch the DOM,
 * which the tests' type check (ES lib only) doesn't know.
 */

/**
 * Every pop-up showing now with no visible Report entry of its own (or of
 * the pop-up it is part of), as `tag.class#id`. The form itself, the
 * working pop-up (its own Report) and the bell's inline ask go without.
 * Menus count. An inert Report (behind a modal) doesn't.
 */
export function missingReports() {
  const LAYER =
    'dialog, [role="dialog"], [role="alertdialog"], [role="menu"], .den-drawer';
  const MAY = ".fb-dlg, .bz-dlg, .den-bell-ask";
  // A box with display: contents (the rail's drawer box) has no rect of
  // its own: its children's.
  const rectOf = (el) => {
    if (getComputedStyle(el).display !== "contents")
      return el.getBoundingClientRect();
    const rs = [...el.children].map(rectOf).filter((r) => r.width && r.height);
    if (!rs.length) return new DOMRect();
    const l = Math.min(...rs.map((r) => r.left));
    const t = Math.min(...rs.map((r) => r.top));
    return new DOMRect(
      l,
      t,
      Math.max(...rs.map((r) => r.right)) - l,
      Math.max(...rs.map((r) => r.bottom)) - t,
    );
  };
  const seen = (el) => {
    if (el.closest("[inert]")) return false;
    const r = rectOf(el);
    if (!r.width || !r.height) return false;
    if (r.bottom <= 0 || r.right <= 0) return false;
    if (r.top >= innerHeight || r.left >= innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && Number(cs.opacity) !== 0;
  };
  const out = [];
  for (const el of document.querySelectorAll(LAYER)) {
    if (el.matches(MAY) || el.closest(MAY)) continue;
    if (el.tagName === "DIALOG" && !el.open) {
      let pop = false;
      try {
        pop = el.matches(":popover-open");
      } catch {
        /* no popovers */
      }
      if (!pop) continue;
    }
    if (el.hidden || el.closest("[hidden]") || !seen(el)) continue;
    const host = el.parentElement?.closest(LAYER);
    const has = (x) => [...x.querySelectorAll("[data-den-report]")].some(seen);
    if (has(el) || (host && has(host))) continue;
    out.push(
      `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}${el.id ? "#" + el.id : ""}`,
    );
  }
  return out;
}

/** The top bar's Report, visible (laid out, in the window, not inert). */
export function topReportShows() {
  return [...document.querySelectorAll(".den-top [data-den-report]")].some(
    (b) => {
      if (b.closest("[inert]")) return false;
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right <= innerWidth + 1;
    },
  );
}

/** The phone drawer's scrim, clicked (closes the drawer), if it is there. */
export function clickScrim() {
  document.querySelector(".den-scrim")?.click();
}

/** Two frames: the injector's, and one for a pop-up that repaints. */
export function twoFrames() {
  return new Promise((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
  );
}

/**
 * The shell's openers that show now, as [what, selector]: the status
 * drawer, the bell, the user menu (◐ ▾), each scope crumb, and the ☰
 * button (the rail drawer, below 720 px).
 */
export function shellOpeners() {
  const vis = (e) => {
    const r = e?.getBoundingClientRect();
    return !!r && r.width > 0 && r.height > 0;
  };
  const out = [];
  for (const [what, sel] of [
    ["status drawer", "#den-status"],
    ["bell", "#den-bell"],
    ["user menu", "#appearance-btn"],
  ])
    if (vis(document.querySelector(sel))) out.push([what, sel]);
  for (const b of document.querySelectorAll(".den-top button[data-scope]"))
    if (vis(b))
      out.push([
        `scope menu ${b.dataset.scope}`,
        `.den-top button[data-scope="${b.dataset.scope}"]`,
      ]);
  if (vis(document.querySelector("#den-menu-btn")))
    out.push(["rail drawer", "#den-menu-btn"]);
  return out;
}

/** Every page the nav registry leads to (denShell.pages()), as paths. */
export function navPages() {
  return window.denShell
    .pages()
    .map((x) => new URL(x.href, location.origin).pathname);
}

/** The shell is up. */
export function shellUp() {
  return !!window.denShell;
}
