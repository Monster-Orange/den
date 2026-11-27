/**
 * The Settings page (R21, 0.3.0-dev.19): /settings, inside the shell. The
 * prototype's look (den-shell.html: page header, sections, rows, segmented
 * buttons, swatches, the navigation list) applied to every row of the
 * SETTINGS registry (shell.js), with:
 *
 *   - categories on the left (a nav, the current one aria-current) and
 *     their rows on the right, one section per category;
 *   - a search box (/ focuses it) that filters rows by label, description
 *     and keywords: a match stays under its category's heading, empty
 *     categories hide, and "No settings match" shows when nothing does;
 *     the count is announced (aria-live polite);
 *   - the URL keeps #<category> and ?q=, so a setting can be linked to,
 *     and reload and back/forward work.
 *
 * Nothing writes except an explicit change: loading, searching, moving
 * between categories and changing the hash or query read only. A control
 * writes on its change (the per-workspace editor on Save, as before), and
 * says "✓ Saved" or "✗ Save failed".
 *
 * The pure parts (matching, filtering, the URL) are exported for tests.
 */

/** The search's terms: lower-case words, every one of which must match. */
import { rowKit, settingsCtx } from "./settings-rows.js";

export function terms(q) {
  return String(q || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Whether a row matches the query (its label, description and keywords). */
export function rowMatches(row, q) {
  const ts = terms(q);
  if (!ts.length) return true;
  const hay = [
    row.label,
    row.description,
    // The English too: the palette's ?q= is a row's English label.
    row.en?.label,
    row.en?.description,
    ...(row.keywords || []),
  ]
    .join(" ")
    .toLowerCase();
  return ts.every((t) => hay.includes(t));
}

/**
 * A row in the page's language (0.4.45): its label (set.<id>), description
 * (set.<id>.d) and option labels (set.<id>.o.<value>) through `tr`
 * (window.denShell.tr): a built-in row reads the catalogs; a row a
 * distribution or plugin adds may bring its own as `messages`
 * ({ es: { "set.<id>": … }, ja: … }), else it shows its English. The
 * English stays on `en` for search.
 */
export function localizeRow(r, tr) {
  if (typeof tr !== "function") return r;
  const k = `set.${r.id}`;
  const own = r.messages;
  const control =
    r.control && Array.isArray(r.control.options)
      ? {
          ...r.control,
          options: r.control.options.map((o) => ({
            ...o,
            label: tr(`${k}.o.${o.value}`, o.label, own),
          })),
        }
      : r.control;
  return {
    ...r,
    en: { label: r.label, description: r.description },
    label: tr(k, r.label, own),
    description: tr(`${k}.d`, r.description, own),
    control,
  };
}

/** A category in the page's language: setc.<id> and setc.<id>.d. */
export function localizeCategory(c, tr) {
  if (typeof tr !== "function") return c;
  const k = `setc.${c.id}`;
  return {
    ...c,
    label: tr(k, c.label, c.messages),
    description: tr(`${k}.d`, c.description, c.messages),
  };
}

/**
 * The sections to draw: each category (by order) with its matching rows
 * (by order, then registration), empty ones left out. Rows whose category
 * isn't registered wait for it.
 */
export function sections(categories, rows, q) {
  const out = [];
  const ordered = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r.order ?? 100) - (b.r.order ?? 100) || a.i - b.i)
    .map((x) => x.r);
  for (const c of categories) {
    const rs = ordered.filter((r) => r.category === c.id && rowMatches(r, q));
    if (rs.length) out.push({ category: c, rows: rs });
  }
  return out;
}

/** { category, q } from a location (its hash and ?q=). */
export function readLocation(loc) {
  const params = new URLSearchParams(loc.search || "");
  const hash = decodeURIComponent(String(loc.hash || "").replace(/^#/, ""));
  return { category: hash || null, q: params.get("q") || "" };
}

/** The URL for a category and query, keeping the other params. */
export function settingsUrl(loc, { category, q }) {
  const params = new URLSearchParams(loc.search || "");
  if (q) params.set("q", q);
  else params.delete("q");
  const search = params.toString();
  return (
    (loc.pathname || "/settings") +
    (search ? "?" + search : "") +
    (category ? "#" + encodeURIComponent(category) : "")
  );
}

/** The page's own en words, for where there is no shell (a unit test). */
const EN_FALLBACK = {
  "set.ui.countNone": "No settings match",
  "set.ui.count": "{n} settings match",
  "set.ui.count.one": "{n} setting matches",
  "set.ui.scopeDist": "Distribution · read-only",
  "set.ui.scopeWs": "Project setup · {ws}",
  "set.ui.scopeWsNone": "Project setup",
  "set.ui.scopeUser": "User",
};
function enT(key, vars) {
  const k =
    vars && vars.n === 1 && EN_FALLBACK[`${key}.one`] ? `${key}.one` : key;
  return String(EN_FALLBACK[k] ?? key).replace(/\{(\w+)\}/g, (m, x) =>
    vars && vars[x] != null ? String(vars[x]) : m,
  );
}

/** "3 settings match" / "1 setting matches" / "No settings match". */
export function countText(n, t = enT) {
  if (!n) return t("set.ui.countNone");
  return t("set.ui.count", { n });
}

/**
 * The scope tag's text: User, Project setup · <project>, Distribution ·
 * read-only. `workspace` is the name the project shows (0.4.45).
 */
export function scopeText(row, workspace, t = enT) {
  if (row.scope === "distribution") return t("set.ui.scopeDist");
  if (row.scope === "workspace")
    return workspace
      ? t("set.ui.scopeWs", { ws: workspace })
      : t("set.ui.scopeWsNone");
  return t("set.ui.scopeUser");
}

// ── the page ──────────────────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const slug = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, "-");
/**
 * Issue 163: how long a link to a row or category keeps it in view while
 * content above it loads late (the persona list), at most. Any scroll,
 * key, click or touch of yours ends it sooner. A page-only constant, not
 * a Setting: it never limits anything, it only stops holding a place.
 */
export const ANCHOR_MS = 10_000;
/** How long the arrived-at row stays marked after it last moved. */
export const MARK_MS = 2_500;

/**
 * Mount the page into `root` (#den-content's settings markup). `deps`:
 * { shell, appearance: { ensureAppearance, setAppearance } }.
 */
export async function mountSettings(deps) {
  const shell = deps.shell;
  /** A catalog word (0.4.45: the page's own words go through it). */
  const L = (k, v) => shell.t(k, v);
  let ctx = null;
  const wsName = (slug) => ctx?.wsName ? ctx.wsName(slug) : slug;
  const $ = (id) => document.getElementById(id);
  const body = $("set-body");
  const navEl = $("set-nav");
  navEl.setAttribute("aria-label", shell.t("set.ui.cats"));
  const search = $("set-q");
  const count = $("set-count");
  const scroller = $("den-content");

  ctx = await settingsCtx(deps);
  if (!ctx) {
    body.innerHTML = `<div class="empty"><b>${esc(L("set.ui.loadFailed"))}</b> ${esc(L("set.ui.reload"))}</div>`;
    return;
  }
  const loadWorkspaceSettings = ctx.loadWorkspaceSettings;
  const kit = rowKit(ctx, { redraw: () => draw() });
  const { drawRow, wireRow, rowShown, tag } = kit;

  let state = readLocation(location);
  search.value = state.q;

  // ── drawing ─────────────────────────────────────────────────────────
  function currentCategory(list) {
    const ids = list.map((s) => s.category.id);
    if (ids.includes(state.category)) return state.category;
    // Issue 268: a row's id (/settings#agents.default_mode) is its category.
    const holds = list.find((s) => s.rows.some((r) => r.id === state.category));
    return holds ? holds.category.id : (ids[0] ?? null);
  }
  function drawNav(list) {
    const cur = currentCategory(list);
    navEl.innerHTML = list
      .map(
        ({ category: c, rows }) =>
          `<a class="set-ni" href="#${esc(c.id)}" data-cat="${esc(c.id)}"${c.id === cur ? ' aria-current="true"' : ""}>` +
          `<span class="set-ni-l">${esc(c.label)}</span>${tag(c.from)}` +
          (state.q
            ? `<span class="den-bdg" aria-label="${esc(L("set.ui.matching", { n: rows.length }))}">${rows.length}</span>`
            : "") +
          "</a>",
      )
      .join("");
  }
  /** The sections, in the page's language (0.4.45). */
  function localSections() {
    const tr = shell.tr;
    const rows = shell.settings().filter(rowShown);
    return sections(
      shell.settingsCategories().map((c) => localizeCategory(c, tr)),
      rows.map((r) => localizeRow(r, tr)),
      state.q,
    );
  }
  function draw() {
    const list = localSections();
    const total = list.reduce((n, s) => n + s.rows.length, 0);
    count.textContent = state.q ? countText(total, L) : "";
    drawNav(list);
    const keep = document.activeElement?.dataset?.focusKey || null;
    body.innerHTML = list.length
      ? list.map(drawSection).join("")
      : `<div class="empty" id="set-empty"><b>${esc(L("set.ui.noMatch", { q: state.q }))}</b>` +
        ` <button type="button" class="den-btn sm" data-clear>${esc(L("set.ui.clearSearch"))}</button></div>`;
    for (const { rows } of list) for (const r of rows) wireRow(r);
    if (keep) body.querySelector(`[data-focus-key="${keep}"]`)?.focus();
  }
  function drawSection({ category: c, rows }) {
    const ws =
      rows.some((r) => r.scope === "workspace") && ctx.askWorkspace
        ? `<div class="row set-ask"><label class="l" for="set-ws">${esc(L("set.ui.project"))}</label>` +
          `<select id="set-ws" data-focus-key="set-ws">${ctx.workspaces
            .map(
              (w) =>
                `<option value="${esc(w)}"${w === ctx.workspace ? " selected" : ""}>${esc(wsName(w))}</option>`,
            )
            .join("")}</select>` +
          `<span class="set-note">${esc(L("set.ui.pickProject"))}</span></div>`
        : "";
    const none =
      rows.some((r) => r.scope === "workspace") && !ctx.workspace
        ? `<p class="set-note">${esc(L("set.ui.noActive"))}</p>`
        : "";
    return (
      `<section id="cat-${esc(c.id)}" data-cat="${esc(c.id)}" aria-labelledby="h-${esc(c.id)}">` +
      `<h2 id="h-${esc(c.id)}">${esc(c.label)}${tag(c.from)}</h2>` +
      (c.description ? `<p>${esc(c.description)}</p>` : "") +
      ws +
      none +
      rows.map(drawRow).join("") +
      "</section>"
    );
  }

  // ── search, categories, the URL (all read-only) ────────────────────────
  function go({ category, q }, how) {
    state = { category: category ?? state.category, q: q ?? state.q };
    const url = settingsUrl(location, state);
    if (how === "push") history.pushState(null, "", url);
    else if (how === "replace") history.replaceState(null, "", url);
  }
  function scrollToCategory(id, smooth) {
    const el = id && $(`cat-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
  }
  function markCurrent(id) {
    navEl.querySelectorAll(".set-ni").forEach((a) => {
      if (a.dataset.cat === id) a.setAttribute("aria-current", "true");
      else a.removeAttribute("aria-current");
    });
  }
  search.addEventListener("input", () => {
    go({ q: search.value.trim() }, "replace");
    draw();
  });
  body.addEventListener("click", (e) => {
    if (e.target.closest("[data-clear]")) {
      search.value = "";
      go({ q: "" }, "replace");
      draw();
      search.focus();
    }
  });
  body.addEventListener("change", async (e) => {
    if (e.target.id !== "set-ws") return;
    // Which workspace the rows are about: a read, never a write.
    ctx.workspace = e.target.value;
    const params = new URLSearchParams(location.search);
    params.set("ws", ctx.workspace);
    history.replaceState(
      null,
      "",
      location.pathname + "?" + params.toString() + location.hash,
    );
    await loadWorkspaceSettings();
    draw();
  });
  navEl.addEventListener("click", (e) => {
    const a = e.target.closest(".set-ni");
    if (!a) return;
    e.preventDefault();
    go({ category: a.dataset.cat }, "push");
    markCurrent(a.dataset.cat);
    lockCurrent(a.dataset.cat);
    scrollToCategory(a.dataset.cat, true);
    focusHeading(a.dataset.cat);
  });
  // Arriving at a category (a link, the hash, back/forward) puts focus on
  // its heading, so a screen reader starts there. A search in the URL
  // keeps focus where it is.
  function focusHeading(id) {
    const h = id && $(`h-${id}`);
    if (!h) return;
    h.setAttribute("tabindex", "-1");
    h.focus({ preventScroll: true });
  }
  const arrive = () => {
    const cur = currentCategory(localSections());
    markCurrent(cur);
    // Plain /settings stays at the top: the title and the search box are
    // what you land on. Only a URL that names a category moves you to it.
    if (!state.category) {
      unanchor();
      return;
    }
    // Issue 268: a category's id, to its section; a row's id, to that row.
    const rowId = state.category !== cur ? slug(state.category) : null;
    anchorTo(
      () => (rowId ? $(`setting-${rowId}`) : $(`cat-${cur}`)),
      () => {
        if (state.q) return;
        if (!rowId) return focusHeading(cur);
        const l = $(`l-${rowId}`);
        if (!l) return;
        l.setAttribute("tabindex", "-1");
        l.focus({ preventScroll: true });
      },
    );
  };
  // Issue 163: the place a link arrived at holds while late content (the
  // persona list, a plugin's rows) loads above it, and waits for the row
  // if it isn't drawn yet. It lets go at your first scroll, key, click or
  // touch, or after ANCHOR_MS. The row is marked until it has stayed put
  // for MARK_MS.
  let anchor = null;
  const LET_GO = ["wheel", "keydown", "pointerdown", "touchstart"];
  function unanchor() {
    if (!anchor) return;
    const a = anchor;
    anchor = null;
    a.ro?.disconnect();
    a.mo.disconnect();
    clearTimeout(a.end);
    for (const ev of LET_GO)
      window.removeEventListener(ev, unanchor, { capture: true });
    // The mark stays a moment longer, so it can be seen.
    a.unmark();
  }
  function anchorTo(find, focus) {
    unanchor();
    let last = null;
    let markTimer = 0;
    let marked = null;
    let focused = false;
    const unmark = (later) => {
      clearTimeout(markTimer);
      const drop = () => marked?.classList.remove("set-arrived");
      if (later) markTimer = setTimeout(drop, MARK_MS);
      else drop();
    };
    const place = () => {
      const el = find();
      if (!el) return;
      if (marked !== el) {
        marked?.classList.remove("set-arrived");
        marked = el;
      }
      el.classList.add("set-arrived");
      const top = el.getBoundingClientRect().top;
      if (last === null || Math.abs(top - last) > 1) {
        el.scrollIntoView({ block: "start" });
        last = el.getBoundingClientRect().top;
      }
      if (!focused) {
        focused = true;
        focus();
      }
      unmark(true);
    };
    const a = {
      ro:
        typeof ResizeObserver === "function"
          ? new ResizeObserver(() => anchor === a && place())
          : null,
      // A redraw (a plugin's rows, the appearance) replaces the rows.
      mo: new MutationObserver(() => anchor === a && place()),
      end: setTimeout(unanchor, ANCHOR_MS),
      unmark: () => unmark(true),
    };
    anchor = a;
    a.ro?.observe(body);
    a.mo.observe(body, { childList: true });
    for (const ev of LET_GO)
      window.addEventListener(ev, unanchor, { capture: true, passive: true });
    place();
  }
  const fromUrl = () => {
    state = readLocation(location);
    if (search.value !== state.q) search.value = state.q;
    draw();
    arrive();
  };
  window.addEventListener("popstate", fromUrl);
  window.addEventListener("hashchange", fromUrl);
  // `/` focuses the search, unless you are typing somewhere.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    const tg = e.target;
    if (
      tg &&
      (tg.isContentEditable ||
        /^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName || ""))
    )
      return;
    e.preventDefault();
    search.focus();
    search.select();
  });
  // Your pick holds while the smooth scroll runs (SA's dev.21 run: the spy
  // walked aria-current through every category it passed). It lets go on
  // scrollend, or, where there is none, once the scroll has been still for
  // a while, at most ~1s after the last move; then the spy looks again.
  let locked = null;
  let lockTimer = 0;
  /** The page's height when the pick locked (den#143: it may grow). */
  let lockedHeight = 0;
  const hasScrollEnd = scroller && "onscrollend" in scroller;
  function unlock() {
    if (!locked) return;
    const id = locked;
    locked = null;
    clearTimeout(lockTimer);
    // den#143: rows that load late can grow the page while it scrolls, so
    // the scroll ends where your pick was, not where it is. Go there again,
    // only then: a scroll of your own is never undone.
    if (scroller && scroller.scrollHeight !== lockedHeight && offTarget(id))
      scrollToCategory(id, false);
    spy();
  }
  /** Whether section `id` is away from where a category click puts it. */
  function offTarget(id) {
    const el = $(`cat-${id}`);
    if (!el || !scroller) return false;
    const under =
      parseFloat(getComputedStyle(scroller).getPropertyValue("--set-top")) || 0;
    const box = scroller.getBoundingClientRect();
    const top = el.getBoundingClientRect().top - box.top - under;
    if (Math.abs(top) <= 8) return false;
    // At the foot, a short last section can't reach the header: in view is
    // where it goes.
    const atEnd =
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    return !(atEnd && top > 0 && top < scroller.clientHeight);
  }
  function lockCurrent(id) {
    locked = id;
    lockedHeight = scroller ? scroller.scrollHeight : 0;
    clearTimeout(lockTimer);
    // No scroll may come at all (already there): let go after ~1s.
    lockTimer = setTimeout(unlock, 1000);
  }
  scroller?.addEventListener("scrollend", unlock);
  // The section in view is the current one (the URL keeps your pick).
  scroller?.addEventListener("scroll", () => {
    if (locked) {
      markCurrent(locked);
      // Still moving: the fallback waits for the scroll to settle.
      clearTimeout(lockTimer);
      lockTimer = setTimeout(unlock, hasScrollEnd ? 1000 : 150);
      return;
    }
    spy();
  });
  function spy() {
    const box = scroller.getBoundingClientRect();
    // Below the sticky header (R21a): a section is current once it reaches
    // the header's foot, where a category click scrolls it to.
    const under =
      parseFloat(getComputedStyle(scroller).getPropertyValue("--set-top")) || 0;
    const top = box.top + under + 24;
    const all = [...body.querySelectorAll("section[data-cat]")];
    let cur = null;
    all.forEach((s) => {
      if (s.getBoundingClientRect().top <= top) cur = s.dataset.cat;
    });
    // At the bottom, the last short sections can never reach the line:
    // your pick (a click, the hash) wins if it is in view, else the last.
    const atEnd =
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
    if (atEnd && all.length) {
      const picked = all.find((s) => s.dataset.cat === state.category);
      const r = picked?.getBoundingClientRect();
      cur =
        r && r.top < box.bottom && r.bottom > box.top
          ? picked.dataset.cat
          : all[all.length - 1].dataset.cat;
    }
    if (cur) markCurrent(cur);
  }
  // The registry or the appearance changed (a plugin, the ◐ menu): repaint.
  window.addEventListener("den:settings", () => draw());
  window.addEventListener("den:appearance", () => {
    ctx.appearance = deps.appearance.appearanceState();
    draw();
  });
  window.addEventListener("den:pins", () => draw());

  draw();
  arrive();
  return ctx;
}
