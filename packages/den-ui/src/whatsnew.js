/**
 * den-ui What's new: the release notes pop-up, opened from the version
 * chip (or on a new version's first visit). Its look is whatsnew.css.
 *
 *   configureWhatsNew({ lang, changelog, reportButton, onClose })
 *     lang          the kit's words' language (a string or a function)
 *     changelog()   the product's adapter: Promise of the entries, newest
 *                   first: [{ version, date, note?, raw?, sections:
 *                   { "Added": [{ text, sub? }] } }]
 *     reportButton()  the footer's Report button HTML ("" when reports
 *                   are off); default the kit's
 *     onClose(latest) after a close: the newest version, to remember it
 *                   as seen (the chip's dot goes)
 *   loadWhatsNew()     asks changelog() and keeps the entries
 *   setEntries(list)   or gives them directly
 *   openWhatsNew()     opens it at the newest release; focus on its heading
 *   closeWhatsNew()    closes it; focus back where it was (else the chip)
 *   changelogView(entries, showAll)  what it shows (pure)
 *
 * It is an aria-modal dialog: Tab stays in it, Escape and a click on the
 * veil close it. Markdown and Slack copy buttons on each version.
 */
import { esc, kitT } from "./strings.js";
import { reportButtonHtml } from "./shell-html.js";

const cfg = {
  lang: "en",
  changelog: null,
  reportButton: null,
  onClose: null,
};
let entries = [];
let showAll = false;
let returnFocus = null;
let made = false;

const lang = () => (typeof cfg.lang === "function" ? cfg.lang() : cfg.lang);
const t = (key, vars) => kitT(lang(), key, vars);
const escT = (key, vars) => esc(t(key, vars));

export function configureWhatsNew(o = {}) {
  Object.assign(cfg, o);
}

/**
 * What the pop-up shows: the newest release only, or every version once
 * the reader asks for them, plus the one button that toggles between the
 * two (null when there is nothing earlier to show).
 */
export function changelogView(list, all) {
  const l = Array.isArray(list) ? list : [];
  const earlier = l.length - 1;
  if (earlier < 1) return { shown: l.slice(0, 1), toggle: null };
  return {
    shown: all ? l : l.slice(0, 1),
    toggle: all
      ? { label: "Show latest only", expanded: true }
      : { label: `Show all versions (${earlier} earlier)`, expanded: false },
  };
}

export function setEntries(list) {
  entries = Array.isArray(list) ? list : [];
}
export function getEntries() {
  return entries;
}

export async function loadWhatsNew() {
  try {
    setEntries(cfg.changelog ? await cfg.changelog() : []);
  } catch {
    setEntries([]);
  }
  return entries;
}

/** The overlay, made once (hidden until opened). */
export function ensureWhatsNew() {
  if (made && document.getElementById("cl-overlay")) return;
  made = true;
  const report = cfg.reportButton
    ? cfg.reportButton()
    : reportButtonHtml({ inFoot: false, lang: lang() });
  const overlay = document.createElement("div");
  overlay.id = "cl-overlay";
  overlay.className = "cl-overlay";
  overlay.innerHTML =
    '<div class="cl-box" role="dialog" aria-modal="true" aria-labelledby="cl-title">' +
    `<div class="cl-hdr"><h3 id="cl-title" tabindex="-1">${escT("kit.whatsnew.title")}</h3><button type="button" class="cl-close" id="cl-close-btn" title="${escT("kit.whatsnew.close")}" aria-label="${escT("kit.whatsnew.close")}">×</button></div>` +
    '<div class="cl-body" id="cl-body"></div>' +
    '<div class="cl-footer">' +
    // Report, as in every pop-up.
    (report || "") +
    '<button type="button" class="cl-more-btn" id="cl-more" aria-controls="cl-body" aria-expanded="false" hidden></button><button class="cl-got-it" id="cl-got-it-btn">' +
    escT("kit.whatsnew.gotIt") +
    "</button></div>" +
    "</div>";
  document.body.appendChild(overlay);
  document.getElementById("cl-more")?.addEventListener("click", () => {
    showAll = !showAll;
    renderBody();
    const body = document.getElementById("cl-body");
    if (body) body.scrollTop = 0;
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeWhatsNew();
  });
  document
    .getElementById("cl-close-btn")
    ?.addEventListener("click", () => closeWhatsNew());
  document
    .getElementById("cl-got-it-btn")
    ?.addEventListener("click", () => closeWhatsNew());
  document.addEventListener("keydown", (e) => {
    if (!overlay.classList.contains("open")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeWhatsNew();
    } else if (e.key === "Tab") trapTab(e, overlay);
  });
}

/** Tab and Shift+Tab stay inside the open dialog (aria-modal). */
function trapTab(e, overlay) {
  const box = overlay.querySelector(".cl-box");
  const stops = [
    ...box.querySelectorAll("button, a[href], [tabindex]:not([tabindex='-1'])"),
  ].filter((el) => !el.hidden && !el.disabled && el.getClientRects().length);
  if (!stops.length) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  const at = document.activeElement;
  // Anything not one of the stops (the focused heading, or outside) counts
  // as outside: Shift+Tab from the heading must not leave the dialog.
  const inside = stops.includes(at);
  if (e.shiftKey ? at === first || !inside : at === last) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (!inside) {
    e.preventDefault();
    first.focus();
  }
}

const COPY_ICON =
  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="4" y="0.5" width="8.5" height="8.5" rx="1.5"/>' +
  '<path d="M8.5 9v2.5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h2.5"/>' +
  "</svg>";
const SLACK_ICON =
  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M1 2a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L5 12v-3H2a1 1 0 0 1-1-1V2z"/>' +
  "</svg>";
const CHECK_ICON =
  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<polyline points="2,7 5,10 11,3"/>' +
  "</svg>";

const escHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const renderItem = (s) =>
  escHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");

/** The body: the release(s) shown, and the footer's toggle. */
export function renderBody() {
  const body = document.getElementById("cl-body");
  if (!body) return;
  if (!entries.length) {
    body.innerHTML = `<p class="cl-none">${escT("kit.whatsnew.none")}</p>`;
    return;
  }
  const view = changelogView(entries, showAll);
  body.innerHTML = view.shown
    .map(
      (entry, i) =>
        (i > 0 ? '<hr class="cl-divider">' : "") +
        '<div class="cl-entry">' +
        '<div class="cl-ver-row">' +
        '<h4 class="cl-ver">v' +
        escHtml(entry.version) +
        "</h4>" +
        '<span class="cl-date">' +
        escHtml(entry.date) +
        "</span>" +
        '<div class="cl-copy-group">' +
        '<button class="cl-copy-btn" data-cl-version="' +
        escHtml(entry.version) +
        '" title="' +
        escT("kit.whatsnew.copyMd") +
        '" aria-label="' +
        escT("kit.whatsnew.copyMdX", { v: entry.version }) +
        '">' +
        COPY_ICON +
        "</button>" +
        '<button class="cl-slack-btn" data-cl-version="' +
        escHtml(entry.version) +
        '" title="' +
        escT("kit.whatsnew.copySlack") +
        '" aria-label="' +
        escT("kit.whatsnew.copySlackX", { v: entry.version }) +
        '">' +
        SLACK_ICON +
        "</button>" +
        "</div>" +
        "</div>" +
        (entry.note
          ? '<p class="cl-note">' + renderItem(entry.note) + "</p>"
          : "") +
        Object.entries(entry.sections ?? {})
          .map(
            ([sec, items]) =>
              '<div class="cl-sec">' +
              escHtml(sec) +
              "</div>" +
              '<ul class="cl-items">' +
              items
                .map(
                  (it) =>
                    "<li>" +
                    renderItem(it.text) +
                    (it.sub?.length
                      ? '<ul class="cl-subitems">' +
                        it.sub
                          .map((s) => "<li>" + renderItem(s) + "</li>")
                          .join("") +
                        "</ul>"
                      : "") +
                    "</li>",
                )
                .join("") +
              "</ul>",
          )
          .join("") +
        "</div>",
    )
    .join("");

  // The toggle lives in the footer, so it is in view however long the
  // newest entry is.
  const more = document.getElementById("cl-more");
  if (more) {
    more.hidden = !view.toggle;
    if (view.toggle) {
      more.textContent = view.toggle.expanded
        ? t("kit.whatsnew.latest")
        : t("kit.whatsnew.all", { n: entries.length - 1 });
      more.setAttribute("aria-expanded", String(view.toggle.expanded));
    }
  }

  const copyBtn = (sel, icon, title, make, write) =>
    body.querySelectorAll(sel).forEach((btn) => {
      btn.addEventListener("click", async () => {
        const entry = entries.find((e) => e.version === btn.dataset.clVersion);
        if (!entry) return;
        try {
          await write(make(entry));
          btn.innerHTML = CHECK_ICON;
          btn.classList.add("copied");
          setTimeout(() => {
            btn.innerHTML = icon;
            btn.classList.remove("copied");
          }, 2000);
        } catch {
          btn.title = t("kit.whatsnew.copyFailed");
          setTimeout(() => (btn.title = t(title)), 2000);
        }
      });
    });
  // Markdown copy: plain text for GitHub, MD editors, etc.
  copyBtn(
    ".cl-copy-btn",
    COPY_ICON,
    "kit.whatsnew.copyMd",
    (e) => e.raw || buildMarkdown(e),
    copyText,
  );
  // Rich copy: a DOM selection's HTML, which Slack (and Notion, Docs)
  // trusts and renders as formatted text.
  copyBtn(
    ".cl-slack-btn",
    SLACK_ICON,
    "kit.whatsnew.copySlack",
    buildRichHtml,
    writeRich,
  );
}

/**
 * Plain text to the clipboard: navigator.clipboard where it can (secure
 * contexts), else execCommand('copy') (an http:// origin).
 */
export function copyText(text) {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.className = "kit-offscreen";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy")
        ? resolve()
        : reject(new Error("execCommand failed"));
    } catch (e) {
      reject(e);
    } finally {
      document.body.removeChild(ta);
    }
  });
}

/**
 * Rich HTML to the clipboard through a hidden contenteditable: the "copy
 * from a web page" path, whose HTML Slack's paste trusts (a ClipboardItem's
 * it ignores).
 */
function writeRich(html) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("div");
    el.contentEditable = "true";
    el.className = "kit-offscreen";
    el.innerHTML = html;
    document.body.appendChild(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      document.execCommand("copy")
        ? resolve()
        : reject(new Error("execCommand failed"));
    } catch (e) {
      reject(e);
    } finally {
      sel.removeAllRanges();
      document.body.removeChild(el);
    }
  });
}

/** Slack's HTML: bold paragraphs for headings, <code>, bullets. */
export function buildRichHtml(entry) {
  const sections = Object.entries(entry.sections ?? {})
    .map(([sec, items]) => {
      const li = items.flatMap((it) => [
        `<li>${renderItem(it.text)}</li>`,
        ...(it.sub ?? []).map((s) => `<li>${renderItem(s)}</li>`),
      ]);
      return `<p><strong>${escHtml(sec)}</strong></p><ul>${li.join("")}</ul>`;
    })
    .join("");
  return `<p><strong>v${escHtml(entry.version)} — ${escHtml(entry.date)}</strong></p>${sections}`;
}

/** Markdown rebuilt from an entry (when it has no `raw`). */
export function buildMarkdown(entry) {
  const lines = [`## [${entry.version}] — ${entry.date}`];
  for (const [sec, items] of Object.entries(entry.sections ?? {})) {
    lines.push("", `### ${sec}`, "");
    for (const item of items) {
      lines.push(`- ${item.text}`);
      for (const s of item.sub ?? []) lines.push(`  - ${s}`);
    }
  }
  return lines.join("\n");
}

export function openWhatsNew() {
  showAll = false;
  ensureWhatsNew();
  renderBody();
  const overlay = document.getElementById("cl-overlay");
  if (!overlay) return;
  if (!overlay.classList.contains("open")) {
    const at = document.activeElement;
    // Nothing focused (a first-visit open): the version chip.
    returnFocus =
      at && at !== document.body && !overlay.contains(at)
        ? at
        : document.getElementById("version-pill");
  }
  overlay.classList.add("open");
  // Always at the newest release. After `.open`: while the overlay is
  // display:none the body has no scroll box, so a reset there doesn't stick.
  const body = document.getElementById("cl-body");
  if (body) body.scrollTop = 0;
  // The heading first, so a screen reader starts at the latest notes.
  document.getElementById("cl-title")?.focus();
}

export function closeWhatsNew() {
  const overlay = document.getElementById("cl-overlay");
  const wasOpen = !!overlay?.classList.contains("open");
  if (overlay) overlay.classList.remove("open");
  if (wasOpen) {
    const back = returnFocus?.isConnected
      ? returnFocus
      : document.getElementById("version-pill");
    returnFocus = null;
    back?.focus();
  }
  if (cfg.onClose) cfg.onClose(entries[0]?.version ?? null);
  const pip = document.getElementById("v-pip");
  if (pip) pip.style.display = "none";
}
