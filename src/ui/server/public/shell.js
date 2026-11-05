/**
 * The shell (0.3.0-dev.14, rail rebuilt in 0.3.0-dev.17): one top bar and
 * one left rail, the same on every page. A page holds only its content;
 * its markup starts with
 *
 *   <div id="den-shell" data-page="<id>"></div>
 *   <script src="/shell.js"></script>
 *
 * A classic script, run where it stands: the frame is in the DOM before the
 * page's own scripts look for #health, #env-sel, #version-pill or #ws-pill.
 * header.js then drives it (health row, changelog, workspace and env
 * pickers); appearance.js adds ◐ at the end of the bar.
 *
 * The acceptance bar is the shell prototype (den-merge-notes/shell-proto/
 * den-shell.html): its sizes, weights, spacing and states are ported here
 * as they are, its colors mapped onto the theme tokens (--r-btn is
 * --radius-button, --bar-grad is --bar). scripts/shell-fidelity.mjs
 * measures the two side by side.
 *
 *   top bar  ☰ (narrow) · brand mark and title · / Workspace / Env (one
 *            env for the whole shell) · health row (in the status chip's
 *            slot, as a chip, until dev.20) · lock (Local Dev) · What's
 *            new · ◐ ▾
 *   rail     Pinned, then the NAV registry by GROUPS (Develop, Verify,
 *            Ship, a distribution's own), then Settings and the collapse
 *            toggle. One tab stop (the current page); ↑/↓, Home and End
 *            move within it. Collapsed: icons only, the headings kept for
 *            screen readers. Below 720px it is a drawer behind ☰.
 *
 * The registries (window.denShell, the spec's NAV and GROUPS):
 *   registerGroup({ id, label, order, from? })
 *   registerNav({ id, label, icon, group, order, href, badge?(state),
 *                 when?(state) })
 *   addMessages(lang, { key: text }), t(key, vars)
 *   setState(partial): health { repo|address: state }, openLogs, …
 *   pin(id), unpin(id), isPinned(id): pins are user prefs (/api/settings
 *   `shell.pins`), nothing else.
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

  // ── i18n: labels are keys; only en ships until slice 5 ─────────────────
  var MESSAGES = {
    en: {
      "g.pinned": "Pinned",
      "g.develop": "Develop",
      "g.verify": "Verify",
      "g.ship": "Ship",
      "n.local-dev": "Local Dev",
      "n.services": "Services",
      "n.logs": "Logs",
      "n.tests": "Tests",
      "n.environments": "Environments",
      "n.releases": "Releases",
      "n.settings": "Settings",
      "k.org": "Org",
      "b.logs": "{n} open",
      "b.down": "{n} down",
      "act.unpin": "Unpin",
      "toast.pinned": "Pinned {s}",
      "toast.unpinned": "Unpinned {s}",
      collapse: "Collapse",
      expand: "Expand",
      menu: "Menu",
      skip: "Skip to content",
      pages: "Pages",
    },
  };
  var lang = "en";
  function t(key, vars) {
    var s = (MESSAGES[lang] || {})[key];
    if (s == null) s = MESSAGES.en[key];
    if (s == null) s = key;
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      return vars && vars[k] != null ? String(vars[k]) : m;
    });
  }
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ── icons: the prototype's 24px line drawings ─────────────────────────
  var ICONS = {
    overview: '<path d="M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z"/>',
    services:
      '<rect x="4" y="4" width="16" height="6" rx="1.5"/><rect x="4" y="14" width="16" height="6" rx="1.5"/><path d="M8 7h.01M8 17h.01"/>',
    logs: '<path d="M5 5h14M5 9h10M5 13h14M5 17h8"/>',
    tests:
      '<path d="M9 4h6M10 4v5l-5 9a1.5 1.5 0 0 0 1.3 2h11.4a1.5 1.5 0 0 0 1.3-2l-5-9V4"/>',
    envs: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>',
    releases: '<path d="M12 3v12M7 10l5 5 5-5M5 20h14"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
    page: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 9h6M9 13h6"/>',
  };
  function icon(name) {
    var d = ICONS[name] || (/^</.test(name || "") ? name : ICONS.page);
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + d + "</svg>";
  }

  // ── registries ─────────────────────────────────────────────────────────
  var GROUPS = [];
  var NAV = [];
  function upsert(list, item) {
    for (var i = 0; i < list.length; i++)
      if (list[i].id === item.id) {
        list[i] = item;
        return;
      }
    list.push(item);
  }
  function byOrder(a, b) {
    return (a.order || 0) - (b.order || 0) || (a.id < b.id ? -1 : 1);
  }
  var ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
  function registerGroup(g) {
    if (!g || !ID.test(g.id || "")) throw new Error("group needs an id");
    upsert(GROUPS, {
      id: g.id,
      label: g.label || g.id,
      order: typeof g.order === "number" ? g.order : 100,
      from: g.from || null,
    });
    renderRail();
  }
  function registerNav(n) {
    if (!n || !ID.test(n.id || "") || !n.href || !n.group)
      throw new Error("a page needs an id, an href and a group");
    upsert(NAV, {
      id: n.id,
      label: n.label || n.id,
      icon: n.icon || "page",
      group: n.group,
      order: typeof n.order === "number" ? n.order : 100,
      href: n.href,
      badge: typeof n.badge === "function" ? n.badge : null,
      when: typeof n.when === "function" ? n.when : null,
      from: n.from || null,
    });
    renderRail();
  }

  // ── state: what badges, when() and the pinned dots read ───────────────
  var LS = "__DEN_CLI__-shell";
  var state = { health: {}, down: 0, openLogs: 0, pins: [], collapsed: false };
  try {
    var cached = JSON.parse(localStorage.getItem(LS) || "{}");
    if (Array.isArray(cached.pins)) state.pins = cached.pins;
    state.collapsed = cached.collapsed === true;
  } catch (e) {
    /* no storage: the server's copy arrives below */
  }
  function remember() {
    try {
      localStorage.setItem(
        LS,
        JSON.stringify({ pins: state.pins, collapsed: state.collapsed }),
      );
    } catch (e) {
      /* a convenience only */
    }
  }
  function setState(partial) {
    for (var k in partial)
      if (Object.prototype.hasOwnProperty.call(partial, k))
        state[k] = partial[k];
    applyCollapsed();
    renderRail();
  }
  function saveShell(patch) {
    remember();
    if (typeof fetch !== "function") return Promise.resolve();
    return fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shell: patch }),
    }).catch(function () {});
  }
  function isPinned(id) {
    return state.pins.indexOf(id) >= 0;
  }
  function pin(id) {
    if (isPinned(id)) return;
    setState({ pins: state.pins.concat([id]) });
    saveShell({ pins: state.pins });
    toast(t("toast.pinned", { s: id }));
  }
  function unpin(id) {
    if (!isPinned(id)) return;
    setState({
      pins: state.pins.filter(function (p) {
        return p !== id;
      }),
    });
    saveShell({ pins: state.pins });
    toast(t("toast.unpinned", { s: id }));
  }
  var toastTimer = null;
  function toast(msg) {
    if (!document.body || !document.createElement) return;
    var old = document.querySelector && document.querySelector(".den-toast");
    if (old && old.remove) old.remove();
    var el = document.createElement("div");
    el.className = "den-toast";
    if (el.setAttribute) el.setAttribute("role", "status");
    el.textContent = msg;
    if (document.body.appendChild) document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (el.remove) el.remove();
    }, 2200);
  }

  // ── Den's own groups and pages ─────────────────────────────────────────
  [
    { id: "develop", label: "g.develop", order: 10 },
    { id: "verify", label: "g.verify", order: 20 },
    { id: "ship", label: "g.ship", order: 30 },
  ].forEach(function (g) {
    GROUPS.push({ id: g.id, label: g.label, order: g.order, from: null });
  });
  [
    // Den's overview: the workspace and its graph (the prototype's
    // Overview and Graph are one page here).
    {
      id: "local-dev",
      label: "n.local-dev",
      icon: "overview",
      group: "develop",
      order: 10,
      href: "/local-dev",
    },
    {
      id: "services",
      label: "n.services",
      icon: "services",
      group: "develop",
      order: 20,
      href: "/services",
      // R13: down services, from the health row's rollup, live.
      badge: function (s) {
        return s.down > 0
          ? { n: s.down, bad: true, label: t("b.down", { n: s.down }) }
          : null;
      },
    },
    {
      id: "logs",
      label: "n.logs",
      icon: "logs",
      group: "develop",
      order: 30,
      href: "/logs",
      badge: function (s) {
        // Open log streams (Den keeps no new-lines count yet).
        return s.openLogs > 0
          ? { n: s.openLogs, label: t("b.logs", { n: s.openLogs }) }
          : null;
      },
    },
    {
      id: "tests",
      label: "n.tests",
      icon: "tests",
      group: "verify",
      order: 10,
      href: "/tests",
    },
    {
      id: "environments",
      label: "n.environments",
      icon: "envs",
      group: "ship",
      order: 10,
      href: "/environments",
    },
    {
      id: "release",
      label: "n.releases",
      icon: "releases",
      group: "ship",
      order: 20,
      href: "/release",
    },
  ].forEach(function (n) {
    NAV.push({
      id: n.id,
      label: n.label,
      icon: n.icon,
      group: n.group,
      order: n.order,
      href: n.href,
      badge: n.badge || null,
      when: null,
      from: null,
    });
  });
  // The settings surface that exists: Local Dev's settings panel.
  var SETTINGS = {
    id: "settings",
    label: "n.settings",
    icon: "settings",
    href: "/local-dev?settings=1",
  };

  // ── the frame ──────────────────────────────────────────────────────────
  var lock =
    page === "local-dev"
      ? '<button id="sudo-lock" class="den-chip den-top-lock" title="Sudo password">🔓</button>'
      : "";
  host.className = "den-shell";
  host.innerHTML =
    '<a class="den-skip" href="#den-content">' +
    esc(t("skip")) +
    "</a>" +
    '<header class="den-top">' +
    '<button class="den-ib den-menu-btn" id="den-menu-btn" aria-label="' +
    esc(t("menu")) +
    '" aria-expanded="false" aria-controls="den-rail">☰</button>' +
    '<a class="den-brand" href="/" title="__DEN_TITLE__">' +
    '<span class="den-mark" id="den-mark" aria-hidden="true"></span>' +
    '<h1 class="den-title">__DEN_CLI__</h1></a>' +
    // The prototype's scope breadcrumb: / Workspace / Env (R4 makes each
    // part a menu in dev.18). The pill is hidden until header.js knows the
    // workspace (it clears the inline display).
    '<div class="den-scope" aria-label="Scope">' +
    '<span class="den-sep" aria-hidden="true">/</span>' +
    // The org (setOrg, from header.js): hidden until it is known.
    '<span id="org-crumb" class="den-ib den-org" hidden><span class="den-k">' +
    esc(t("k.org")) +
    '</span><span class="den-org-name"></span></span>' +
    '<span class="den-sep den-org-sep" aria-hidden="true" hidden>/</span>' +
    '<span id="ws-pill" class="den-ib den-ws-pill" style="display: none" title="Focused workspace"></span>' +
    '<span class="den-sep" aria-hidden="true">/</span>' +
    '<label class="den-ib den-env" title="Environment, for every page">' +
    '<span class="den-k">Env</span>' +
    '<select id="env-sel" aria-label="Environment"><option value="local">local</option></select>' +
    "</label>" +
    "</div>" +
    '<div class="health" id="health" title="' +
    (host.dataset.healthEnv ? "Local service health" : "Service health") +
    '"></div>' +
    lock +
    '<button class="den-ib v-pill" id="version-pill" onclick="openChangelog()" title="View changelog">' +
    '<span class="v-txt">v…</span><span class="v-pip" id="v-pip"></span></button>' +
    "</header>" +
    '<nav class="den-rail" id="den-rail" aria-label="' +
    esc(t("pages")) +
    '"></nav>';

  var nav = host.querySelector(".den-rail");

  function healthDot(id) {
    var s = state.health[id];
    var cls =
      s === "down"
        ? " bad"
        : s === "degraded"
          ? " warn"
          : s === "ok"
            ? ""
            : " off";
    return '<span class="den-dot' + cls + '" aria-hidden="true"></span>';
  }
  function pinHref(id) {
    var repo = id.split("/")[0];
    return "/services#repo-" + encodeURIComponent(repo);
  }
  function item(n, current, extra, attrs) {
    return (
      '<a class="den-ni" href="' +
      esc(n.href) +
      '" data-nav="' +
      esc(n.id) +
      '"' +
      (current ? ' aria-current="page"' : "") +
      (attrs || "") +
      ' title="' +
      esc(n.title) +
      '">' +
      (n.lead || icon(n.icon)) +
      '<span class="den-lbl' +
      (n.mono ? " den-mono" : "") +
      '">' +
      esc(n.title) +
      "</span>" +
      (extra || "") +
      "</a>"
    );
  }
  function group(id, label, from, body) {
    return (
      '<div class="den-rail-group" role="group" aria-labelledby="den-gh-' +
      esc(id) +
      '"><div class="den-gh" id="den-gh-' +
      esc(id) +
      '"><span>' +
      esc(label) +
      "</span>" +
      (from ? '<span class="den-tagx">' + esc(from) + "</span>" : "") +
      "</div>" +
      body +
      "</div>"
    );
  }
  /** The rail's markup from the registries and the state. */
  function railHtml() {
    var html = "";
    if (state.pins.length)
      html += group(
        "pinned",
        t("g.pinned"),
        null,
        state.pins
          .map(function (p) {
            return item(
              {
                id: "pin-" + p,
                href: pinHref(p),
                title: p,
                lead: healthDot(p),
                mono: true,
              },
              false,
              '<span class="den-pin-x" data-unpin="' +
                esc(p) +
                '" role="button" aria-label="' +
                esc(t("act.unpin") + " " + p) +
                '" title="' +
                esc(t("act.unpin")) +
                '">×</span>',
              ' data-pin="' + esc(p) + '"',
            );
          })
          .join(""),
      );
    GROUPS.slice()
      .sort(byOrder)
      .forEach(function (g) {
        var items = NAV.filter(function (n) {
          return n.group === g.id && (!n.when || n.when(state));
        }).sort(byOrder);
        if (!items.length) return;
        html += group(
          g.id,
          t(g.label),
          g.from,
          items
            .map(function (n) {
              var b = n.badge ? n.badge(state) : null;
              var name = t(n.label);
              return item(
                { id: n.id, href: n.href, title: name, icon: n.icon },
                n.id === page,
                b
                  ? '<span class="den-bdg' +
                      (b.bad ? " bad" : "") +
                      '" aria-hidden="true">' +
                      esc(b.n) +
                      "</span>"
                  : "",
                b && b.label
                  ? ' aria-label="' + esc(name + ", " + b.label) + '"'
                  : "",
              );
            })
            .join(""),
        );
      });
    html += '<div class="den-rail-grow"></div>';
    html += item(
      {
        id: SETTINGS.id,
        href: SETTINGS.href,
        title: t(SETTINGS.label),
        icon: SETTINGS.icon,
      },
      false,
    );
    html +=
      '<button class="den-ni den-collapse-btn" type="button" data-act="collapse" aria-expanded="' +
      (state.collapsed ? "false" : "true") +
      '" title="' +
      esc(state.collapsed ? t("expand") : t("collapse")) +
      '"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="' +
      (state.collapsed ? "M9 6l6 6-6 6" : "M15 6l-6 6 6 6") +
      '"/></svg><span class="den-lbl">' +
      esc(state.collapsed ? t("expand") : t("collapse")) +
      "</span></button>";
    return html;
  }

  // One tab stop for the rail: the current page, else the first item.
  function rove() {
    var links = Array.prototype.slice.call(nav.querySelectorAll(".den-ni"));
    var stop = null;
    for (var i = 0; i < links.length; i++)
      if (
        links[i].getAttribute
          ? links[i].getAttribute("aria-current") === "page"
          : links[i].attrs && links[i].attrs["aria-current"] === "page"
      )
        stop = links[i];
    if (!stop) stop = links[0];
    for (var j = 0; j < links.length; j++)
      links[j].tabIndex = links[j] === stop ? 0 : -1;
  }
  var lastHtml = "";
  function renderRail() {
    if (!nav) return;
    var html = railHtml();
    if (html === lastHtml) return;
    // Keep keyboard focus on the same item across a re-render.
    var active = document.activeElement;
    var keep =
      active && nav.contains && nav.contains(active) && active.dataset
        ? active.dataset.nav
        : null;
    lastHtml = html;
    nav.innerHTML = html;
    rove();
    if (keep && nav.querySelector) {
      var again = nav.querySelector('[data-nav="' + keep + '"]');
      if (again) {
        again.tabIndex = 0;
        again.focus();
      }
    }
  }

  // ↑/↓, Home and End move along the rail; Tab still leaves it.
  nav.addEventListener("keydown", function (e) {
    var links = Array.prototype.slice.call(nav.querySelectorAll(".den-ni"));
    var i = links.indexOf(document.activeElement);
    if (i < 0) return;
    var pinId =
      links[i].dataset && links[i].dataset.pin ? links[i].dataset.pin : null;
    if (pinId && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      unpin(pinId);
      return;
    }
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
    links[i].tabIndex = -1;
    links[next].tabIndex = 0;
    links[next].focus();
  });
  nav.addEventListener("click", function (e) {
    var tgt = e.target;
    var x = tgt && tgt.closest ? tgt.closest("[data-unpin]") : null;
    if (x) {
      e.preventDefault();
      unpin(x.getAttribute("data-unpin"));
      return;
    }
    var c = tgt && tgt.closest ? tgt.closest('[data-act="collapse"]') : null;
    if (c) {
      setState({ collapsed: !state.collapsed });
      saveShell({ collapsed: state.collapsed });
    }
  });

  function applyCollapsed() {
    if (document.body && document.body.classList)
      document.body.classList.toggle("den-rail-collapsed", !!state.collapsed);
  }

  // ☰ opens the rail as a drawer below 720px.
  var menu = host.querySelector(".den-menu-btn");
  if (menu)
    menu.addEventListener("click", function () {
      var open = !document.body.classList.contains("den-rail-open");
      document.body.classList.toggle("den-rail-open", open);
      menu.setAttribute("aria-expanded", open ? "true" : "false");
    });

  // Skip to content: the page's first element after the shell.
  var skip = host.querySelector(".den-skip");
  if (skip)
    skip.addEventListener("click", function (e) {
      var el = host.nextElementSibling;
      while (el && el.tagName === "SCRIPT") el = el.nextElementSibling;
      if (!el) return;
      e.preventDefault();
      if (!el.id) el.id = "den-content";
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus();
    });

  document.body.classList.add("den-has-shell");
  applyCollapsed();
  renderRail();

  window.denShell = {
    registerGroup: registerGroup,
    registerNav: registerNav,
    addMessages: function (l, msgs) {
      MESSAGES[l] = Object.assign({}, MESSAGES[l] || {}, msgs || {});
      lastHtml = "";
      renderRail();
    },
    t: t,
    setState: setState,
    getState: function () {
      return state;
    },
    pin: pin,
    unpin: unpin,
    isPinned: isPinned,
    toast: toast,
    /** The org part of the scope: "/ ORG <title> /", before the workspace. */
    setOrg: function (org) {
      var el = document.getElementById("org-crumb");
      if (!el || !org || !org.title) return false;
      el.querySelector(".den-org-name").textContent = org.title;
      el.title = "Org: " + org.title + (org.id ? " (" + org.id + ")" : "");
      el.hidden = false;
      var sep = el.nextElementSibling;
      if (sep && sep.classList.contains("den-org-sep")) sep.hidden = false;
      return true;
    },
    groups: function () {
      return GROUPS.slice().sort(byOrder);
    },
    nav: function () {
      return NAV.slice();
    },
  };

  // The server's prefs win over the local copy.
  if (typeof fetch === "function")
    fetch("/api/settings")
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (s) {
        if (!s || !s.shell) return;
        setState({
          pins: Array.isArray(s.shell.pins) ? s.shell.pins : [],
          collapsed: s.shell.collapsed === true,
        });
        remember();
      })
      .catch(function () {});

  var style = document.createElement("style");
  style.id = "den-shell-styles";
  style.textContent = [
    // Layout: the prototype's 48px bar, 216px rail (56px collapsed); a
    // drawer below 720px.
    // The prototype's rail is `width: 216px` (56px collapsed) in a
    // content box: with its padding and border it takes 233px (73px).
    "body.den-has-shell { --den-top-h: 48px; --den-rail-cw: 216px;",
    "  --den-rail-w: calc(var(--den-rail-cw) + 17px); padding-left: var(--den-rail-w); }",
    "body.den-has-shell.den-rail-collapsed { --den-rail-cw: 56px; }",
    ".den-shell { display: contents; }",
    ".den-top, .den-rail { font: 14px/1.45 var(--sans); }",
    ".den-top :focus-visible, .den-rail :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    ".den-skip { position: fixed; left: 8px; top: -40px; z-index: 100; padding: 6px 10px;",
    "  background: var(--surface); color: var(--text); border: 1px solid var(--accent);",
    "  border-radius: var(--radius-button); font: 600 12px var(--sans); text-decoration: none; }",
    ".den-skip:focus { top: 8px; }",
    // Top bar (.top)
    ".den-top { display: flex; align-items: center; gap: 8px; height: var(--den-top-h);",
    "  box-sizing: border-box; padding: 0 12px; flex-shrink: 0; position: relative; z-index: 20;",
    "  margin-left: calc(-1 * var(--den-rail-w)); background: var(--surface);",
    "  border-bottom: 1px solid var(--border); min-width: 0; color: var(--text); }",
    ".den-top::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;",
    "  background: var(--bar, none); pointer-events: none; }",
    // Brand (.brand, .mark)
    ".den-brand { display: flex; align-items: center; gap: 8px; color: var(--text);",
    "  text-decoration: none; flex-shrink: 0; white-space: nowrap; }",
    ".den-title { font: 600 15px var(--display); margin: 0; white-space: nowrap; }",
    "#den-shell .den-mark { width: 22px; height: 22px; }",
    "#den-shell .den-mark img { width: 22px; height: 22px; }",
    "#den-shell .den-mark-text { font: 700 12px/1 var(--mono); }",
    "#den-shell .den-mark-rounded { border-radius: 6px; }",
    // Buttons in the bar (.ib)
    ".den-ib { background: none; border: 1px solid transparent; border-radius: var(--radius-button);",
    "  padding: 4px 8px; cursor: pointer; color: var(--muted); display: inline-flex;",
    "  align-items: center; gap: 6px; white-space: nowrap; font: inherit; }",
    ".den-ib:hover { background: var(--sunken); color: var(--text); }",
    ".den-menu-btn { display: none; }",
    // Scope (.scope, .sep, .k): View / Focus / Env
    ".den-scope { display: flex; align-items: center; gap: 2px; min-width: 0; flex-shrink: 1; }",
    ".den-sep { color: var(--faint); }",
    ".den-scope [hidden] { display: none; }",
    ".den-scope .den-ib { color: var(--text); font-size: 13px; }",
    ".den-k, .den-ws-pill .ws-pill-key { font: 11px var(--mono); color: var(--faint);",
    "  text-transform: uppercase; letter-spacing: .06em; }",
    ".den-env select { font: inherit; color: inherit; background: transparent; border: none;",
    "  outline: none; cursor: pointer; padding: 0; appearance: none; -webkit-appearance: none; }",
    ".den-env select option { background: var(--surface); color: var(--text); }",
    ".den-env::after { content: '▾'; }",
    ".den-env:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }",
    // Focus pill: a scope button too
    ".den-ws-pill { min-width: 0; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }",
    ".den-ws-pill .ws-pill-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }",
    "#den-shell .den-top .den-scope > #ws-pill, #den-shell .den-top .den-scope > .ws-pill-wrap {",
    "  flex-shrink: 1; min-width: 60px; max-width: 220px; }",
    "#den-shell .ws-pill-wrap > #ws-pill { max-width: 100%; }",
    "#den-shell #ws-pill.ws-pill-btn { color: var(--text); font-size: 13px; }",
    "#den-shell .ws-pill-caret { font-size: inherit; opacity: 1; }",
    // Chips (.chip): the lock
    ".den-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border);",
    "  border-radius: 999px; padding: 3px 10px; background: var(--surface); cursor: pointer;",
    "  font-size: 13px; white-space: nowrap; flex-shrink: 0; color: var(--text); }",
    ".den-chip:hover { border-color: var(--border-strong); }",
    // What's new (.ib.whatsnew + .badge-dot)
    "#den-shell .v-pill { font: inherit; padding: 4px 8px; border: 1px solid transparent;",
    "  border-radius: var(--radius-button); color: var(--muted); flex-shrink: 0; }",
    "#den-shell .v-pill:hover { background: var(--sunken); color: var(--text); border-color: transparent; }",
    "#den-shell .v-pip { position: static; width: 7px; height: 7px; border: 0; border-radius: 50%;",
    "  background: var(--accent); }",
    // ◐ (the prototype's user menu, an .ib)
    "#den-shell .den-top .appearance { margin-left: 0; }",
    "#den-shell .den-top .appearance-btn { font: inherit; line-height: inherit; padding: 4px 8px;",
    "  border: 1px solid transparent; border-radius: var(--radius-button); color: var(--muted); }",
    "#den-shell .den-top .appearance-btn:hover, #den-shell .den-top .appearance-btn[aria-expanded='true'] {",
    "  background: var(--sunken); color: var(--text); border-color: transparent; }",
    // Rail (.rail)
    ".den-rail { position: fixed; left: 0; top: var(--den-top-h); bottom: 0; width: var(--den-rail-cw);",
    "  box-sizing: content-box; display: flex; flex-direction: column; padding: 10px 8px;",
    "  background: var(--surface); border-right: 1px solid var(--border); overflow-y: auto; z-index: 15;",
    "  color: var(--text); }",
    ".den-rail-group { display: contents; }",
    // Group heading (.gh)
    ".den-gh { font: 11px var(--mono); text-transform: uppercase; letter-spacing: .07em; color: var(--faint);",
    "  padding: 12px 10px 4px; display: flex; justify-content: space-between; }",
    ".den-rail > .den-rail-group:first-child > .den-gh { padding-top: 2px; }",
    ".den-tagx { font: 10px var(--mono); color: var(--faint); border: 1px dashed var(--border-strong);",
    "  border-radius: 4px; padding: 0 4px; text-transform: none; letter-spacing: 0; }",
    // Rail item (.ni)
    ".den-ni { display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box;",
    "  text-align: left; background: none; border: 0; padding: 6px 10px; border-radius: var(--radius-button);",
    "  cursor: pointer; color: var(--muted); text-decoration: none; position: relative; font: inherit; }",
    ".den-ni:hover { background: var(--sunken); color: var(--text); }",
    ".den-ni[aria-current='page'] { background: color-mix(in srgb, var(--accent) 13%, transparent);",
    "  color: var(--text); font-weight: 500; }",
    ".den-ni[aria-current='page']::before { content: ''; position: absolute; left: -8px; top: 6px;",
    "  bottom: 6px; width: 3px; border-radius: 2px; background: var(--accent); }",
    ".den-ni svg { width: 18px; height: 18px; flex: none; stroke: currentColor; fill: none;",
    "  stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }",
    ".den-lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-mono { font-family: var(--mono); font-size: 12.5px; }",
    ".den-bdg { font: 11px var(--mono); padding: 0 6px; border-radius: 999px; background: var(--sunken);",
    "  color: var(--muted); font-variant-numeric: tabular-nums; }",
    ".den-bdg.bad { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }",
    ".den-rail-grow { flex: 1; }",
    // Pinned row: the dot in place of the icon (.dot, margin 0 5px)
    ".den-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none;",
    "  display: inline-block; margin: 0 5px; }",
    ".den-dot.bad { background: var(--bad); } .den-dot.warn { background: var(--warn); }",
    ".den-dot.off { background: var(--faint); }",
    ".den-pin-x { opacity: 0; font-size: 12px; color: var(--faint); }",
    ".den-ni:hover .den-pin-x, .den-ni:focus-visible .den-pin-x { opacity: 1; }",
    // Collapsed: icons only. The prototype hides headings and labels; they
    // stay here for screen readers (visually hidden, no space taken).
    "body.den-rail-collapsed .den-rail .den-lbl, body.den-rail-collapsed .den-rail .den-gh,",
    "body.den-rail-collapsed .den-rail .den-bdg, body.den-rail-collapsed .den-rail .den-pin-x {",
    "  position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden;",
    "  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }",
    // Toast (.toast)
    ".den-toast { position: fixed; bottom: 70px; left: 50%; transform: translateX(-50%);",
    "  background: var(--raised); border: 1px solid var(--border-strong); border-radius: 8px;",
    "  padding: 8px 14px; box-shadow: var(--shadow); z-index: 60; font: 14px/1.45 var(--sans);",
    "  color: var(--text); }",
    // Narrow (the prototype's 860 and 720px steps)
    "@media (max-width: 860px) { .den-k, .den-sep { display: none; } }",
    "@media (max-width: 720px) {",
    "  body.den-has-shell, body.den-has-shell.den-rail-collapsed { --den-rail-w: 0px; --den-rail-cw: 244px; }",
    "  .den-menu-btn { display: inline-flex; }",
    "  .den-rail { transform: translateX(-105%); transition: transform .18s;",
    "    box-shadow: var(--shadow); z-index: 42; }",
    "  body.den-rail-open .den-rail { transform: none; }",
    "  body.den-rail-collapsed .den-rail .den-lbl, body.den-rail-collapsed .den-rail .den-gh,",
    "  body.den-rail-collapsed .den-rail .den-bdg { position: static; width: auto; height: auto;",
    "    clip: auto; overflow: hidden; }",
    "  .den-collapse-btn { display: none; }",
    "}",
    "@media (prefers-reduced-motion: reduce) { .den-rail { transition: none; } }",
    // Names in the bar never wrap mid-word: they end in an ellipsis and
    // keep the whole name in their title.
    ".den-top .health-item, .den-top .health-app-label, .den-ws-pill { white-space: nowrap; }",
    // The health row sits in the status chip's slot, as a chip (R6 replaces
    // it with the real chip and drawer in dev.20).
    ".health { display: flex; align-items: center; gap: 10px; }",
    "#den-shell .den-top > .health { border: 1px solid var(--border); border-radius: 999px;",
    "  padding: 3px 10px; background: var(--surface); font-size: 13px; margin-left: auto; }",
    "#den-shell .den-top > .health:empty { display: none; }",
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
