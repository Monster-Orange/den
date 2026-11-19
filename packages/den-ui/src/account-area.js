/**
 * The Account area (issue 310): one place for "me", separate from
 * Settings, drawn by the kit from data in every product. The approved
 * Account area mock (v2) is the spec: an account pop-up, copied value
 * for value (a 240px rail of sections with a search box beside the pane,
 * the open section in the address, a phone strip with a select), with
 * the device list from GitHub's Sessions page.
 *
 *   accountAreaHtml({
 *     current,            the open section (default: the first drawn)
 *     profile,            Profile (profilePaneHtml); left out: no section
 *     access,             Access and security (accessPaneHtml)
 *     devices,            Devices and sessions (devicesPaneHtml)
 *     notifications,      Your notifications (notificationsPaneHtml)
 *     settings: { href }, the rail foot's "Install settings →"
 *     id,                 the root's id (default "den-aa")
 *     lang, now?, zone?, product?
 *   })
 *
 * Every pane is drawn (each stays mounted); only the current one shows.
 * The sections, their groups and their order are the kit's
 * (ACCOUNT_SECTIONS); a product passes the data it has and the kit draws
 * those sections only.
 *
 *   accountSectionOf(location.search)       ?account=<section> → the
 *                                           section, or null (none asked)
 *   accountAreaHref(href, section | null)   the same address with
 *                                           ?account=<section>, or without
 *
 *   const area = hydrateAccountArea(el, {
 *     onAction(act, { id, name, button }) → Promise   a button's action:
 *         signout, signout-all (asked first, with the kit's danger
 *         dialog), edit, unlink, link, pair, revoke-token, new-token,
 *         device-signout, approve, retry
 *     onToggle(id, on) → Promise    a notification switch, saved when
 *                                   changed (no Save button)
 *     onSection(section), onClose(),
 *     history,                      false: leave the address alone
 *     lang,
 *   })
 *   area.select(section)  area.current()  area.toast(text)
 *   area.update(data)     draws the panes again from new data
 *   area.destroy()
 *
 *   const area = openAccountArea({ ...data, ...hydrateOptions })
 *     the area in a modal <dialog> (closed by ✕, Esc or area.close());
 *     focus goes back to what opened it.
 *
 * Keys: "/" jumps to the search; in the search, Esc clears it first; Enter
 * jumps to the first row that matches and flashes it. A search hides the
 * sections with no match.
 *
 * Its look is account-area.css, with button.css, switch.css and
 * dialog.css.
 */
import { buttonClass, buttonHtml } from "./button.js";
import { askConfirm, focusBack, openerOf } from "./dialog.js";
import { icon } from "./icons.js";
import { esc, kitT } from "./strings.js";
import { switchHtml, hydrateSwitch } from "./switch.js";
import { timeHtml, upgradeTimes } from "./time.js";

/** The sections, their groups and their order (the mock's). */
export const ACCOUNT_SECTIONS = [
  { id: "profile", group: "account" },
  { id: "access", group: "signin" },
  { id: "devices", group: "devices" },
  { id: "notifications", group: "notifications" },
];
const IDS = ACCOUNT_SECTIONS.map((s) => s.id);
const HOWS = ["github", "link", "code", "claim", "local"];
const FLASH_MS = 1200;
const TOAST_MS = 4000;

/** An href that can't run script: relative, http(s) or mailto; else "#". */
function safeHref(h) {
  const s = String(h ?? "").trim();
  if (!s) return "#";
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^(https?|mailto):/i.test(s))
    return "#";
  return s;
}

/** The words with {name} vars, plus <time> elements dropped in whole. */
function wordsHtml(o, key, vars = {}, times = {}) {
  const marks = {};
  const all = { ...vars };
  if (o.product) all.product = o.product;
  for (const k of Object.keys(times)) {
    marks[k] = "\u0000" + k + "\u0000";
    all[k] = marks[k];
  }
  let h = esc(kitT(o.lang, key, all));
  for (const k of Object.keys(times)) h = h.replace(marks[k], () => times[k]);
  return h;
}
const w = (o, key, vars) =>
  esc(
    kitT(o.lang, key, {
      ...(o.product ? { product: o.product } : {}),
      ...(vars || {}),
    }),
  );
const date = (o, iso) =>
  timeHtml(iso, { style: "date", locale: o.lang, now: o.now, zone: o.zone });
const ago = (o, iso) =>
  timeHtml(iso, {
    style: "relative",
    locale: o.lang,
    now: o.now,
    zone: o.zone,
  });

/** A button with an action (data-den-aa-act) and the item's id. */
function actBtn(o, label, act, variant, size, more = {}) {
  return buttonHtml({
    label,
    variant,
    size,
    attrs: { "data-den-aa-act": act, ...more },
  });
}

/** One row: its words on the left, its action on the right. */
function row(left, right = "", data = "") {
  return (
    '<div class="den-aa-row"' + data + ">" + left + right + "</div><!--row-->"
  );
}
const words = (title, small) =>
  '<div class="den-aa-l"><b>' +
  title +
  "</b>" +
  (small ? "<small>" + small + "</small>" : "") +
  "</div>";
const card = (rows) =>
  rows ? '<div class="den-aa-card">' + rows + "</div>" : "";
const cap = (text) => '<p class="den-aa-cap">' + text + "</p>";
const chip = (text, ok) =>
  '<span class="den-aa-chip' + (ok ? " ok" : "") + '">' + text + "</span>";
const foot = (btns) =>
  btns ? '<div class="den-aa-foot">' + btns + "</div>" : "";

function paneOpen(o, section) {
  const id = (o.id || "den-aa") + "-" + section;
  return (
    '<section class="den-aa-pane" data-section="' +
    section +
    '" aria-labelledby="' +
    esc(id) +
    '-h"' +
    (o.hidden ? " hidden" : "") +
    '><h2 class="den-aa-h" id="' +
    esc(id) +
    '-h">' +
    w(o, "kit.acct.sec." + section) +
    "</h2>"
  );
}
const paneClose = "</section>";

/** Profile: the person, how this browser signed in, the sign-outs. */
export function profilePaneHtml(p = {}, o = {}) {
  let rows = "";
  const login = p.login ? String(p.login).replace(/^@/, "") : "";
  const name = p.name ? String(p.name) : "";
  if (name || login) {
    const heading = name || "@" + login;
    const sub = [name && login ? "@" + login : "", p.role || ""]
      .filter(Boolean)
      .join(" · ");
    const initial = (name || login).trim().charAt(0).toUpperCase();
    const av = p.avatar
      ? '<img class="den-aa-av" src="' + esc(safeHref(p.avatar)) + '" alt="">'
      : '<span class="den-aa-av" aria-hidden="true">' +
        esc(initial) +
        "</span>";
    const edit = p.editHref
      ? '<a class="' +
        buttonClass("ghost", "sm") +
        '" href="' +
        esc(safeHref(p.editHref)) +
        '" target="_blank" rel="noopener noreferrer" data-den-aa-act="edit">' +
        w(o, "kit.acct.editGithub") +
        "</a>"
      : "";
    rows += row(
      '<div class="den-aa-who">' +
        av +
        words(esc(heading), esc(sub)) +
        "</div>",
      edit,
      ' data-row="person"',
    );
  }
  const how = HOWS.includes(p.how) ? p.how : null;
  if (how) {
    const small =
      how === "local"
        ? w(o, "kit.acct.onThisComputer")
        : p.since
          ? wordsHtml(o, "kit.acct.since", {}, { time: date(o, p.since) })
          : w(o, "kit.acct.thisBrowser");
    rows += row(
      words(w(o, "kit.acct.how." + how), small),
      how === "github" ? chip(w(o, "kit.acct.linked"), true) : "",
      ' data-row="how"',
    );
  }
  const btns =
    (p.signOut ? actBtn(o, kitT(o.lang, "kit.acct.signOut"), "signout") : "") +
    (p.signOutEverywhere
      ? actBtn(o, kitT(o.lang, "kit.acct.signOutAll"), "signout-all", "ghost")
      : "");
  return paneOpen(o, "profile") + card(rows) + foot(btns) + paneClose;
}

/** Access and security: GitHub, another way in, personal tokens. */
export function accessPaneHtml(a = {}, o = {}) {
  let rows = "";
  const g = a.github;
  if (g && g.login) {
    const login = String(g.login).replace(/^@/, "");
    rows += row(
      words(
        w(o, "kit.acct.github"),
        wordsHtml(
          o,
          "kit.acct.github.linked",
          { login },
          { time: g.linkedAt ? date(o, g.linkedAt) : "" },
        ),
      ),
      g.unlink
        ? actBtn(o, kitT(o.lang, "kit.acct.unlink"), "unlink", "ghost", "sm")
        : "",
      ' data-row="github"',
    );
  } else {
    rows += row(
      words(w(o, "kit.acct.github"), w(o, "kit.acct.github.none")),
      a.link === false
        ? ""
        : actBtn(o, kitT(o.lang, "kit.acct.link"), "link", undefined, "sm"),
      ' data-row="github"',
    );
  }
  if (a.pair)
    rows += row(
      words(w(o, "kit.acct.otherWay"), w(o, "kit.acct.otherWay.help")),
      actBtn(o, kitT(o.lang, "kit.acct.pair"), "pair", undefined, "sm"),
      ' data-row="pair"',
    );
  let tokens = "";
  if (Array.isArray(a.tokens)) {
    const list = a.tokens
      .map((t) =>
        row(
          words(
            esc(t.name),
            t.lastUsedAt
              ? wordsHtml(
                  o,
                  "kit.acct.token.used",
                  {},
                  { created: date(o, t.createdAt), used: ago(o, t.lastUsedAt) },
                )
              : wordsHtml(
                  o,
                  "kit.acct.token.never",
                  {},
                  { created: date(o, t.createdAt) },
                ),
          ),
          actBtn(
            o,
            kitT(o.lang, "kit.acct.revoke"),
            "revoke-token",
            "ghost",
            "sm",
            {
              "data-id": t.id,
              "data-name": t.name,
            },
          ),
          ' data-row="token"',
        ),
      )
      .join("");
    tokens =
      cap(w(o, "kit.acct.tokens")) +
      card(list) +
      (a.newToken
        ? foot(actBtn(o, kitT(o.lang, "kit.acct.newToken"), "new-token"))
        : "");
  }
  return paneOpen(o, "access") + card(rows) + tokens + paneClose;
}

/** Devices and sessions: each device, the waiting codes, the foot. */
export function devicesPaneHtml(d = {}, o = {}) {
  if (d.error)
    return (
      paneOpen(o, "devices") +
      '<div class="den-aa-card den-aa-err" role="alert"><b>' +
      w(o, "kit.acct.cantList") +
      "</b><p>" +
      w(o, "kit.acct.cantList.help") +
      "</p>" +
      actBtn(o, kitT(o.lang, "kit.acct.retry"), "retry") +
      "</div>" +
      paneClose
    );
  const list = Array.isArray(d.list) ? d.list : [];
  const rows = list
    .map((x) =>
      row(
        words(
          esc(x.name) +
            (x.current ? " " + chip(w(o, "kit.acct.thisDevice"), true) : ""),
          (x.where ? esc(x.where) + " · " : "") +
            wordsHtml(
              o,
              "kit.acct.lastSeen",
              {},
              { time: ago(o, x.lastSeenAt) },
            ),
        ),
        actBtn(
          o,
          kitT(o.lang, "kit.acct.signOut"),
          "device-signout",
          "ghost",
          "sm",
          {
            "data-id": x.id,
            "data-name": x.name,
          },
        ),
        ' data-row="device"',
      ),
    )
    .join("");
  const alone =
    list.filter((x) => !x.current).length === 0
      ? '<div class="den-aa-card den-aa-note"><b>' +
        w(o, "kit.acct.alone") +
        "</b><p>" +
        w(o, "kit.acct.alone.help") +
        "</p></div>"
      : "";
  const waiting = Array.isArray(d.waiting) ? d.waiting : [];
  const wait = waiting.length
    ? cap(w(o, "kit.acct.waiting")) +
      card(
        waiting
          .map((x) =>
            row(
              words(
                w(o, "kit.acct.waiting.code", { code: x.code }),
                w(o, "kit.acct.waiting.help", {
                  n: typeof x.minutes === "number" ? x.minutes : 10,
                }),
              ),
              actBtn(
                o,
                kitT(o.lang, "kit.acct.approve"),
                "approve",
                undefined,
                "sm",
                {
                  "data-id": x.code,
                },
              ),
              ' data-row="waiting"',
            ),
          )
          .join(""),
      )
    : "";
  const btns =
    (d.pair ? actBtn(o, kitT(o.lang, "kit.acct.pair"), "pair") : "") +
    (d.signOutEverywhere
      ? actBtn(o, kitT(o.lang, "kit.acct.signOutAll"), "signout-all", "ghost")
      : "");
  return (
    paneOpen(o, "devices") + card(rows) + alone + wait + foot(btns) + paneClose
  );
}

/** Your notifications: one switch per choice, saved when changed. */
export function notificationsPaneHtml(n = {}, o = {}) {
  const items = Array.isArray(n.items) ? n.items : [];
  const rows = items
    .map((x) =>
      row(
        switchHtml({
          id: "den-aa-n-" + String(x.id).replace(/[^A-Za-z0-9_-]/g, "-"),
          label: x.label,
          help: x.help,
          on: !!x.on,
          disabled: !!x.disabled,
        }),
        "",
        ' data-row="notification" data-id="' + esc(x.id) + '"',
      ),
    )
    .join("");
  return paneOpen(o, "notifications") + card(rows) + paneClose;
}

const BUILD = {
  profile: profilePaneHtml,
  access: accessPaneHtml,
  devices: devicesPaneHtml,
  notifications: notificationsPaneHtml,
};

/** The sections the host gave data for, in the kit's order. */
function drawn(o) {
  return ACCOUNT_SECTIONS.filter((s) => o[s.id] != null);
}

/** The shell's inside: the phone's top, the rail, the panes. */
function innerHtml(o, current) {
  const root = o.id || "den-aa";
  const secs = drawn(o);
  let nav = "";
  let group = "";
  for (const s of secs) {
    if (s.group !== group) {
      group = s.group;
      nav += '<p class="den-aa-grp">' + w(o, "kit.acct.grp." + group) + "</p>";
    }
    nav +=
      '<button type="button" class="den-aa-sec" data-section="' +
      s.id +
      '"' +
      (s.id === current ? ' aria-current="true"' : "") +
      ">" +
      w(o, "kit.acct.sec." + s.id) +
      "</button>";
  }
  const sel =
    '<select class="den-aa-sel" aria-label="' +
    w(o, "kit.acct.sections") +
    '">' +
    secs
      .map(
        (s) =>
          '<option value="' +
          s.id +
          '"' +
          (s.id === current ? " selected" : "") +
          ">" +
          w(o, "kit.acct.sec." + s.id) +
          "</option>",
      )
      .join("") +
    "</select>";
  const cross =
    o.settings && o.settings.href
      ? '<a class="den-aa-cross" href="' +
        esc(safeHref(o.settings.href)) +
        '">' +
        w(o, "kit.acct.settings") +
        "</a>"
      : "";
  const panes = secs
    .map((s) =>
      BUILD[s.id](o[s.id], { ...o, id: root, hidden: s.id !== current }),
    )
    .join("");
  return (
    '<div class="den-aa-top"><button type="button" class="den-aa-close" aria-label="' +
    w(o, "kit.acct.close") +
    '" data-den-aa-close>' +
    icon("close") +
    '</button><h1 class="den-aa-title" id="' +
    esc(root) +
    '-title">' +
    w(o, "kit.acct.title") +
    "</h1></div>" +
    '<div class="den-aa-rail"><label class="den-aa-search"><span class="den-aa-vh">' +
    w(o, "kit.acct.search") +
    '</span><input type="search" class="den-aa-search-in" placeholder="' +
    w(o, "kit.acct.search") +
    '" aria-keyshortcuts="/" autocomplete="off" spellcheck="false"><kbd>/</kbd></label>' +
    sel +
    '<nav class="den-aa-nav" aria-label="' +
    w(o, "kit.acct.sections") +
    '">' +
    nav +
    "</nav>" +
    cross +
    "</div>" +
    '<div class="den-aa-panes">' +
    panes +
    '<p class="den-aa-toast" role="status" aria-live="polite"></p></div>'
  );
}

/** The current section: the asked one when drawn, else the first drawn. */
function currentOf(o) {
  const secs = drawn(o).map((s) => s.id);
  return secs.includes(o.current) ? o.current : secs[0] || "profile";
}

/** The Account area's markup (see the top). */
export function accountAreaHtml(o = {}) {
  const root = o.id || "den-aa";
  const current = currentOf(o);
  return (
    '<div class="den-aa" id="' +
    esc(root) +
    '" data-den-aa data-current="' +
    current +
    '" role="region" aria-labelledby="' +
    esc(root) +
    '-title">' +
    innerHtml(o, current) +
    "</div>"
  );
}

/** ?account=<section> → the section ("profile" for one it doesn't know), or null. */
export function accountSectionOf(search) {
  let p;
  try {
    p = new URLSearchParams(String(search ?? ""));
  } catch {
    return null;
  }
  if (!p.has("account")) return null;
  const s = p.get("account");
  return IDS.includes(s) ? s : "profile";
}

/** `href` with ?account=<section>, or without it (section null). */
export function accountAreaHref(href, section) {
  const s = String(href ?? "");
  const hashAt = s.indexOf("#");
  const hash = hashAt >= 0 ? s.slice(hashAt) : "";
  const noHash = hashAt >= 0 ? s.slice(0, hashAt) : s;
  const qAt = noHash.indexOf("?");
  const path = qAt >= 0 ? noHash.slice(0, qAt) : noHash;
  const q = new URLSearchParams(qAt >= 0 ? noHash.slice(qAt + 1) : "");
  if (section) q.set("account", section);
  else q.delete("account");
  const qs = q.toString();
  return path + (qs ? "?" + qs : "") + hash;
}

/** Wires a drawn area (see the top). */
export function hydrateAccountArea(el, opts = {}) {
  let data = opts.data || null;
  const lang = () =>
    typeof opts.lang === "function"
      ? opts.lang()
      : opts.lang ||
        (el.closest && el.closest("[lang]")
          ? el.closest("[lang]").getAttribute("lang")
          : undefined);
  let dead = false;
  let toastT = 0;
  let switches = [];
  const q = (s) => el.querySelector(s);
  const all = (s) => Array.from(el.querySelectorAll(s));
  const search = () => q(".den-aa-search-in");

  function current() {
    return el.getAttribute("data-current");
  }

  function select(section, { quiet = false } = {}) {
    const pane = q('.den-aa-pane[data-section="' + section + '"]');
    if (!pane || dead) return;
    el.setAttribute("data-current", section);
    for (const b of all(".den-aa-sec"))
      if (b.getAttribute("data-section") === section)
        b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    const sel = q(".den-aa-sel");
    if (sel) sel.value = section;
    for (const p of all(".den-aa-pane"))
      p.hidden = p.getAttribute("data-section") !== section;
    if (opts.history !== false && typeof history !== "undefined")
      try {
        history.replaceState(
          history.state,
          "",
          accountAreaHref(
            location.pathname + location.search + location.hash,
            section,
          ),
        );
      } catch {
        /* an address the page can't change */
      }
    if (!quiet && opts.onSection) opts.onSection(section);
  }

  /** The rows that match, and the sections with a match. */
  function hits(text) {
    const t = String(text || "")
      .trim()
      .toLowerCase();
    const rows = [];
    const secs = new Set();
    if (!t) return { rows, secs: null };
    for (const p of all(".den-aa-pane")) {
      const s = p.getAttribute("data-section");
      const title = p.querySelector(".den-aa-h");
      const btn = q('.den-aa-sec[data-section="' + s + '"]');
      if (
        (title && title.textContent.toLowerCase().includes(t)) ||
        (btn && btn.textContent.toLowerCase().includes(t))
      )
        secs.add(s);
      for (const r of p.querySelectorAll(".den-aa-row"))
        if (r.textContent.toLowerCase().includes(t)) {
          rows.push(r);
          secs.add(s);
        }
    }
    return { rows, secs };
  }

  function filter() {
    const { secs } = hits(search() ? search().value : "");
    for (const b of all(".den-aa-sec"))
      b.hidden = !!secs && !secs.has(b.getAttribute("data-section"));
    // A group heading with no section left shows no more.
    for (const g of all(".den-aa-grp")) {
      let n = g.nextElementSibling;
      let any = false;
      while (n && n.classList.contains("den-aa-sec")) {
        if (!n.hidden) any = true;
        n = n.nextElementSibling;
      }
      g.hidden = !any;
    }
  }

  function jump() {
    const { rows, secs } = hits(search() ? search().value : "");
    const r = rows[0];
    if (!r) {
      if (secs && secs.size) select([...secs][0]);
      return;
    }
    const pane = r.closest(".den-aa-pane");
    select(pane.getAttribute("data-section"));
    if (r.scrollIntoView) r.scrollIntoView({ block: "nearest" });
    r.classList.remove("den-aa-flash");
    void r.offsetWidth;
    r.classList.add("den-aa-flash");
    setTimeout(() => r.classList.remove("den-aa-flash"), FLASH_MS);
  }

  function toast(text) {
    const t = q(".den-aa-toast");
    if (!t || dead) return;
    t.textContent = String(text ?? "");
    t.classList.toggle("on", !!text);
    clearTimeout(toastT);
    if (text)
      toastT = setTimeout(() => {
        t.textContent = "";
        t.classList.remove("on");
      }, TOAST_MS);
  }

  function run(btn) {
    const act = btn.getAttribute("data-den-aa-act");
    if (btn.getAttribute("aria-disabled") === "true") return;
    const info = {
      id: btn.getAttribute("data-id"),
      name: btn.getAttribute("data-name"),
      button: btn,
    };
    const go = () => {
      if (!opts.onAction) return;
      btn.setAttribute("aria-disabled", "true");
      let p;
      try {
        p = Promise.resolve(opts.onAction(act, info));
      } catch (e) {
        p = Promise.reject(e);
      }
      const done = () => {
        if (btn.isConnected) btn.removeAttribute("aria-disabled");
      };
      return p.then(done, done);
    };
    if (act !== "signout-all") return go();
    const l = lang();
    return askConfirm({
      title: kitT(l, "kit.acct.signOutAll.q"),
      message: kitT(l, "kit.acct.signOutAll.body"),
      okLabel: kitT(l, "kit.acct.signOutAll"),
      danger: true,
      opener: btn,
    }).then((yes) => (yes ? go() : undefined));
  }

  function wireSwitches() {
    for (const s of switches) s.destroy();
    switches = all(".den-aa-row[data-row=notification]").map((r) => {
      const id = r.getAttribute("data-id");
      let sw;
      sw = hydrateSwitch(r, {
        onChange(on) {
          if (!opts.onToggle) return;
          let p;
          try {
            p = Promise.resolve(opts.onToggle(id, on));
          } catch (e) {
            p = Promise.reject(e);
          }
          // Not saved: the switch goes back.
          p.catch(() => sw.set(!on));
        },
      });
      return sw;
    });
  }

  const onClick = (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const sec = t.closest(".den-aa-sec");
    if (sec) return select(sec.getAttribute("data-section"));
    if (t.closest("[data-den-aa-close]")) {
      if (opts.onClose) opts.onClose();
      return;
    }
    const btn = t.closest("[data-den-aa-act]");
    if (!btn || btn.getAttribute("data-den-aa-act") === "edit") return;
    e.preventDefault();
    run(btn);
  };
  const onChange = (e) => {
    if (e.target && e.target.classList.contains("den-aa-sel"))
      select(e.target.value);
  };
  const onInput = (e) => {
    if (e.target && e.target.classList.contains("den-aa-search-in")) filter();
  };
  const onKey = (e) => {
    if (e.isComposing) return;
    const t = e.target;
    const inSearch =
      t && t.classList && t.classList.contains("den-aa-search-in");
    if (e.key === "Escape") {
      if (inSearch && t.value) {
        e.preventDefault();
        e.stopPropagation();
        t.value = "";
        filter();
        return;
      }
      if (opts.onClose) {
        e.preventDefault();
        e.stopPropagation();
        opts.onClose();
      }
      return;
    }
    if (inSearch && e.key === "Enter") {
      e.preventDefault();
      jump();
      return;
    }
    if (
      e.key === "/" &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !(
        t &&
        t.closest &&
        t.closest("input, textarea, select, [contenteditable]")
      )
    ) {
      e.preventDefault();
      if (search()) search().focus();
    }
  };
  el.addEventListener("click", onClick);
  el.addEventListener("change", onChange);
  el.addEventListener("input", onInput);
  el.addEventListener("keydown", onKey);
  upgradeTimes(el);
  wireSwitches();

  return {
    select: (s, so) => select(s, so),
    current,
    toast,
    search: (text) => {
      if (!search()) return;
      search().value = String(text ?? "");
      filter();
    },
    update(next) {
      if (dead) return;
      data = { ...(data || {}), ...(next || {}) };
      const text = search() ? search().value : "";
      const o = { lang: lang(), ...data, current: current() };
      const cur = currentOf(o);
      el.innerHTML = innerHtml(o, cur);
      el.setAttribute("data-current", cur);
      if (search()) search().value = text;
      filter();
      upgradeTimes(el);
      wireSwitches();
    },
    destroy() {
      dead = true;
      clearTimeout(toastT);
      for (const s of switches) s.destroy();
      el.removeEventListener("click", onClick);
      el.removeEventListener("change", onChange);
      el.removeEventListener("input", onInput);
      el.removeEventListener("keydown", onKey);
    },
  };
}

/** The area in a modal <dialog> (see the top). */
export function openAccountArea(opts = {}) {
  const opener = openerOf(opts.opener);
  const d = document.createElement("dialog");
  d.className = "den-aa-dlg";
  const root = opts.id || "den-aa";
  d.setAttribute("aria-labelledby", root + "-title");
  if (opts.lang) d.setAttribute("lang", opts.lang);
  d.innerHTML = accountAreaHtml(opts);
  document.body.append(d);
  let closed = false;
  let area = null;
  function close() {
    if (closed) return;
    closed = true;
    if (area) area.destroy();
    if (d.open) d.close();
    d.remove();
    if (opts.history !== false)
      try {
        history.replaceState(
          history.state,
          "",
          accountAreaHref(
            location.pathname + location.search + location.hash,
            null,
          ),
        );
      } catch {
        /* an address the page can't change */
      }
    focusBack(opener);
    if (opts.onClosed) opts.onClosed();
  }
  area = hydrateAccountArea(d.firstElementChild, {
    ...opts,
    data: opts,
    onClose: close,
  });
  // The browser's own Esc (a cancel) goes the same way as the area's.
  d.addEventListener("cancel", (e) => {
    e.preventDefault();
    close();
  });
  // A press on the backdrop (outside the box) closes it.
  d.addEventListener("click", (e) => {
    if (e.target === d) close();
  });
  if (typeof d.showModal === "function") d.showModal();
  else d.setAttribute("open", "");
  area.select(area.current(), { quiet: true });
  const first = d.querySelector('.den-aa-sec[aria-current="true"]');
  if (first && first.offsetParent) first.focus();
  else {
    const s = d.querySelector(".den-aa-search-in");
    if (s) s.focus();
  }
  return { ...area, close, dialog: d };
}
