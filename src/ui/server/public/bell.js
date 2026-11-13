/**
 * NT-3: the bell in the top bar (shell.js draws #den-bell; header.js
 * calls initBell on every page). It reads GET /api/notifications every
 * 5 s and on focus, shows the unread count, and opens a panel grouped by
 * project, then agent, newest first (a waiting agent first). A row opens
 * the agent (its link) and marks it read. Mark all read, Clear read, per
 * project Mark read, per agent Mute for 1 hour. Esc or a click outside
 * closes it; focus goes back to the bell.
 */
const POLL_MS = 5000;

const tr = (k, v) => window.denShell?.t?.(k, v) ?? k;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** "now", "3 min", "2 h", or the date. */
export function bellAgo(iso, now = Date.now()) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const m = Math.round(ms / 60000);
  if (m < 1) return tr("bell.now");
  if (m < 60) return tr("bell.min", { n: m });
  const h = Math.round(m / 60);
  if (h < 48) return tr("bell.h", { n: h });
  return iso.slice(0, 10);
}

/** A scope's heading: a project's name, Server, or "Hub · <project>". */
function scopeLabel(scope) {
  if (scope === "workspace/den-server") return tr("bell.server");
  if (scope.startsWith("workspace/")) return scope.slice("workspace/".length);
  if (scope.startsWith("hub/"))
    return tr("bell.hub", { project: scope.slice("hub/".length) });
  return scope;
}

/** Only Den's own pages, or http(s): a row's link. */
const safeLink = (l) =>
  typeof l === "string" && (/^\/(?!\/)/.test(l) || /^https?:\/\//.test(l))
    ? l
    : "";

/** The panel's HTML for GET /api/notifications's answer. */
export function bellHtml(b) {
  const groups = b?.groups ?? [];
  const head =
    `<div class="den-bell-hd"><h2 id="den-bell-h">${esc(tr("bell.title"))}</h2>` +
    (b?.unread
      ? `<button type="button" data-bell="all">${esc(tr("bell.markAll"))}</button>`
      : "") +
    (groups.some((g) => g.subjects.some((s) => s.items.some((n) => n.read)))
      ? `<button type="button" data-bell="clear">${esc(tr("bell.clearRead"))}</button>`
      : "") +
    `</div>`;
  if (!groups.length)
    return head + `<p class="den-bell-empty">${esc(tr("bell.empty"))}</p>`;
  return (
    head +
    groups
      .map(
        (g) =>
          `<section data-scope="${esc(g.scope)}"><div class="den-bell-sc"><span>${esc(scopeLabel(g.scope))}</span>` +
          (g.subjects.some((s) => s.items.some((n) => !n.read))
            ? `<button type="button" data-bell="scope" data-scope="${esc(g.scope)}">${esc(tr("bell.read"))}</button>`
            : "") +
          `</div>` +
          g.subjects
            .map((s) =>
              s.items
                .map((n, i) => {
                  const link = safeLink(n.link);
                  return (
                    `<div class="den-bell-row${n.read ? " read" : ""}" data-id="${esc(n.id)}" data-kind="${esc(n.kind)}">` +
                    `<span class="den-dot ${n.read ? "off" : n.kind === "waiting" ? "warn" : "ok"}" aria-hidden="true"></span>` +
                    (link
                      ? `<a href="${esc(link)}" data-bell="open">${esc(n.text)}</a>`
                      : `<span>${esc(n.text)}</span>`) +
                    `<time datetime="${esc(n.at)}">${esc(bellAgo(n.at))}</time>` +
                    (i === 0 && s.subject.startsWith("agent:")
                      ? `<button type="button" class="den-ib" data-bell="mute" data-target="${esc(s.subject)}" title="${esc(tr("bell.mute"))}" aria-label="${esc(tr("bell.mute"))}">⊘</button>`
                      : "") +
                    `</div>`
                  );
                })
                .join(""),
            )
            .join("") +
          `</section>`,
      )
      .join("")
  );
}

let last = null;

async function load() {
  try {
    const r = await fetch("/api/notifications", {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function paintCount(btn, b) {
  const n = btn.querySelector(".den-bell-n");
  const unread = b?.unread ?? 0;
  if (n) {
    n.hidden = !unread;
    n.textContent = unread > 99 ? "99+" : String(unread);
  }
  btn.setAttribute(
    "aria-label",
    unread ? tr("bell.n", { n: unread }) : tr("bell.title"),
  );
}

async function post(path, body) {
  try {
    await window.denShell?.api?.("POST", path, body);
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
}

/** Wire the bell on this page; a page without #den-bell does nothing. */
export function initBell(doc = document) {
  const btn = doc.getElementById("den-bell");
  if (!btn || btn.dataset.wired) return;
  btn.dataset.wired = "1";
  const pop = doc.createElement("div");
  pop.className = "den-bell-pop";
  pop.id = "den-bell-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-labelledby", "den-bell-h");
  pop.hidden = true;
  doc.body.appendChild(pop);
  btn.setAttribute("aria-controls", pop.id);

  const refresh = async () => {
    const b = await load();
    if (!b) return;
    last = b;
    paintCount(btn, b);
    if (!pop.hidden) pop.innerHTML = bellHtml(b);
  };
  const close = (focus = true) => {
    if (pop.hidden) return;
    pop.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (focus) btn.focus();
  };
  const open = async () => {
    pop.innerHTML = bellHtml(last ?? { groups: [], unread: 0 });
    pop.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    (pop.querySelector("a, button") ?? pop).focus?.();
    await refresh();
  };
  btn.addEventListener("click", () => (pop.hidden ? open() : close()));
  doc.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !pop.hidden) close();
  });
  doc.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !btn.contains(e.target))
      close(false);
  });
  pop.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-bell]");
    if (!el) return;
    const what = el.dataset.bell;
    if (what === "open") {
      const id = el.closest("[data-id]")?.dataset.id;
      // Marked read first; the link then opens the agent.
      if (id)
        void fetch("/api/notifications/read", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
          keepalive: true,
        }).catch(() => {});
      return;
    }
    e.preventDefault();
    if (what === "all") await post("/api/notifications/read", { all: true });
    else if (what === "clear") await post("/api/notifications/clear", {});
    else if (what === "scope")
      await post("/api/notifications/read", { scope: el.dataset.scope });
    else if (what === "mute") {
      await post("/api/notifications/mute", {
        target: el.dataset.target,
        minutes: 60,
      });
      window.denShell?.toast?.(tr("bell.muted"));
    }
    await refresh();
  });
  void refresh();
  const timer = setInterval(() => {
    if (doc.visibilityState !== "hidden") void refresh();
  }, POLL_MS);
  window.addEventListener("focus", () => void refresh());
  window.addEventListener("pagehide", () => clearInterval(timer));
}
