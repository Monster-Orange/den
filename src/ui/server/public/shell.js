/**
 * The shell (0.3.0-dev.14): one top bar and one left rail, the same on every
 * page. A page holds only its content; its markup starts with
 *
 *   <div id="den-shell" data-page="<id>"></div>
 *   <script src="/shell.js"></script>
 *
 * A classic script, run where it stands: the frame is in the DOM before the
 * page's own scripts look for #health, #env-sel, #version-pill or #ws-pill.
 * header.js then drives it (health row, changelog, workspace and env
 * pickers); appearance.js adds ◐ at the end of the bar.
 *
 *   top bar  brand mark and title (the theme's display face) · version ·
 *            health row and chip · workspace focus · env (one for the whole
 *            shell) · ◐
 *   rail     the pages, the current one marked aria-current="page";
 *            ↑/↓, Home and End move between them; icons only below 1100px
 *
 * data-health-env pins the health row's env on pages that are local by
 * nature (Local Dev, Releases), whatever the env picker says.
 *
 * Every color and font is a theme token.
 */
(function () {
  "use strict";
  var host = document.getElementById("den-shell");
  if (!host || host.dataset.mounted) return;
  host.dataset.mounted = "1";
  var page = host.dataset.page || "";

  // Icons: 16px line drawings in currentColor.
  var svg = function (d) {
    return (
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      d +
      "</svg>"
    );
  };
  var PAGES = [
    {
      id: "local-dev",
      href: "/local-dev",
      label: "Local Dev",
      icon: svg(
        '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 7l2 1.5L5 10M8.5 10.5H11"/>',
      ),
    },
    {
      id: "services",
      href: "/services",
      label: "Services",
      icon: svg(
        '<path d="M8 2l6 3-6 3-6-3 6-3z"/><path d="M2 8l6 3 6-3M2 11l6 3 6-3"/>',
      ),
    },
    {
      id: "environments",
      href: "/environments",
      label: "Environments",
      icon: svg(
        '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
      ),
    },
    {
      id: "release",
      href: "/release",
      label: "Releases",
      icon: svg('<path d="M8 13V3M4 7l4-4 4 4"/><path d="M3 14h10"/>'),
    },
    {
      id: "logs",
      href: "/logs",
      label: "Logs",
      badge: "log-badge",
      icon: svg('<path d="M3 4h10M3 7h10M3 10h7M3 13h5"/>'),
    },
    {
      id: "tests",
      href: "/tests",
      label: "Tests",
      icon: svg('<path d="M3 8.5l3 3 7-7"/>'),
    },
  ];

  var rail = PAGES.map(function (p) {
    var current = p.id === page ? ' aria-current="page"' : "";
    var badge = p.badge
      ? '<span class="den-rail-badge" id="' + p.badge + '"></span>'
      : "";
    return (
      '<a class="den-rail-link" href="' +
      p.href +
      '" data-page="' +
      p.id +
      '"' +
      current +
      ' title="' +
      p.label +
      '">' +
      '<span class="den-rail-icon">' +
      p.icon +
      "</span>" +
      '<span class="den-rail-label">' +
      p.label +
      "</span>" +
      badge +
      "</a>"
    );
  }).join("");

  // Local Dev's sudo lock lives in the bar on that page (it was a button
  // inside the nav link, which a link may not hold).
  var lock =
    page === "local-dev"
      ? '<button id="sudo-lock" class="den-top-lock" title="Sudo password">🔓</button>'
      : "";

  host.className = "den-shell";
  host.innerHTML =
    '<header class="den-top">' +
    '<a class="den-brand" href="/" title="__DEN_TITLE__">' +
    '<span class="den-mark" id="den-mark" aria-hidden="true"></span>' +
    '<h1 class="den-title">__DEN_CLI__</h1></a>' +
    '<button class="v-pill" id="version-pill" onclick="openChangelog()" title="View changelog">' +
    '<span class="v-pip" id="v-pip"></span><span class="v-txt">v…</span></button>' +
    '<div class="health" id="health" title="' +
    (host.dataset.healthEnv ? "Local service health" : "Service health") +
    '"></div>' +
    lock +
    // Hidden until header.js knows the focused workspace (it clears the
    // inline display).
    '<span id="ws-pill" class="den-ws-pill" style="display: none" title="Focused workspace: the default target for commands"></span>' +
    '<label class="den-env" title="Environment, for every page">' +
    '<span class="den-env-label">Env</span>' +
    '<select id="env-sel" aria-label="Environment"><option value="local">local</option></select>' +
    "</label>" +
    "</header>" +
    '<nav class="den-rail" aria-label="Pages">' +
    rail +
    "</nav>";

  // ↑/↓, Home and End move along the rail; Tab still leaves it.
  var nav = host.querySelector(".den-rail");
  nav.addEventListener("keydown", function (e) {
    var links = Array.prototype.slice.call(nav.querySelectorAll("a"));
    var i = links.indexOf(document.activeElement);
    if (i < 0) return;
    var next =
      e.key === "ArrowDown"
        ? (i + 1) % links.length
        : e.key === "ArrowUp"
          ? (i - 1 + links.length) % links.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? links.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    links[next].focus();
  });

  document.body.classList.add("den-has-shell");
  var style = document.createElement("style");
  style.id = "den-shell-styles";
  style.textContent = [
    "body.den-has-shell { --den-top-h: 48px; --den-rail-w: 176px; padding-left: var(--den-rail-w); }",
    "@media (max-width: 1100px) { body.den-has-shell { --den-rail-w: 52px; } }",
    ".den-shell { display: contents; }",
    ".den-top { display: flex; align-items: center; gap: 10px; height: var(--den-top-h);",
    "  box-sizing: border-box; padding: 0 14px; flex-shrink: 0; position: relative; z-index: 20;",
    "  margin-left: calc(-1 * var(--den-rail-w)); background: var(--surface);",
    "  border-bottom: 1px solid var(--border); min-width: 0; }",
    ".den-brand { display: flex; align-items: center; gap: 8px; color: var(--text);",
    "  text-decoration: none; flex-shrink: 0; }",
    ".den-title { font-family: var(--display); font-size: 15px; font-weight: 600;",
    "  letter-spacing: -0.01em; margin: 0; white-space: nowrap; }",
    ".den-top .v-pill { flex-shrink: 0; }",
    ".den-ws-pill { font-size: 11px; font-family: var(--mono); padding: 2px 8px;",
    "  border-radius: 10px; color: var(--accent-text);",
    "  border: 1px solid color-mix(in srgb, var(--accent) 27%, transparent);",
    "  background: color-mix(in srgb, var(--accent) 6%, transparent); white-space: nowrap; }",
    ".den-env { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;",
    "  font-size: 11px; color: var(--muted); padding: 2px 4px 2px 8px; border-radius: 999px;",
    "  border: 1px solid var(--border); background: var(--surface); }",
    ".den-env-label { font-size: 10px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }",
    ".den-env select { font: 600 11px var(--sans); color: var(--text); background: transparent;",
    "  border: none; outline: none; cursor: pointer; padding: 0 2px; }",
    ".den-env select option { background: var(--surface); color: var(--text); }",
    ".den-env:focus-within { border-color: var(--accent); }",
    ".den-top-lock { background: none; border: none; cursor: pointer; font-size: 13px; padding: 0 2px; flex-shrink: 0; }",
    ".den-rail { position: fixed; left: 0; top: var(--den-top-h); bottom: 0; width: var(--den-rail-w);",
    "  box-sizing: border-box; display: flex; flex-direction: column; gap: 2px; padding: 10px 8px;",
    "  background: var(--surface); border-right: 1px solid var(--border); overflow-y: auto; z-index: 15; }",
    ".den-rail-link { display: flex; align-items: center; gap: 10px; padding: 7px 8px;",
    "  border-radius: 6px; color: var(--muted); text-decoration: none; font: 500 12px var(--sans);",
    "  white-space: nowrap; min-width: 0; position: relative; }",
    ".den-rail-link:hover { color: var(--text); background: var(--raised); }",
    ".den-rail-link[aria-current='page'] { color: var(--text); background: var(--raised);",
    "  box-shadow: inset 2px 0 0 var(--accent); }",
    ".den-rail-link:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }",
    ".den-rail-icon { display: inline-flex; flex-shrink: 0; }",
    ".den-rail-label { overflow: hidden; text-overflow: ellipsis; }",
    ".den-rail-badge { margin-left: auto; background: var(--warn); color: var(--bg); font-size: 10px;",
    "  font-weight: 700; padding: 1px 5px; border-radius: 8px; line-height: 1.4; display: none; }",
    ".den-rail-badge.visible { display: inline-block; }",
    "@media (max-width: 1100px) {",
    "  .den-rail { padding: 10px 6px; }",
    "  .den-rail-link { justify-content: center; padding: 8px 0; }",
    "  .den-rail-label { position: absolute; width: 1px; height: 1px; overflow: hidden;",
    "    clip: rect(0 0 0 0); white-space: nowrap; }",
    "  .den-rail-badge { position: absolute; top: 2px; right: 2px; padding: 0 4px; font-size: 9px; }",
    "}",
    // Names in the bar never wrap mid-word: they end in an ellipsis and
    // keep the whole name in their title.
    ".den-top .health-item, .den-top .health-app-label, .den-ws-pill { white-space: nowrap; }",
    ".den-ws-pill { max-width: 220px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }",
    ".den-ws-pill > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }",
    // The workspace name may give way (ellipsis, title) where the brand and
    // version may not (appearance.js keeps those at their width).
    "#den-shell .den-top > #ws-pill, #den-shell .den-top > .ws-pill-wrap {",
    "  flex-shrink: 1; min-width: 60px; max-width: 220px; }",
    "#den-shell .ws-pill-wrap > #ws-pill { max-width: 100%; }",
    ".health { display: flex; align-items: center; gap: 10px; padding: 0 4px; }",
    ".health-item { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); }",
    ".den-top .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted);",
    "  flex-shrink: 0; display: inline-block; }",
    ".den-top .dot.ok { background: var(--ok); }",
    ".den-top .dot.err { background: var(--bad); }",
    ".den-top .dot.warn { background: var(--warn); }",
    ".den-top .dot.running { background: var(--warn); }",
  ].join("\n");
  document.head.appendChild(style);
})();
