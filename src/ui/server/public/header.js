/**
 * The shell's behaviour (shell.js draws the frame: top bar and rail):
 * the health poll that feeds the status chip and drawer (topbar.js), the
 * version pill and changelog, the workspace menu, the env picker (one for
 * the whole shell) and the log badge. Every page imports it. It expects
 * a <select id="env-sel"> (shell.js) whose change event triggers a re-ping.
 *
 * Health data is driven entirely by __DEN_CLI__.json manifests — no hardcoded
 * service names. Each registered service that declares a health.url for
 * the current env is counted.
 */

import { buildScopeMenuModel } from "./workspace-picker.js";
import { initAppearance } from "./appearance.js";
import { versionLabel } from "./version-label.js";
import { changelogView } from "./changelog-view.js";
import { buildRow, healthCycle, paintGate, shellHealth } from "./health-fit.js";
import { initTopbar, paintChecking, paintStatus } from "./topbar.js";
import { initBell } from "./bell.js";
import { registerDenSettings } from "./settings-registry.js";
import { initServicePanel } from "./svc-panel.js";
import { restartDen } from "./restart-den.js";

/** The shell's message lookup (R19; shell.js MESSAGES). */
const t = (key, vars) =>
  typeof window !== "undefined" && window.denShell?.t
    ? window.denShell.t(key, vars)
    : key;
const escT = (key, vars) =>
  String(t(key, vars)).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

export {
  askSudo,
  problemCards,
  problemFix,
  setServiceRunner,
  sudoRun,
  takePendingAction,
} from "./topbar.js";
export { buildRow } from "./health-fit.js";

// Every page with this header gets the appearance controls (mode, theme)
// and the top bar's chips, palette and drawer (topbar.js).
void initAppearance();
// Den's SETTINGS rows on every page, not only /settings: each is a ⌘K
// palette row (kind "setting"), so "terminal" finds Default terminal.
if (typeof window !== "undefined")
  (window.denShellQueue = window.denShellQueue || []).push((sh) => {
    if (sh?.registerSetting) registerDenSettings(sh);
  });
// NT-3: the bell.
if (typeof document !== "undefined") initBell();
if (typeof document !== "undefined")
  initTopbar({
    refreshHealth: (env, opts) => refreshHealth(env, opts),
    healthEnv: () => healthEnv(),
    storeOpenLog: (repo, service, env) => storeOpenLog(repo, service, env),
  });
// 0.4.18: the service panel (rail pins, Graph ⋯, Services names).
if (typeof document !== "undefined")
  initServicePanel({
    currentEnv: () => currentEnv(),
    refreshHealth: (env, opts) => refreshHealth(env, opts),
  });

// 5s between polls — measured from each poll's COMPLETION (schedulePoll
// re-arms after renderHealth resolves), so slow probes can't overlap.
const POLL_INTERVAL_MS = 5_000;

// Last painted health results, keyed `repo/service`, so a new poll can seed
// from them and update dots in place instead of collapsing the strip and
// regrowing it (see renderHealth).
let _healthAcc = new Map();
let _healthAccGen = -1;
// The poll generation that last painted _healthAcc (healthCycle's `last`).
let _healthPaintGen = -1;
let pollTimer = null;
// Generation token: every (re)start of polling bumps this. A stale tick (an
// env the user already switched away from, or a slow fetch resolving late)
// must neither paint the DOM nor re-arm the loop for its outdated env —
// without this, one in-flight poll during an env switch permanently hijacked
// the dots back to the old env.
let pollGen = 0;

// ── The env picker: one for the whole shell (0.3.0-dev.14) ─────────────────────

const LS_ENV = "__DEN_CLI__-env";
let _envReady = null;

/**
 * Fill the shell's env picker from /api/environments and restore the last
 * choice (one key for every page). Resolves with the env list once the
 * picker holds the right value; pages await it before reading #env-sel.
 * Started as soon as header.js loads.
 */
export function envReady() {
  if (_envReady) return _envReady;
  _envReady = (async () => {
    const sel = document.getElementById("env-sel");
    // A refusal page (SEC-1b, shell.js apiOff): /api answers the refusal.
    const envs = apiOff()
      ? ["local"]
      : await fetch("/api/environments")
          .then((r) => r.json())
          .then((v) => (Array.isArray(v) ? v : ["local"]))
          .catch(() => ["local"]);
    if (!sel) return envs;
    const esc = (s) =>
      String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    sel.innerHTML = envs
      .map((e) => `<option value="${esc(e)}">${esc(e)}</option>`)
      .join("");
    let saved = null;
    try {
      saved = localStorage.getItem(LS_ENV);
    } catch {}
    if (saved && envs.includes(saved)) sel.value = saved;
    // The Env ▾ menu (shell.js) shows and sets this select's value.
    window.denShell?.syncEnv?.();
    sel.addEventListener("change", () => {
      try {
        localStorage.setItem(LS_ENV, sel.value);
      } catch {}
    });
    return envs;
  })();
  return _envReady;
}
if (typeof document !== "undefined" && document.getElementById?.("env-sel"))
  void envReady();

/** The env picker's value: what this page shows. */
export function currentEnv() {
  return document.getElementById("env-sel")?.value ?? "local";
}

/**
 * The env the health row checks: the page's pin (Local Dev and Releases are
 * local by nature: `data-health-env` on #den-shell), else the env picker.
 */
export function healthEnv() {
  return (
    document.getElementById("den-shell")?.dataset?.healthEnv || currentEnv()
  );
}

// ── Changelog modal ────────────────────────────────────────────────────────────

const LS_CHANGELOG_SEEN = "__DEN_CLI__-changelog-seen";
let _changelogEntries = [];
let _changelogInjected = false;
/** The pop-up lists every version only after the reader asks. */
let _clShowAll = false;

function _injectChangelogStyles() {
  if (_changelogInjected) return;
  _changelogInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .v-pill {
      font-family: var(--mono); font-size: 10px;
      padding: 2px 8px; border-radius: 10px;
      border: 1px solid var(--border); color: var(--muted);
      background: none; cursor: pointer; user-select: none;
      transition: color .1s, border-color .1s; position: relative;
      flex-shrink: 0;
    }
    .v-pill:hover { color: var(--accent-text); border-color: var(--accent); }
    .v-pip {
      position: absolute; top: -3px; right: -3px;
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--accent);
      border: 1.5px solid var(--bg);
      display: none; pointer-events: none;
    }
    .cl-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(0,0,0,.65);
      display: none; align-items: center; justify-content: center;
    }
    .cl-overlay.open { display: flex; }
    .cl-box {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px; width: min(580px, 92vw); max-height: 78vh;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: var(--shadow);
    }
    .cl-hdr {
      display: flex; align-items: center; gap: 10px;
      padding: 13px 18px; border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .cl-hdr h3 {
      font-family: var(--mono); font-size: 13px; font-weight: 600;
      color: var(--text); flex: 1; margin: 0;
    }
    .cl-close {
      background: none; border: none; color: var(--muted);
      font-size: 18px; cursor: pointer; line-height: 1;
      padding: 2px 5px; border-radius: 3px; transition: color .1s, background .1s;
    }
    .cl-close:hover { color: var(--text); background: var(--border); }
    .cl-body { overflow-y: auto; padding: 16px 18px; flex: 1; }
    .cl-entry { margin-bottom: 18px; }
    .cl-ver-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
    .cl-ver {
      margin: 0;
      font-family: var(--mono); font-size: 13px; font-weight: 700;
      color: var(--accent-text);
    }
    .cl-date { font-size: 11px; color: var(--muted); }
    .cl-note { font-size: 12px; color: var(--muted); margin: 0 0 8px; font-style: italic; }
    .cl-sec {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: .07em; color: var(--muted); margin: 8px 0 4px;
    }
    .cl-items { list-style: none; padding: 0; margin: 0; }
    .cl-items li {
      font-size: 12px; color: var(--text);
      padding: 2px 0 2px 14px; position: relative; line-height: 1.5;
    }
    .cl-items li::before { content: "·"; position: absolute; left: 2px; color: var(--muted); }
    .cl-subitems { list-style: none; padding: 0; margin: 2px 0 0 0; }
    .cl-subitems li { font-size: 11.5px; padding: 1px 0 1px 14px; color: var(--muted); }
    .cl-subitems li::before { content: "–"; position: absolute; left: 2px; }
    .cl-items code {
      font-family: var(--mono); font-size: 10.5px;
      color: var(--accent-text); background: color-mix(in srgb, var(--accent) 10%, transparent);
      padding: 1px 4px; border-radius: 3px;
    }
    .cl-divider { border: none; border-top: 1px solid var(--border); margin: 14px 0; }
    .cl-copy-group { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; }
    .cl-copy-btn, .cl-slack-btn {
      background: none; border: 1px solid var(--border); color: var(--muted);
      padding: 3px 6px; border-radius: 4px; line-height: 0;
      cursor: pointer; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      transition: color .1s, border-color .1s;
    }
    .cl-more-btn {
      margin-right: auto; padding: 4px 12px;
      font: inherit; font-size: 11px; color: var(--muted);
      background: none; border: 1px solid var(--border); border-radius: 6px;
      cursor: pointer;
    }
    .cl-more-btn:hover { color: var(--accent-text); border-color: var(--accent); }
    .cl-copy-btn:hover { color: var(--accent-text); border-color: var(--accent); }
    .cl-copy-btn.copied { color: var(--ok); border-color: var(--ok); }
    .cl-slack-btn:hover { color: var(--accent-text); border-color: var(--accent); }
    .cl-slack-btn.copied { color: var(--ok); border-color: var(--ok); }
    .cl-footer {
      padding: 10px 18px; border-top: 1px solid var(--border);
      display: flex; justify-content: flex-end; flex-shrink: 0;
      background: var(--surface);
    }
    .cl-got-it {
      background: var(--accent-fill); border: none; color: var(--on-accent);
      padding: 5px 16px; border-radius: 5px; font-size: 12px;
      font-weight: 600; cursor: pointer;
    }
    .cl-got-it:hover { filter: brightness(0.92); }
  `;
  document.head.appendChild(style);

  // Modal overlay
  const overlay = document.createElement("div");
  overlay.id = "cl-overlay";
  overlay.className = "cl-overlay";
  overlay.innerHTML =
    '<div class="cl-box" role="dialog" aria-modal="true" aria-labelledby="cl-title">' +
    `<div class="cl-hdr"><h3 id="cl-title" tabindex="-1">${escT("cl.title")}</h3><button type="button" class="cl-close" id="cl-close-btn" title="${escT("cl.close")}" aria-label="${escT("cl.close")}">×</button></div>` +
    '<div class="cl-body" id="cl-body"></div>' +
    '<div class="cl-footer"><button type="button" class="cl-more-btn" id="cl-more" aria-controls="cl-body" aria-expanded="false" hidden></button><button class="cl-got-it" id="cl-got-it-btn">' +
    escT("cl.gotIt") +
    "</button></div>" +
    "</div>";
  document.body.appendChild(overlay);
  document.getElementById("cl-more")?.addEventListener("click", () => {
    _clShowAll = !_clShowAll;
    _renderChangelogBody(_changelogEntries);
    const body = document.getElementById("cl-body");
    if (body) body.scrollTop = 0;
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) window.closeChangelog();
  });
  document
    .getElementById("cl-close-btn")
    ?.addEventListener("click", () => window.closeChangelog());
  document
    .getElementById("cl-got-it-btn")
    ?.addEventListener("click", () => window.closeChangelog());

  document.addEventListener("keydown", (e) => {
    if (!overlay.classList.contains("open")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      window.closeChangelog();
    } else if (e.key === "Tab") _trapChangelogTab(e, overlay);
  });
}

/** Tab and Shift+Tab stay inside the open dialog (aria-modal). */
function _trapChangelogTab(e, overlay) {
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

function _renderChangelogBody(entries) {
  const body = document.getElementById("cl-body");
  if (!body) return;
  if (!entries.length) {
    body.innerHTML = `<p style="color:var(--muted);font-size:12px">${escT("cl.none")}</p>`;
    return;
  }
  const escHtml = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const renderItem = (s) =>
    escHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const view = changelogView(entries, _clShowAll);
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
        escT("cl.copyMd") +
        '" aria-label="' +
        escT("cl.copyMdX", { v: entry.version }) +
        '">' +
        '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="4" y="0.5" width="8.5" height="8.5" rx="1.5"/>' +
        '<path d="M8.5 9v2.5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h2.5"/>' +
        "</svg>" +
        "</button>" +
        '<button class="cl-slack-btn" data-cl-version="' +
        escHtml(entry.version) +
        '" title="' +
        escT("cl.copySlack") +
        '" aria-label="' +
        escT("cl.copySlackX", { v: entry.version }) +
        '">' +
        '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M1 2a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L5 12v-3H2a1 1 0 0 1-1-1V2z"/>' +
        "</svg>" +
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
      // changelog-view.js's labels are its en; the button says them in
      // the page's language.
      more.textContent = view.toggle.expanded
        ? t("cl.latest")
        : t("cl.all", { n: entries.length - 1 });
      more.setAttribute("aria-expanded", String(view.toggle.expanded));
    }
  }

  const _slackIcon =
    '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M1 2a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L5 12v-3H2a1 1 0 0 1-1-1V2z"/>' +
    "</svg>";
  const _copyIcon =
    '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="4" y="0.5" width="8.5" height="8.5" rx="1.5"/>' +
    '<path d="M8.5 9v2.5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h2.5"/>' +
    "</svg>";
  const _checkIcon =
    '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="2,7 5,10 11,3"/>' +
    "</svg>";

  // Markdown copy — plain text for GitHub, MD editors, etc.
  body.querySelectorAll(".cl-copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const entry = _changelogEntries.find(
        (e) => e.version === btn.dataset.clVersion,
      );
      if (!entry) return;
      try {
        await copyToClipboard(entry.raw || _buildMarkdown(entry));
        btn.innerHTML = _checkIcon;
        btn.classList.add("copied");
        setTimeout(() => {
          btn.innerHTML = _copyIcon;
          btn.classList.remove("copied");
        }, 2000);
      } catch {
        btn.title = t("cl.copyFailed");
        setTimeout(() => (btn.title = t("cl.copyMd")), 2000);
      }
    });
  });

  // Rich copy — contenteditable + execCommand produces DOM-originated HTML that
  // Slack (and Notion, Docs) trusts and renders as formatted text.
  body.querySelectorAll(".cl-slack-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const entry = _changelogEntries.find(
        (e) => e.version === btn.dataset.clVersion,
      );
      if (!entry) return;
      try {
        await _writeRichToClipboard(_buildRichHtml(entry));
        btn.innerHTML = _checkIcon;
        btn.classList.add("copied");
        setTimeout(() => {
          btn.innerHTML = _slackIcon;
          btn.classList.remove("copied");
        }, 2000);
      } catch {
        btn.title = t("cl.copyFailed");
        setTimeout(() => (btn.title = t("cl.copySlack")), 2000);
      }
    });
  });
}

/**
 * Write plain text to clipboard.
 * Uses navigator.clipboard when available (secure contexts), falls back
 * to execCommand('copy') for http:// origins like http://__DEN_CLI__:7777.
 * Shared utility — use this instead of rolling your own copy logic.
 */
export function copyToClipboard(text) {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
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
 * Write rich HTML to the clipboard via a hidden contenteditable element.
 *
 * ClipboardItem produces clipboard entries that Slack ignores. Copying from
 * an actual DOM selection (the "copy from webpage" path) puts HTML on the
 * clipboard in the format Slack's paste handler trusts and renders as
 * formatted text.
 */
function _writeRichToClipboard(html) {
  return new Promise((resolve, reject) => {
    const el = document.createElement("div");
    el.contentEditable = "true";
    el.style.cssText =
      "position:fixed;opacity:0;top:0;left:0;pointer-events:none";
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

/**
 * Build rich HTML for Slack paste. Uses inline formatting Slack renders:
 * <strong> for bold, <code> for inline code, <ul><li> for bullets.
 * Block-level headings are replaced with bold paragraphs so Slack doesn't
 * strip them.
 */
function _buildRichHtml(entry) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const renderItem = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");

  const sections = Object.entries(entry.sections ?? {})
    .map(([sec, items]) => {
      const liItems = items.flatMap((it) => [
        `<li>${renderItem(it.text)}</li>`,
        ...(it.sub ?? []).map((s) => `<li>${renderItem(s)}</li>`),
      ]);
      return `<p><strong>${esc(sec)}</strong></p><ul>${liItems.join("")}</ul>`;
    })
    .join("");
  return `<p><strong>v${esc(entry.version)} — ${esc(entry.date)}</strong></p>${sections}`;
}

/** Reconstruct markdown from a structured entry as a fallback. */
function _buildMarkdown(entry) {
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

// Where focus goes back to when the dialog closes.
let _clReturnFocus = null;

window.openChangelog = function () {
  _clShowAll = false;
  _injectChangelogStyles();
  _renderChangelogBody(_changelogEntries);
  const overlay = document.getElementById("cl-overlay");
  if (!overlay) return;
  const wasOpen = overlay.classList.contains("open");
  if (!wasOpen) {
    const at = document.activeElement;
    // Nothing focused (a first-visit auto-open): the version pill.
    _clReturnFocus =
      at && at !== document.body && !overlay.contains(at)
        ? at
        : document.getElementById("version-pill");
  }
  overlay.classList.add("open");
  // Always opens at the newest release. After `.open`: while the overlay is
  // display:none the body has no scroll box, so a reset there doesn't stick.
  const body = document.getElementById("cl-body");
  if (body) body.scrollTop = 0;
  // The heading first, so a screen reader starts at the latest notes.
  document.getElementById("cl-title")?.focus();
};

window.closeChangelog = function () {
  const overlay = document.getElementById("cl-overlay");
  const wasOpen = !!overlay?.classList.contains("open");
  if (overlay) overlay.classList.remove("open");
  if (wasOpen) {
    const back = _clReturnFocus?.isConnected
      ? _clReturnFocus
      : document.getElementById("version-pill");
    _clReturnFocus = null;
    back?.focus();
  }
  if (_changelogEntries[0]?.version) {
    try {
      localStorage.setItem(LS_CHANGELOG_SEEN, _changelogEntries[0].version);
    } catch {}
  }
  const pip = document.getElementById("v-pip");
  if (pip) pip.style.display = "none";
};

/**
 * Fetch changelog, populate the version pill, and auto-open if unread.
 * Call once per page from each page's init function.
 */
export async function initChangelog() {
  if (apiOff()) return;
  _injectChangelogStyles();
  try {
    _changelogEntries = await fetch("/api/changelog").then((r) => r.json());
  } catch {
    _changelogEntries = [];
  }

  const latest = _changelogEntries[0];
  let info = null;
  try {
    info = await fetch("/api/server-info").then((r) => r.json());
  } catch {
    /* fall back to the changelog's newest version */
  }
  const pill = document.getElementById("version-pill");
  if (pill) {
    const label = versionLabel(info?.version ?? null, _changelogEntries);
    if (label) pill.querySelector(".v-txt").textContent = label;
  }

  let lastSeen = null;
  try {
    lastSeen = localStorage.getItem(LS_CHANGELOG_SEEN);
  } catch {}

  // ON-6: a brand-new Den (no repo yet) opens on its agent and the
  // approvals: no release notes over them. This version counts as seen.
  if (info?.fresh === true) {
    if (latest?.version)
      try {
        localStorage.setItem(LS_CHANGELOG_SEEN, latest.version);
      } catch {}
    return;
  }

  if (latest?.version && lastSeen !== latest.version) {
    const pip = document.getElementById("v-pip");
    if (pip) pip.style.display = "block";
    window.openChangelog();
  }
}

// ── __DEN_TITLE__ config ──────────────────────────────────────────────────────────────

let _cliConfig = null;

/**
 * 0.4.1: true once the shell knows the config fails validation (shell.js
 * configInvalid): the polls and streams below that read it don't start.
 */
function configInvalid() {
  return window.denShell?.configInvalid?.() === true;
}

/**
 * SEC-1b: a refusal page (421, signed out; shell.js apiOff): every /api
 * call would answer the same refusal, so none is made.
 */
function apiOff() {
  return window.denShell?.apiOff?.() === true;
}

async function getDenConfig() {
  if (_cliConfig) return _cliConfig;
  if (configInvalid()) return { environments: ["local"] };
  try {
    _cliConfig = await fetch("/api/__DEN_CLI__/config").then((r) => r.json());
  } catch {
    _cliConfig = {
      environments: ["local"],
    };
  }
  return _cliConfig;
}

/**
 * Apply __DEN_CLI__ config to the nav — hide Workspaces when the local environment is disabled.
 * Call once on page load from each page's init function.
 */
export async function applyDenConfig() {
  const config = await getDenConfig();
  _renderOrgCrumb(config.org);
  const localEnabled = config.environments?.includes("local") ?? true;
  if (!localEnabled) {
    document
      .querySelectorAll(".den-rail a[href='/local-dev']")
      .forEach((el) => {
        el.style.display = "none";
      });
  }
  return config;
}

/**
 * The org (root of Org > Application > Repo > Services) as a small crumb
 * before the product name: "Globex › __DEN_CLI__".
 */
function _renderOrgCrumb(org) {
  // The shell's scope has an org part (the prototype's "/ ORG name").
  if (window.denShell?.setOrg?.(org)) return;
  const h1 = document.querySelector(".den-top .den-title, header h1");
  if (!h1 || !org?.title || document.getElementById("org-crumb")) return;
  const crumb = document.createElement("span");
  crumb.id = "org-crumb";
  crumb.title = t("org.titleId", { title: org.title, id: org.id });
  crumb.style.cssText =
    "font-size:12px;font-weight:600;color:var(--text);" +
    "white-space:nowrap;flex-shrink:0;display:flex;align-items:center;gap:8px";
  crumb.textContent = org.title;
  const sep = document.createElement("span");
  sep.textContent = "›";
  sep.style.cssText = "color:var(--muted);font-weight:400";
  crumb.appendChild(sep);
  h1.parentNode.insertBefore(crumb, h1);
}

// ── Applications (for grouping the health dots) ───────────────────────────────

// Focused workspace's applications, refreshed at most every 30s so a config
// edit shows up without a reload but polls don't refetch every 5s.
let _apps = null;
let _appsAt = 0;
async function _loadApps() {
  if (_apps && Date.now() - _appsAt < 30_000) return _apps;
  if (configInvalid()) return _apps ?? [];
  try {
    const r = await fetch("/api/applications", {
      signal: AbortSignal.timeout(5_000),
    });
    if (r.ok) {
      _apps = (await r.json()).applications ?? [];
      _appsAt = Date.now();
    }
  } catch {
    /* keep the last set (or none: dots render ungrouped) */
  }
  return _apps ?? [];
}

/**
 * Order repos by application and say which application box each sits in.
 * Declared applications get a box; a repo that is its own application (or is
 * in none) renders bare. Pure — exported for tests.
 */
export function groupReposByApplication(repos, apps) {
  const appOf = new Map();
  for (const a of apps || [])
    for (const r of a.repos || []) if (!appOf.has(r)) appOf.set(r, a);
  const out = [];
  const seen = new Set();
  for (const a of apps || []) {
    const members = repos.filter((r) => appOf.get(r) === a);
    if (!members.length) continue;
    members.forEach((r) => seen.add(r));
    out.push({ app: a.source === "declared" ? a : null, repos: members });
  }
  const rest = repos.filter((r) => !seen.has(r));
  if (rest.length) out.push({ app: null, repos: rest });
  return out;
}

// ── Workspace: the scope breadcrumb's Workspace ▾ menu (R4) ─────────────────

/**
 * Feed the shell's Workspace part (shell.js #ws-pill, a menu): "All active"
 * and each active workspace, the focused one marked. Choosing a workspace
 * makes it the CLI default (POST /api/workspaces `focus`, workspaces.yml)
 * and sets the view (POST /api/scope, a preference) for every page: one
 * "current workspace" (Ward's decision, 0.4.11). "All active" sets only the
 * view; the CLI default stays.
 *
 * The arguments are dev.17's (an env select, an onSwitch callback) and are
 * no longer used: the view applies to every env.
 */
export async function initWorkspacePill() {
  await _renderScopeMenu();
}

/** Re-fetch and repaint the Workspace part (after a workspace change). */
export async function refreshWorkspacePill() {
  await _renderScopeMenu();
}

async function _renderScopeMenu() {
  const sh = window.denShell;
  if (!sh?.setWorkspaces || configInvalid()) return;
  try {
    const [data, scope] = await Promise.all([
      fetch("/api/workspaces").then((r) => r.json()),
      fetch("/api/scope")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);
    sh.setWorkspaces({
      // The page's language sorts the projects (ja its own way).
      ...buildScopeMenuModel(
        pageScope(scope, data),
        data,
        t,
        document.documentElement.lang || undefined,
      ),
      onSelect: _switchScope,
    });
  } catch {
    sh.setWorkspaces(null);
  }
}

/** The pages whose ?ws= wins over the stored view (Graph, Agents). */
const WS_URL_PAGES = new Set(["/graph", "/agents"]);

/**
 * The Graph page draws what its ?ws= names (it wins over the stored view,
 * 0.3.0-dev.33), so its pill shows that workspace too: the pill, the URL,
 * the header's line and the graph agree (0.3.0-dev.34, a consumer's
 * finding). The Agents page's ?ws= (the Workspaces page's "Open in
 * Agents") is the same. Elsewhere, and for a ?ws= that names no active
 * workspace, the stored view.
 */
function pageScope(scope, data) {
  if (!WS_URL_PAGES.has(location.pathname)) return scope;
  const q = new URLSearchParams(location.search);
  const ws = q.get("project") || q.get("ws");
  const active = Array.isArray(data?.active)
    ? data.active
    : data?.active
      ? [data.active]
      : [];
  return ws && active.includes(ws) ? { ...scope, scope: ws } : scope;
}

/**
 * A choice replaces ?ws= (All active drops it, a workspace sets it) on the
 * Graph and Agents pages, and on any page whose URL names a workspace
 * (Workspaces' detail pane), so the reload shows the choice rather than
 * the old ?ws=. The history entry is replaced, not pushed: Back does not
 * return to a view the picker has left.
 */
function followScopeInUrl(value) {
  const u = new URL(location.href);
  if (
    !WS_URL_PAGES.has(location.pathname) &&
    !u.searchParams.has("ws") &&
    !u.searchParams.has("project")
  )
    return;
  // #80: ?project=; an old ?ws= goes.
  u.searchParams.delete("ws");
  if (value === "all") u.searchParams.delete("project");
  else u.searchParams.set("project", value);
  history.replaceState(history.state, "", u.pathname + u.search + u.hash);
}

/**
 * A workspace: first the CLI default (workspaces.yml), then the view. When
 * the CLI default can't be set, nothing changes and the error shows. "All
 * active": the view only. POST /api/scope stores the view (user.yml
 * `view`), then the page reloads to show it whole. The workspace already
 * in view (`inView`): the CLI default only, the view untouched. No
 * service, container, daemon or route changes.
 */
async function _switchScope(value, focus, inView) {
  if (value !== "all" && value !== focus && !(await _setFocus(value))) return;
  if (inView) {
    // A ?ws= page shows the pick after the reload, not its old ?ws=.
    followScopeInUrl(value);
    location.reload();
    return;
  }
  try {
    await window.denShell.api("POST", "/api/scope", { scope: value });
  } catch (err) {
    if (err?.denApi) {
      err.message = t("ws.viewFailed", { msg: err.message });
      window.denShell.errorToast(err);
    } else window.denShell?.toast?.(t("ws.viewFailed", { msg: err.message }));
    return;
  }
  followScopeInUrl(value);
  location.reload();
}

/**
 * Switch the View to one workspace, as the top bar's Workspace menu does
 * (the Graph page's Show <workspace>): the CLI default, then the view,
 * then a reload (the URL's hash stays).
 */
export async function switchView(name) {
  const scope = await fetch("/api/scope")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  await _switchScope(name, scope?.focus ?? null, false);
}

/**
 * Make `name` the CLI default: Local Dev's focus action (POST
 * /api/workspaces `focus`, which writes workspaces.yml and retargets the
 * CLI). False, with the error shown, when it couldn't.
 */
async function _setFocus(name) {
  try {
    await window.denShell.api("POST", "/api/workspaces", {
      name,
      action: "focus",
    });
  } catch (err) {
    if (err?.denApi) {
      err.message = t("ws.focusFailed", { msg: err.message });
      window.denShell.errorToast(err);
    } else window.denShell?.toast?.(t("ws.focusFailed", { msg: err.message }));
    return false;
  }
  return true;
}

// ── Health: the status chip and drawer (topbar.js, R6 and R15) ─────────────

/** Call once on page load. Does NOT manage env changes — caller handles that. */
export async function initHealth() {
  await envReady();
  if (configInvalid()) return;
  const env = healthEnv();
  const gen = ++pollGen;
  await renderHealth(env, gen);
  schedulePoll(env, gen);
}

/** Call whenever the environment changes. Cancels the current poll and restarts it for the new env. */
export async function refreshHealth(env, { force = false } = {}) {
  const gen = ++pollGen;
  clearTimeout(pollTimer);
  if (configInvalid()) return;
  // The chip goes neutral while the new env is checked: never red from
  // the old env's answers, never a partial count.
  if (env !== _healthEnvPainted) paintChecking();
  await renderHealth(env, gen, force);
  schedulePoll(env, gen);
}

// Background tabs throttle chained timers (Chrome clamps to ~1/min after a few
// hidden minutes), so the chip freezes while hidden — refresh immediately on
// return instead of showing pre-hide state for up to another minute.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pollGen > 0) {
    refreshHealth(healthEnv());
  }
});

function schedulePoll(env, gen) {
  if (gen !== pollGen) return; // superseded by an env switch/re-init
  if (configInvalid()) return; // a reload once fixed starts it again
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      await renderHealth(env, gen);
    } finally {
      // ALWAYS re-arm: a thrown/aborted tick must not silently kill polling
      // (that froze the chip at its last state until a page reload).
      schedulePoll(env, gen);
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Stream health results and paint them through the gate (health-fit.js):
 * a first cycle (a page load, an env switch) paints once, complete, so a
 * cold load never shows a partial count or a flash of red; later polls
 * seed from the last one and repaint debounced.
 */
async function renderHealth(env, gen = pollGen, force = false) {
  await _loadApps();
  const seed = gen === _healthAccGen ? [..._healthAcc] : [];
  _healthAccGen = gen;
  await healthCycle({
    seed,
    gate: _healthGate,
    stream: (onResult) => _streamHealth(env, force, onResult),
    // Stream unavailable or broken (older server, a proxy that buffers SSE,
    // a dropped connection): the plain endpoint completes the cycle.
    fetchAll: () =>
      fetch(`/api/health?env=${env}${force ? "&refresh=1" : ""}`, {
        signal: AbortSignal.timeout(10_000),
      })
        .then((r) => r.json())
        .catch(() => null),
    // What the chip shows now, for a paint before this cycle completes.
    last: () => (_healthPaintGen === gen ? _healthAcc : null),
    paint: (m) => {
      _healthAcc = m;
      _healthPaintGen = gen;
      _paintHealth(env, _sortHealth([...m.values()]));
    },
    current: () => gen === pollGen,
  });
}
const _healthGate = paintGate();
let _healthEnvPainted = null;

/**
 * Stable display order. `idx` is the server's graph-ranked position (entry repo
 * first … infra-stack last); results arrive in completion order, which differs
 * every poll, so sorting by it is what keeps the drawer from reshuffling. Falls
 * back to repo name when the server doesn't send `idx`.
 */
function _sortHealth(results) {
  return results.sort(
    (a, b) =>
      (a.idx ?? Number.MAX_SAFE_INTEGER) - (b.idx ?? Number.MAX_SAFE_INTEGER) ||
      a.repo.localeCompare(b.repo) ||
      String(a.service).localeCompare(String(b.service)),
  );
}

/**
 * Read /api/health/stream to completion, calling onResult per check.
 * Resolves "done" when the server ended the cycle (every check answered),
 * "partial" when it broke after some results, "none" when it gave nothing:
 * only "done" is a whole cycle (healthCycle).
 */
function _streamHealth(env, force, onResult) {
  return new Promise((resolve) => {
    let es;
    let got = false;
    // Backstop: a hung stream must not stall the poll chain forever.
    const broken = () => (got ? "partial" : "none");
    const guard = setTimeout(() => {
      try {
        es?.close();
      } catch {}
      resolve(broken());
    }, 15_000);
    const done = (ok) => {
      clearTimeout(guard);
      try {
        es?.close();
      } catch {}
      resolve(ok);
    };
    try {
      // force bypasses the server-side health cache — used right after a repo
      // sync, where the probes on disk may have just changed.
      es = new EventSource(
        `/api/health/stream?env=${encodeURIComponent(env)}${force ? "&refresh=1" : ""}`,
      );
    } catch {
      clearTimeout(guard);
      return resolve("none");
    }
    es.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "result") {
        got = true;
        onResult(msg.result);
      } else if (msg.type === "done") {
        done("done");
      } else if (msg.type === "error") {
        done(broken());
      }
    };
    // An error ends the stream: before any result, fall back; after some,
    // the cycle is partial and /api/health completes it.
    es.onerror = () => done(broken());
  });
}

/**
 * One painted cycle: the shared rollup (buildRow, health-rollup.js) feeds
 * the rail (the Services badge and pinned dots) and the status chip and
 * drawer alike, so they never disagree (R6, R13): a down service counts
 * only once its repo's checks have all answered, pending and unchecked
 * ones never do.
 */
function _paintHealth(env, results) {
  // WS-6.4: the server checks every active workspace; the chip and the
  // drawer count only what the view scope shows (`inView`). The pages get
  // every row, so the Workspaces page knows any workspace's health.
  const shown = results.filter((r) => r.inView !== false);
  const repos = [...new Set(shown.map((r) => r.repo))];
  const groups = groupReposByApplication(repos, _apps);
  const row = buildRow(shown, groups);
  window.denShell?.setState(shellHealth(row));
  _healthEnvPainted = env;
  paintStatus({ row, groups, env });

  // Broadcast results so other components (e.g. dep graph) can stay in sync
  document.dispatchEvent(
    new CustomEvent("__DEN_CLI__:health-update", { detail: results }),
  );
}

// ── Log badge (shared across pages) ───────────────────────────────────────────

const LS_OPEN_LOGS = "__DEN_CLI__-open-logs";

/**
 * Read __DEN_CLI__-open-logs from localStorage and populate the #log-badge element.
 * Call once on page load from any page that has a Logs nav link with a badge.
 */
export function initLogBadge() {
  _updateBadgeFromStorage();
  // Stay in sync if another tab opens/closes a log stream
  window.addEventListener("storage", (e) => {
    if (e.key === LS_OPEN_LOGS) _updateBadgeFromStorage();
  });
}

/** The Logs page's NAV badge (shell.js) reads `openLogs`. */
function _updateBadgeFromStorage() {
  try {
    const logs = JSON.parse(localStorage.getItem(LS_OPEN_LOGS) || "[]");
    const count = Array.isArray(logs) ? logs.length : 0;
    window.denShell?.setState({ openLogs: count });
  } catch {
    window.denShell?.setState({ openLogs: 0 });
  }
}

/** Add a log entry to localStorage (call before navigating to /logs). */
export function storeOpenLog(repo, service, env) {
  try {
    const logs = JSON.parse(localStorage.getItem(LS_OPEN_LOGS) || "[]");
    const filtered = logs.filter(
      (l) => !(l.repo === repo && l.service === service),
    );
    filtered.push({ repo, service, env });
    localStorage.setItem(LS_OPEN_LOGS, JSON.stringify(filtered));
    _updateBadgeFromStorage();
  } catch {
    /* noop */
  }
}

// ── Primary-service resolution (shared by local-dev tabs + logs toolbar) ─────
/**
 * Map repo → its PRIMARY service (the "main system" service) from an
 * /api/services payload. Precedence: entrypoint > root-named (service===repo)
 * > first seen. This is the same rollup the health dots, log tabs, and logs
 * toolbar key off, so "one thing per system" means the same thing everywhere.
 */
export function computePrimaryByRepo(svcList) {
  const primary = new Map();
  const rank = new Map();
  for (const s of Array.isArray(svcList) ? svcList : []) {
    const r = s.isEntrypoint ? 2 : s.service === s.repo ? 1 : 0;
    if (!primary.has(s.repo) || r > (rank.get(s.repo) ?? -1)) {
      primary.set(s.repo, s.address);
      rank.set(s.repo, r);
    }
  }
  return primary;
}

// ── Stale-server watch (self-initializing on every page) ─────────────────────
// The __DEN_CLI__ web server loads its TypeScript at startup; edit server code
// without restarting and it keeps serving the OLD handlers while still serving
// FRESH HTML from disk — a confusing mismatch (the Releases-tab POST/SSE bug was
// exactly this). The server exposes /api/server-info { stale } (any src/*.ts
// newer than its start); when stale we surface an amber header pill offering a
// one-click Restart (POST /api/web/restart → detached `__DEN_CLI__ web restart`),
// then reconnect to the fresh daemon and reload.

const SERVER_INFO_POLL_MS = 12_000;
let _lastServerInfo = null; // most recent { pid, startedAt }
let _staleStylesInjected = false;

function _injectStaleStyles() {
  if (_staleStylesInjected) return;
  _staleStylesInjected = true;
  const s = document.createElement("style");
  s.textContent = `
    .stale-pill {
      font-family: var(--mono); font-size: 10px; font-weight: 600;
      padding: 2px 9px; border-radius: 10px; cursor: pointer; user-select: none;
      border: 1px solid var(--warn); color: var(--warn);
      background: color-mix(in srgb, var(--warn) 12%, transparent);
      display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
      animation: stale-pulse 2s ease-in-out infinite;
    }
    .stale-pill:hover { color: var(--bg); background: var(--warn); }
    .stale-pill b { font-weight: 700; }
    @keyframes stale-pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
  `;
  document.head.appendChild(s);
}

function _renderStalePill(info) {
  let pill = document.getElementById("stale-pill");
  if (!info || !info.stale) {
    if (pill) pill.style.display = "none";
    return;
  }
  _injectStaleStyles();
  if (!pill) {
    const header =
      document.querySelector(".den-top") || document.querySelector("header");
    if (!header) return;
    pill = document.createElement("button");
    pill.id = "stale-pill";
    pill.className = "stale-pill";
    pill.title = t("stale.title", { cli: "__DEN_CLI__" });
    pill.setAttribute("aria-label", t("stale.aria"));
    pill.innerHTML = `<span aria-hidden="true">⚠</span><span class="stale-lbl"> ${escT("stale.label")} · <b>${escT("stale.restart")}</b></span>`;
    pill.addEventListener("click", _requestRestart);
    const vpill = document.getElementById("version-pill");
    if (vpill && vpill.parentNode)
      vpill.parentNode.insertBefore(pill, vpill.nextSibling);
    else header.appendChild(pill);
  }
  pill.style.display = "";
}

async function _fetchServerInfo() {
  try {
    return await fetch("/api/server-info", {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    }).then((r) => r.json());
  } catch {
    return null;
  }
}

async function _staleTick() {
  if (apiOff()) return;
  const info = await _fetchServerInfo();
  if (info && info.pid != null) _lastServerInfo = info;
  _renderStalePill(info);
  // MD-2: a newer engine on disk than the one this server runs.
  if (info && "engineStale" in info)
    window.denShell?.setEngine?.({
      stale: info.engineStale === true,
      loaded: info.loaded?.version ?? null,
      onDisk: info.onDisk?.version ?? null,
    });
  setTimeout(_staleTick, SERVER_INFO_POLL_MS);
}

async function _requestRestart() {
  // No confirm: the pill exists only when the server IS stale, and a click
  // on it is the ask. D64: the same in-place dialog as Restart Den (no page
  // reload; live connections reconnect).
  const info = await restartDen({ confirm: false, before: _lastServerInfo });
  if (info) {
    _lastServerInfo = info;
    _renderStalePill(info);
  }
}

// Self-init: begin watching once there's a <header> to anchor the pill into.
if (typeof document !== "undefined") {
  const _bootStaleWatch = () => _staleTick();
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", _bootStaleWatch);
  else _bootStaleWatch();
}
