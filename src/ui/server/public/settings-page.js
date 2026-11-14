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
import { projectLabel } from "./workspace-picker.js";

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
const SWATCHES = ["accent", "ok", "warn", "bad", "bg", "surface", "text"];

/**
 * Mount the page into `root` (#den-content's settings markup). `deps`:
 * { shell, appearance: { ensureAppearance, setAppearance } }.
 */
export async function mountSettings(deps) {
  const shell = deps.shell;
  /** A catalog word (0.4.45: the page's own words go through it). */
  const L = (k, v) => shell.t(k, v);
  /** A project's name as it shows (Hub's when linked; 0.4.45). */
  let wsPayload = null;
  const wsName = (slug) => (wsPayload ? projectLabel(wsPayload, slug) : slug);
  const $ = (id) => document.getElementById(id);
  const body = $("set-body");
  const navEl = $("set-nav");
  navEl.setAttribute("aria-label", shell.t("set.ui.cats"));
  const search = $("set-q");
  const count = $("set-count");
  const scroller = $("den-content");

  const ctx = {
    data: {},
    appearance: {},
    scope: null,
    workspace: null,
    workspaces: [],
    wsSettings: null,
    shell,
    post,
    setAppearance: async (patch) => {
      await deps.appearance.setAppearance(patch);
      ctx.appearance = deps.appearance.appearanceState();
      return true;
    },
    saveWorkspace,
  };

  async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  }
  /** POST /api/settings; merges the reply. true when saved. */
  async function post(patch) {
    const r = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) return false;
    const reply = await r.json().catch(() => ({}));
    // Every setting the reply returns (0.4.13): a fixed list here left a
    // new row's pressed button on its old value until a reload.
    for (const [k, v] of Object.entries(reply))
      if (k !== "ok" && v !== undefined) ctx.data[k] = v;
    return true;
  }
  async function saveWorkspace(patch) {
    if (!ctx.workspace) return false;
    const r = await fetch("/api/workspaces/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace: ctx.workspace, ...patch }),
    });
    if (!r.ok) return false;
    const reply = await r.json().catch(() => ({}));
    ctx.wsSettings = { editor: reply.editor ?? null };
    return true;
  }
  async function loadWorkspaceSettings() {
    // 0.4.1: under an invalid config it answers 422; the rows show none.
    if (window.denShell?.configInvalid?.() === true) {
      ctx.wsSettings = null;
      return;
    }
    ctx.wsSettings = ctx.workspace
      ? await getJson(
          `/api/workspaces/settings?workspace=${encodeURIComponent(ctx.workspace)}`,
        ).catch(() => null)
      : null;
  }

  // Everything the rows read, read once (GET only).
  const [data, appearance, scope] = await Promise.all([
    getJson("/api/settings").catch(() => null),
    deps.appearance.ensureAppearance().catch(() => ({})),
    getJson("/api/scope").catch(() => null),
  ]);
  // 0.4.1: under an invalid config /api/workspaces answers 422; slugs then.
  wsPayload =
    shell.configInvalid?.() === true
      ? null
      : await getJson("/api/workspaces").catch(() => null);
  if (!data) {
    body.innerHTML = `<div class="empty"><b>${esc(L("set.ui.loadFailed"))}</b> ${esc(L("set.ui.reload"))}</div>`;
    return;
  }
  ctx.data = data;
  ctx.appearance = appearance;
  ctx.scope = scope;
  // The Workspace rows follow the view; with All active, they ask which.
  ctx.workspaces = scope?.inView || [];
  const askWs = !scope || scope.scope === "all";
  const q = new URLSearchParams(location.search);
  // #80: ?project=, with ?ws= read as its old name.
  const wanted = q.get("project") || q.get("ws");
  ctx.workspace = !askWs
    ? scope.scope
    : ctx.workspaces.includes(wanted)
      ? wanted
      : ctx.workspaces.includes(scope?.focus)
        ? scope.focus
        : (ctx.workspaces[0] ?? null);
  ctx.askWorkspace = askWs && ctx.workspaces.length > 0;
  await loadWorkspaceSettings();

  let state = readLocation(location);
  search.value = state.q;

  // ── drawing ─────────────────────────────────────────────────────────
  function tag(from) {
    return from
      ? ` <span class="den-tagx" title="${esc(L("set.ui.from", { from }))}">${esc(from)}</span>`
      : "";
  }
  function currentCategory(list) {
    const ids = list.map((s) => s.category.id);
    return ids.includes(state.category) ? state.category : (ids[0] ?? null);
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
    return sections(
      shell.settingsCategories().map((c) => localizeCategory(c, tr)),
      shell.settings().map((r) => localizeRow(r, tr)),
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
        ` <button type="button" class="btn sm" data-clear>${esc(L("set.ui.clearSearch"))}</button></div>`;
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
      `<h3 id="h-${esc(c.id)}">${esc(c.label)}${tag(c.from)}</h3>` +
      (c.description ? `<p>${esc(c.description)}</p>` : "") +
      ws +
      none +
      rows.map(drawRow).join("") +
      "</section>"
    );
  }
  function value(r) {
    try {
      return r.read(ctx);
    } catch {
      return undefined;
    }
  }
  function opts(o) {
    const v = typeof o === "function" ? o(ctx) : o;
    return Array.isArray(v) ? v : [];
  }
  // A custom control draws itself (it may act through its own API rather
  // than save a value: Settings › Access), so it renders whether or not the
  // row has a write.
  function drawsItself(r) {
    return (
      r.control?.type === "custom" && typeof r.control.render === "function"
    );
  }
  function drawRow(r) {
    const id = slug(r.id);
    const lid = `l-${id}`;
    const cid = `c-${id}`;
    const did = `d-${id}`;
    const v = value(r);
    const t = r.control?.type || "readonly";
    const ro = !r.write && !drawsItself(r);
    const single = ["number", "select", "toggle", "text"].includes(t);
    const label = single
      ? `<label class="l" id="${lid}" for="${cid}">${esc(r.label)}</label>`
      : `<span class="l" id="${lid}">${esc(r.label)}</span>`;
    const desc = `aria-describedby="${did}"`;
    let ctl = "";
    if (ro || t === "readonly") {
      ctl = `<output class="set-ro" id="${cid}" aria-labelledby="${lid}" ${desc}>${esc(v ?? "")}</output>`;
    } else if (t === "seg" || t === "theme") {
      ctl =
        `<div class="seg" role="group" aria-labelledby="${lid}" ${desc}>` +
        opts(r.control.options)
          .map(
            (o) =>
              `<button type="button" data-v="${esc(o.value)}" data-focus-key="${id}:${esc(o.value)}" aria-pressed="${String(o.value) === String(v) || !!o.selected}">${esc(o.label)}</button>`,
          )
          .join("") +
        "</div>";
      if (t === "theme") {
        const notice = r.control.notice?.(ctx);
        ctl +=
          (notice
            ? `<p class="set-warn" role="status">${esc(notice)}</p>`
            : "") +
          `<div class="swatches" aria-label="${esc(L("set.ui.swatches"))}" role="img">${swatches()}</div>`;
      }
    } else if (t === "radio") {
      ctl =
        `<div class="set-radios" role="radiogroup" aria-labelledby="${lid}" ${desc}>` +
        opts(r.control.options)
          .map(
            (o) =>
              `<label class="set-radio${o.disabled ? " off" : ""}"><input type="radio" name="${cid}" value="${esc(o.value)}" data-focus-key="${id}:${esc(o.value)}"${String(o.value) === String(v) ? " checked" : ""}${o.disabled ? " disabled" : ""}>` +
              `<span>${esc(o.label)}</span>${(o.tags || [])
                .filter(Boolean)
                .map((x) => `<span class="set-tag">${esc(x)}</span>`)
                .join("")}</label>`,
          )
          .join("") +
        "</div>";
    } else if (t === "select") {
      ctl =
        `<select id="${cid}" data-focus-key="${id}" ${desc}>` +
        opts(r.control.options)
          .map(
            (o) =>
              `<option value="${esc(o.value)}"${String(o.value) === String(v) ? " selected" : ""}>${esc(o.label)}</option>`,
          )
          .join("") +
        "</select>";
    } else if (t === "number") {
      const c = r.control;
      ctl =
        `<input type="number" id="${cid}" data-focus-key="${id}" value="${esc(v)}"` +
        (c.min != null ? ` min="${c.min}"` : "") +
        (c.max != null ? ` max="${c.max}"` : "") +
        (c.step != null ? ` step="${c.step}"` : "") +
        ` ${desc}>` +
        (c.unit
          ? `<span class="set-unit" aria-hidden="true">${esc(c.unit)}</span>`
          : "");
    } else if (t === "text") {
      ctl = `<input type="text" id="${cid}" data-focus-key="${id}" value="${esc(v)}" ${desc}>`;
    } else if (t === "toggle") {
      ctl = `<input type="checkbox" class="set-check" id="${cid}" data-focus-key="${id}"${v ? " checked" : ""} ${desc}>`;
      // Bell v6: a switch may say what being off means (waiting).
      const notice = r.control.notice?.(ctx);
      if (notice) ctl += `<p class="set-warn" role="status">${esc(notice)}</p>`;
    } else if (t === "langmap") {
      const map = v || {};
      const eds = opts(r.control.options);
      ctl =
        `<div class="set-langs" role="group" aria-labelledby="${lid}" ${desc}>` +
        opts(r.control.languages)
          .map((l) => {
            const sid = `${cid}-${slug(l.key)}`;
            return (
              `<div class="set-lang"><label for="${sid}">${esc(l.name)}</label>` +
              `<select id="${sid}" data-lang="${esc(l.key)}" data-focus-key="${sid}">` +
              `<option value="">${esc(L("set.ui.inherit"))}</option>` +
              eds
                .map(
                  (e) =>
                    `<option value="${esc(e.value)}"${map[l.key] === e.value ? " selected" : ""}>${esc(e.label)}</option>`,
                )
                .join("") +
              "</select></div>"
            );
          })
          .join("") +
        "</div>";
    } else if (t === "navlist") {
      ctl = navlist(r, v, lid, desc);
    } else if (t === "pins") {
      const pins = v || [];
      ctl = pins.length
        ? `<div class="navlist" role="list" aria-labelledby="${lid}" ${desc}>` +
          pins
            .map(
              (p, i) =>
                `<div class="it" role="listitem"><span class="nm den-mono">${esc(p)}</span>` +
                `<button type="button" class="btn sm" data-pin-move="${esc(p)}" data-d="-1" data-focus-key="pin-up-${esc(p)}"${i === 0 ? " disabled" : ""} aria-label="${esc(L("set.ui.moveUp", { name: p }))}">↑</button>` +
                `<button type="button" class="btn sm" data-pin-move="${esc(p)}" data-d="1" data-focus-key="pin-down-${esc(p)}"${i === pins.length - 1 ? " disabled" : ""} aria-label="${esc(L("set.ui.moveDown", { name: p }))}">↓</button>` +
                `<button type="button" class="btn sm" data-pin-remove="${esc(p)}" data-focus-key="pin-x-${esc(p)}" aria-label="${esc(L("set.ui.unpinX", { name: p }))}">${esc(L("act.unpin"))}</button></div>`,
            )
            .join("") +
          "</div>"
        : `<output class="set-ro" aria-labelledby="${lid}" ${desc}>${esc(L("set.ui.noPins"))}</output>`;
    } else if (t === "workspace-editor") {
      ctl = wsEditor(v, lid, cid, desc);
    } else if (t === "custom") {
      ctl = `<div class="set-custom" id="${cid}" role="group" aria-labelledby="${lid}" ${desc}></div>`;
    }
    const dist = r.scope === "distribution";
    const note = dist
      ? ` ${esc(
          ctx.data.distribution?.file
            ? L("set.ui.setByIn", { file: ctx.data.distribution.file })
            : L("set.ui.setBy"),
        )}`
      : "";
    return (
      `<div class="set-row" id="setting-${id}" data-setting="${esc(r.id)}" data-scope="${esc(r.scope)}">` +
      `<div class="row">${label}<div class="ctl">${ctl}</div>` +
      `<span class="set-scope" data-scope="${esc(r.scope)}">${esc(scopeText(r, ctx.workspace ? wsName(ctx.workspace) : null, L))}</span></div>` +
      // helpInControl: the control shows its own help line (mock v6);
      // the description stays for screen readers.
      `<div class="d${r.helpInControl ? " den-sr" : ""}" id="${did}">${esc(r.description)}${note}${tag(r.from)}</div>` +
      `<span class="set-saved" role="status" id="s-${id}"></span>` +
      "</div>"
    );
  }
  function navlist(r, v, lid, desc) {
    const hidden = (v && v.hidden) || [];
    const items = shell.orderedNav();
    const groups = shell.groups();
    const gl = (id) => {
      const g = groups.find((x) => x.id === id);
      return g ? shell.t(g.label) : id;
    };
    return (
      `<div class="navlist" role="list" aria-labelledby="${lid}" ${desc}>` +
      items
        .map((n, i) => {
          const off = hidden.includes(n.id);
          const name = shell.t(n.label);
          const sameGroup = (j) => items[j] && items[j].group === n.group;
          return (
            `<div class="it${off ? " off" : ""}" role="listitem"><span class="nm">${esc(name)} <span class="set-grp">· ${esc(gl(n.group))}</span>${tag(n.from)}</span>` +
            `<button type="button" class="btn sm" data-move="${esc(n.id)}" data-d="-1" data-focus-key="nav-up-${esc(n.id)}"${sameGroup(i - 1) ? "" : " disabled"} aria-label="${esc(L("set.ui.moveUp", { name }))}">↑</button>` +
            `<button type="button" class="btn sm" data-move="${esc(n.id)}" data-d="1" data-focus-key="nav-down-${esc(n.id)}"${sameGroup(i + 1) ? "" : " disabled"} aria-label="${esc(L("set.ui.moveDown", { name }))}">↓</button>` +
            `<button type="button" class="btn sm" data-hide="${esc(n.id)}" data-focus-key="nav-hide-${esc(n.id)}" aria-pressed="${off}" aria-label="${esc(L(off ? "set.ui.showX" : "set.ui.hideX", { name }))}">${esc(L(off ? "set.ui.show" : "set.ui.hide"))}</button></div>`
          );
        })
        .join("") +
      "</div>"
    );
  }
  function wsEditor(v, lid, cid, desc) {
    if (!ctx.workspace)
      return `<output class="set-ro" aria-labelledby="${lid}" ${desc}>${esc(L("set.ui.noProject"))}</output>`;
    const eds = ctx.data.editors || [];
    const def =
      eds.find(
        (e) => e.key === (ctx.data.editor ?? eds.find((x) => x.available)?.key),
      )?.name || L("set.ui.none");
    const radio = (val, name, tagText) =>
      `<label class="set-radio"><input type="radio" name="${cid}" value="${esc(val)}" data-focus-key="ws-ed-${esc(val)}"${(v || "") === val ? " checked" : ""}>` +
      `<span>${esc(name)}</span>${tagText ? `<span class="set-tag">${esc(tagText)}</span>` : ""}</label>`;
    return (
      `<div class="set-radios" role="radiogroup" aria-labelledby="${lid}" ${desc}>` +
      radio("", L("set.ui.default"), def) +
      eds
        .filter((e) => e.available)
        .map((e) =>
          radio(e.key, e.name, e.terminal ? L("set.ui.terminalTag") : null),
        )
        .join("") +
      "</div>"
    );
  }
  function swatches() {
    const cs = getComputedStyle(document.documentElement);
    return SWATCHES.map((n) => {
      const c = cs.getPropertyValue(`--${n}`).trim();
      return `<div class="sw" style="background:${esc(c)}" title="--${n} ${esc(c)}"><span>${esc(n)}</span></div>`;
    }).join("");
  }

  // ── writing: only on an explicit change ────────────────────────────────
  async function save(r, v) {
    const el = $(`s-${slug(r.id)}`);
    let ok = false;
    try {
      ok = (await r.write(v, ctx)) !== false;
    } catch {
      ok = false;
    }
    draw();
    const again = $(`s-${slug(r.id)}`) || el;
    if (!again) return;
    again.className = "set-saved " + (ok ? "ok" : "bad");
    again.textContent = L(ok ? "set.ui.saved" : "set.ui.saveFailed");
    if (ok)
      setTimeout(() => {
        if (again.isConnected) again.textContent = "";
      }, 2000);
  }
  function wireRow(r) {
    if (!r.write && !drawsItself(r)) return;
    const row = $(`setting-${slug(r.id)}`);
    if (!row) return;
    const t = r.control?.type;
    if (t === "seg" || t === "theme")
      row.querySelectorAll(".seg button").forEach((b) =>
        b.addEventListener("click", () => {
          if (b.getAttribute("aria-pressed") === "true") return;
          save(r, b.dataset.v);
        }),
      );
    else if (t === "radio")
      row
        .querySelectorAll('input[type="radio"]')
        .forEach((i) => i.addEventListener("change", () => save(r, i.value)));
    else if (t === "select" || t === "text")
      row
        .querySelector(".ctl select, .ctl input")
        ?.addEventListener("change", (e) => save(r, e.target.value));
    else if (t === "number")
      row.querySelector(".ctl input")?.addEventListener("change", (e) => {
        const n = Number(e.target.value);
        if (!Number.isFinite(n)) return;
        const c = r.control;
        if ((c.min != null && n < c.min) || (c.max != null && n > c.max)) {
          e.target.reportValidity?.();
          return;
        }
        save(r, n);
      });
    else if (t === "toggle")
      row
        .querySelector(".ctl input")
        ?.addEventListener("change", (e) => save(r, e.target.checked));
    else if (t === "langmap")
      row.querySelectorAll("select[data-lang]").forEach((s) =>
        s.addEventListener("change", () => {
          const map = {};
          row.querySelectorAll("select[data-lang]").forEach((x) => {
            if (x.value) map[x.dataset.lang] = x.value;
          });
          save(r, map);
        }),
      );
    else if (t === "navlist")
      row.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b || b.disabled) return;
        const cur = value(r) || { hidden: [], order: [] };
        if (b.dataset.hide) {
          const id = b.dataset.hide;
          const hidden = cur.hidden.includes(id)
            ? cur.hidden.filter((x) => x !== id)
            : [...cur.hidden, id];
          save(r, { hidden });
        } else if (b.dataset.move) {
          const ids = shell.orderedNav().map((n) => n.id);
          const i = ids.indexOf(b.dataset.move);
          const j = i + Number(b.dataset.d);
          if (i < 0 || j < 0 || j >= ids.length) return;
          [ids[i], ids[j]] = [ids[j], ids[i]];
          save(r, { order: ids });
        }
      });
    else if (t === "pins")
      row.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b || b.disabled) return;
        const pins = (value(r) || []).slice();
        if (b.dataset.pinRemove)
          save(
            r,
            pins.filter((p) => p !== b.dataset.pinRemove),
          );
        else if (b.dataset.pinMove) {
          const i = pins.indexOf(b.dataset.pinMove);
          const j = i + Number(b.dataset.d);
          if (i < 0 || j < 0 || j >= pins.length) return;
          [pins[i], pins[j]] = [pins[j], pins[i]];
          save(r, pins);
        }
      });
    else if (t === "workspace-editor")
      // Saves on change, like every other row (SA's dev.20 run: a
      // separate Save gave no sign that a choice was not saved yet).
      row.addEventListener("change", (e) => {
        if (e.target.type === "radio" && e.target.checked)
          save(r, e.target.value);
      });
    else if (t === "custom" && typeof r.control.render === "function") {
      const host = row.querySelector(".set-custom");
      r.control.render(host, ctx, {
        value: value(r),
        save: (v) => save(r, v),
      });
    }
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
    if (!state.category) return;
    scrollToCategory(cur);
    if (!state.q) focusHeading(cur);
  };
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
  const hasScrollEnd = scroller && "onscrollend" in scroller;
  function unlock() {
    if (!locked) return;
    locked = null;
    clearTimeout(lockTimer);
    spy();
  }
  function lockCurrent(id) {
    locked = id;
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
