/**
 * The Account area (issue 310, rescoped 11-19): the person's own place,
 * apart from Settings, drawn by the kit in every product from data. It is
 * an existing product's Account pop-up copied value for value (the approved mock
 * "Account area: Den and Den Hub", v2): a 240 px rail of sections with a
 * search box beside one pane, `?account=<section>` in the address, and on
 * a phone (under 768 px) a strip with the search box and a select.
 * Framework-free; every word is the kit's (kit.aa.* in strings.js), every
 * name, date and code is the host's data.
 *
 *   accountAreaHtml({
 *     id: "den-aa", lang: "en", current: "profile", now?,
 *     settingsHref,       the rail foot's "Install settings →" (none: left out)
 *     profile: { name?, login, role?, avatarUrl?, editHref?,
 *                how: "github" | "local" | "paired", since?,
 *                signOut?: { url, csrf },   a plain POST form (none: no
 *                                           Sign out, a local browser)
 *                signOutAll? },
 *     access: { github?: { login, linkedAt?, unlink? }, pair?,
 *               tokens?: [{ id, name, createdAt, lastUsedAt? }], newToken? },
 *     devices: { list?: [{ id, name, where?, lastSeen?, current? }],
 *                error?, waiting?: [{ code, minutes }], pair?, signOutAll? },
 *     notifications?: [{ id, label, help?, on }],
 *   }) → string    (pure: runs in Node)
 *
 * A section with no data is left out (its rail row, select option, pane).
 * Every pane is drawn (search finds rows in all of them); only the open
 * one shows. Dates are <time> in the viewer's own zone (time.js).
 *
 *   accountSectionOf(location.search) → the section ?account= names (the
 *     first one when it names none known), or null with no ?account=.
 *
 *   mountAccountArea(el, { ...data, onAction, onSection?, address? })
 *     → { show(section), current(), update(data), destroy() }
 *   openAccountArea({ ...data, onAction, opener? }) → { dialog, close() }
 *     The pop-up: a modal dialog; the address holds ?account=<section>
 *     while it is open and loses it on close.
 *
 *   onAction(act, id, button, extra) is the host's: "sign-out" (signOut
 *   true), "unlink", "pair",
 *   "new-token", "revoke-token" (id), "sign-out-device" (id),
 *   "sign-out-all" (asked first, in the source product's words), "approve" (the code),
 *   "retry-devices", "notify" (id, extra { on }). A request goes through
 *   the kit's busy (pending(button, …)) so the button shows its dots. A
 *   "notify" whose promise rejects is switched back.
 *
 * Keys (the source product's settings shell): "/" goes to the search box; Escape there
 * clears it first; Enter opens the first hit's section and flashes its row.
 *
 * Its look is account-area.css (link it after tokens.css and button.css).
 */
import { esc, kitT } from "./strings.js";
import { timeHtml } from "./time.js";
import { askConfirm, mountDialog } from "./dialog.js";

/** The sections, in the rail's order, each under its group. */
export const ACCOUNT_SECTIONS = [
  "profile",
  "access",
  "devices",
  "notifications",
];
const GROUP = {
  profile: "kit.aa.g.account",
  access: "kit.aa.g.access",
  devices: "kit.aa.g.devices",
  notifications: "kit.aa.g.notifications",
};
const TITLE = {
  profile: "kit.aa.profile",
  access: "kit.aa.access",
  devices: "kit.aa.devices",
  notifications: "kit.aa.notifications",
};

/** The sections this data draws, in order. */
export function accountAreaSections(d = {}) {
  return ACCOUNT_SECTIONS.filter((s) =>
    s === "notifications"
      ? Array.isArray(d.notifications) && d.notifications.length > 0
      : !!d[s],
  );
}

/** The section ?account= names (see the top of this file). */
export function accountSectionOf(search, sections = ACCOUNT_SECTIONS) {
  let v;
  try {
    v = new URLSearchParams(String(search ?? "")).get("account");
  } catch {
    return null;
  }
  if (v == null) return null;
  return sections.includes(v) ? v : (sections[0] ?? null);
}

/** Issue 656: a name that is just the login is no name. */
const sameAsLogin = (name, login) => {
  const n = (v) =>
    String(v ?? "")
      .trim()
      .replace(/^@/, "")
      .toLowerCase();
  return !!n(login) && n(name) === n(login);
};
const at = (login) =>
  login ? (String(login).startsWith("@") ? String(login) : `@${login}`) : "";

/** The words searched for a row: lower case, one line. */
const findOf = (...bits) =>
  bits
    .filter(Boolean)
    .join(" ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function btn(lang, key, act, o = {}) {
  const cls = [
    "den-btn",
    o.primary ? "primary" : "",
    o.ghost ? "ghost" : "",
    o.sm ? "sm" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    `<button type="button" class="${cls}" data-aa-act="${esc(act)}"` +
    (o.id != null ? ` data-aa-id="${esc(o.id)}"` : "") +
    (o.label ? ` aria-label="${esc(o.label)}"` : "") +
    `>${esc(kitT(lang, key))}</button>`
  );
}

/** One row: words on the left (title, small line), its action on the right. */
function item(title, small, action, find, extra = "") {
  return (
    `<div class="den-aa-item" data-aa-find="${esc(find)}"${extra}>` +
    `<div class="den-aa-l">${title}${small ? `<small>${small}</small>` : ""}</div>` +
    (action || "") +
    `</div>`
  );
}

const card = (rows) => `<div class="den-aa-card">${rows}</div>`;
const sub = (lang, key) =>
  `<h3 class="den-aa-sub">${esc(kitT(lang, key))}</h3>`;

function profilePane(p, lang, t) {
  const login = at(p.login);
  const name = p.name && !sameAsLogin(p.name, p.login) ? String(p.name) : "";
  const who = name || login;
  const initial = (who.replace(/^@/, "")[0] || "?").toUpperCase();
  const avatar = p.avatarUrl
    ? `<img class="den-aa-av" src="${esc(p.avatarUrl)}" alt="">`
    : `<span class="den-aa-av" aria-hidden="true">${esc(initial)}</span>`;
  // Under the heading: @login · role (the heading is @login with no name,
  // so then the role alone).
  const second = name
    ? p.role
      ? kitT(lang, "kit.aa.loginRole", { login, role: p.role })
      : login
    : p.role || "";
  const edit = p.editHref
    ? `<a class="den-btn ghost sm" href="${esc(p.editHref)}" target="_blank" rel="noopener noreferrer">${esc(kitT(lang, "kit.aa.edit"))}</a>`
    : "";
  const how = ["github", "local", "paired"].includes(p.how) ? p.how : "local";
  const since = p.since
    ? esc(kitT(lang, "kit.aa.since", { date: "\u0000" })).replace(
        "\u0000",
        t(p.since, "date"),
      )
    : "";
  // No person known (a device paired with a link or a code may be
  // anyone's): no person row, the how line first.
  let rows = !who
    ? ""
    : `<div class="den-aa-item den-aa-me" data-aa-find="${esc(findOf(who, second))}">` +
      `<div class="den-aa-me-l">${avatar}<div class="den-aa-l"><b class="den-aa-who">${esc(who)}</b>` +
      (second ? `<small class="den-aa-login">${esc(second)}</small>` : "") +
      `</div></div>${edit}</div>`;
  rows += item(
    `<b data-aa-how="${how}">${esc(kitT(lang, `kit.aa.how.${how}`))}</b>`,
    since,
    how === "github"
      ? `<span class="den-aa-chip ok">${esc(kitT(lang, "kit.aa.linked"))}</span>`
      : "",
    findOf(kitT(lang, `kit.aa.how.${how}`)),
  );
  let foot = "";
  if (p.signOut?.url)
    foot +=
      `<form class="den-aa-out" method="post" action="${esc(p.signOut.url)}">` +
      (p.signOut.csrf != null
        ? `<input type="hidden" name="csrf" value="${esc(p.signOut.csrf)}">`
        : "") +
      `<button type="submit" class="den-btn">${esc(kitT(lang, "kit.aa.signOut"))}</button></form>`;
  // A host whose sign-out isn't a plain form (a header-borne csrf, say):
  // signOut true, and Sign out is its action "sign-out".
  else if (p.signOut === true) foot += btn(lang, "kit.aa.signOut", "sign-out");
  if (p.signOutAll)
    foot += btn(lang, "kit.aa.signOutAll", "sign-out-all", { ghost: true });
  return card(rows) + (foot ? `<div class="den-aa-foot">${foot}</div>` : "");
}

function accessPane(a, lang, t) {
  let rows = "";
  if (a.github) {
    const g = a.github;
    const small = g.login
      ? esc(
          kitT(lang, "kit.aa.githubLinked", {
            login: at(g.login),
            date: "\u0000",
          }),
        ).replace("\u0000", g.linkedAt ? t(g.linkedAt, "date") : "")
      : esc(kitT(lang, "kit.aa.githubNone"));
    rows += item(
      `<b>${esc(kitT(lang, "kit.aa.github"))}</b>`,
      small,
      g.unlink
        ? btn(lang, "kit.aa.unlink", "unlink", { ghost: true, sm: true })
        : "",
      findOf(kitT(lang, "kit.aa.github"), at(g.login)),
    );
  }
  if (a.pair)
    rows += item(
      `<b>${esc(kitT(lang, "kit.aa.otherWay"))}</b>`,
      esc(kitT(lang, "kit.aa.otherWayHelp")),
      btn(lang, "kit.aa.pair", "pair", { sm: true }),
      findOf(
        kitT(lang, "kit.aa.otherWay"),
        kitT(lang, "kit.aa.otherWayHelp"),
        kitT(lang, "kit.aa.pair"),
      ),
    );
  let out = rows ? card(rows) : "";
  if (Array.isArray(a.tokens)) {
    out += sub(lang, "kit.aa.tokens");
    const toks = a.tokens
      .map((k) => {
        const meta = esc(
          kitT(lang, k.lastUsedAt ? "kit.aa.tokenMeta" : "kit.aa.tokenNever", {
            created: "\u0000",
            used: "\u0001",
          }),
        )
          .replace("\u0000", t(k.createdAt, "date"))
          .replace("\u0001", k.lastUsedAt ? t(k.lastUsedAt, "relative") : "");
        return item(
          `<b>${esc(k.name)}</b>`,
          meta,
          btn(lang, "kit.aa.revoke", "revoke-token", {
            ghost: true,
            sm: true,
            id: k.id,
            label: `${kitT(lang, "kit.aa.revoke")} ${k.name ?? ""}`.trim(),
          }),
          findOf(kitT(lang, "kit.aa.tokens"), k.name),
        );
      })
      .join("");
    out += toks
      ? card(toks)
      : `<p class="den-aa-none">${esc(kitT(lang, "kit.aa.noTokens"))}</p>`;
    if (a.newToken)
      out += `<div class="den-aa-foot">${btn(lang, "kit.aa.newToken", "new-token")}</div>`;
  }
  return out;
}

function devicesPane(d, lang, t) {
  if (d.error)
    return (
      `<div class="den-aa-card den-aa-bad" role="alert"><b>${esc(kitT(lang, "kit.aa.cantList"))}</b>` +
      `<p>${esc(kitT(lang, "kit.aa.cantListHelp"))}</p>` +
      btn(lang, "kit.aa.retry", "retry-devices") +
      `</div>`
    );
  const list = Array.isArray(d.list) ? d.list : [];
  let out = "";
  if (list.length) {
    // This device first, then the most recently seen.
    const sorted = [...list].sort(
      (x, y) =>
        (y.current ? 1 : 0) - (x.current ? 1 : 0) ||
        String(y.lastSeen ?? "").localeCompare(String(x.lastSeen ?? "")),
    );
    out += card(
      sorted
        .map((v) => {
          const mark = v.current
            ? ` <span class="den-aa-chip ok">${esc(kitT(lang, "kit.aa.thisDevice"))}</span>`
            : "";
          const seen = v.lastSeen
            ? esc(kitT(lang, "kit.aa.lastSeen", { when: "\u0000" })).replace(
                "\u0000",
                t(v.lastSeen, "relative"),
              )
            : "";
          const small = [v.where ? esc(v.where) : "", seen]
            .filter(Boolean)
            .join(" · ");
          return item(
            `<b>${esc(v.name)}${mark}</b>`,
            small,
            btn(lang, "kit.aa.signOut", "sign-out-device", {
              ghost: true,
              sm: true,
              id: v.id,
              label: `${kitT(lang, "kit.aa.signOut")}: ${v.name ?? ""}`,
            }),
            findOf(
              v.name,
              v.where,
              v.current ? kitT(lang, "kit.aa.thisDevice") : "",
            ),
          );
        })
        .join(""),
    );
  }
  if (!list.some((v) => !v.current))
    out +=
      `<div class="den-aa-card den-aa-empty"><b>${esc(kitT(lang, "kit.aa.noOthers"))}</b>` +
      `<p>${esc(kitT(lang, "kit.aa.noOthersHelp"))}</p></div>`;
  if (Array.isArray(d.waiting) && d.waiting.length) {
    out += sub(lang, "kit.aa.waiting");
    out += card(
      d.waiting
        .map((w) =>
          item(
            `<b>${esc(kitT(lang, "kit.aa.code", { code: w.code }))}</b>`,
            esc(kitT(lang, "kit.aa.codeHelp", { n: Number(w.minutes) || 10 })),
            btn(lang, "kit.aa.approve", "approve", { sm: true, id: w.code }),
            findOf(kitT(lang, "kit.aa.waiting"), w.code),
          ),
        )
        .join(""),
    );
  }
  let foot = "";
  if (d.pair) foot += btn(lang, "kit.aa.pair", "pair");
  if (d.signOutAll)
    foot += btn(lang, "kit.aa.signOutAll", "sign-out-all", { ghost: true });
  return out + (foot ? `<div class="den-aa-foot">${foot}</div>` : "");
}

function notificationsPane(list, lang) {
  return card(
    list
      .map((n) => {
        const on = !!n.on;
        return item(
          `<b id="den-aa-n-${esc(n.id)}">${esc(n.label)}</b>`,
          n.help ? esc(n.help) : "",
          `<button type="button" class="den-aa-sw" role="switch" aria-checked="${on}" data-aa-act="notify" data-aa-id="${esc(n.id)}"` +
            ` aria-labelledby="den-aa-n-${esc(n.id)}">${esc(kitT(lang, on ? "kit.aa.on" : "kit.aa.off"))}</button>`,
          findOf(n.label, n.help),
        );
      })
      .join(""),
  );
}

/** The whole area as markup (see the top of this file). Pure. */
export function accountAreaHtml(d = {}) {
  const lang = d.lang || "en";
  const id = d.id || "den-aa";
  const sections = accountAreaSections(d);
  const current = sections.includes(d.current) ? d.current : sections[0];
  const t = (iso, style) => timeHtml(iso, { style, now: d.now }) || "";

  let rail =
    `<div class="den-aa-find"><input type="search" class="den-aa-search" id="${esc(id)}-q"` +
    ` aria-label="${esc(kitT(lang, "kit.aa.search"))}" placeholder="${esc(kitT(lang, "kit.aa.search"))}"` +
    ` aria-controls="${esc(id)}-panes" autocomplete="off"><kbd aria-hidden="true">/</kbd></div>` +
    `<select class="den-aa-select" aria-label="${esc(kitT(lang, "kit.aa.section"))}">` +
    sections
      .map(
        (s) =>
          `<option value="${s}"${s === current ? " selected" : ""}>${esc(kitT(lang, TITLE[s]))}</option>`,
      )
      .join("") +
    `</select>`;
  for (const s of sections)
    rail +=
      `<div class="den-aa-grp">${esc(kitT(lang, GROUP[s]))}</div>` +
      `<a class="den-aa-row" href="?account=${s}" data-aa-section="${s}"` +
      (s === current ? ' aria-current="page"' : "") +
      `>${esc(kitT(lang, TITLE[s]))}</a>`;
  rail += `<div class="den-aa-grow"></div>`;
  if (d.settingsHref)
    rail += `<a class="den-aa-cross" href="${esc(d.settingsHref)}">${esc(kitT(lang, "kit.aa.cross"))}</a>`;

  const body = {
    profile: () => profilePane(d.profile, lang, t),
    access: () => accessPane(d.access, lang, t),
    devices: () => devicesPane(d.devices, lang, t),
    notifications: () => notificationsPane(d.notifications, lang),
  };
  const panes = sections
    .map(
      (s) =>
        `<section class="den-aa-pane" id="${esc(id)}-p-${s}" data-aa-pane="${s}" aria-labelledby="${esc(id)}-h-${s}"` +
        (s === current ? "" : " hidden") +
        `><h2 id="${esc(id)}-h-${s}" tabindex="-1">${esc(kitT(lang, TITLE[s]))}</h2>${body[s]()}</section>`,
    )
    .join("");

  return (
    `<div class="den-aa" id="${esc(id)}" data-aa-current="${current ?? ""}" lang="${esc(lang)}">` +
    `<nav class="den-aa-rail" aria-label="${esc(kitT(lang, "kit.aa.sections"))}">${rail}</nav>` +
    `<div class="den-aa-panes" id="${esc(id)}-panes">` +
    `<p class="den-aa-found" role="status" aria-live="polite"></p>${panes}</div></div>`
  );
}

/* ---------- the browser half ---------- */

const FLASH_MS = 1200;

/** The area in `el`, wired (see the top of this file). */
/**
 * What Sign out everywhere asks: it names personal access tokens only when
 * the product passes them (access.tokens), so a product without them never
 * says it turns them off.
 */
export function signOutAllBody(data, lang = "en") {
  return kitT(
    lang,
    Array.isArray(data?.access?.tokens)
      ? "kit.aa.allBody"
      : "kit.aa.allBodyNoTokens",
  );
}

export function mountAccountArea(el, opts = {}) {
  let data = opts;
  const lang = () =>
    data.lang || document.documentElement.lang?.slice(0, 2) || "en";
  let root;
  let gone = false;

  const sections = () => accountAreaSections(data);
  const panes = () => [...root.querySelectorAll(".den-aa-pane")];

  function draw(current) {
    el.innerHTML = accountAreaHtml({ ...data, lang: lang(), current });
    root = el.firstElementChild;
  }

  function setAddress(s) {
    if (opts.address === false || typeof history === "undefined") return;
    try {
      const u = new URL(location.href);
      if (s) u.searchParams.set("account", s);
      else u.searchParams.delete("account");
      history.replaceState(history.state, "", u);
    } catch {
      /* an address the page can't change: the area still works */
    }
  }

  function show(s, { focus = false } = {}) {
    const all = sections();
    if (!all.includes(s)) s = all[0];
    if (!s) return;
    root.dataset.aaCurrent = s;
    for (const p of panes()) p.hidden = p.dataset.aaPane !== s;
    for (const r of root.querySelectorAll(".den-aa-row"))
      if (r.dataset.aaSection === s) r.setAttribute("aria-current", "page");
      else r.removeAttribute("aria-current");
    const sel = root.querySelector(".den-aa-select");
    if (sel) sel.value = s;
    setAddress(s);
    opts.onSection?.(s);
    if (focus) root.querySelector(`#${CSS.escape(root.id)}-h-${s}`)?.focus?.();
  }

  const current = () => root?.dataset.aaCurrent || sections()[0];

  /** Search: every pane with a hit shows, rows without one hide. */
  function find(q) {
    const words = String(q ?? "")
      .trim()
      .toLowerCase();
    const said = root.querySelector(".den-aa-found");
    const items = [...root.querySelectorAll(".den-aa-item[data-aa-find]")];
    if (!words) {
      for (const it of items) it.hidden = false;
      for (const p of panes()) p.hidden = p.dataset.aaPane !== current();
      said.textContent = "";
      return [];
    }
    const hits = items.filter((it) => it.dataset.aaFind.includes(words));
    for (const it of items) it.hidden = !hits.includes(it);
    for (const p of panes()) p.hidden = !hits.some((h) => p.contains(h));
    said.textContent = hits.length
      ? kitT(lang(), "kit.aa.found", { n: hits.length })
      : kitT(lang(), "kit.aa.noneFound", { q: String(q).trim() });
    return hits;
  }

  function jump(row) {
    const pane = row.closest(".den-aa-pane");
    const q = root.querySelector(".den-aa-search");
    q.value = "";
    find("");
    show(pane.dataset.aaPane);
    row.classList.add("den-aa-flash");
    setTimeout(() => row.classList.remove("den-aa-flash"), FLASH_MS);
    row.scrollIntoView?.({ block: "nearest" });
    (row.querySelector("button, a[href]") || row).focus?.();
  }

  async function act(b) {
    const name = b.dataset.aaAct;
    const id = b.dataset.aaId ?? null;
    if (name === "sign-out-all") {
      const ok = await askConfirm({
        title: kitT(lang(), "kit.aa.allQ"),
        message: signOutAllBody(data, lang()),
        okLabel: kitT(lang(), "kit.aa.signOutAll"),
        danger: true,
        opener: b,
      });
      if (!ok) return;
    }
    // Unlinking can stop the owner signing in from another machine: it asks
    // first, like signing out everywhere.
    if (name === "unlink") {
      const ok = await askConfirm({
        title: kitT(lang(), "kit.aa.unlinkQ"),
        message: kitT(lang(), "kit.aa.unlinkBody"),
        okLabel: kitT(lang(), "kit.aa.unlink"),
        danger: true,
        opener: b,
      });
      if (!ok) return;
    }
    if (name === "notify") {
      const on = b.getAttribute("aria-checked") !== "true";
      const flip = (v) => {
        b.setAttribute("aria-checked", String(v));
        b.textContent = kitT(lang(), v ? "kit.aa.on" : "kit.aa.off");
      };
      flip(on);
      try {
        await opts.onAction?.(name, id, b, { on });
      } catch {
        flip(!on);
      }
      return;
    }
    await opts.onAction?.(name, id, b, {});
  }

  const onClick = (e) => {
    const row = e.target.closest?.(".den-aa-row");
    if (row && root.contains(row)) {
      e.preventDefault();
      show(row.dataset.aaSection, { focus: true });
      return;
    }
    const b = e.target.closest?.("[data-aa-act]");
    if (b && root.contains(b) && !b.disabled) void act(b);
  };
  const onChange = (e) => {
    if (e.target.classList?.contains("den-aa-select"))
      show(e.target.value, { focus: false });
  };
  const onInput = (e) => {
    if (e.target.classList?.contains("den-aa-search")) find(e.target.value);
  };
  const onKey = (e) => {
    const q = root.querySelector(".den-aa-search");
    if (e.target === q) {
      if (e.key === "Escape" && q.value) {
        // Escape clears the search first; the next one closes.
        e.preventDefault();
        e.stopPropagation();
        q.value = "";
        find("");
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = find(q.value)[0];
        if (hit) jump(hit);
      }
    }
  };
  // "/" from anywhere while the area shows (focus may be on the dialog
  // itself, outside el): the search box.
  const onSlash = (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!root?.isConnected || !root.getClientRects().length) return;
    const typing = e.target?.closest?.(
      "input, textarea, select, [contenteditable]",
    );
    if (typing) return;
    e.preventDefault();
    root.querySelector(".den-aa-search")?.focus();
  };

  draw(
    opts.current ?? accountSectionOf(location.search, sections()) ?? undefined,
  );
  // Issue 310: the section it opens on goes in the address too, not only
  // a section picked later (?account=<section>, so a reload or a shared
  // link opens the same place).
  setAddress(current());
  el.addEventListener("click", onClick);
  el.addEventListener("change", onChange);
  el.addEventListener("input", onInput);
  el.addEventListener("keydown", onKey);
  document.addEventListener("keydown", onSlash);

  return {
    root: () => root,
    show: (s) => show(s, { focus: false }),
    current,
    find,
    update(next) {
      const s = current();
      const q = root.querySelector(".den-aa-search")?.value ?? "";
      data = { ...data, ...next };
      draw(s);
      if (q) {
        root.querySelector(".den-aa-search").value = q;
        find(q);
      }
    },
    destroy() {
      if (gone) return;
      gone = true;
      el.removeEventListener("click", onClick);
      el.removeEventListener("change", onChange);
      el.removeEventListener("input", onInput);
      el.removeEventListener("keydown", onKey);
      document.removeEventListener("keydown", onSlash);
    },
  };
}

/** The pop-up (see the top of this file). */
export function openAccountArea(opts = {}) {
  const lang = opts.lang || document.documentElement.lang?.slice(0, 2) || "en";
  const d = document.createElement("dialog");
  d.className = "den-aa-dlg";
  d.setAttribute("aria-label", kitT(lang, "kit.aa.title"));
  d.innerHTML =
    `<div class="den-aa-top"><h2 class="den-aa-title">${esc(kitT(lang, "kit.aa.title"))}</h2>` +
    `<button type="button" class="den-aa-x" aria-label="${esc(kitT(lang, "kit.aa.close"))}">✕</button></div>` +
    `<div class="den-aa-host"></div>`;
  document.body.append(d);
  const area = mountAccountArea(d.querySelector(".den-aa-host"), {
    ...opts,
    lang,
  });
  const frame = mountDialog(d, {
    opener: opts.opener,
    remove: true,
    focus: ".den-aa-search",
    onClose: () => {
      area.destroy();
      if (opts.address !== false) {
        try {
          const u = new URL(location.href);
          u.searchParams.delete("account");
          history.replaceState(history.state, "", u);
        } catch {
          /* nothing to undo */
        }
      }
      opts.onClose?.();
    },
  });
  d.querySelector(".den-aa-x").addEventListener("click", () =>
    frame.close("close"),
  );
  frame.show(opts.opener);
  return { dialog: d, area, close: () => frame.close("close") };
}
