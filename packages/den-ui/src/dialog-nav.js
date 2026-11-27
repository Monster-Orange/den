import { esc } from "./strings.js";
import { askConfirm, openerOf, focusBack } from "./dialog.js";
import { icon } from "./icons.js";
import { holdDots } from "./busy.js";

export const DIALOG_NAV_WORDS = {
  en: {
    close: "Close",
    searchAccount: "Search account",
    searchSettings: "Search settings",
    noMatch: "Nothing matches “{q}”.",
    back: "Back to {title}",
    toSettings: "Settings ↗",
    toAccount: "Account ↗",
    discard: "Discard your change to {field}?",
    discardYes: "Discard",
    discardNo: "Keep editing",
    saved: "Saved",
    notSaved: "Not saved. Try again.",
  },
  es: {
    close: "Cerrar",
    searchAccount: "Buscar en la cuenta",
    searchSettings: "Buscar en la configuración",
    noMatch: "No hay nada que coincida con «{q}».",
    back: "Volver a {title}",
    toSettings: "Configuración ↗",
    toAccount: "Cuenta ↗",
    discard: "¿Descartar tu cambio en {field}?",
    discardYes: "Descartar",
    discardNo: "Seguir editando",
    saved: "Guardado",
    notSaved: "No se guardó. Inténtalo de nuevo.",
  },
  ja: {
    close: "閉じる",
    searchAccount: "アカウント内を検索",
    searchSettings: "設定を検索",
    noMatch: "「{q}」に一致するものはありません。",
    back: "{title} に戻る",
    toSettings: "設定 ↗",
    toAccount: "アカウント ↗",
    discard: "{field} の変更を破棄しますか？",
    discardYes: "破棄",
    discardNo: "編集を続ける",
    saved: "保存しました",
    notSaved: "保存されませんでした。もう一度お試しください。",
  },
};
const HITS = 6;
const PHONE = "(max-width: 600px)";

const wordsFor = (lang, words) => ({
  ...DIALOG_NAV_WORDS.en,
  ...(DIALOG_NAV_WORDS[lang] ?? {}),
  ...(words ?? {}),
});
const fill = (s, v) =>
  String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m));
const paneHref = (base, param, pane) => {
  const u = new URL(base || "/", "http://x/");
  u.searchParams.set(param, pane);
  u.searchParams.delete("at");
  return u.pathname + u.search + u.hash;
};
const closeHrefOf = (base, param) => {
  const u = new URL(base || "/", "http://x/");
  u.searchParams.delete(param);
  u.searchParams.delete("at");
  return u.pathname + u.search + u.hash;
};

export function dialogNavHtml({
  id = "den-dn",
  kind = "settings",
  param = kind,
  title,
  groups = [],
  open,
  href = "",
  cross,
  foot = [],
  lang = "en",
  words,
  shown = true,
} = {}) {
  const w = wordsFor(lang, words);
  const panes = groups.flatMap((g) => g.panes ?? []);
  const on = panes.some((p) => p.id === open) ? open : panes[0]?.id;
  const rail = groups
    .map((g) => {
      const rows = (g.panes ?? [])
        .map(
          (p) =>
            `<li><a class="dn-row" href="${esc(paneHref(href, param, p.id))}" data-dn-pane="${esc(p.id)}"` +
            (p.id === on ? ' aria-current="true"' : "") +
            `>` +
            (p.icon
              ? icon(p.icon).replace("<svg ", '<svg class="dn-ic" ')
              : "") +
            `<span class="dn-row-t">${esc(p.title)}</span><span class="dn-chev" aria-hidden="true">›</span></a></li>`,
        )
        .join("");
      return (
        (g.label ? `<p class="dn-group">${esc(g.label)}</p>` : "") +
        `<ul class="dn-list">${rows}</ul>`
      );
    })
    .join("");
  const sections = panes
    .map((p) => {
      const hid = `${id}-h-${p.id}`;
      const body = p.lazy ? "" : (p.html ?? "");
      return (
        `<section class="dn-pane" data-dn-pane="${esc(p.id)}" aria-labelledby="${esc(hid)}"` +
        (p.id === on ? "" : " hidden") +
        (p.lazy ? " data-dn-lazy" : "") +
        `><header class="dn-pane-head">` +
        `<a class="den-btn ghost icon dn-back" href="${esc(paneHref(href, param, ""))}" data-dn-back aria-label="${esc(fill(w.back, { title }))}"><span aria-hidden="true">←</span></a>` +
        `<h3 id="${esc(hid)}" class="dn-pane-t">${esc(p.title)}</h3>` +
        `<a class="den-btn ghost icon dn-pane-x" href="${esc(closeHrefOf(href, param))}" data-dn-close aria-label="${esc(w.close)}"><span aria-hidden="true">✕</span></a>` +
        (p.desc ? `<p class="dn-pane-d">${esc(p.desc)}</p>` : "") +
        `</header>` +
        (p.readOnly
          ? `<p class="dn-ro">${esc(p.readOnly)}</p><fieldset class="dn-body" disabled>${body}</fieldset>`
          : `<div class="dn-body">${body}</div>`) +
        `</section>`
      );
    })
    .join("");
  const ph = kind === "account" ? w.searchAccount : w.searchSettings;
  const tid = `${id}-title`;
  return (
    `<dialog class="dn" id="${esc(id)}" data-dn-param="${esc(param)}" aria-labelledby="${esc(tid)}"` +
    (shown ? " open" : "") +
    ` data-dn-screen="${open ? "pane" : "list"}">` +
    `<header class="dn-head"><h2 id="${esc(tid)}" class="dn-title">${esc(title)}</h2>` +
    `<a class="den-btn ghost icon dn-x" href="${esc(closeHrefOf(href, param))}" data-dn-close aria-label="${esc(w.close)}"><span aria-hidden="true">✕</span></a></header>` +
    `<nav class="dn-rail" aria-label="${esc(title)}">` +
    `<input class="dn-search" type="search" autocomplete="off" data-dn-search placeholder="${esc(ph)}" aria-label="${esc(ph)}" aria-keyshortcuts="/">` +
    `<p class="dn-none" data-dn-none hidden></p>` +
    `<div class="dn-lists">${rail}</div>` +
    (cross || foot.length
      ? `<div class="dn-foot">` +
        (cross
          ? `<a class="dn-cross" href="${esc(cross.href)}" data-dn-cross>${esc(cross.label ?? (kind === "account" ? w.toSettings : w.toAccount))}</a>`
          : "") +
        foot
          .filter((f) => f && f.href)
          .map(
            (f) =>
              `<a class="dn-cross" href="${esc(f.href)}">${esc(f.label ?? "")}</a>`,
          )
          .join("") +
        `</div>`
      : "") +
    `</nav><div class="dn-panes">${sections}</div></dialog>`
  );
}

const norm = (s) => String(s ?? "").toLocaleLowerCase();
const labelOf = (el) =>
  (
    el.querySelector("[data-entry-label]") ??
    el.querySelector("label, h4, .dn-label") ??
    el
  ).textContent
    .trim()
    .replace(/\s+/g, " ");
const bold = (text, q) => {
  const at = norm(text).indexOf(q);
  if (at < 0 || !q) return esc(text);
  return (
    esc(text.slice(0, at)) +
    `<b>${esc(text.slice(at, at + q.length))}</b>` +
    esc(text.slice(at + q.length))
  );
};

export function hydrateDialogNav(dialog, opts = {}) {
  if (!dialog || dialog.dataset.dnLive != null) return dialog?.__dn;
  dialog.dataset.dnLive = "";
  const doc = dialog.ownerDocument;
  const win = doc.defaultView;
  const param = dialog.dataset.dnParam;
  const w = wordsFor(opts.lang, opts.words);
  const $ = (s) => dialog.querySelector(s);
  const $$ = (s) => [...dialog.querySelectorAll(s)];
  const search = $("[data-dn-search]");
  const none = $("[data-dn-none]");
  const phone = () => win.matchMedia?.(PHONE).matches ?? false;
  const loaded = new Set();
  let opener = null;
  let pushed = false;
  let reopening = false;
  let unwinding = null;

  const section = (id) =>
    $$("section[data-dn-pane]").find((s) => s.dataset.dnPane === id);
  const current = () =>
    $("a.dn-row[aria-current='true']")?.dataset.dnPane ??
    $$("section[data-dn-pane]").find((s) => !s.hidden)?.dataset.dnPane;
  const first = () => $("section[data-dn-pane]")?.dataset.dnPane;
  const url = (pane, at) => {
    const u = new URL(win.location.href);
    u.searchParams.set(param, pane ?? "");
    if (at) u.searchParams.set("at", at);
    else u.searchParams.delete("at");
    return u.pathname + u.search + u.hash;
  };
  const write = (pane, how, at) => {
    if (opts.url === false || how === "none") return;
    win.history[how === "push" ? "pushState" : "replaceState"](
      {
        dn: param,
        dnPhonePane: how === "push" || !!win.history.state?.dnPhonePane,
      },
      "",
      url(pane, at),
    );
  };

  function show(pane, at, how = "replace") {
    const s = section(pane) ?? $("section[data-dn-pane]");
    if (!s) return;
    const id = s.dataset.dnPane;
    for (const x of $$("section[data-dn-pane]")) x.hidden = x !== s;
    for (const r of $$("a.dn-row[data-dn-pane]"))
      if (r.dataset.dnPane === id) r.setAttribute("aria-current", "true");
      else r.removeAttribute("aria-current");
    if (s.hasAttribute("data-dn-lazy") && !loaded.has(id)) {
      loaded.add(id);
      Promise.resolve(opts.load?.(id, s.querySelector(".dn-body"))).catch(
        () => {},
      );
    }
    dialog.dataset.dnScreen = "pane";
    write(id, how, at);
    $(".dn-panes").scrollTop = 0;
    if (at) jumpTo(s, at);
  }

  function jumpTo(s, at) {
    const row = [...s.querySelectorAll("[data-entry]")].find(
      (e) => e.dataset.entry === at,
    );
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.classList.remove("dn-flash");
    void row.offsetWidth;
    row.classList.add("dn-flash");
    row.addEventListener(
      "animationend",
      () => row.classList.remove("dn-flash"),
      { once: true },
    );
    win.setTimeout(() => row.classList.remove("dn-flash"), 2000);
    const c = row.querySelector(
      "input:not([type=hidden]), select, textarea, button, [tabindex]",
    );
    (c ?? row).focus?.({ preventScroll: true });
  }

  function find(q) {
    const hits = [];
    for (const s of $$("section[data-dn-pane]")) {
      const id = s.dataset.dnPane;
      const title = s.querySelector(".dn-pane-t")?.textContent ?? "";
      const own =
        norm(title).includes(q) || norm(s.dataset.dnTitleEn).includes(q);
      const found = [];
      for (const e of s.querySelectorAll("[data-entry]")) {
        if (found.length >= HITS) break;
        const text = labelOf(e);
        const all = norm(e.textContent) + " " + norm(e.dataset.entryEn);
        if (all.includes(q)) found.push({ at: e.dataset.entry, text });
      }
      if (own || found.length) hits.push({ id, title, found });
    }
    return hits;
  }

  function filter() {
    const q = norm(search.value.trim());
    for (const ul of $$(".dn-hits")) ul.remove();
    dialog.toggleAttribute("data-dn-searching", !!q);
    if (!q) {
      for (const li of $$(".dn-list > li")) li.hidden = false;
      for (const g of $$(".dn-group")) g.hidden = false;
      none.hidden = true;
      return;
    }
    const hits = find(q);
    const by = new Map(hits.map((h) => [h.id, h]));
    for (const r of $$("a.dn-row[data-dn-pane]")) {
      const h = by.get(r.dataset.dnPane);
      r.parentElement.hidden = !h;
      if (!h?.found.length) continue;
      const ul = doc.createElement("ul");
      ul.className = "dn-hits";
      ul.innerHTML = h.found
        .map(
          (f) =>
            `<li><button type="button" class="dn-hit" data-dn-hit="${esc(h.id)}" data-dn-at="${esc(f.at)}">` +
            `<span class="dn-hit-pane">${esc(h.title)} › </span>${bold(f.text, q)}</button></li>`,
        )
        .join("");
      r.parentElement.append(ul);
    }
    for (const g of $$(".dn-group")) {
      const list = g.nextElementSibling;
      g.hidden = !list || ![...list.children].some((li) => !li.hidden);
    }
    none.hidden = hits.length > 0;
    none.textContent = hits.length ? "" : fill(w.noMatch, { q: search.value });
  }

  function clearSearch() {
    search.value = "";
    filter();
  }

  const typed = () =>
    $$("[data-dn-typed]").find(
      (el) =>
        ("value" in el && el.value !== el.defaultValue) ||
        el.dataset.dnDirty === "true",
    );

  async function close() {
    const dirty = typed();
    if (dirty) {
      const field =
        dirty.dataset.dnField ||
        dirty.labels?.[0]?.textContent?.trim() ||
        dirty.name ||
        "";
      const ok = await askConfirm({
        title: fill(w.discard, { field }),
        okLabel: w.discardYes,
        cancelLabel: w.discardNo,
        danger: true,
        opener: doc.activeElement,
      });
      if (!ok) return false;
      for (const el of $$("[data-dn-typed]"))
        if ("value" in el) el.value = el.defaultValue;
    }
    dialog.close();
    return true;
  }

  dialog.addEventListener("close", () => {
    if (reopening) {
      reopening = false;
      return;
    }
    if (opts.url !== false) {
      const steps = (pushed ? 1 : 0) + (win.history.state?.dnPhonePane ? 1 : 0);
      if (steps) {
        unwinding = { clean: !pushed };
        win.history.go(-steps);
      } else dropParam();
      pushed = false;
    }
    doc.documentElement.classList.remove("dn-locked");
    opts.onClose?.();
    focusBack(opener);
  });

  const say = (pane, text, bad) => {
    let p = pane.querySelector(":scope > .dn-say");
    if (!p) {
      p = doc.createElement("p");
      p.className = "dn-say";
      pane.querySelector(".dn-pane-head")?.after(p);
    }
    p.setAttribute("role", bad ? "alert" : "status");
    p.textContent = text;
    p.hidden = !text;
  };
  dialog.addEventListener("submit", async (e) => {
    const form = e.target;
    const pane = form.closest?.("section[data-dn-pane]");
    if (!pane || form.method === "dialog") return;
    e.preventDefault();
    const btn =
      e.submitter ?? form.querySelector("button:not([type]), [type=submit]");
    if (btn?.getAttribute("aria-busy") === "true") return;
    if (btn) holdDots(btn, true);
    say(pane, "");
    let r;
    try {
      if (opts.onSave) r = await opts.onSave(form, pane.dataset.dnPane);
      else {
        const res = await win.fetch(form.action, {
          method: (form.method || "post").toUpperCase(),
          body: new win.FormData(form, e.submitter ?? undefined),
          credentials: "same-origin",
          headers: { accept: "text/html", "x-dn-pane": "1" },
        });
        if (res.ok && res.headers.get("x-dn-pane")) {
          const body = pane.querySelector(".dn-body");
          if (body) body.innerHTML = await res.text();
          r = { ok: true };
        } else r = { ok: false };
      }
    } catch {
      r = { ok: false };
    }
    if (btn) holdDots(btn, false);
    if (r && r.ok !== false) {
      for (const el of form.elements)
        if ("defaultValue" in el) el.defaultValue = el.value;
      say(pane, r.message ?? w.saved);
    } else say(pane, r?.error ?? w.notSaved, true);
  });

  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (search.value) return clearSearch();
    void close();
  });

  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      const out =
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom;
      if (out) return void close();
    }
    const t = e.target.closest?.("a, button");
    if (!t || !dialog.contains(t)) return;
    if (t.matches("[data-dn-close]")) {
      e.preventDefault();
      void close();
    } else if (t.matches("[data-dn-back]")) {
      e.preventDefault();
      backToList();
    } else if (t.matches("a.dn-row")) {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      const was = dialog.dataset.dnScreen;
      show(
        t.dataset.dnPane,
        null,
        phone() && was === "list" ? "push" : "replace",
      );
      if (phone()) $(".dn-pane:not([hidden]) .dn-back")?.focus();
    } else if (t.matches("a[data-dn-to]")) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || !section(t.dataset.dnTo))
        return;
      e.preventDefault();
      show(t.dataset.dnTo, t.dataset.dnAt || null);
      (phone()
        ? $(".dn-pane:not([hidden]) .dn-back")
        : $("a.dn-row[aria-current]")
      )?.focus();
    } else if (t.matches("[data-dn-hit]")) {
      const pane = t.dataset.dnHit;
      const at = t.dataset.dnAt;
      clearSearch();
      show(pane, at, phone() ? "push" : "replace");
    } else if (t.matches("[data-dn-cross]")) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || !opts.onCross) return;
      e.preventDefault();
      pushed = false;
      dialog.close();
      opts.onCross(t.getAttribute("href"));
    }
  });

  function backToList() {
    const id = current();
    if (opts.url !== false && win.history.state?.dnPhonePane)
      win.history.back();
    else {
      dialog.dataset.dnScreen = "list";
      write("", "replace");
    }
    $$("a.dn-row")
      .find((r) => r.dataset.dnPane === id)
      ?.focus();
  }

  const railItems = () =>
    $$(".dn-rail a.dn-row, .dn-rail .dn-hit").filter(
      (x) => !x.closest("[hidden]"),
    );
  dialog.addEventListener("keydown", (e) => {
    const t = e.target;
    const inField = t.matches?.("input, textarea, select, [contenteditable]");
    if (e.key === "/" && !inField) {
      e.preventDefault();
      search.focus();
      return;
    }
    if (t === search) {
      if (e.key === "Enter") {
        e.preventDefault();
        (
          railItems().find((x) => x.matches(".dn-hit")) ?? railItems()[0]
        )?.click();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        railItems()[0]?.focus();
      }
      return;
    }
    if (!t.closest?.(".dn-rail") || !t.matches("a.dn-row, .dn-hit")) return;
    const items = railItems();
    const i = items.indexOf(t);
    let to = null;
    if (e.key === "ArrowDown") to = items[Math.min(i + 1, items.length - 1)];
    else if (e.key === "ArrowUp") to = i > 0 ? items[i - 1] : search;
    else if (e.key === "Home") to = items[0];
    else if (e.key === "End") to = items.at(-1);
    if (!to) return;
    e.preventDefault();
    to.focus();
    if (to.matches("a.dn-row") && !phone()) show(to.dataset.dnPane);
  });

  search.addEventListener("input", filter);

  function dropParam() {
    const u = new URL(win.location.href);
    u.searchParams.delete(param);
    u.searchParams.delete("at");
    win.history.replaceState(null, "", u.pathname + u.search + u.hash);
  }

  win.matchMedia?.(PHONE).addEventListener?.("change", (m) => {
    if (dialog.open && !m.matches && dialog.dataset.dnScreen === "list")
      show(current() ?? first());
  });

  win.addEventListener("popstate", () => {
    if (unwinding) {
      if (unwinding.clean) dropParam();
      unwinding = null;
      return;
    }
    if (!dialog.open || opts.url === false) return;
    const u = new URL(win.location.href);
    if (!u.searchParams.has(param)) {
      pushed = false;
      dialog.close();
      return;
    }
    const pane = u.searchParams.get(param);
    if (pane) return show(pane, null, "none");
    const was = current();
    dialog.dataset.dnScreen = "list";
    railItems()
      .find((r) => r.dataset.dnPane === was)
      ?.focus();
  });

  function open(pane, at, from) {
    opener = openerOf(from ?? doc.activeElement);
    const already = dialog.open;
    if (dialog.open && !dialog.matches(":modal")) {
      reopening = true;
      dialog.close();
    }
    if (!dialog.open) dialog.showModal();
    doc.documentElement.classList.add("dn-locked");
    const target = pane || (phone() ? null : (current() ?? first()));
    if (!already && opts.url !== false) {
      const u = new URL(win.location.href);
      if (!u.searchParams.has(param)) {
        pushed = true;
        win.history.pushState({ dn: param }, "", url(target ?? "", at));
      }
    }
    if (target) show(target, at);
    else dialog.dataset.dnScreen = "list";
    if (!at) search.focus();
    return api;
  }

  const api = { open, show, close, element: dialog };
  dialog.__dn = api;
  if (dialog.hasAttribute("open")) {
    const u = new URL(win.location.href);
    open(u.searchParams.get(param) || null, u.searchParams.get("at"));
  }
  return api;
}
