/**
 * Issue 754, "Den shows the work": what Hub knows about the work, drawn in
 * Den. Den only reads it (GET /api/hub/work, GET /api/hub/agents-current:
 * the server asks Hub with the install token; contract in
 * src/shared/hub-work.ts) and stores nothing.
 *
 *   hubWorkCardHtml(answer, t)  → the home page's Work in Hub card: Needs
 *                                 you, Building and Blocked, and each vision
 *                                 with a bar (done of total), each opening
 *                                 Hub. One project: one card; All projects:
 *                                 one row per project.
 *   hubCurrentHtml(current, t)  → under an agent's row: "Working on …" or
 *                                 "Last on …", a Kind chip and its vision.
 *                                 Nothing when it has no item.
 *   hubQuietLineHtml(t)         → no Hub connected: one quiet line to
 *                                 Connect, no card. The Groups work (issue
 *                                 750) shares it.
 *   hubRefusedLineHtml(a, t)    → Hub's 403: a plan code is the quiet plan
 *                                 line; any other, "Hub refused: <error>".
 *   loadHubWork(names)          → the answer for those projects.
 *   loadAgentsCurrent(ids)      → the answer for those agents.
 *   ensureHubWorkCss()          → the card's and the line's styles, once.
 */

const tDefault = (key, vars) =>
  globalThis.window?.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
/** Only an http(s) link opens; anything else is text. */
const href = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : "");
const out = (u, inner, cls = "") => {
  const h = href(u);
  return h
    ? `<a${cls ? ` class="${cls}"` : ""} href="${esc(h)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
    : inner;
};
const num = (v) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;

/** Where Connect to Hub is (Settings › Agents › Hub). */
export const HUB_CONNECT_HREF = "/settings#agents.hub";

/** The one quiet line when Hub isn't there to ask (shared with issue 750). */
export function hubQuietLineHtml(t = tDefault) {
  return (
    `<p class="note hub-quiet" data-hub-quiet>${esc(t("hub.quiet.line"))} ` +
    `<a href="${HUB_CONNECT_HREF}">${esc(t("hub.quiet.connect"))}</a></p>`
  );
}

/**
 * Hub's 403 (shared with issue 750): a plan code (Hub's machine `code`,
 * never its `error` words) is the quiet plan line; any other is
 * "Hub refused: <error>". No card either way.
 */
export function hubRefusedLineHtml(answer, t = tDefault) {
  if (answer?.plan === true)
    return `<p class="note hub-quiet" data-hub-quiet="plan">${esc(t("hub.quiet.plan"))}</p>`;
  const why =
    typeof answer?.error === "string" && answer.error
      ? answer.error
      : (answer?.code ?? "403");
  return `<p class="note hub-quiet" data-hub-quiet="refused">${esc(t("hub.quiet.refused", { error: why }))}</p>`;
}

const COUNTS = [
  ["needs_you", "needsYou", "hw.needsYou"],
  ["building", "building", "hw.building"],
  ["blocked", "blocked", "hw.blocked"],
];

function countsHtml(w, t) {
  return (
    `<div class="hw-counts">` +
    COUNTS.map(([data, key, word]) => {
      const c = w[key] ?? {};
      const n = num(c.count);
      const inner = `<b>${n}</b> ${esc(t(word))}`;
      const h = href(c.url);
      return h
        ? `<a class="hw-count" data-count="${data}" href="${esc(h)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : `<span class="hw-count" data-count="${data}">${inner}</span>`;
    }).join("") +
    `</div>`
  );
}

function visionsHtml(w, t) {
  const vs = Array.isArray(w.visions) ? w.visions : [];
  if (!vs.length) return "";
  return (
    `<ul class="hw-visions">` +
    vs
      .map((v) => {
        const total = num(v.total);
        const done = Math.min(num(v.done), total);
        const words = t("hw.doneOf", { done, total });
        return (
          `<li class="hw-vision" data-vision="${esc(v.id)}">` +
          `<span class="hw-vt">${out(v.url, esc(v.title || v.id))}</span>` +
          `<progress value="${done}" max="${Math.max(total, 1)}" aria-label="${esc(`${v.title || v.id}: ${words}`)}"></progress>` +
          `<span class="hw-of">${esc(words)}</span></li>`
        );
      })
      .join("") +
    `</ul>`
  );
}

/** The home page's card; the quiet line without Hub; "" with nothing. */
export function hubWorkCardHtml(answer, t = tDefault) {
  if (!answer || typeof answer !== "object") return "";
  if (answer.hub === "none") return hubQuietLineHtml(t);
  if (answer.hub === "refused") return hubRefusedLineHtml(answer, t);
  if (answer.hub !== "ok" || !Array.isArray(answer.projects)) return "";
  const shown = answer.projects.filter((p) => p && p.work);
  if (!shown.length) return "";
  const head = `<h2 class="den-sec" id="hub-work-h">${esc(t("hw.title"))}</h2>`;
  const body =
    answer.projects.length === 1
      ? `<div class="hw-one">${countsHtml(shown[0].work, t)}${visionsHtml(shown[0].work, t)}</div>`
      : shown
          .map(
            (p) =>
              `<div class="hw-proj" data-project="${esc(p.project)}">` +
              `<span class="hw-name">${esc(p.name || p.project)}</span>` +
              countsHtml(p.work, t) +
              visionsHtml(p.work, t) +
              `</div>`,
          )
          .join("");
  return `<section class="hw-card" id="hub-work-card" aria-labelledby="hub-work-h">${head}${body}</section>`;
}

/** Since when, in the viewer's own time zone (a tooltip). */
function sinceTitle(since) {
  const d = typeof since === "string" ? new Date(since) : null;
  return d && !Number.isNaN(d.getTime())
    ? ` title="${esc(d.toLocaleString())}"`
    : "";
}

/** Under an agent's row: its current Hub item, or nothing. */
export function hubCurrentHtml(cur, t = tDefault) {
  const item = cur?.item;
  if (!item || (cur.source !== "working" && cur.source !== "recent")) return "";
  const link = out(item.url, esc(item.title || item.id));
  const key = cur.source === "working" ? "hw.workingOn" : "hw.lastOn";
  const kind = item.kind
    ? ` <span class="tagx hw-kind">${esc(item.kind)}</span>`
    : "";
  const vision = cur.vision
    ? ` · ${out(cur.vision.url, esc(cur.vision.title || cur.vision.id), "hw-vlink")}`
    : "";
  return (
    `<div class="aghub hw-cur" data-hubcurrent="${cur.source}"${sinceTitle(cur.since)}>` +
    `<span class="den-dot ${cur.source === "working" ? "ok" : ""}" aria-hidden="true"></span> ` +
    `${t(key, { item: link })}${kind}${vision}</div>`
  );
}

const getJson = (u) =>
  fetch(u, { headers: { accept: "json" } })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

/** GET /api/hub/work for these Den projects. */
export function loadHubWork(names) {
  return getJson(
    `/api/hub/work?projects=${encodeURIComponent(names.join(","))}`,
  );
}

/** GET /api/hub/agents-current for these Den agent ids. */
export function loadAgentsCurrent(ids) {
  return getJson(
    `/api/hub/agents-current?agents=${encodeURIComponent(ids.join(","))}`,
  );
}

const CSS = `
.hw-card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 0 0 14px; }
.hw-card .den-sec { margin: 0 0 8px; }
.hw-counts { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12.5px; }
.hw-count { color: var(--text); text-decoration: none; }
a.hw-count:hover { text-decoration: underline; }
.hw-visions { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
.hw-vision { display: grid; grid-template-columns: minmax(0, 1fr) 120px auto; gap: 8px; align-items: center; font-size: 12px; }
.hw-vt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hw-vision progress { width: 120px; height: 6px; }
.hw-of { color: var(--muted); font-size: 11px; white-space: nowrap; }
.hw-proj { padding: 6px 0; border-top: 1px solid var(--border); }
.hw-proj:first-of-type { border-top: 0; }
.hw-name { display: block; font-weight: 600; font-size: 12.5px; margin-bottom: 2px; }
.hub-quiet { color: var(--muted); font-size: 12px; margin: 0 0 12px; }
.hw-kind { margin-left: 4px; }
@media (max-width: 600px) {
  .hw-vision { grid-template-columns: minmax(0, 1fr) auto; }
  .hw-vision progress { grid-column: 1 / -1; width: 100%; }
}
`;

export function ensureHubWorkCss() {
  if (typeof document === "undefined" || document.getElementById("hw-css"))
    return;
  const s = document.createElement("style");
  s.id = "hw-css";
  s.textContent = CSS;
  document.head.append(s);
}
