/**
 * The error page (R26a, 0.3.0-dev.38): what a failed page request gets
 * inside the shell frame (rail, top bar, status chip). The server fills
 * #den-error (a JSON script) with what failed; this draws it.
 *
 *   404 "Page not found"   the path asked for; "Did you mean …" from the
 *                          command palette's own matcher (topbar.js
 *                          rankCommands) over the shell's pages; links to
 *                          Workspaces and Search (⌘K); the list of pages;
 *                          for /plugins/<id>/…, that the plugin isn't
 *                          installed, by name
 *   500 "Something went wrong"  the method and route template (never query
 *                          values), the time, the request id; Retry and
 *                          Copy details. No stack: the server log has it
 *                          under the same request id.
 *
 * On an engine mismatch (MD-2) the shell's banner leads the page with the
 * restart message, and a 404 says the page may be new in that version.
 *
 * suggestPage and detailsText are pure, for tests.
 */
import { rankCommands } from "/topbar.js";

// Its words are the shell's catalog (shell.js MESSAGES, R19: the err.*
// keys), so the page is in the page's language. "Copy details" is a
// report: it stays in English, like the server log it points at.

function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/**
 * The closest page to `pathname` by the palette's ranking: the whole slug
 * first, then each of its words, then shorter prefixes of it (two letters
 * at least), so a near-miss and a stray word both find something. `items`
 * are palette rows ({ label, keywords, href }). Null when nothing matches.
 */
export function suggestPage(pathname, items, rank = rankCommands) {
  const slug = String(pathname || "")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/\.html?$/i, "")
    .toLowerCase();
  if (!slug) return null;
  const tries = [slug, ...slug.split(/[-_.\s]+/).filter((w) => w.length > 1)];
  for (let n = slug.length - 1; n >= 2; n--) tries.push(slug.slice(0, n));
  for (const q of tries) {
    const hit = rank(items, q, { limit: 1 })[0];
    if (hit) return hit;
  }
  return null;
}

/** "Copy details": what a report needs, nothing more (no stack). */
export function detailsText(d, page = "") {
  return [
    `Den ${d.version ?? "unknown"}`,
    `Status ${d.status}`,
    d.status === 500
      ? `Route ${d.method ?? "GET"} ${d.route ?? ""}`
      : `Path ${d.path ?? ""}`,
    `Request ${d.requestId}`,
    `Time ${d.time}`,
    ...(page ? [`Page ${page}`] : []),
    ...(d.engine ? [d.engine.message] : []),
  ].join("\n");
}

function pageItems(sh) {
  const st = sh.getState?.() ?? {};
  const rows = (sh.orderedNav?.() ?? sh.nav?.() ?? [])
    .filter((n) => !n.when || n.when(st))
    .map((n) => ({
      label: sh.t(n.label),
      keywords: [n.id, ...(n.keywords ?? [])],
      href: n.href,
    }));
  rows.push({
    label: sh.t("n.settings"),
    keywords: ["settings", "preferences"],
    href: "/settings",
  });
  return rows;
}

function readData() {
  try {
    return JSON.parse(document.getElementById("den-error")?.textContent ?? "");
  } catch {
    return null;
  }
}

async function copy(text, btn, t) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* nothing more to try */
    }
    ta.remove();
  }
  const label = btn.textContent;
  btn.textContent = t("err.copied");
  setTimeout(() => (btn.textContent = label), 1500);
}

export function mountErrorPage(root) {
  const sh = window.denShell;
  const d = readData();
  if (!root || !sh || !d) return;
  const t = sh.t;
  const header = (title, sub) =>
    `<div class="ph"><div><h1>${esc(title)}</h1>` +
    `<div class="sub">${sub}</div></div></div>`;

  if (d.status === 404) {
    document.title = document.title.replace(/Error$/, t("err.404.title"));
    const items = pageItems(sh);
    const hit = suggestPage(d.path, items);
    const lines = [];
    if (d.plugin) {
      const name = esc(d.plugin.name || d.plugin.id);
      lines.push(
        `<p class="lead">${t(
          d.plugin.installed
            ? "err.404.pluginNoPage"
            : d.plugin.locked
              ? "err.404.pluginLocked"
              : "err.404.plugin",
          { name: `<b>${name}</b>` },
        )}</p>`,
      );
    } else lines.push(`<p class="lead">${esc(t("err.404.lead"))}</p>`);
    if (d.engine)
      lines.push(
        `<p>${esc(t("err.404.stale", { onDisk: d.engine.onDisk ?? "?", loaded: d.engine.loaded ?? "?" }))}</p>`,
      );
    if (hit)
      lines.push(
        `<p class="den-err-mean">${t("err.404.mean", {
          page: `<a href="${esc(hit.href)}">${esc(hit.label)}</a>`,
        })}</p>`,
      );
    root.innerHTML =
      header(
        t("err.404.title"),
        // The path sits where the language puts it ("Nothing at {path}").
        esc(t("err.404.sub", { path: "\u0000" })).replace(
          "\u0000",
          `<span class="mono">${esc(d.path)}</span>`,
        ),
      ) +
      `<div class="empty">${lines.join("")}` +
      `<div class="acts"><a class="btn primary" href="/local-dev">${esc(t("err.404.workspaces"))}</a>` +
      `<button type="button" class="btn" id="den-err-search">${esc(t("err.404.search"))} <kbd>⌘K</kbd></button></div>` +
      `<h2 class="sec">${esc(t("err.404.pages"))}</h2><ul class="pages">` +
      items
        .map((i) => `<li><a href="${esc(i.href)}">${esc(i.label)}</a></li>`)
        .join("") +
      `</ul></div>`;
    root.querySelector("#den-err-search")?.addEventListener("click", () => {
      document.getElementById("den-search")?.click();
    });
    return;
  }

  document.title = document.title.replace(/Error$/, t("err.500.title"));
  const what = `${d.method ?? "GET"} ${d.route ?? ""}`;
  const when = new Date(d.time);
  root.innerHTML =
    header(
      t("err.500.title"),
      `<span class="mono">${esc(t("err.500.sub", { what }))}</span>`,
    ) +
    `<div class="empty"><p class="lead">${esc(t("err.500.lead"))}</p>` +
    `<dl class="facts">` +
    `<dt>${esc(t("err.500.what"))}</dt><dd class="mono">${esc(what)}</dd>` +
    `<dt>${esc(t("err.500.time"))}</dt><dd><time datetime="${esc(d.time)}">${esc(isNaN(when) ? d.time : when.toLocaleString(sh.lang?.() && sh.lang() !== "en" ? sh.lang() : undefined))}</time></dd>` +
    `<dt>${esc(t("err.500.id"))}</dt><dd class="mono" id="den-err-id">${esc(d.requestId)}</dd>` +
    `<dt>${esc(t("err.500.version"))}</dt><dd class="mono">${esc(d.version ?? "unknown")}</dd>` +
    `</dl><div class="acts">` +
    `<button type="button" class="btn primary" id="den-err-retry">${esc(t("err.retry"))}</button>` +
    `<button type="button" class="btn" id="den-err-copy">${esc(t("err.copy"))}</button>` +
    `</div></div>`;
  root
    .querySelector("#den-err-retry")
    ?.addEventListener("click", () => location.reload());
  const copyBtn = root.querySelector("#den-err-copy");
  copyBtn?.addEventListener("click", () =>
    copy(detailsText(d, location.pathname), copyBtn, t),
  );
}
