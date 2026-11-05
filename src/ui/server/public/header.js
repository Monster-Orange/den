/**
 * Shared header logic — service health dots
 *
 * Both index.html and services.html include this script.
 * It expects:
 *   - a <div id="health"> in the header to render dots into
 *   - a <select id="env-sel"> whose change event triggers a re-ping
 *
 * Health data is driven entirely by __DEN_CLI__.json manifests — no hardcoded
 * service names. Each registered service that declares a health.url for
 * the current env gets a dot.
 */

import {
  buildWorkspaceMenuModel,
  buildWorkspacePillModel,
} from "./workspace-picker.js";

// 5s between polls — measured from each poll's COMPLETION (schedulePoll
// re-arms after renderHealthDots resolves), so slow probes can't overlap.
const POLL_INTERVAL_MS = 5_000;

// Last painted health results, keyed `repo/service`, so a new poll can seed
// from them and update dots in place instead of collapsing the strip and
// regrowing it (which shifted the whole page below — see renderHealthDots).
let _healthAcc = new Map();
let _healthAccGen = -1;
let pollTimer = null;
// Generation token: every (re)start of polling bumps this. A stale tick (an
// env the user already switched away from, or a slow fetch resolving late)
// must neither paint the DOM nor re-arm the loop for its outdated env —
// without this, one in-flight poll during an env switch permanently hijacked
// the dots back to the old env.
let pollGen = 0;

// ── Editor preference (cached) ─────────────────────────────────────────────────
let _editorKey = null;
let _editorKeyFetched = false;
async function _loadEditorKey() {
  if (_editorKeyFetched) return;
  _editorKeyFetched = true;
  try {
    const data = await fetch("/api/settings").then((r) => r.json());
    _editorKey = data.editor ?? null;
  } catch {
    /* settings unavailable */
  }
}

function _injectNavStyles() {
  if (document.getElementById("__DEN_CLI__-nav-styles")) return;
  const s = document.createElement("style");
  s.id = "__DEN_CLI__-nav-styles";
  s.textContent = `
    .nav-open-btn {
      background: none; border: none; color: var(--muted, #8b949e);
      cursor: pointer; font-size: 11px; padding: 0 3px; line-height: 1;
      opacity: 0; transition: opacity .15s, color .1s;
      flex-shrink: 0;
    }
    .health-item:hover .nav-open-btn,
    .health-group:hover .nav-open-btn { opacity: 1; }
    .nav-open-btn:hover { color: var(--accent, #58a6ff) !important; }
    /* Repo dots boxed by application (Org > Application > Repo). */
    .health-app {
      display: flex; align-items: center; gap: 8px;
      padding: 1px 8px 1px 6px; border: 1px solid var(--border, #30363d);
      border-radius: 10px;
    }
    .health-app-label {
      font-size: 10px; font-weight: 600; letter-spacing: .03em;
      color: var(--text, #c9d1d9); opacity: .7; white-space: nowrap;
    }
  `;
  document.head.appendChild(s);
}

// ── Changelog modal ────────────────────────────────────────────────────────────

const LS_CHANGELOG_SEEN = "__DEN_CLI__-changelog-seen";
let _changelogEntries = [];
let _changelogInjected = false;

function _injectChangelogStyles() {
  if (_changelogInjected) return;
  _changelogInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    .v-pill {
      font-family: var(--mono, monospace); font-size: 10px;
      padding: 2px 8px; border-radius: 10px;
      border: 1px solid var(--border, #30363d); color: var(--muted, #8b949e);
      background: none; cursor: pointer; user-select: none;
      transition: color .1s, border-color .1s; position: relative;
      flex-shrink: 0;
    }
    .v-pill:hover { color: var(--accent, #58a6ff); border-color: var(--accent, #58a6ff); }
    .v-pip {
      position: absolute; top: -3px; right: -3px;
      width: 7px; height: 7px; border-radius: 50%;
      background: var(--accent, #58a6ff);
      border: 1.5px solid var(--bg, #0d1117);
      display: none; pointer-events: none;
    }
    .cl-overlay {
      position: fixed; inset: 0; z-index: 1000;
      background: rgba(0,0,0,.65);
      display: none; align-items: center; justify-content: center;
    }
    .cl-overlay.open { display: flex; }
    .cl-box {
      background: var(--surface, #161b22);
      border: 1px solid var(--border, #30363d);
      border-radius: 10px; width: min(580px, 92vw); max-height: 78vh;
      display: flex; flex-direction: column; overflow: hidden;
      box-shadow: 0 8px 40px rgba(0,0,0,.65);
    }
    .cl-hdr {
      display: flex; align-items: center; gap: 10px;
      padding: 13px 18px; border-bottom: 1px solid var(--border, #30363d); flex-shrink: 0;
    }
    .cl-hdr h3 {
      font-family: var(--mono, monospace); font-size: 13px; font-weight: 600;
      color: var(--text, #c9d1d9); flex: 1; margin: 0;
    }
    .cl-close {
      background: none; border: none; color: var(--muted, #8b949e);
      font-size: 18px; cursor: pointer; line-height: 1;
      padding: 2px 5px; border-radius: 3px; transition: color .1s, background .1s;
    }
    .cl-close:hover { color: var(--text, #c9d1d9); background: var(--border, #30363d); }
    .cl-body { overflow-y: auto; padding: 16px 18px; flex: 1; }
    .cl-entry { margin-bottom: 18px; }
    .cl-ver-row { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
    .cl-ver {
      font-family: var(--mono, monospace); font-size: 13px; font-weight: 700;
      color: var(--accent, #58a6ff);
    }
    .cl-date { font-size: 11px; color: var(--muted, #8b949e); }
    .cl-note { font-size: 12px; color: var(--muted, #8b949e); margin: 0 0 8px; font-style: italic; }
    .cl-sec {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: .07em; color: var(--muted, #8b949e); margin: 8px 0 4px;
    }
    .cl-items { list-style: none; padding: 0; margin: 0; }
    .cl-items li {
      font-size: 12px; color: var(--text, #c9d1d9);
      padding: 2px 0 2px 14px; position: relative; line-height: 1.5;
    }
    .cl-items li::before { content: "·"; position: absolute; left: 2px; color: var(--muted, #8b949e); }
    .cl-subitems { list-style: none; padding: 0; margin: 2px 0 0 0; }
    .cl-subitems li { font-size: 11.5px; padding: 1px 0 1px 14px; color: var(--muted, #8b949e); }
    .cl-subitems li::before { content: "–"; position: absolute; left: 2px; }
    .cl-items code {
      font-family: var(--mono, monospace); font-size: 10.5px;
      color: var(--accent, #58a6ff); background: rgba(88,166,255,.1);
      padding: 1px 4px; border-radius: 3px;
    }
    .cl-divider { border: none; border-top: 1px solid var(--border, #30363d); margin: 14px 0; }
    .cl-copy-group { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; }
    .cl-copy-btn, .cl-slack-btn {
      background: none; border: 1px solid var(--border, #30363d); color: var(--muted, #8b949e);
      padding: 3px 6px; border-radius: 4px; line-height: 0;
      cursor: pointer; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      transition: color .1s, border-color .1s;
    }
    .cl-copy-btn:hover { color: var(--accent, #58a6ff); border-color: var(--accent, #58a6ff); }
    .cl-copy-btn.copied { color: #3fb950; border-color: #3fb950; }
    .cl-slack-btn:hover { color: #e01e5a; border-color: #e01e5a; }
    .cl-slack-btn.copied { color: #3fb950; border-color: #3fb950; }
    .cl-footer {
      padding: 10px 18px; border-top: 1px solid var(--border, #30363d);
      display: flex; justify-content: flex-end; flex-shrink: 0;
      background: var(--surface, #161b22);
    }
    .cl-got-it {
      background: var(--accent, #58a6ff); border: none; color: #000;
      padding: 5px 16px; border-radius: 5px; font-size: 12px;
      font-weight: 600; cursor: pointer;
    }
    .cl-got-it:hover { opacity: .85; }
  `;
  document.head.appendChild(style);

  // Modal overlay
  const overlay = document.createElement("div");
  overlay.id = "cl-overlay";
  overlay.className = "cl-overlay";
  overlay.innerHTML =
    '<div class="cl-box">' +
    '<div class="cl-hdr"><h3>What\'s new</h3><button class="cl-close" id="cl-close-btn" title="Close">×</button></div>' +
    '<div class="cl-body" id="cl-body"></div>' +
    '<div class="cl-footer"><button class="cl-got-it" id="cl-got-it-btn">Got it</button></div>' +
    "</div>";
  document.body.appendChild(overlay);

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
    if (e.key === "Escape") window.closeChangelog();
  });
}

function _renderChangelogBody(entries) {
  const body = document.getElementById("cl-body");
  if (!body) return;
  if (!entries.length) {
    body.innerHTML =
      '<p style="color:var(--muted,#8b949e);font-size:12px">No entries found.</p>';
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
  body.innerHTML = entries
    .map(
      (entry, i) =>
        (i > 0 ? '<hr class="cl-divider">' : "") +
        '<div class="cl-entry">' +
        '<div class="cl-ver-row">' +
        '<span class="cl-ver">v' +
        escHtml(entry.version) +
        "</span>" +
        '<span class="cl-date">' +
        escHtml(entry.date) +
        "</span>" +
        '<div class="cl-copy-group">' +
        '<button class="cl-copy-btn" data-cl-version="' +
        escHtml(entry.version) +
        '" title="Copy as Markdown">' +
        '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<rect x="4" y="0.5" width="8.5" height="8.5" rx="1.5"/>' +
        '<path d="M8.5 9v2.5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h2.5"/>' +
        "</svg>" +
        "</button>" +
        '<button class="cl-slack-btn" data-cl-version="' +
        escHtml(entry.version) +
        '" title="Copy for Slack">' +
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
        btn.title = "Copy failed — try again";
        setTimeout(() => (btn.title = "Copy as Markdown"), 2000);
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
        btn.title = "Copy failed — try again";
        setTimeout(() => (btn.title = "Copy for Slack"), 2000);
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

window.openChangelog = function () {
  _injectChangelogStyles();
  _renderChangelogBody(_changelogEntries);
  const overlay = document.getElementById("cl-overlay");
  if (overlay) overlay.classList.add("open");
};

window.closeChangelog = function () {
  const overlay = document.getElementById("cl-overlay");
  if (overlay) overlay.classList.remove("open");
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
  _injectChangelogStyles();
  try {
    _changelogEntries = await fetch("/api/changelog").then((r) => r.json());
  } catch {
    _changelogEntries = [];
  }

  const latest = _changelogEntries[0];
  const pill = document.getElementById("version-pill");
  if (pill && latest?.version) {
    pill.querySelector(".v-txt").textContent = "v" + latest.version;
  }

  let lastSeen = null;
  try {
    lastSeen = localStorage.getItem(LS_CHANGELOG_SEEN);
  } catch {}

  if (latest?.version && lastSeen !== latest.version) {
    const pip = document.getElementById("v-pip");
    if (pip) pip.style.display = "block";
    window.openChangelog();
  }
}

// ── __DEN_TITLE__ config ──────────────────────────────────────────────────────────────

let ___DEN_CLI__Config = null;

async function getDenConfig() {
  if (___DEN_CLI__Config) return ___DEN_CLI__Config;
  try {
    ___DEN_CLI__Config = await fetch("/api/__DEN_CLI__/config").then((r) =>
      r.json(),
    );
  } catch {
    ___DEN_CLI__Config = {
      environments: ["local"],
    };
  }
  return ___DEN_CLI__Config;
}

/**
 * Apply __DEN_CLI__ config to the nav — hide "Local Dev" when local environment is disabled.
 * Call once on page load from each page's init function.
 */
export async function applyDenConfig() {
  const config = await getDenConfig();
  _renderOrgCrumb(config.org);
  const localEnabled = config.environments?.includes("local") ?? true;
  if (!localEnabled) {
    document
      .querySelectorAll("nav a[href='/'], nav a[href='/local-dev']")
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
  const h1 = document.querySelector("header h1");
  if (!h1 || !org?.title || document.getElementById("org-crumb")) return;
  const crumb = document.createElement("span");
  crumb.id = "org-crumb";
  crumb.title = `Org: ${org.title} (${org.id})`;
  crumb.style.cssText =
    "font-size:12px;font-weight:600;color:var(--text,#c9d1d9);" +
    "white-space:nowrap;flex-shrink:0;display:flex;align-items:center;gap:8px";
  crumb.textContent = org.title;
  const sep = document.createElement("span");
  sep.textContent = "›";
  sep.style.cssText = "color:var(--muted,#8b949e);font-weight:400";
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

// ── Workspace pill ────────────────────────────────────────────────────────────

// Set when a page opts into switching (initWorkspacePill's `onSwitch`): the
// pill becomes a dropdown of every known workspace instead of a static label.
let _wsOnSwitch = null;
let _wsMenuOpen = false;

/**
 * Render the active workspace name into <span id="ws-pill">.
 * Pass the id of the env <select> to show the pill only when env is "local".
 * Omit envSelId (or pass null) to always show it (e.g. Local Dev page).
 *
 * Pass `onSwitch` to make the pill a workspace picker: choosing an entry POSTs
 * `use` (activate + focus, same as `__DEN_CLI__ workspace use`) and then calls
 * onSwitch(name) so the page can reload whatever it derives from the focused
 * workspace. Pages with their own workspace UI (Local Dev) omit it.
 */
export async function initWorkspacePill(envSelId = null, { onSwitch } = {}) {
  const envSel = envSelId ? document.getElementById(envSelId) : null;
  _wsOnSwitch = onSwitch ?? null;
  await _renderPill(envSel);
  if (envSel) {
    envSel.addEventListener("change", () => _renderPill(envSel));
  }
}

/** Re-fetch and re-render the workspace pill (call after switching workspaces). */
export async function refreshWorkspacePill() {
  const envSel = document.getElementById("env-sel");
  await _renderPill(envSel);
}

async function _renderPill(envSel) {
  const el = document.getElementById("ws-pill");
  if (!el) return;
  const isLocal = !envSel || envSel.value === "local";
  if (!isLocal) {
    _closeWorkspaceMenu();
    _pillHost(el).style.display = "none";
    return;
  }
  try {
    const data = await fetch("/api/workspaces").then((r) => r.json());
    const { label, title } = buildWorkspacePillModel(data);
    if (_wsOnSwitch) {
      _renderPickerPill(el, data, label, title);
    } else {
      el.textContent = label;
      el.title = data.active?.length > 1 ? title : "";
    }
    // The pill starts as inline display:none in every page's markup; clear it
    // on the pill AND its picker wrapper, or the wrapper shows an empty box.
    el.style.display = "";
    _pillHost(el).style.display = "";
  } catch {
    _closeWorkspaceMenu();
    _pillHost(el).style.display = "none";
  }
}

/**
 * The element whose visibility tracks the pill's: the wrapper once the picker
 * has been built (so the menu is hidden with it), the pill itself before that.
 */
function _pillHost(el) {
  return el.parentElement?.classList.contains("ws-pill-wrap")
    ? el.parentElement
    : el;
}

function _injectWorkspacePickerStyles() {
  if (document.getElementById("__DEN_CLI__-ws-picker-styles")) return;
  const s = document.createElement("style");
  s.id = "__DEN_CLI__-ws-picker-styles";
  s.textContent = `
    .ws-pill-wrap { position: relative; display: inline-flex; flex-shrink: 0; }
    #ws-pill.ws-pill-btn { cursor: pointer; user-select: none; display: inline-flex; align-items: center; gap: 5px; }
    #ws-pill.ws-pill-btn:hover, #ws-pill.ws-pill-btn.open { border-color: var(--accent, #58a6ff); }
    .ws-pill-caret { font-size: 8px; opacity: .7; }
    .ws-menu {
      display: none; position: absolute; top: calc(100% + 4px); left: 0; z-index: 200;
      background: var(--surface, #161b22); border: 1px solid var(--border, #30363d);
      border-radius: 6px; min-width: 190px; max-height: 280px; overflow-y: auto;
      box-shadow: 0 4px 16px rgba(0,0,0,.4); padding: 3px 0;
    }
    .ws-menu.open { display: block; }
    .ws-menu-item {
      display: flex; align-items: center; gap: 8px; width: 100%;
      background: none; border: none; text-align: left;
      padding: 6px 12px; cursor: pointer; font-size: 12px;
      font-family: var(--mono, monospace); color: var(--text, #c9d1d9); white-space: nowrap;
    }
    .ws-menu-item:hover { background: var(--border, #30363d); }
    .ws-menu-item[disabled] { cursor: default; }
    .ws-menu-mark { width: 10px; flex-shrink: 0; color: var(--accent, #58a6ff); }
    .ws-menu-tag { margin-left: auto; font-size: 10px; color: var(--muted, #8b949e); }
  `;
  document.head.appendChild(s);
}

/** Turn the static pill into a button + dropdown (idempotent). */
function _renderPickerPill(el, data, label, title) {
  _injectWorkspacePickerStyles();

  let wrap = el.parentElement;
  if (!wrap?.classList.contains("ws-pill-wrap")) {
    wrap = document.createElement("span");
    wrap.className = "ws-pill-wrap";
    el.replaceWith(wrap);
    wrap.appendChild(el);
    el.classList.add("ws-pill-btn");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.addEventListener("click", () => _toggleWorkspaceMenu());
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        _toggleWorkspaceMenu();
      }
    });
  }

  el.replaceChildren();
  const name = document.createElement("span");
  name.textContent = label;
  const caret = document.createElement("span");
  caret.className = "ws-pill-caret";
  caret.textContent = "▾";
  el.append(name, caret);
  el.title = title;

  let menu = wrap.querySelector(".ws-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.className = "ws-menu";
    wrap.appendChild(menu);
  }
  _paintWorkspaceMenu(menu, data);
}

function _paintWorkspaceMenu(menu, data) {
  const { items } = buildWorkspaceMenuModel(data);
  menu.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement("button");
    empty.className = "ws-menu-item";
    empty.disabled = true;
    empty.textContent = "No workspaces";
    menu.appendChild(empty);
    return;
  }
  for (const item of items) {
    const btn = document.createElement("button");
    btn.className = "ws-menu-item";
    btn.type = "button";
    // Selecting an inactive workspace activates it (POST `use`), which only
    // rewrites workspaces.json — no services are started.
    btn.title = item.focused
      ? "Current workspace"
      : item.active
        ? "Focus this workspace"
        : "Activate and focus this workspace";

    const mark = document.createElement("span");
    mark.className = "ws-menu-mark";
    mark.textContent = item.focused ? "●" : "";
    const name = document.createElement("span");
    name.textContent = item.name;
    btn.append(mark, name);

    if (!item.active) {
      const tag = document.createElement("span");
      tag.className = "ws-menu-tag";
      tag.textContent = "not active";
      btn.appendChild(tag);
    }

    btn.addEventListener("click", () => _switchWorkspace(item));
    menu.appendChild(btn);
  }
}

function _toggleWorkspaceMenu(force = null) {
  const menu = document.querySelector(".ws-pill-wrap .ws-menu");
  const pill = document.getElementById("ws-pill");
  if (!menu) return;
  _wsMenuOpen = force ?? !_wsMenuOpen;
  menu.classList.toggle("open", _wsMenuOpen);
  pill?.classList.toggle("open", _wsMenuOpen);
}

function _closeWorkspaceMenu() {
  if (_wsMenuOpen) _toggleWorkspaceMenu(false);
}

document.addEventListener("click", (e) => {
  if (_wsMenuOpen && !e.target.closest(".ws-pill-wrap")) _closeWorkspaceMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") _closeWorkspaceMenu();
});

async function _switchWorkspace(item) {
  _closeWorkspaceMenu();
  if (item.focused) return;
  const onSwitch = _wsOnSwitch;
  try {
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `use` = activate + focus, matching `__DEN_CLI__ workspace use`. Focus alone
      // is rejected by the server for a workspace that is not active yet.
      body: JSON.stringify({ name: item.name, action: "use" }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }
  } catch (err) {
    alert(`Could not switch to workspace "${item.name}": ${err.message}`);
    return;
  }
  await refreshWorkspacePill();
  try {
    await onSwitch?.(item.name);
  } catch {
    /* the page's own refresh failing must not break the switch */
  }
}

// ── Health dots ───────────────────────────────────────────────────────────────

/** Call once on page load. Does NOT manage env changes — caller handles that. */
export async function initHealth() {
  const env = document.getElementById("env-sel")?.value ?? "local";
  const gen = ++pollGen;
  await renderHealthDots(env, gen);
  schedulePoll(env, gen);
}

/** Call whenever the environment changes. Cancels the current poll and restarts it for the new env. */
export async function refreshHealth(env, { force = false } = {}) {
  const gen = ++pollGen;
  clearTimeout(pollTimer);
  setCheckingState(env);
  await renderHealthDots(env, gen, force);
  schedulePoll(env, gen);
}

// Background tabs throttle chained timers (Chrome clamps to ~1/min after a few
// hidden minutes), so the dots freeze while hidden — refresh immediately on
// return instead of showing pre-hide state for up to another minute.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && pollGen > 0) {
    refreshHealth(document.getElementById("env-sel")?.value ?? "local");
  }
});

/** Immediately show all dots as "checking" so the user can see the env changed. */
function setCheckingState(env) {
  const container = document.getElementById("health");
  if (!container) return;
  // Pulse all dots yellow while we re-ping
  container.querySelectorAll(".dot").forEach((d) => {
    d.className = "dot running";
  });
}

function schedulePoll(env, gen) {
  if (gen !== pollGen) return; // superseded by an env switch/re-init
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try {
      await renderHealthDots(env, gen);
    } finally {
      // ALWAYS re-arm: a thrown/aborted tick must not silently kill polling
      // (that froze the dots at their last state until a page reload).
      schedulePoll(env, gen);
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Stream health results, painting each batch as it lands.
 *
 * The checks run concurrently but the slowest are shell probes that shell out
 * to the aws CLI (~0.45s each), so waiting for the whole set made every dot
 * resolve at the pace of the worst one. Streaming paints ~75% of them inside
 * 200ms. Batched through requestAnimationFrame so 30 results cause a handful of
 * repaints, not 30.
 */
async function renderHealthDots(env, gen = pollGen, force = false) {
  const container = document.getElementById("health");
  if (!container) return;

  await Promise.all([_loadEditorKey(), _loadApps()]);
  _injectNavStyles();

  // Merge into the PREVIOUS poll's results rather than starting empty.
  //
  // Each poll streams results as checks complete, repainting per batch. Painting
  // only what has landed so far made the strip collapse (13 items → 2) and
  // regrow on every 5s poll; because the strip sits above the content, the whole
  // page below it — the dependency graph especially — visibly jumped ~30px each
  // time. Seeding from the last known set keeps the item count stable, so a poll
  // updates dot COLOURS in place instead of rebuilding the row.
  const acc = new Map(gen === _healthAccGen ? _healthAcc : []);
  _healthAccGen = gen;
  const keyOf = (r) => `${r.repo}/${r.service}`;
  let scheduled = false;
  const paint = () => {
    scheduled = false;
    if (gen !== pollGen) return; // a newer poll owns the DOM now
    _healthAcc = acc;
    _paintHealthDots(container, env, _sortHealth([...acc.values()]));
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(paint);
  };

  const fresh = new Map();
  const streamed = await _streamHealth(env, force, (r) => {
    acc.set(keyOf(r), r);
    fresh.set(keyOf(r), r);
    schedule();
  });

  if (!streamed) {
    // Stream unavailable (older server, proxy that buffers SSE) — fall back to
    // the plain endpoint so the dots still resolve.
    try {
      const rs = await fetch(
        `/api/health?env=${env}${force ? "&refresh=1" : ""}`,
        {
          signal: AbortSignal.timeout(10_000),
        },
      ).then((r) => r.json());
      fresh.clear();
      for (const r of rs) fresh.set(keyOf(r), r);
    } catch {
      /* server unreachable */
    }
  }
  if (gen !== pollGen) return;
  // Settle on exactly what THIS poll returned, so a service removed from the
  // workspace disappears instead of lingering from the seeded set.
  if (fresh.size > 0) {
    _healthAcc = fresh;
    _paintHealthDots(container, env, _sortHealth([...fresh.values()]));
  }
}

/**
 * Stable display order. `idx` is the server's graph-ranked position (entry repo
 * first … infra-stack last); results arrive in completion order, which differs
 * every poll, so sorting by it is what keeps the dots from reshuffling. Falls
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
 * Resolves true if the stream ran, false if the caller should fall back.
 */
function _streamHealth(env, force, onResult) {
  return new Promise((resolve) => {
    let es;
    let got = false;
    // Backstop: a hung stream must not stall the poll chain forever.
    const guard = setTimeout(() => {
      try {
        es?.close();
      } catch {}
      resolve(got);
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
      return resolve(false);
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
        done(true);
      } else if (msg.type === "error") {
        done(got);
      }
    };
    // Errors before any result mean "fall back"; after results, keep what we got.
    es.onerror = () => done(got);
  });
}

/** One repo's dot + label in the health row. */
function _repoHealthItem(repo, items, escAttr) {
  // Show open-in-editor icon if editor is configured and any item is dev-managed
  const devItem = items.find((i) => i.mode === "dev-managed" && i.repoPath);
  const openIcon =
    _editorKey && devItem
      ? `<button class="nav-open-btn" data-open-path="${escAttr(devItem.repoPath)}" title="Open in editor">↗</button>`
      : "";

  const isSingle = items.length === 1 && items[0].service === repo;
  if (isSingle) {
    const { service, ok, status, error } = items[0];
    // What was checked: the URL, or a shell check's command.
    const what = items[0].url ?? items[0].check;
    const state = ok === true ? "ok" : ok === false ? "err" : "";
    const tip =
      ok == null
        ? error
          ? `${what} — ${error}`
          : "no health check"
        : error
          ? `${what} — ${error}`
          : `${what} → ${status}`;
    return `<div class="health-item" title="${escAttr(tip)}">
      <span class="dot ${state}" id="h-${repo}-${service}"></span>
      <span>${repo}</span>
      ${openIcon}
    </div>`;
  }
  // Multi-service repo: ONE dot for the system's main component (the
  // entrypoint), so a down app isn't masked green by its shared-infra
  // sidecars. An entrypoint-less infra provider (infra-stack) falls back
  // to an aggregate across its subsystems.
  const entry = items.find((i) => i.isEntrypoint);
  let overallState, tip;
  if (entry) {
    overallState = entry.ok === true ? "ok" : entry.ok === false ? "err" : "";
    tip =
      entry.ok == null
        ? entry.error
          ? `${entry.url ?? entry.check} — ${entry.error}`
          : "no health check"
        : entry.error
          ? `${entry.url ?? entry.check} — ${entry.error}`
          : `${entry.url ?? entry.check} → ${entry.status}`;
  } else {
    // Only a completed, failed check (ok false) is down; ok null (no check,
    // or no answer yet) is unknown and never turns the dot red.
    const allOk = items.every((i) => i.ok === true);
    const anyOk = items.some((i) => i.ok === true);
    const anyDown = items.some((i) => i.ok === false);
    overallState = allOk ? "ok" : anyOk ? "running" : anyDown ? "err" : "";
    tip = `${items.length} services`;
  }
  return `<div class="health-item" title="${escAttr(tip)}">
      <span class="dot ${overallState}"></span>
      <span>${repo}</span>
      ${openIcon}
    </div>`;
}

function _paintHealthDots(container, env, results) {
  const escAttr = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;");

  if (!results.length) {
    container.innerHTML = `<div class="health-item" style="color:var(--muted);font-size:11px">${env}: no services</div>`;
  } else {
    // Group by repo so multi-service repos don't produce duplicate labels.
    const byRepo = new Map();
    for (const item of results) {
      if (!byRepo.has(item.repo)) byRepo.set(item.repo, []);
      byRepo.get(item.repo).push(item);
    }
    const repoHtml = new Map(
      [...byRepo.entries()].map(([repo, items]) => [
        repo,
        _repoHealthItem(repo, items, escAttr),
      ]),
    );
    container.innerHTML = groupReposByApplication([...byRepo.keys()], _apps)
      .map(({ app, repos }) => {
        const inner = repos.map((r) => repoHtml.get(r)).join("");
        if (!app) return inner;
        const tip = [app.title, app.owner, app.description]
          .filter(Boolean)
          .join(" · ");
        return `<div class="health-app" title="${escAttr(tip)}"><span class="health-app-label">${escAttr(app.name)}</span>${inner}</div>`;
      })
      .join("");

    // Wire open-in-editor click handlers (data-open-path avoids inline onclick escaping)
    container
      .querySelectorAll(".nav-open-btn[data-open-path]")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          fetch("/api/editor/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: btn.dataset.openPath }),
          }).then((r) => {
            if (!r.ok)
              r.json().then((d) =>
                console.warn("[__DEN_CLI__] open-in-editor:", d.error),
              );
          });
        });
      });
  }

  // Broadcast results so other components (e.g. dep graph) can stay in sync
  document.dispatchEvent(
    new CustomEvent("__DEN_CLI__:health-update", { detail: results }),
  );

  // Refresh button — shown on every page, no per-page HTML changes needed
  const btn = document.createElement("button");
  btn.title = "Refresh service health";
  btn.textContent = "⟳";
  btn.style.cssText =
    "background:none;border:none;color:var(--muted);cursor:pointer;" +
    "font-size:13px;padding:1px 4px;border-radius:3px;line-height:1;margin-left:4px;" +
    "transition:color .1s;";
  btn.addEventListener("mouseenter", () => (btn.style.color = "var(--text)"));
  btn.addEventListener("mouseleave", () => (btn.style.color = "var(--muted)"));
  btn.addEventListener("click", () => {
    const currentEnv = document.getElementById("env-sel")?.value ?? env;
    refreshHealth(currentEnv); // pulses dots yellow while re-pinging
  });
  container.appendChild(btn);
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

function _updateBadgeFromStorage() {
  const el = document.getElementById("log-badge");
  if (!el) return;
  try {
    const logs = JSON.parse(localStorage.getItem(LS_OPEN_LOGS) || "[]");
    const count = Array.isArray(logs) ? logs.length : 0;
    el.textContent = count;
    el.style.display = count > 0 ? "inline" : "none";
  } catch {
    el.style.display = "none";
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
  for (const s of svcList || []) {
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
      font-family: var(--mono, monospace); font-size: 10px; font-weight: 600;
      padding: 2px 9px; border-radius: 10px; cursor: pointer; user-select: none;
      border: 1px solid var(--yellow, #d29922); color: var(--yellow, #d29922);
      background: rgba(210,153,34,0.12);
      display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
      animation: stale-pulse 2s ease-in-out infinite;
    }
    .stale-pill:hover { color: #0d1117; background: var(--yellow, #d29922); }
    .stale-pill b { font-weight: 700; }
    @keyframes stale-pulse { 0%,100%{opacity:1} 50%{opacity:.5} }
    .restart-overlay {
      position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,.82);
      display: flex; align-items: center; justify-content: center;
      flex-direction: column; gap: 16px;
      color: var(--text, #c9d1d9); font-family: var(--mono, monospace);
    }
    .restart-overlay .spinner {
      width: 30px; height: 30px; border-radius: 50%;
      border: 3px solid var(--border, #30363d); border-top-color: var(--accent, #58a6ff);
      animation: stale-spin .8s linear infinite;
    }
    @keyframes stale-spin { to { transform: rotate(360deg); } }
    .restart-overlay .msg { font-size: 13px; }
    .restart-overlay .hint {
      font-size: 11px; color: var(--muted, #8b949e);
      max-width: 380px; text-align: center; line-height: 1.5;
    }
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
    const header = document.querySelector("header");
    if (!header) return;
    pill = document.createElement("button");
    pill.id = "stale-pill";
    pill.className = "stale-pill";
    pill.title =
      "This __DEN_CLI__ web server is running code older than your working tree — " +
      "click to restart and pick up your changes. Running deploys continue on " +
      "GitHub; an open deploy log reattaches after the reload.";
    pill.innerHTML = "⚠ stale server · <b>Restart</b>";
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
  const info = await _fetchServerInfo();
  if (info && info.pid != null)
    _lastServerInfo = { pid: info.pid, startedAt: info.startedAt };
  _renderStalePill(info);
  setTimeout(_staleTick, SERVER_INFO_POLL_MS);
}

async function _requestRestart() {
  // No confirm(): the pill exists only when the server IS stale, and clicking
  // it is already the statement of intent. The restart is cheap and reversible
  // — running deploys continue on GitHub regardless; only an open deploy LOG in
  // this tab is lost, and it reattaches on reload.
  const before = _lastServerInfo;
  _showRestartOverlay();
  try {
    await fetch("/api/web/restart", {
      method: "POST",
      signal: AbortSignal.timeout(4000),
    });
  } catch {
    // The server usually dies before it can answer — expected; poll for the new one.
  }
  _pollForNewServer(before, Date.now());
}

function _showRestartOverlay() {
  _injectStaleStyles();
  if (document.getElementById("restart-overlay")) return;
  const o = document.createElement("div");
  o.id = "restart-overlay";
  o.className = "restart-overlay";
  o.innerHTML =
    '<div class="spinner"></div>' +
    '<div class="msg">Restarting __DEN_CLI__ web…</div>' +
    '<div class="hint" id="restart-hint">Reconnecting — this page will reload automatically.</div>';
  document.body.appendChild(o);
}

async function _pollForNewServer(before, startedAt) {
  const info = await _fetchServerInfo();
  const isNew =
    info &&
    info.pid != null &&
    (!before || info.pid !== before.pid || info.startedAt !== before.startedAt);
  if (isNew) {
    location.reload();
    return;
  }
  if (Date.now() - startedAt > 90_000) {
    const hint = document.getElementById("restart-hint");
    if (hint)
      hint.innerHTML =
        "Still restarting… if this persists, run <b>__DEN_CLI__ web restart</b> in a terminal, then reload.";
  }
  setTimeout(() => _pollForNewServer(before, startedAt), 1500);
}

// Self-init: begin watching once there's a <header> to anchor the pill into.
if (typeof document !== "undefined") {
  const _bootStaleWatch = () => _staleTick();
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", _bootStaleWatch);
  else _bootStaleWatch();
}
