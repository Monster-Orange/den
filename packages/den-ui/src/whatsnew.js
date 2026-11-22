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
 *   closeWhatsNew()    closes it; focus back where it was (else the chip),
 *                      unless the page put it in a control of its own meanwhile
 *   changelogView(entries, showAll)  what it shows (pure)
 *
 * Issue 793: it is the kit's dialog frame (dialog.js: dialogHtml, kind
 * "panel", and mountDialog), so it has the frame's look and its own font,
 * never the page's or the browser's serif. A modal: Tab stays in it,
 * Escape, Close, Got it and a click on the backdrop close it; Report is
 * first in its footer. Markdown and Slack copy buttons on each version.
 */
import { esc, kitT } from "./strings.js";
import { reportButtonHtml } from "./shell-html.js";
import { dialogHtml, mountDialog, openerOf } from "./dialog.js";

const cfg = {
  lang: "en",
  changelog: null,
  reportButton: null,
  onClose: null,
};
let entries = [];
let showAll = false;
/** The open frame (mountDialog's handle); null while closed. */
let frame = null;
/** Waiting for another pop-up to close before opening. */
let waiting = false;

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

/**
 * Kept for hosts that call it at load: the dialog is made when it opens
 * and taken off the page when it closes (issue 793), like the kit's other
 * pop-ups, so nothing of it is on the page while closed.
 */
export function ensureWhatsNew() {}

/** The dialog, made for one opening. */
function makeFrame() {
  const report = cfg.reportButton
    ? cfg.reportButton()
    : reportButtonHtml({ inFoot: false, lang: lang() });
  const close = t("kit.whatsnew.close");
  const html = dialogHtml({
    kind: "panel",
    id: "cl-overlay",
    className: "cl-dlg",
    ids: { h: "cl-title", body: "cl-body" },
    title: t("kit.whatsnew.title"),
    closeLabel: close,
    closeAttrs: { id: "cl-close-btn", title: close, "aria-label": close },
    // Report, as in every pop-up (none when reports are off).
    report: report || "",
    attrs: report ? null : { "data-dk-report": true },
    actions: [
      {
        label: "",
        type: "button",
        className: "cl-more-btn",
        attrs: {
          id: "cl-more",
          "aria-controls": "cl-body",
          "aria-expanded": "false",
          hidden: true,
        },
      },
      {
        label: t("kit.whatsnew.gotIt"),
        value: "ok",
        kind: "primary",
        className: "cl-got-it",
        attrs: { id: "cl-got-it-btn" },
      },
    ],
  });
  frame = mountDialog(html, { show: false, onClose: closed });
  const d = frame.dialog;
  d.querySelector("#cl-more")?.addEventListener("click", () => {
    showAll = !showAll;
    renderBody();
    const body = document.getElementById("cl-body");
    if (body) body.scrollTop = 0;
  });
  // A click on the backdrop (outside the box) closes it.
  d.addEventListener("click", (e) => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      closeWhatsNew();
  });
}

/** After it closes, however: remember the newest version as seen. */
function closed() {
  frame?.dialog.classList.remove("open");
  frame = null;
  if (cfg.onClose) cfg.onClose(entries[0]?.version ?? null);
  const pip = document.getElementById("v-pip");
  if (pip) pip.style.display = "none";
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

/** Another pop-up of the page's that is open as a modal, if any. */
function otherModal() {
  return [...document.querySelectorAll("dialog[open]")].find(
    (d) => d.id !== "cl-overlay" && d.matches(":modal"),
  );
}

export function openWhatsNew() {
  // Issue 793: never over a question or pop-up already open (a modal sits
  // on top of the one before it): it opens once that one closes.
  const other = otherModal();
  if (other) {
    if (!waiting) {
      waiting = true;
      other.addEventListener(
        "close",
        () => {
          // Closed (or seen) meanwhile: nothing to open.
          if (!waiting) return;
          waiting = false;
          setTimeout(openWhatsNew, 0);
        },
        { once: true },
      );
    }
    return;
  }
  showAll = false;
  if (!frame) makeFrame();
  renderBody();
  const d = frame.dialog;
  if (!d.open) {
    // Focus goes back to what opened it; nothing focused (a first-visit
    // open): the version chip.
    const at = openerOf();
    frame.show(
      at && !d.contains(at) ? at : document.getElementById("version-pill"),
    );
    // The page's own style hides it: the frame closed it again.
    if (!d.open) return;
  }
  d.classList.add("open");
  // Always at the newest release.
  const body = document.getElementById("cl-body");
  if (body) body.scrollTop = 0;
  // The heading first, so a screen reader starts at the latest notes.
  document.getElementById("cl-title")?.focus();
}

export function closeWhatsNew() {
  // Issue 143: a field of the page's own that wanted the keyboard while
  // this was open (a deep link's composer) gets it now (focusWhenFree);
  // else what opened it, else the version chip.
  waiting = false;
  if (frame?.dialog.open) frame.close("cancel");
  else closed();
}
