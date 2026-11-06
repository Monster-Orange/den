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
 *   top bar  ☰ (narrow) · brand mark and title · the scope breadcrumb
 *            (R4, dev.18): / ORG <org> ▾ / WORKSPACE <ws> ▾ / ENV <env> ▾,
 *            each part an .ib button with a .pop menu (an ARIA menu: ↑/↓,
 *            Home, End, Enter; Escape and a click outside close it) ·
 *            the ⌘K search field (R5) · the status chip (R6) · the Runs
 *            chip (R7) · the lock chip (R8) · What's new · ◐ ▾ (R10).
 *            shell.js draws them; topbar.js (through header.js) drives the
 *            chips, the command palette (R17), the status drawer (R15) and
 *            the lock popover; appearance.js the user menu (dev.20).
 *   rail     Pinned, then the NAV registry by GROUPS (Develop, Verify,
 *            Ship, a distribution's own), then Settings and the collapse
 *            toggle. One tab stop (the current page); ↑/↓, Home and End
 *            move within it, Delete unpins a pinned row. Collapsed: icons
 *            only, the headings kept for screen readers. Below 720px it is
 *            a drawer behind ☰.
 *
 * The registries and the scope (window.denShell, the spec's NAV and GROUPS):
 *   registerGroup({ id, label, order, from? })
 *   registerNav({ id, label, icon, group, order, href, badge?(state),
 *                 when?(state) })   a non-number order warns
 *                 (console.warn); a page whose group isn't registered
 *                 waits for it, and warns only if the group is still
 *                 missing a tick after the queue has drained
 *   registerSettingsCategory({ id, label, order, description?, from? })
 *   registerSetting({ id, category, label, description, keywords, scope,
 *                 control, read, write?, keys? })   the SETTINGS registry
 *                 (R21): the Settings page (/settings) draws every row
 *                 from it. scope is "user", "workspace" or "distribution";
 *                 a distribution row is read-only (no write). Any change
 *                 fires `den:settings` on window. Each row is also a ⌘K
 *                 palette command (kind "setting", id "setting:<id>"):
 *                 Enter opens /settings?q=<label>#<category>.
 *   settings(), settingsCategories()  the registry, categories by order
 *   setNavPrefs({ hidden?, order? }), setPins(ids), setCollapsed(bool)
 *                 Navigation (R21): the rail pages hidden, their order,
 *                 the pins; saved to /api/settings `shell`
 *   addMessages(lang, { key: text }), t(key, vars)
 *   setState(partial): health { repo|address: state }, openLogs, …
 *   pin(id), unpin(id), isPinned(id): pins are user prefs (/api/settings
 *   `shell.pins`), nothing else. Any change fires `den:pins` on window
 *   (detail { pins }), and every [data-pin-toggle] repaints from it.
 *   setOrg({ id, title })            one org: a static label, no menu (C4)
 *   setOrgs([{ id, title, workspaces? }], currentId, onSelect?)
 *                                    two or more: the Org ▾ menu; a pick
 *                                    calls onSelect(id), fires `den:org`
 *   setWorkspaces({ label, title, items, focusable, onSelect, onFocus })
 *                                    the Workspace ▾ menu (header.js)
 *   syncEnv()                        repaint Env ▾ from #env-sel
 *   registerCommand({ id, label, keywords?, kind?, run })
 *                                    a ⌘K palette row (R17, dev.20). label
 *                                    is a string or a function returning
 *                                    one; keywords a string or an array;
 *                                    kind "action" (the default), "setting"
 *                                    (the Settings registry's rows, dev.19)
 *                                    or any word, shown as the row's kind
 *                                    label. Pages, services and apps are
 *                                    added by the palette itself.
 *   unregisterCommand(id), commands()
 *   openMenu(anchor, menu)           a .pop menu below anchor (the scope
 *                                    parts' and the user menu's)
 *
 * Loading before shell.js: push functions onto window.denShellQueue (an
 * array); each runs with denShell once it exists, and a later push runs at
 * once. `den-shell:ready` fires on window when the shell is up.
 *
 * Every page wraps its content in <main id="den-content">, its one main
 * landmark (the skip link's target). Its one h1 is the page's own (the
 * brand title is a span); a page without one gets a visually hidden h1
 * named from its <title>.
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
  // The page id on the body (den-page-<id>), for CSS from first paint: the
  // Graph page is Local Dev's file at /graph (R22, 0.3.0-dev.32).
  if (/^[a-z0-9-]+$/.test(page) && document.body)
    document.body.classList.add("den-page-" + page);

  // ── i18n: labels are keys; only en ships until slice 5 ─────────────────
  var MESSAGES = {
    en: {
      "g.pinned": "Pinned",
      "g.develop": "Develop",
      "g.verify": "Verify",
      "g.ship": "Ship",
      "n.local-dev": "Local Dev",
      "n.graph": "Graph",
      "n.services": "Services",
      "n.logs": "Logs",
      "n.tests": "Tests",
      "n.environments": "Environments",
      "n.releases": "Releases",
      "n.edge": "Edge",
      "n.settings": "Settings",
      "k.org": "Org",
      "k.ws": "Workspace",
      "k.env": "Env",
      "ws.all": "All active",
      "ws.focus": "focus",
      "ws.none": "No active workspaces",
      "ws.manage": "Manage workspaces…",
      "ws.setFocus": "Set {ws} as focus",
      "ws.setFocusTip":
        "Make it the default target for commands (writes workspaces.yml)",
      "org.n": "{n} workspaces",
      from: "from {d}",
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
      // The top bar (dev.20): the prototype's strings.
      "search.ph": "Search pages, services, actions…",
      "status.checking": "Checking…",
      "status.none": "No services",
      "status.unchecked": "{n} not checked",
      "status.all": "All {n} healthy",
      "status.some": "{ok}/{n} healthy",
      "status.down": "{n} down",
      "runs.title": "Runs",
      "runs.n": "{n} running",
      "runs.none": "No runs",
      "runs.empty": "Nothing has run yet. Output from any page lands here.",
      "dock.done": "done in {s}s",
      "dock.failed": "failed in {s}s",
      "dock.close": "Hide runs",
      "dock.show": "Show runs",
      "dock.copy": "Copy",
      "dock.copied": "Copied!",
      "dock.clear": "Clear",
      "dock.closeRun": "Close {s}",
      "dock.err": "failed",
      "dock.last": "Last run: {s} ↗",
      "dock.resize": "Drag to resize",
      "lock.locked": "Locked",
      "lock.unlocked": "Unlocked",
      "lock.title": "Unlock to start, stop and restart services",
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
    graph:
      '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8.2 7.2 15.6 8M7 8.4l1.6 7.2M16.4 10.2l-5.6 6"/>',
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
    edge: '<path d="M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7z"/><path d="M8 12h8M12 8v8"/>',
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
  /** A registration's `order`: a finite number, else 100 with a warning. */
  function orderOf(kind, x) {
    if (x.order === undefined) return 100;
    if (typeof x.order === "number" && isFinite(x.order)) return x.order;
    warn(
      kind +
        ' "' +
        x.id +
        '": order must be a number (got ' +
        JSON.stringify(x.order) +
        "); using 100",
    );
    return 100;
  }
  function warn(msg) {
    if (typeof console !== "undefined" && console.warn)
      console.warn("denShell: " + msg);
  }
  function hasGroup(id) {
    for (var i = 0; i < GROUPS.length; i++)
      if (GROUPS[i].id === id) return true;
    return false;
  }
  function registerGroup(g) {
    if (!g || !ID.test(g.id || "")) throw new Error("group needs an id");
    upsert(GROUPS, {
      id: g.id,
      label: g.label || g.id,
      order: orderOf("group", g),
      from: g.from || null,
    });
    renderRail();
  }
  function registerNav(n) {
    if (!n || !ID.test(n.id || "") || !n.href || !n.group)
      throw new Error("a page needs an id, an href and a group");
    // A page whose group isn't registered yet is kept, and shows when the
    // group arrives (registerGroup re-renders). Registering a page before
    // its group is a legitimate order (a queue, two scripts), so the
    // warning waits until the queue has drained and a tick has passed.
    upsert(NAV, {
      id: n.id,
      label: n.label || n.id,
      icon: n.icon || "page",
      group: n.group,
      order: orderOf("nav", n),
      href: n.href,
      badge: typeof n.badge === "function" ? n.badge : null,
      when: typeof n.when === "function" ? n.when : null,
      from: n.from || null,
    });
    checkOrphansSoon();
    renderRail();
  }

  // ── orphans: a page or setting whose group or category never came ────
  var settled = false;
  var orphanTimer = null;
  var warnedOrphan = {};
  function checkOrphansSoon() {
    if (!settled || orphanTimer) return;
    orphanTimer = setTimeout(function () {
      orphanTimer = null;
      checkOrphans();
    }, 0);
  }
  function checkOrphans() {
    NAV.forEach(function (n) {
      var key = "nav:" + n.id + ":" + n.group;
      if (hasGroup(n.group) || warnedOrphan[key]) return;
      warnedOrphan[key] = true;
      warn(
        'nav "' +
          n.id +
          '": group "' +
          n.group +
          '" is not registered; the page shows once it is',
      );
    });
    SETTING_ROWS.forEach(function (r) {
      var key = "setting:" + r.id + ":" + r.category;
      if (hasCategory(r.category) || warnedOrphan[key]) return;
      warnedOrphan[key] = true;
      warn(
        'setting "' +
          r.id +
          '": category "' +
          r.category +
          '" is not registered; the row shows once it is',
      );
    });
  }

  // ── SETTINGS (R21): what the Settings page draws, row by row ──────────
  // A category: { id, label, order, description?, from? }. A row: { id,
  // category, label, description, keywords, scope: user|workspace|
  // distribution, control: { type, … }, read(ctx), write?(value, ctx),
  // keys? } (keys: the /api/settings keys it stores, for the inventory).
  var SETTING_CATS = [];
  var SETTING_ROWS = [];
  var SETTING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  var SCOPES = ["user", "workspace", "distribution"];
  function hasCategory(id) {
    for (var i = 0; i < SETTING_CATS.length; i++)
      if (SETTING_CATS[i].id === id) return true;
    return false;
  }
  function settingsChanged() {
    try {
      window.dispatchEvent(new CustomEvent("den:settings"));
    } catch (e) {
      /* no CustomEvent: the page re-reads on its own */
    }
  }
  function registerSettingsCategory(c) {
    if (!c || !ID.test(c.id || ""))
      throw new Error("a settings category needs an id");
    upsert(SETTING_CATS, {
      id: c.id,
      label: c.label || c.id,
      order: orderOf("settings category", c),
      description: c.description || "",
      from: c.from || null,
    });
    settingsChanged();
  }
  function registerSetting(r) {
    if (!r || !SETTING_ID.test(r.id || "") || !r.category || !r.label)
      throw new Error(
        'setting "' +
          (r && r.id) +
          '": a setting needs an id ([A-Za-z0-9._-]), a category and a label',
      );
    var scope = r.scope || "user";
    if (SCOPES.indexOf(scope) < 0)
      throw new Error(
        'setting "' + r.id + '": scope must be user, workspace or distribution',
      );
    if (typeof r.read !== "function")
      throw new Error('setting "' + r.id + '" needs read(ctx)');
    // The distribution's own config is tracked: shown, never written.
    if (scope === "distribution" && r.write)
      throw new Error(
        'setting "' +
          r.id +
          '": a distribution setting is read-only (no write)',
      );
    upsert(SETTING_ROWS, {
      id: r.id,
      category: r.category,
      label: r.label,
      description: r.description || "",
      keywords: Array.isArray(r.keywords) ? r.keywords.slice() : [],
      scope: scope,
      control: r.control || { type: "readonly" },
      read: r.read,
      write: typeof r.write === "function" ? r.write : null,
      keys: Array.isArray(r.keys) ? r.keys.slice() : [],
      order: orderOf("setting", r),
      from: r.from || null,
    });
    settingCommand(r);
    checkOrphansSoon();
    settingsChanged();
  }

  // ── the ⌘K palette's commands (R17, dev.20) ────────────────────────────
  // Pages, services and apps are the palette's own (topbar.js); this holds
  // what a page, a distribution or a plugin adds: actions, and the
  // Settings registry's rows (kind "setting", dev.19).
  var COMMANDS = [];
  function registerCommand(c) {
    if (!c || typeof c.id !== "string" || !c.id || typeof c.run !== "function")
      throw new Error("a command needs an id and a run()");
    if (c.label == null)
      throw new Error('command "' + c.id + '" needs a label');
    upsert(COMMANDS, {
      id: c.id,
      label: c.label,
      keywords: Array.isArray(c.keywords)
        ? c.keywords.slice()
        : c.keywords
          ? [String(c.keywords)]
          : [],
      kind: typeof c.kind === "string" && c.kind ? c.kind : "action",
      run: c.run,
      from: c.from || null,
    });
  }
  function unregisterCommand(id) {
    for (var i = COMMANDS.length - 1; i >= 0; i--)
      if (COMMANDS[i].id === id) COMMANDS.splice(i, 1);
  }
  /**
   * Every SETTINGS row is a palette row too (kind "setting"): Enter opens
   * the Settings page searched for it, at its category
   * (/settings?q=<label>#<category>).
   */
  function settingCommand(r) {
    var cat = r.category;
    registerCommand({
      id: "setting:" + r.id,
      label: r.label,
      keywords: (Array.isArray(r.keywords) ? r.keywords : []).concat([
        cat,
        "settings",
      ]),
      kind: "setting",
      run: function () {
        location.assign(
          "/settings?q=" +
            encodeURIComponent(r.label) +
            "#" +
            encodeURIComponent(cat),
        );
      },
      from: r.from || null,
    });
  }
  /** The registered commands, labels resolved (a label may be a function). */
  function commands() {
    return COMMANDS.map(function (c) {
      var label = c.label;
      if (typeof label === "function") {
        try {
          label = label();
        } catch (e) {
          label = c.id;
        }
      }
      return {
        id: c.id,
        label: String(label),
        keywords: c.keywords.slice(),
        kind: c.kind,
        run: c.run,
        from: c.from,
      };
    });
  }

  // ── state: what badges, when() and the pinned dots read ───────────────
  var LS = "__DEN_CLI__-shell";
  var state = {
    health: {},
    down: 0,
    openLogs: 0,
    pins: [],
    collapsed: false,
    hidden: [],
    order: [],
    // The runs dock (R16a): open or collapsed to its bar, and its height
    // (0: the prototype's 170px). User prefs, like the pins.
    dock: false,
    dockHeight: 0,
    // Whether the edge is configured (the Edge page's when): null until
    // known, the last answer cached so the rail doesn't jump.
    edge: null,
  };
  try {
    var cached = JSON.parse(localStorage.getItem(LS) || "{}");
    if (typeof cached.edge === "boolean") state.edge = cached.edge;
    if (Array.isArray(cached.pins)) state.pins = cached.pins;
    state.collapsed = cached.collapsed === true;
    if (Array.isArray(cached.hidden)) state.hidden = cached.hidden;
    if (Array.isArray(cached.order)) state.order = cached.order;
    state.dock = cached.dock === true;
    if (typeof cached.dockHeight === "number")
      state.dockHeight = cached.dockHeight;
  } catch (e) {
    /* no storage: the server's copy arrives below */
  }
  function remember() {
    try {
      localStorage.setItem(
        LS,
        JSON.stringify({
          pins: state.pins,
          collapsed: state.collapsed,
          hidden: state.hidden,
          order: state.order,
          dock: state.dock,
          dockHeight: state.dockHeight,
          edge: state.edge,
        }),
      );
    } catch (e) {
      /* a convenience only */
    }
  }
  function setState(partial) {
    var before = state.pins.join("\n");
    for (var k in partial)
      if (Object.prototype.hasOwnProperty.call(partial, k))
        state[k] = partial[k];
    applyCollapsed();
    renderRail();
    if (state.pins.join("\n") !== before) pinsChanged();
  }
  /**
   * Any pin change (the rail's ×, Delete, a page's toggle, the server's
   * prefs arriving) is one event, `den:pins` on window, and every pin
   * toggle on the page ([data-pin-toggle]) repaints from it.
   */
  function pinsChanged() {
    if (typeof window.dispatchEvent !== "function") return;
    var detail = { pins: state.pins.slice() };
    var ev;
    try {
      ev = new CustomEvent("den:pins", { detail: detail });
    } catch (e) {
      return;
    }
    window.dispatchEvent(ev);
  }
  if (typeof window.addEventListener === "function")
    window.addEventListener("den:pins", function () {
      syncPinToggles(document);
    });
  /** A pin toggle's look for its id: ★ "Unpin x" pressed, or ☆ "Pin x". */
  function syncPinToggles(root) {
    if (!root || !root.querySelectorAll) return;
    var btns = root.querySelectorAll("[data-pin-toggle]");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var id = b.getAttribute("data-pin-toggle");
      var on = isPinned(id);
      var label = (on ? "Unpin" : "Pin") + " " + id;
      b.textContent = on ? "★" : "☆";
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.setAttribute("aria-label", label);
      b.title = label;
    }
  }
  function saveShell(patch) {
    remember();
    if (typeof fetch !== "function") return Promise.resolve();
    return fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shell: patch }),
    })
      .then(function (r) {
        return r && r.ok !== false;
      })
      .catch(function () {
        return false;
      });
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
  function ids(list) {
    return (Array.isArray(list) ? list : []).filter(function (x, i, all) {
      return typeof x === "string" && all.indexOf(x) === i;
    });
  }
  /** Navigation (R21): the pages the rail hides and their order. */
  function setNavPrefs(prefs) {
    var patch = {};
    if (prefs && prefs.hidden !== undefined) patch.hidden = ids(prefs.hidden);
    if (prefs && prefs.order !== undefined) patch.order = ids(prefs.order);
    setState(patch);
    return saveShell(patch);
  }
  /** The pins, in this order (the Settings page's Pinned row). */
  function setPins(list) {
    setState({ pins: ids(list) });
    return saveShell({ pins: state.pins });
  }
  function setCollapsed(on) {
    setState({ collapsed: !!on });
    return saveShell({ collapsed: state.collapsed });
  }
  /** The runs dock open or collapsed to its bar (R16a), remembered. */
  function setDock(on) {
    dockOpen = !!on;
    renderDock();
    return rememberDock();
  }
  /** NAV pages in the rail's order: groups by order, then yours, then theirs. */
  function orderedNav() {
    var rank = function (id) {
      var i = state.order.indexOf(id);
      return i < 0 ? Infinity : i;
    };
    var gs = GROUPS.slice().sort(byOrder);
    var out = [];
    gs.forEach(function (g) {
      NAV.filter(function (n) {
        return n.group === g.id;
      })
        .sort(function (a, b) {
          return rank(a.id) - rank(b.id) || byOrder(a, b);
        })
        .forEach(function (n) {
          out.push(n);
        });
    });
    return out;
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

  // ── menus (.pop, R18): the scope parts' popovers ─────────────────────
  // A menu is { label, items: [{ heading } | { hr: true } | { label, tag?,
  // checked?, href?, onSelect? }] }. Rows with `checked` are radios (✓ when
  // checked). Keyboard: ↑/↓ (wrapping), Home and End move; Enter or Space
  // picks; Escape and Tab close and give focus back to the button; a click
  // outside closes.
  var openPop = null;
  function closeMenu(refocus) {
    if (!openPop) return;
    var o = openPop;
    openPop = null;
    if (o.el.remove) o.el.remove();
    o.anchor.setAttribute("aria-expanded", "false");
    // aria-controls names the menu only while it exists.
    o.anchor.removeAttribute("aria-controls");
    if (refocus && o.anchor.focus) o.anchor.focus();
  }
  function menuRows(pop) {
    return Array.prototype.slice.call(pop.querySelectorAll(".den-mi"));
  }
  function openMenu(anchor, menu) {
    var again = openPop && openPop.anchor === anchor;
    closeMenu(false);
    if (again || !menu) return;
    var pop = document.createElement("div");
    pop.className = "den-pop";
    pop.tabIndex = -1;
    pop.id = "den-pop-" + (anchor.dataset.scope || "menu");
    pop.setAttribute("role", "menu");
    pop.setAttribute("aria-label", menu.label);
    var html = "";
    var acts = [];
    (menu.items || []).forEach(function (it) {
      if (it.heading != null)
        html +=
          '<div class="den-ml" aria-hidden="true">' +
          esc(it.heading) +
          "</div>";
      else if (it.hr) html += '<div class="den-hr" role="separator"></div>';
      // A line of text (a notice), and an empty slot a later build fills
      // (the user menu's Language, dev.23).
      else if (it.note != null)
        html += '<p class="den-mnote" role="status">' + esc(it.note) + "</p>";
      else if (it.slot != null)
        html +=
          '<div class="den-mslot" data-slot="' +
          esc(it.slot) +
          '"' +
          (it.hidden ? " hidden" : "") +
          "></div>";
      else {
        var radio = it.checked != null;
        var tag = it.href ? "a" : "button";
        html +=
          "<" +
          tag +
          ' class="den-mi" tabindex="-1" data-i="' +
          acts.length +
          '" role="' +
          (radio ? "menuitemradio" : "menuitem") +
          '"' +
          (radio
            ? ' aria-checked="' + (it.checked ? "true" : "false") + '"'
            : "") +
          (it.href ? ' href="' + esc(it.href) + '"' : ' type="button"') +
          (it.title ? ' title="' + esc(it.title) + '"' : "") +
          // With a tag, the name is "default, focus" (the tag's text would
          // run into the label: "defaultfocus").
          (it.tag
            ? ' aria-label="' + esc(it.label + ", " + it.tag) + '"'
            : "") +
          '><span class="den-mi-l">' +
          esc(it.label) +
          "</span>" +
          (it.tag
            ? '<span class="den-mtag" aria-hidden="true">' +
              esc(it.tag) +
              "</span>"
            : "") +
          "</" +
          tag +
          ">";
        acts.push(it);
      }
    });
    pop.innerHTML = html;
    document.body.appendChild(pop);
    openPop = { el: pop, anchor: anchor };
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", pop.id);
    var r = anchor.getBoundingClientRect();
    var w = pop.offsetWidth;
    pop.style.top = r.bottom + 6 + "px";
    pop.style.left =
      Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
    pop.addEventListener("click", function (e) {
      var row = e.target.closest ? e.target.closest(".den-mi") : null;
      if (!row) return;
      var it = acts[+row.getAttribute("data-i")];
      if (!it.href) e.preventDefault();
      closeMenu(true);
      if (it.onSelect) it.onSelect(it);
    });
    pop.addEventListener("keydown", function (e) {
      var rows = menuRows(pop);
      var i = rows.indexOf(document.activeElement);
      var next =
        e.key === "ArrowDown"
          ? (i + 1) % rows.length
          : e.key === "ArrowUp"
            ? (i - 1 + rows.length) % rows.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? rows.length - 1
                : -1;
      if (next >= 0 && rows.length) {
        e.preventDefault();
        rows[next].focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      } else if (e.key === "Tab") closeMenu(true);
      else if (e.key === " " && rows[i] && rows[i].tagName === "A") {
        e.preventDefault();
        rows[i].click();
      }
    });
    var rows = menuRows(pop);
    var first = pop.querySelector('.den-mi[aria-checked="true"]') || rows[0];
    if (first) first.focus();
    else pop.focus();
  }
  document.addEventListener("mousedown", function (e) {
    if (!openPop) return;
    var tg = e.target;
    if (openPop.el.contains(tg) || openPop.anchor.contains(tg)) return;
    closeMenu(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openPop) closeMenu(true);
  });
  window.addEventListener("resize", function () {
    closeMenu(false);
  });

  /** A page's href from the NAV registry (Local Dev manages workspaces). */
  function navHref(id) {
    for (var i = 0; i < NAV.length; i++)
      if (NAV[i].id === id) return NAV[i].href;
    return "/";
  }
  /** A scope part: <button class="den-ib"><k>Key</k> value ▾</button>. */
  function scopeButton(id, scope, key, value, hidden) {
    return (
      '<button type="button" id="' +
      id +
      '" class="den-ib den-scope-btn" data-scope="' +
      scope +
      '" aria-haspopup="menu" aria-expanded="false"' +
      (hidden ? " hidden" : "") +
      '><span class="den-k">' +
      esc(key) +
      '</span> <span class="den-v"><span class="den-vn">' +
      esc(value) +
      '</span> <span aria-hidden="true">▾</span></span></button>'
    );
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
    // Den's overview: the workspaces, their actions and their graph.
    {
      id: "local-dev",
      label: "n.local-dev",
      icon: "overview",
      group: "develop",
      order: 10,
      href: "/local-dev",
    },
    // The Graph page (R22, 0.3.0-dev.32, Ward 2026-11-05): the graph alone,
    // full width, after Local Dev as the prototype orders them.
    {
      id: "graph",
      label: "n.graph",
      icon: "graph",
      group: "develop",
      order: 15,
      href: "/graph",
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
    // The Edge page (PL-SPEC §10): only once /api/edge says the edge is
    // configured (state.edge, from /api/edge?probe=1 below).
    {
      id: "edge",
      label: "n.edge",
      icon: "edge",
      group: "ship",
      order: 30,
      href: "/edge",
      when: function (s) {
        return s.edge === true;
      },
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
      when: n.when || null,
      from: null,
    });
  });
  // The Settings page (R21): every setting, from the SETTINGS registry.
  var SETTINGS = {
    id: "settings",
    label: "n.settings",
    icon: "settings",
    href: "/settings",
  };

  // ── the frame ──────────────────────────────────────────────────────────
  // The top bar after the scope, in the prototype's order (dev.20): the ⌘K
  // search field (R5), then .chips: status (R6), Runs (R7), the lock (R8),
  // What's new (R9) and ◐ ▾ (R10, appearance.js fills #den-user). The
  // chips start neutral ("Checking…", "Runs", "Locked") and topbar.js
  // paints them: a cold load never shows a partial red.
  var chips =
    '<button type="button" class="den-search" id="den-search" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" aria-label="' +
    esc(t("search.ph")) +
    '"><span class="den-search-ph">' +
    esc(t("search.ph")) +
    '</span><kbd aria-hidden="true">⌘K</kbd><span class="den-search-ic" aria-hidden="true">⌕</span></button>' +
    '<div class="den-chips">' +
    '<button type="button" class="den-chip" id="den-status" aria-haspopup="dialog" aria-expanded="false" aria-busy="true">' +
    '<span class="den-dot off" aria-hidden="true"></span><span class="den-n">' +
    esc(t("status.checking")) +
    "</span></button>" +
    '<button type="button" class="den-chip" id="den-runs">' +
    '<span class="den-dot off" aria-hidden="true"></span><span class="den-n den-lbl-l">' +
    esc(t("runs.title")) +
    "</span></button>" +
    '<button type="button" class="den-chip" id="den-lock" aria-haspopup="dialog" aria-expanded="false" title="' +
    esc(t("lock.title")) +
    '"><span class="den-lock-ic" aria-hidden="true">🔒</span><span class="den-lbl-l">' +
    esc(t("lock.locked")) +
    "</span></button>" +
    '<button class="den-ib v-pill" id="version-pill" onclick="openChangelog()" title="View changelog">' +
    '<span class="v-txt">v…</span><span class="v-pip" id="v-pip"></span></button>' +
    '<span class="den-user" id="den-user"></span>' +
    "</div>";
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
    // The brand is a name, not a heading: the page's own h1 is its one.
    '<span class="den-title">__DEN_CLI__</span></a>' +
    // The prototype's scope breadcrumb (R4): / ORG <org> ▾ / WORKSPACE
    // <ws> ▾ / ENV <env> ▾. Each part is an .ib button with a .pop menu.
    // The org is a static label while there is one org (ORG-SPEC C4) and
    // hidden until header.js knows it; the workspace part is hidden until
    // header.js knows the workspaces. #env-sel stays as the env's value
    // (pages read it and listen for its change): the Env menu drives it.
    '<div class="den-scope" role="group" aria-label="Scope">' +
    '<span class="den-sep" aria-hidden="true">/</span>' +
    '<span id="org-crumb" class="den-ib den-org den-opt" hidden><span class="den-k">' +
    esc(t("k.org")) +
    '</span> <span class="den-org-name"></span></span>' +
    '<span class="den-sep den-org-sep" aria-hidden="true" hidden>/</span>' +
    scopeButton("ws-pill", "ws", t("k.ws"), "", true) +
    '<span class="den-sep den-ws-sep" aria-hidden="true" hidden>/</span>' +
    scopeButton("env-btn", "env", t("k.env"), "local", false) +
    '<select id="env-sel" hidden aria-hidden="true" tabindex="-1"><option value="local">local</option></select>' +
    "</div>" +
    chips +
    "</header>" +
    '<nav class="den-rail" id="den-rail" aria-label="' +
    esc(t("pages")) +
    '"></nav>';

  var nav = host.querySelector(".den-rail");

  // ── the scope parts (R4) ───────────────────────────────────────────────
  // Each part's menu comes from its model, set by header.js: setOrgs (the
  // org menu, only with two or more orgs), setWorkspaces (the view scope),
  // and the env from #env-sel's options. Choosing never starts, stops or
  // routes anything: the callbacks only store a preference.
  var scopeMenus = {
    org: null,
    ws: null,
    env: function () {
      var sel = document.getElementById("env-sel");
      if (!sel) return null;
      var items = [{ heading: t("k.env") }];
      Array.prototype.forEach.call(sel.options, function (o) {
        items.push({
          label: o.textContent,
          checked: o.value === sel.value,
          onSelect: function () {
            if (sel.value === o.value) return;
            sel.value = o.value;
            syncEnv();
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          },
        });
      });
      return { label: t("k.env"), items: items };
    },
  };
  function scopeMenu(kind) {
    var m = scopeMenus[kind];
    return typeof m === "function" ? m() : m;
  }
  host.addEventListener("click", function (e) {
    var b = e.target.closest ? e.target.closest("[data-scope]") : null;
    if (!b || b.tagName !== "BUTTON") return;
    openMenu(b, scopeMenu(b.dataset.scope));
  });
  host.addEventListener("keydown", function (e) {
    var b = e.target.closest ? e.target.closest("[data-scope]") : null;
    if (!b || b.tagName !== "BUTTON") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!openPop || openPop.anchor !== b)
        openMenu(b, scopeMenu(b.dataset.scope));
      if (e.key === "ArrowUp" && openPop) {
        var rows = menuRows(openPop.el);
        if (rows.length) rows[rows.length - 1].focus();
      }
    }
  });
  function setValue(btn, value, title) {
    if (!btn) return;
    btn.querySelector(".den-vn").textContent = value;
    if (title != null) btn.title = title;
  }
  /** The Env part's value: what #env-sel holds now. */
  function syncEnv() {
    var sel = document.getElementById("env-sel");
    if (sel) setValue(document.getElementById("env-btn"), sel.value);
  }
  var envSel = document.getElementById("env-sel");
  if (envSel) envSel.addEventListener("change", syncEnv);

  /** One org: "/ ORG <title>" as a static label, no ▾ (C4). */
  function setOrg(org) {
    var el = document.getElementById("org-crumb");
    if (!el || !org || !org.title) return false;
    if (el.tagName === "BUTTON") {
      var span = document.createElement("span");
      span.id = "org-crumb";
      span.className = "den-ib den-org den-opt";
      span.innerHTML =
        '<span class="den-k">' +
        esc(t("k.org")) +
        '</span> <span class="den-org-name"></span>';
      el.replaceWith(span);
      el = span;
    }
    scopeMenus.org = null;
    el.querySelector(".den-org-name").textContent = org.title;
    el.title = "Org: " + org.title + (org.id ? " (" + org.id + ")" : "");
    el.hidden = false;
    var sep = el.nextElementSibling;
    if (sep && sep.classList.contains("den-org-sep")) sep.hidden = false;
    return true;
  }
  /**
   * The orgs that own workspaces (ORG-1b plugs /api/orgs in here). Fewer
   * than two: the static label (C4). Two or more: an Org ▾ menu; picking
   * one calls onSelect(id) and fires `den:org` on window. No backend.
   */
  function setOrgs(orgs, current, onSelect) {
    var list = (Array.isArray(orgs) ? orgs : []).filter(function (o) {
      return o && o.id;
    });
    var cur = null;
    for (var i = 0; i < list.length; i++)
      if (list[i].id === current) cur = list[i];
    cur = cur || list[0];
    var title = function (o) {
      return o.title || o.label || o.id;
    };
    if (list.length < 2)
      return cur ? setOrg({ id: cur.id, title: title(cur) }) : false;
    var el = document.getElementById("org-crumb");
    if (!el) return false;
    if (el.tagName !== "BUTTON") {
      var tmp = document.createElement("span");
      tmp.innerHTML = scopeButton("org-crumb", "org", t("k.org"), "", false);
      var btn = tmp.firstChild;
      btn.className += " den-org den-opt";
      btn.querySelector(".den-vn").className += " den-org-name";
      el.replaceWith(btn);
      el = btn;
    }
    el.hidden = false;
    setValue(el, title(cur), "Org: " + title(cur) + " (" + cur.id + ")");
    var sep = el.nextElementSibling;
    if (sep && sep.classList.contains("den-org-sep")) sep.hidden = false;
    scopeMenus.org = {
      label: t("k.org"),
      items: [{ heading: t("k.org") }].concat(
        list.map(function (o) {
          return {
            label: title(o),
            checked: o.id === cur.id,
            tag:
              typeof o.workspaces === "number"
                ? t("org.n", { n: o.workspaces })
                : null,
            onSelect: function () {
              if (o.id === cur.id) return;
              setOrgs(list, o.id, onSelect);
              if (typeof onSelect === "function") onSelect(o.id);
              try {
                window.dispatchEvent(
                  new CustomEvent("den:org", { detail: { id: o.id } }),
                );
              } catch (e) {
                /* no CustomEvent: the callback has it */
              }
            },
          };
        }),
      ),
    };
    return true;
  }
  /**
   * The Workspace part: { label, title, items: [{ value, label, checked,
   * focused, title? }], onSelect(value) }. "All active" and the active
   * workspaces, the focused one marked; then, apart, "Set <ws> as focus"
   * (model.focusable, model.onFocus(name)) and a link to manage them.
   */
  function setWorkspaces(model) {
    var btn = document.getElementById("ws-pill");
    if (!btn) return;
    var sep = btn.nextElementSibling;
    if (!model) {
      btn.hidden = true;
      if (sep) sep.hidden = true;
      scopeMenus.ws = null;
      return;
    }
    setValue(btn, model.label, model.title || null);
    btn.hidden = false;
    if (sep) sep.hidden = false;
    var items = [{ heading: t("k.ws") }];
    if (!model.items || !model.items.length)
      items.push({ label: t("ws.none"), href: navHref("local-dev") });
    (model.items || []).forEach(function (it) {
      items.push({
        label: it.label,
        checked: !!it.checked,
        tag: it.focused ? t("ws.focus") : null,
        title: it.title || null,
        onSelect: function () {
          if (!it.checked && typeof model.onSelect === "function")
            model.onSelect(it.value);
        },
      });
    });
    items.push({ hr: true });
    // Focus is a separate action (it writes workspaces.yml and retargets
    // the CLI); picking a view above never moves it.
    if (model.focusable && typeof model.onFocus === "function")
      items.push({
        label: t("ws.setFocus", { ws: model.focusable }),
        title: t("ws.setFocusTip"),
        onSelect: function () {
          model.onFocus(model.focusable);
        },
      });
    items.push({ label: t("ws.manage"), href: navHref("local-dev") });
    scopeMenus.ws = { label: t("k.ws"), items: items };
  }

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
      '"' +
      (from ? ' aria-describedby="den-gd-' + esc(id) + '"' : "") +
      // The name is the label alone ("Acme", not "Acmeacme"): the tag is
      // in the description ("from acme").
      '><div class="den-gh"><span id="den-gh-' +
      esc(id) +
      '">' +
      esc(label) +
      "</span>" +
      (from
        ? '<span class="den-tagx" aria-hidden="true" title="' +
          esc(t("from", { d: from })) +
          '">' +
          esc(from) +
          "</span>"
        : "") +
      "</div>" +
      (from
        ? '<span class="den-sr" id="den-gd-' +
          esc(id) +
          '">' +
          esc(t("from", { d: from })) +
          "</span>"
        : "") +
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
            // The row is the link (named by the id alone, Delete unpins
            // it); the × beside it is its own control, out of the tab
            // order, named "Unpin <id>", its glyph hidden from readers.
            return (
              '<div class="den-pin-row">' +
              item(
                {
                  id: "pin-" + p,
                  href: pinHref(p),
                  title: p,
                  lead: healthDot(p),
                  mono: true,
                },
                false,
                // Holds the ×'s place in the row, as in the prototype.
                '<span class="den-pin-sp" aria-hidden="true">×</span>',
                ' data-pin="' + esc(p) + '" aria-keyshortcuts="Delete"',
              ) +
              '<button type="button" class="den-pin-x" tabindex="-1" data-unpin="' +
              esc(p) +
              '" aria-label="' +
              esc(t("act.unpin") + " " + p) +
              '" title="' +
              esc(t("act.unpin")) +
              '"><span aria-hidden="true">×</span></button></div>'
            );
          })
          .join(""),
      );
    var ordered = orderedNav();
    GROUPS.slice()
      .sort(byOrder)
      .forEach(function (g) {
        var items = ordered.filter(function (n) {
          return (
            n.group === g.id &&
            state.hidden.indexOf(n.id) < 0 &&
            (!n.when || n.when(state))
          );
        });
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
      page === SETTINGS.id,
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

  /**
   * Unpin from the rail (Delete on a pinned row, or its ×) and keep focus
   * in the rail: the next pinned row, else the previous one, else the
   * first item. One rule for both paths.
   */
  function unpinFromRail(pinId) {
    var pins = Array.prototype.slice.call(
      nav.querySelectorAll(".den-ni[data-pin]"),
    );
    var at = -1;
    for (var k = 0; k < pins.length; k++)
      if (pins[k].dataset.pin === pinId) at = k;
    var to = at < 0 ? null : pins[at + 1] || pins[at - 1] || null;
    var toNav = to ? to.dataset.nav : null;
    unpin(pinId);
    var dest =
      (toNav && nav.querySelector('[data-nav="' + toNav + '"]')) ||
      nav.querySelector(".den-ni");
    if (!dest) return;
    Array.prototype.forEach.call(nav.querySelectorAll(".den-ni"), function (a) {
      a.tabIndex = a === dest ? 0 : -1;
    });
    dest.focus();
  }

  // ↑/↓, Home and End move along the rail; Tab still leaves it (except
  // in the narrow drawer, a modal: Tab stays inside).
  nav.addEventListener("keydown", function (e) {
    if (e.key === "Tab" && drawerOpen()) {
      e.preventDefault();
      return;
    }
    var links = Array.prototype.slice.call(nav.querySelectorAll(".den-ni"));
    var i = links.indexOf(document.activeElement);
    if (i < 0) return;
    var pinId =
      links[i].dataset && links[i].dataset.pin ? links[i].dataset.pin : null;
    if (pinId && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      unpinFromRail(pinId);
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
      unpinFromRail(x.getAttribute("data-unpin"));
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

  // ☰ opens the rail as a drawer below 720px: a modal overlay. Focus
  // moves into the rail (the current item); the top bar and the page are
  // inert behind a scrim; Escape or the scrim closes it and focus goes back
  // to ☰; Tab stays inside.
  var menu = host.querySelector(".den-menu-btn");
  var scrim = null;
  function drawerOpen() {
    return document.body.classList.contains("den-rail-open");
  }
  function setInert(on) {
    var els = [
      host.querySelector(".den-top"),
      document.getElementById("den-content"),
      document.getElementById("den-dock"),
    ];
    els.forEach(function (el) {
      if (!el) return;
      if (on) el.setAttribute("inert", "");
      else el.removeAttribute("inert");
    });
  }
  function openDrawer() {
    document.body.classList.add("den-rail-open");
    if (menu) menu.setAttribute("aria-expanded", "true");
    nav.setAttribute("role", "dialog");
    nav.setAttribute("aria-modal", "true");
    if (!scrim) {
      scrim = document.createElement("div");
      scrim.className = "den-scrim";
      scrim.addEventListener("click", function () {
        closeDrawer(true);
      });
    }
    document.body.appendChild(scrim);
    setInert(true);
    var stop =
      nav.querySelector('.den-ni[aria-current="page"]') ||
      nav.querySelector('.den-ni[tabindex="0"]') ||
      nav.querySelector(".den-ni");
    if (stop) stop.focus();
  }
  function closeDrawer(refocus) {
    if (!drawerOpen()) return;
    document.body.classList.remove("den-rail-open");
    if (menu) menu.setAttribute("aria-expanded", "false");
    nav.removeAttribute("role");
    nav.removeAttribute("aria-modal");
    if (scrim && scrim.remove) scrim.remove();
    setInert(false);
    if (refocus && menu) menu.focus();
  }
  if (menu)
    menu.addEventListener("click", function () {
      if (drawerOpen()) closeDrawer(true);
      else openDrawer();
    });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && drawerOpen() && !openPop) {
      e.preventDefault();
      closeDrawer(true);
    }
  });
  // Wider than the drawer's step: the rail is a rail again.
  window.addEventListener("resize", function () {
    if (drawerOpen() && window.innerWidth > 720) closeDrawer(false);
  });

  // ── the page header (R20, 0.3.0-dev.32) ──────────────────────────────
  // One h1 per page, the page's own (the brand is not a heading). A page
  // whose content has none gets the prototype's page header (.ph): the h1,
  // named from its rail entry or its <title> ("__DEN_TITLE__ · Services" →
  // Services), and a 13px muted sub line with the scope ("org / ws / env",
  // kept in step with the top bar's scope). A page adds its primary action
  // with denShell.pageHeader().act and its tabs below it with .tabs (both
  // empty until a page fills them). Settings and Edge draw their own.
  var ph = null;
  function scopeText() {
    var parts = [];
    var org = document.getElementById("org-crumb");
    if (org && !org.hidden) {
      var on =
        org.querySelector(".den-org-name") || org.querySelector(".den-vn");
      if (on && on.textContent) parts.push(on.textContent);
    }
    var over = (ph && ph.over) || {};
    [
      ["ws-pill", over.ws],
      ["env-btn", over.env],
    ].forEach(function (p) {
      if (p[1]) return parts.push(p[1]);
      var b = document.getElementById(p[0]);
      var v = b && !b.hidden ? b.querySelector(".den-vn") : null;
      if (v && v.textContent) parts.push(v.textContent);
    });
    return parts.join(" / ");
  }
  function paintPageSub() {
    if (!ph || ph.subFixed) return;
    var text = scopeText();
    if (ph.sub.textContent !== text) ph.sub.textContent = text;
  }
  function ensurePageHeader() {
    var main = document.getElementById("den-content");
    if (!main || main.querySelector("h1")) return;
    var label = "";
    NAV.forEach(function (n) {
      if (n.id === page) label = t(n.label);
    });
    if (!label) {
      var title = String(document.title || "");
      label = title.indexOf(" · ") >= 0 ? title.split(" · ").pop() : "";
    }
    if (!label) return;
    var el = document.createElement("div");
    el.className = "ph den-ph";
    el.innerHTML =
      '<div class="den-ph-h"><h1></h1><div class="sub"></div></div>' +
      '<div class="act" hidden></div>';
    el.querySelector("h1").textContent = label;
    main.insertBefore(el, main.firstChild);
    ph = {
      el: el,
      h1: el.querySelector("h1"),
      sub: el.querySelector(".sub"),
      act: el.querySelector(".act"),
      tabs: null,
      subFixed: false,
      over: null,
    };
    paintPageSub();
    var scope = host.querySelector(".den-scope");
    if (scope && typeof MutationObserver === "function")
      new MutationObserver(paintPageSub).observe(scope, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["hidden"],
      });
  }
  // ── tabs: the WAI-ARIA tabs pattern, one helper (0.3.0-dev.33) ────────
  // Every page tablist (Local Dev's workspace tabs, a page header's tabs)
  // is wired here: one tab stop (the selected tab is tabindex 0, the rest
  // -1); ←/→ move and wrap, Home and End go to the ends, and each selects
  // as it moves (automatic activation); a click selects. Each tab has
  // aria-controls naming its role=tabpanel, which has aria-labelledby back
  // to the tab, and only the selected tab's panel shows.
  var tabSeq = 0;
  function tabIdOf(el, stem) {
    if (!el.id) el.id = "den-" + stem + "-" + ++tabSeq;
    return el.id;
  }
  /**
   * Wire `list` (an element with role=tablist) as tabs. opts:
   *   panelOf(tab)    its panel (default: the element its aria-controls
   *                   names)
   *   onSelect(tab)   after a tab is selected (by click or key)
   *   selected        the tab (or its index) to select first (default:
   *                   the one with aria-selected="true", else the first)
   * Returns { select(tabOrIndex, focus?), selected(), tabs() }. Wiring the
   * same list again replaces the old wiring.
   */
  function wireTabs(list, opts) {
    opts = opts || {};
    if (!list) return null;
    if (list._denTabs) list._denTabs.off();
    list.setAttribute("role", "tablist");
    function tabs() {
      return Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    }
    function panelOf(tab) {
      if (typeof opts.panelOf === "function") return opts.panelOf(tab);
      var id = tab.getAttribute("aria-controls");
      return id ? document.getElementById(id) : null;
    }
    tabs().forEach(function (tab) {
      var panel = panelOf(tab);
      tabIdOf(tab, "tab");
      if (!panel) return;
      tab.setAttribute("aria-controls", tabIdOf(panel, "tabpanel"));
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
    });
    function indexOf(t) {
      return typeof t === "number" ? t : tabs().indexOf(t);
    }
    function paint(i) {
      tabs().forEach(function (tab, j) {
        var on = j === i;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.setAttribute("tabindex", on ? "0" : "-1");
        tab.classList.toggle("active", on);
        var panel = panelOf(tab);
        if (panel) {
          panel.hidden = !on;
          panel.classList.toggle("active", on);
        }
      });
    }
    function select(t, focus) {
      var all = tabs();
      var i = indexOf(t);
      if (i < 0 || !all[i]) return;
      paint(i);
      if (focus) all[i].focus();
      if (typeof opts.onSelect === "function") opts.onSelect(all[i]);
    }
    function current() {
      var all = tabs();
      for (var i = 0; i < all.length; i++)
        if (all[i].getAttribute("aria-selected") === "true") return all[i];
      return all[0] || null;
    }
    function onClick(e) {
      var tab = e.target.closest && e.target.closest('[role="tab"]');
      if (!tab || !list.contains(tab)) return;
      e.preventDefault();
      select(tab, false);
    }
    function onKey(e) {
      var tab = e.target.closest && e.target.closest('[role="tab"]');
      if (!tab || !list.contains(tab)) return;
      var all = tabs();
      var i = all.indexOf(tab);
      var n = all.length;
      var next =
        e.key === "ArrowRight"
          ? (i + 1) % n
          : e.key === "ArrowLeft"
            ? (i - 1 + n) % n
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? n - 1
                : -1;
      if (next < 0) return;
      e.preventDefault();
      select(next, true);
    }
    list.addEventListener("click", onClick);
    list.addEventListener("keydown", onKey);
    var first =
      opts.selected != null ? indexOf(opts.selected) : indexOf(current());
    paint(first < 0 ? 0 : first);
    var api = {
      select: select,
      selected: current,
      tabs: tabs,
      off: function () {
        list.removeEventListener("click", onClick);
        list.removeEventListener("keydown", onKey);
        list._denTabs = null;
      },
    };
    list._denTabs = api;
    return api;
  }
  /**
   * The page header's tabs, made only when a page asks (no empty stub):
   * spec { label, tabs: [{ id, label, panel }], selected?, onSelect? }.
   * A .ptabs tablist below the header, wired by wireTabs; each panel is
   * the page's own element. Asked again, the old tablist is replaced.
   */
  function pageTabs(spec) {
    if (!ph || !spec || !Array.isArray(spec.tabs)) return null;
    if (ph.tabs) ph.tabs.remove();
    var list = document.createElement("div");
    list.className = "ptabs den-ptabs";
    list.setAttribute("role", "tablist");
    if (spec.label) list.setAttribute("aria-label", String(spec.label));
    var panels = [];
    var sel = 0;
    spec.tabs.forEach(function (d, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      if (d.id) b.setAttribute("data-tab", String(d.id));
      b.textContent = String(d.label || d.id || "");
      list.appendChild(b);
      panels.push(d.panel || null);
      if (spec.selected != null && d.id === spec.selected) sel = i;
    });
    ph.el.parentNode.insertBefore(list, ph.el.nextSibling);
    ph.tabs = list;
    var all = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    return wireTabs(list, {
      panelOf: function (tab) {
        return panels[all.indexOf(tab)] || null;
      },
      selected: sel,
      onSelect: function (tab) {
        if (typeof spec.onSelect === "function")
          spec.onSelect(tab.getAttribute("data-tab"), tab);
      },
    });
  }
  /**
   * The page header (R20): { el, h1, sub, act, tabs }, or null on a page
   * that draws its own. setSub(text) fixes the sub line (null: the scope
   * again); setScope({ ws?, env? }) keeps the scope line but names the
   * workspace or env the page shows (Local Dev and Graph show one
   * workspace, locally); a page shows .act by filling it and unhiding it,
   * and tabs with tabs(spec) (pageTabs: made only then).
   */
  function pageHeader() {
    if (!ph) return null;
    return {
      el: ph.el,
      h1: ph.h1,
      sub: ph.sub,
      act: ph.act,
      tabs: pageTabs,
      setSub: function (text) {
        ph.subFixed = text != null;
        if (text != null) ph.sub.textContent = String(text);
        else paintPageSub();
      },
      setScope: function (over) {
        ph.over = over || null;
        paintPageSub();
      },
    };
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", ensurePageHeader);
  else ensurePageHeader();

  // Skip to content: the page's <main id="den-content">, its one main
  // landmark (each page wraps its content in it).
  var skip = host.querySelector(".den-skip");
  if (skip)
    skip.addEventListener("click", function (e) {
      var el = document.getElementById("den-content");
      if (!el) return;
      e.preventDefault();
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus();
    });

  // The browser-tab icon is the active theme's (dev.22), set here and
  // nowhere else: no page links one. Until appearance.js knows the theme
  // (it calls setFavicon with the versioned URL for the mode it draws in,
  // again on every theme or mode change), the bare route serves the
  // active theme's, never cached.
  function setFavicon(href) {
    var links = document.querySelectorAll('link[rel~="icon"]');
    var link = document.getElementById("den-favicon");
    for (var i = 0; i < links.length; i++)
      if (links[i] !== link) links[i].remove();
    if (!link) {
      link = document.createElement("link");
      link.id = "den-favicon";
      link.rel = "icon";
      document.head.appendChild(link);
    }
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  }
  setFavicon(
    "/theme-favicon?mode=" +
      (document.documentElement.dataset.mode === "light" ? "light" : "dark"),
  );

  document.body.classList.add("den-has-shell");
  applyCollapsed();
  renderRail();

  // ── the runs dock (R16, 0.3.0-dev.30) ──────────────────────────────────
  // One output dock for every page, at the foot of the content column
  // (the prototype's grid area `dock`). A bar: "Runs", the run tabs (mono
  // 12, a dot that pulses while running) and Show/Hide runs; open, a 170px
  // <pre> with the selected run's output. It replaces the pages' own output
  // panes: every run a page starts is a tab here, through denShell.runs.
  //
  //   runs.add(id, label, opts)     a tab (no change to its state if it
  //                                 exists, beyond what opts set)
  //   runs.start(id, label, opts)   add + running + selected; the dock
  //                                 stays as it is unless opts.open: true
  //                                 (R16a); opts.select: false keeps the
  //                                 selection
  //   runs.append(id, text, cls?, { key }?)  one line (cls: cmd, err, warn,
  //                                 done-ok, done-fail, ok, phase); a `key`
  //                                 replaces that line in place (progress)
  //   runs.finish(id, { ok })       stops the pulse; ok false is an error.
  //                                 A run with opts.doneLine (the default
  //                                 for new callers) gets "✓ done in {s}s"
  //   runs.set(id, { label, running, error, actions })
  //   runs.select(id, { open }) (opens only with open: true),
  //   runs.clear(id), runs.remove(id)
  //   runs.show(), hide(), toggle(), isOpen(), has(id), list(), selected(),
  //   runs.text(id), running(), onChange(fn)
  //
  // opts: closable (default true: a × on the tab), onClose(id) (the page
  // decides; else the tab goes), onSelect(id), onClear(id), max (lines
  // kept, 0 = all), actions [{ id, label, title?, run(id) }] (buttons in
  // the bar for the selected run, e.g. Stop), doneLine.
  //
  // The bar carries Copy and Clear for the selected run (the panes had
  // them). R16a (Ward QA 2026-11-05): the dock starts collapsed to its bar.
  // Open/closed and its height are user prefs (/api/settings `shell.dock`,
  // `shell.dockHeight`, mirrored with the rest of the shell's prefs for the
  // first paint), so they survive navigation and reloads, per user. A run
  // starting never opens it: its tab appears and the Runs chip pulses. Only
  // the engineer opens it: Show runs, the Runs chip, a tab click, or a page
  // action whose whole point is output (runs.start/select with open: true).
  // Drag the dock's top edge to resize it, 60px to half the window.
  var SS_LAST_RUN = "__DEN_CLI__-last-run";
  var RUNS = [];
  var runSel = null;
  var DOCK_H = 170;
  var dockOpen = state.dock === true;
  var dockH = state.dockHeight >= 60 ? state.dockHeight : DOCK_H;
  var runSeqId = 0;
  var runListeners = [];
  /** At most half the window (R16a); at least 60px. */
  function dockCap(h) {
    var max = Math.max(60, Math.floor((window.innerHeight || 800) * 0.5));
    return Math.round(Math.max(60, Math.min(h, max)));
  }
  var dock = document.createElement("div");
  dock.className = "den-dock";
  dock.id = "den-dock";
  if (dock.setAttribute) {
    dock.setAttribute("role", "region");
    dock.setAttribute("aria-label", t("runs.title"));
  }
  function placeDock() {
    if (document.body && document.body.appendChild)
      document.body.appendChild(dock);
  }
  placeDock();
  // After the page's content (the foot of the column), once it's parsed.
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", placeDock);

  function runById(id) {
    for (var i = 0; i < RUNS.length; i++) if (RUNS[i].id === id) return RUNS[i];
    return null;
  }
  function selectedRun() {
    return runById(runSel) || RUNS[RUNS.length - 1] || null;
  }
  function runsChanged() {
    runListeners.forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        /* a listener's problem */
      }
    });
    try {
      window.dispatchEvent(new CustomEvent("den:runs"));
    } catch (e) {
      /* no CustomEvent */
    }
  }
  /** Open/closed changed by the engineer: the pref follows. */
  function rememberDock() {
    if (state.dock === dockOpen) return Promise.resolve(true);
    state.dock = dockOpen;
    return saveShell({ dock: dockOpen });
  }
  /** The server's prefs arrived: the dock follows them. */
  function dockFromPrefs() {
    var h = state.dockHeight >= 60 ? state.dockHeight : DOCK_H;
    if (dockOpen === (state.dock === true) && h === dockH) return;
    dockOpen = state.dock === true;
    dockH = h;
    var out = outEl();
    if (out) out.style.height = dockCap(dockH) + "px";
    renderDock();
  }
  function secs(ms) {
    return (Math.max(0, ms) / 1000).toFixed(1);
  }
  function dotClass(r) {
    if (r.running) return "run";
    if (r.error) return "bad";
    if (r.done) return "";
    return "off";
  }
  function runTitle(r) {
    if (r.running) return r.label;
    if (r.done && r.endedAt)
      return (
        r.label +
        " · " +
        t(r.error ? "dock.failed" : "dock.done", {
          s: secs(r.endedAt - r.startedAt),
        })
      );
    return r.label;
  }
  function lastRunHere() {
    try {
      var l = JSON.parse(sessionStorage.getItem(SS_LAST_RUN) || "null");
      var here = location.pathname + location.search;
      return l && l.page && l.page !== here ? l : null;
    } catch (e) {
      return null;
    }
  }

  // The bar: redrawn on any run's state change (not on every line).
  function barHtml() {
    var sel = selectedRun();
    var tabs = RUNS.length
      ? RUNS.map(function (r) {
          var on = sel && sel.id === r.id;
          return (
            '<span class="den-rtab-w">' +
            '<button type="button" class="den-rtab' +
            (r.closable ? " den-x" : "") +
            '" role="tab" id="den-rtab-' +
            r.n +
            '" data-rsel="' +
            r.n +
            '" aria-selected="' +
            (on ? "true" : "false") +
            '" aria-controls="den-dock-out" tabindex="' +
            (on ? "0" : "-1") +
            '" title="' +
            esc(runTitle(r)) +
            '"' +
            (r.closable ? ' aria-keyshortcuts="Delete"' : "") +
            '><span class="den-dot ' +
            dotClass(r) +
            '" aria-hidden="true"></span>' +
            esc(r.label) +
            (r.running
              ? '<span class="den-sr">, ' +
                esc(t("runs.n", { n: 1 })) +
                "</span>"
              : r.error
                ? '<span class="den-sr">, ' + esc(t("dock.err")) + "</span>"
                : "") +
            "</button>" +
            (r.closable
              ? '<button type="button" class="den-rtab-x" tabindex="-1" data-rclose="' +
                r.n +
                '" aria-label="' +
                esc(t("dock.closeRun", { s: r.label })) +
                '" title="' +
                esc(t("dock.closeRun", { s: r.label })) +
                '"><span aria-hidden="true">×</span></button>'
              : "") +
            "</span>"
          );
        }).join("")
      : "<span>" + esc(t("runs.none")) + "</span>";
    var acts = "";
    if (dockOpen && sel) {
      (sel.actions || []).forEach(function (a, i) {
        acts +=
          '<button type="button" class="den-ib" data-ract="' +
          i +
          '"' +
          (a.title ? ' title="' + esc(a.title) + '"' : "") +
          ">" +
          esc(a.label) +
          "</button>";
      });
      acts +=
        '<button type="button" class="den-ib" data-dock="copy">' +
        esc(t("dock.copy")) +
        "</button>" +
        '<button type="button" class="den-ib" data-dock="clear">' +
        esc(t("dock.clear")) +
        "</button>";
    }
    return (
      "<b>" +
      esc(t("runs.title")) +
      "</b>" +
      // A tablist only while it holds tabs: an empty one ("No runs") is
      // a tablist with no tab, which screen readers announce as broken
      // (0.3.0-dev.34, a consumer's finding). The bar redraws on any run's
      // state change, so the first tab brings the role back.
      '<div class="den-runs-l"' +
      (RUNS.length
        ? ' role="tablist" aria-label="' + esc(t("runs.title")) + '"'
        : "") +
      ">" +
      tabs +
      "</div>" +
      (acts ? '<span class="den-dock-acts">' + acts + "</span>" : "") +
      '<button type="button" class="den-ib" data-act="dock" aria-expanded="' +
      (dockOpen ? "true" : "false") +
      '" aria-controls="den-dock-out">' +
      esc(dockOpen ? t("dock.close") + " ▾" : t("dock.show") + " ▴") +
      "</button>"
    );
  }
  var shownRun = null;
  var pending = [];
  var rafId = null;
  function lineSpan(l) {
    var span = document.createElement("span");
    if (l.cls) span.className = l.cls;
    span.textContent = l.text + "\n";
    l.el = span;
    return span;
  }
  function outEl() {
    return dock.querySelector ? dock.querySelector("#den-dock-out") : null;
  }
  function fillOut() {
    var out = outEl();
    if (!out) return;
    pending = [];
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    var sel = selectedRun();
    shownRun = sel;
    out.innerHTML = "";
    if (sel) out.setAttribute("aria-labelledby", "den-rtab-" + sel.n);
    else out.removeAttribute("aria-labelledby");
    if (!sel) {
      out.textContent = t("runs.empty");
      var last = lastRunHere();
      if (last) {
        out.appendChild(document.createTextNode(" "));
        var a = document.createElement("a");
        a.href = last.page;
        a.textContent = t("dock.last", { s: last.label });
        out.appendChild(a);
      }
      return;
    }
    var frag = document.createDocumentFragment();
    sel.lines.forEach(function (l) {
      frag.appendChild(lineSpan(l));
    });
    out.appendChild(frag);
    if (sel.autoScroll) out.scrollTop = out.scrollHeight;
  }
  function flush() {
    rafId = null;
    var out = outEl();
    var batch = pending;
    pending = [];
    if (!out || !shownRun || !batch.length) return;
    var frag = document.createDocumentFragment();
    batch.forEach(function (l) {
      if (shownRun.lines.indexOf(l) >= 0) frag.appendChild(lineSpan(l));
    });
    out.appendChild(frag);
    if (shownRun.max)
      while (out.childElementCount > shownRun.max)
        out.removeChild(out.firstChild);
    if (shownRun.autoScroll) out.scrollTop = out.scrollHeight;
  }
  function renderDock() {
    if (!dock.querySelector) return;
    var bar = dock.querySelector(".den-bar");
    if (!bar) {
      dock.innerHTML =
        '<div class="den-dock-grip" aria-hidden="true" title="' +
        esc(t("dock.resize")) +
        '"></div><div class="den-bar"></div>';
      bar = dock.querySelector(".den-bar");
    }
    var focusSel =
      document.activeElement && dock.contains(document.activeElement)
        ? document.activeElement.getAttribute("data-rsel") ||
          document.activeElement.getAttribute("data-act") ||
          document.activeElement.getAttribute("data-dock")
        : null;
    bar.innerHTML = barHtml();
    dock.classList.toggle("open", dockOpen);
    var out = outEl();
    if (dockOpen && !out) {
      out = document.createElement("pre");
      out.id = "den-dock-out";
      out.setAttribute("role", "tabpanel");
      out.tabIndex = 0;
      out.style.height = dockCap(dockH) + "px";
      out.addEventListener("scroll", function () {
        if (!shownRun) return;
        shownRun.autoScroll =
          out.scrollHeight - out.scrollTop <= out.clientHeight + 20;
      });
      dock.appendChild(out);
      fillOut();
    } else if (!dockOpen && out) {
      out.remove();
      shownRun = null;
    } else if (out && selectedRun() !== shownRun) fillOut();
    // Keep focus on what had it (a redraw replaces the bar's buttons).
    if (focusSel) {
      var back =
        bar.querySelector('[data-rsel="' + focusSel + '"]') ||
        bar.querySelector('[data-act="' + focusSel + '"]') ||
        bar.querySelector('[data-dock="' + focusSel + '"]');
      if (back) back.focus();
    }
    var on = bar.querySelector('.den-rtab[aria-selected="true"]');
    if (on && on.scrollIntoView)
      on.scrollIntoView({ block: "nearest", inline: "nearest" });
    var chip = document.getElementById("den-runs");
    if (chip) {
      chip.setAttribute("aria-expanded", dockOpen ? "true" : "false");
      chip.setAttribute("aria-controls", "den-dock");
    }
  }

  function addRun(id, label, opts) {
    id = String(id);
    opts = opts || {};
    var r = runById(id);
    if (!r) {
      r = {
        id: id,
        n: ++runSeqId,
        label: String(label == null ? id : label),
        lines: [],
        running: false,
        done: false,
        error: false,
        startedAt: Date.now(),
        endedAt: null,
        autoScroll: true,
        closable: true,
        doneLine: true,
        max: 0,
        actions: [],
        keyed: {},
      };
      RUNS.push(r);
    } else if (label != null) r.label = String(label);
    [
      "closable",
      "doneLine",
      "max",
      "onClose",
      "onSelect",
      "onClear",
      "actions",
    ].forEach(function (k) {
      if (opts[k] !== undefined) r[k] = opts[k];
    });
    if (opts.running !== undefined) r.running = !!opts.running;
    if (opts.error !== undefined) r.error = !!opts.error;
    return r;
  }
  var runsApi = {
    add: function (id, label, opts) {
      var r = addRun(id, label, opts);
      if (opts && opts.select) runSel = r.id;
      if (opts && opts.open === true) {
        dockOpen = true;
        rememberDock();
      }
      renderDock();
      runsChanged();
      return r.id;
    },
    start: function (id, label, opts) {
      opts = opts || {};
      var r = addRun(id, label, opts);
      r.running = opts.running !== false;
      r.done = false;
      r.error = false;
      r.startedAt = Date.now();
      r.endedAt = null;
      if (opts.clear) {
        r.lines = [];
        r.keyed = {};
        if (shownRun === r) shownRun = null;
      }
      if (opts.select !== false) runSel = r.id;
      // R16a: a run starting never opens the dock; open: true is for an
      // action whose whole point is output (e.g. a service's Logs).
      if (opts.open === true) {
        dockOpen = true;
        rememberDock();
      }
      renderDock();
      runsChanged();
      return r.id;
    },
    append: function (id, text, cls, o) {
      var r = runById(String(id));
      if (!r) return;
      var key = o && o.key;
      if (key != null && r.keyed[key] && r.lines.indexOf(r.keyed[key]) >= 0) {
        var l0 = r.keyed[key];
        l0.text = String(text);
        if (l0.el && shownRun === r) l0.el.textContent = l0.text + "\n";
        if (shownRun === r && r.autoScroll) {
          var o0 = outEl();
          if (o0) o0.scrollTop = o0.scrollHeight;
        }
        return;
      }
      var l = { text: String(text), cls: cls || "" };
      if (key != null) r.keyed[key] = l;
      r.lines.push(l);
      if (r.max && r.lines.length > r.max)
        r.lines.splice(0, r.lines.length - r.max);
      if (shownRun === r) {
        pending.push(l);
        if (rafId === null) rafId = requestAnimationFrame(flush);
      }
    },
    finish: function (id, o) {
      var r = runById(String(id));
      if (!r) return;
      var ok = !(o && o.ok === false);
      r.running = false;
      r.done = true;
      r.error = !ok;
      r.endedAt = Date.now();
      if (r.doneLine)
        runsApi.append(
          r.id,
          (ok ? "✓ " : "✗ ") +
            t(ok ? "dock.done" : "dock.failed", {
              s: secs(r.endedAt - r.startedAt),
            }),
          ok ? "done-ok" : "done-fail",
        );
      renderDock();
      runsChanged();
    },
    set: function (id, o) {
      var r = runById(String(id));
      if (!r || !o) return;
      if (o.label != null) r.label = String(o.label);
      if (o.running !== undefined) r.running = !!o.running;
      if (o.error !== undefined) r.error = !!o.error;
      if (o.actions !== undefined) r.actions = o.actions || [];
      renderDock();
      runsChanged();
    },
    select: function (id, o) {
      var r = runById(String(id));
      if (!r) return;
      runSel = r.id;
      if (o && o.open === true) {
        dockOpen = true;
        rememberDock();
      }
      renderDock();
    },
    clear: function (id) {
      var r = runById(String(id == null ? runSel : id));
      if (!r) return;
      r.lines = [];
      r.keyed = {};
      if (shownRun === r) fillOut();
    },
    remove: function (id) {
      var r = runById(String(id));
      if (!r) return;
      RUNS.splice(RUNS.indexOf(r), 1);
      if (runSel === r.id) {
        var last = RUNS[RUNS.length - 1];
        runSel = last ? last.id : null;
      }
      if (shownRun === r) shownRun = null;
      renderDock();
      runsChanged();
    },
    show: function () {
      dockOpen = true;
      rememberDock();
      renderDock();
    },
    hide: function () {
      dockOpen = false;
      rememberDock();
      renderDock();
    },
    toggle: function () {
      dockOpen = !dockOpen;
      rememberDock();
      renderDock();
      return dockOpen;
    },
    isOpen: function () {
      return dockOpen;
    },
    has: function (id) {
      return !!runById(String(id));
    },
    list: function () {
      return RUNS.map(function (r) {
        return {
          id: r.id,
          label: r.label,
          running: r.running,
          done: r.done,
          error: r.error,
          lines: r.lines.length,
        };
      });
    },
    selected: function () {
      var r = selectedRun();
      return r ? r.id : null;
    },
    text: function (id) {
      var r = runById(String(id == null ? runSel : id)) || selectedRun();
      return r
        ? r.lines
            .map(function (l) {
              return l.text + "\n";
            })
            .join("")
        : "";
    },
    running: function () {
      return RUNS.filter(function (r) {
        return r.running;
      }).length;
    },
    onChange: function (fn) {
      if (typeof fn === "function") runListeners.push(fn);
    },
  };

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText)
      return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      ta.remove();
      if (ok) resolve();
      else reject(new Error("copy failed"));
    });
  }
  function runOfEl(el, attr) {
    var n = Number(el.getAttribute(attr));
    for (var i = 0; i < RUNS.length; i++) if (RUNS[i].n === n) return RUNS[i];
    return null;
  }
  function closeRun(r) {
    if (typeof r.onClose === "function") r.onClose(r.id);
    else runsApi.remove(r.id);
  }
  if (dock.addEventListener) {
    dock.addEventListener("click", function (e) {
      var tgt = e.target && e.target.closest ? e.target : null;
      if (!tgt) return;
      var x = tgt.closest("[data-rclose]");
      if (x) {
        var rx = runOfEl(x, "data-rclose");
        if (rx) closeRun(rx);
        return;
      }
      var tab = tgt.closest("[data-rsel]");
      if (tab) {
        var rt = runOfEl(tab, "data-rsel");
        if (!rt) return;
        runsApi.select(rt.id, { open: true });
        if (typeof rt.onSelect === "function") rt.onSelect(rt.id);
        return;
      }
      if (tgt.closest('[data-act="dock"]')) {
        runsApi.toggle();
        return;
      }
      var act = tgt.closest("[data-ract]");
      var sel = selectedRun();
      if (act && sel) {
        var a = (sel.actions || [])[Number(act.getAttribute("data-ract"))];
        if (a && typeof a.run === "function") a.run(sel.id);
        return;
      }
      var d = tgt.closest("[data-dock]");
      if (!d || !sel) return;
      if (d.getAttribute("data-dock") === "clear") {
        runsApi.clear(sel.id);
        if (typeof sel.onClear === "function") sel.onClear(sel.id);
      } else {
        var btn = d;
        copyText(runsApi.text(sel.id))
          .then(function () {
            btn.textContent = t("dock.copied");
            setTimeout(function () {
              btn.textContent = t("dock.copy");
            }, 1500);
          })
          .catch(function () {});
      }
    });
    // The run tabs: one tab stop; ←/→, Home and End move (and select);
    // Delete closes a closable run.
    dock.addEventListener("keydown", function (e) {
      var tab = e.target && e.target.closest && e.target.closest("[data-rsel]");
      if (!tab) return;
      var r = runOfEl(tab, "data-rsel");
      var i = RUNS.indexOf(r);
      var next =
        e.key === "ArrowRight"
          ? (i + 1) % RUNS.length
          : e.key === "ArrowLeft"
            ? (i - 1 + RUNS.length) % RUNS.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? RUNS.length - 1
                : -1;
      if (e.key === "Delete" && r && r.closable) {
        e.preventDefault();
        closeRun(r);
        var stop = dock.querySelector('.den-rtab[tabindex="0"]');
        if (stop) stop.focus();
        return;
      }
      if (next < 0 || !RUNS[next]) return;
      e.preventDefault();
      runsApi.select(RUNS[next].id, { open: dockOpen });
      if (typeof RUNS[next].onSelect === "function")
        RUNS[next].onSelect(RUNS[next].id);
      var to = dock.querySelector('[data-rsel="' + RUNS[next].n + '"]');
      if (to) to.focus();
    });
    // Drag the top edge to resize (Local Dev's handle): 60px to half the
    // window (R16a), remembered (shell.dockHeight).
    var drag = null;
    dock.addEventListener("mousedown", function (e) {
      if (!e.target.closest || !e.target.closest(".den-dock-grip")) return;
      var out = outEl();
      if (!out) return;
      drag = { y: e.clientY, h: out.offsetHeight };
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!drag) return;
      var out = outEl();
      if (!out) return;
      dockH = dockCap(drag.h + drag.y - e.clientY);
      out.style.height = dockH + "px";
    });
    document.addEventListener("mouseup", function () {
      if (!drag) return;
      drag = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (state.dockHeight !== dockH) {
        state.dockHeight = dockH;
        saveShell({ dockHeight: dockH });
      }
    });
  }
  renderDock();

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
    /** The browser-tab icon (appearance.js: the active theme's, per mode). */
    setFavicon: setFavicon,
    /** The org part of the scope: "/ ORG <title>", static (one org). */
    setOrg: setOrg,
    setOrgs: setOrgs,
    setWorkspaces: setWorkspaces,
    /** Repaint the Env part from #env-sel (after setting its value). */
    syncEnv: syncEnv,
    syncPinToggles: syncPinToggles,
    registerCommand: registerCommand,
    unregisterCommand: unregisterCommand,
    commands: commands,
    /** A .pop menu below `anchor` (the model as the scope menus'). */
    openMenu: openMenu,
    closeMenu: function () {
      closeMenu(false);
    },
    groups: function () {
      return GROUPS.slice().sort(byOrder);
    },
    nav: function () {
      return NAV.slice();
    },
    /** NAV in the rail's order (groups, then your order), hidden included. */
    orderedNav: orderedNav,
    setNavPrefs: setNavPrefs,
    setPins: setPins,
    setCollapsed: setCollapsed,
    setDock: setDock,
    /** The runs dock (R16): every page's output, one path. */
    runs: runsApi,
    /** The page header (R20): { el, h1, sub, act, tabs(spec), setSub }, or null. */
    pageHeader: pageHeader,
    /** Wire a role=tablist as WAI-ARIA tabs (roving tabindex, keys, panels). */
    wireTabs: wireTabs,
    registerSettingsCategory: registerSettingsCategory,
    registerSetting: registerSetting,
    settings: function () {
      return SETTING_ROWS.slice();
    },
    settingsCategories: function () {
      return SETTING_CATS.slice().sort(byOrder);
    },
  };

  // The ready path for a script that loads before shell.js:
  // window.denShellQueue is an array of functions, each called with
  // denShell once it exists (now); a later push runs at once. Then
  // `den-shell:ready` fires on window.
  var queued = Array.isArray(window.denShellQueue) ? window.denShellQueue : [];
  function runQueued(fn) {
    if (typeof fn !== "function") return;
    try {
      fn(window.denShell);
    } catch (err) {
      warn("a denShellQueue function threw: " + (err && err.message));
    }
  }
  window.denShellQueue = {
    push: function () {
      for (var i = 0; i < arguments.length; i++) runQueued(arguments[i]);
      return 0;
    },
    length: 0,
  };
  queued.forEach(runQueued);
  try {
    window.dispatchEvent(
      new CustomEvent("den-shell:ready", { detail: window.denShell }),
    );
  } catch (e) {
    /* no CustomEvent: the queue still ran */
  }
  // The queue has drained and ready has fired: a page still without its
  // group (or a setting without its category) a tick from now warns.
  settled = true;
  checkOrphansSoon();

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
          hidden: Array.isArray(s.shell.hidden) ? s.shell.hidden : [],
          order: Array.isArray(s.shell.order) ? s.shell.order : [],
          dock: s.shell.dock === true,
          dockHeight:
            typeof s.shell.dockHeight === "number" ? s.shell.dockHeight : 0,
        });
        remember();
        dockFromPrefs();
      })
      .catch(function () {});

  // The Edge page shows once the edge is configured (no Docker asked).
  if (typeof fetch === "function")
    fetch("/api/edge?probe=1")
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (e) {
        if (!e) return;
        setState({ edge: e.configured === true });
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
    // A column on every page (most pages are one already), so the runs
    // dock sits at the foot even when the content is short.
    "body.den-has-shell { display: flex; flex-direction: column; min-height: 100vh; }",
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
    // Scope (.scope, .sep, .k): / Org ▾ / Workspace ▾ / Env ▾ (R4)
    // The search gives way first (dev.20): the scope keeps its parts whole
    // (each name is capped below), so they never run into one another.
    ".den-scope { display: flex; align-items: center; gap: 2px; min-width: 0; flex-shrink: 0; }",
    ".den-sep { color: var(--faint); }",
    ".den-scope [hidden] { display: none; }",
    ".den-scope .den-ib { color: var(--text); font-size: 13px; }",
    ".den-k { font: 11px var(--mono); color: var(--faint); text-transform: uppercase; letter-spacing: .06em; }",
    ".den-scope .den-ib[aria-expanded='true'] { background: var(--sunken); }",
    // A long name ends in an ellipsis; the whole name is in the menu.
    ".den-scope .den-ib { min-width: 0; }",
    "#ws-pill .den-vn, #org-crumb .den-vn { display: inline-block; max-width: 200px; overflow: hidden;",
    "  text-overflow: ellipsis; vertical-align: top; }",
    // Menus (.pop, .ml, .mi, .hr: R18)
    ".den-pop { position: fixed; z-index: 45; background: var(--raised); border: 1px solid var(--border-strong);",
    "  border-radius: 10px; box-shadow: var(--shadow); padding: 6px; min-width: 220px;",
    "  max-height: calc(100vh - 72px); overflow-y: auto; box-sizing: border-box;",
    "  font: 14px/1.45 var(--sans); color: var(--text); }",
    ".den-pop:focus { outline: none; }",
    ".den-pop :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    ".den-pop .den-ml { font: 11px var(--mono); color: var(--faint); text-transform: uppercase;",
    "  letter-spacing: .07em; padding: 6px 8px 2px; }",
    ".den-pop .den-mi { display: flex; width: 100%; align-items: center; gap: 8px; background: none;",
    "  border: 0; padding: 6px 8px; border-radius: 6px; cursor: pointer; text-align: left;",
    "  font: inherit; color: inherit; text-decoration: none; box-sizing: border-box; }",
    ".den-pop .den-mi:hover, .den-pop .den-mi:focus { background: var(--sunken); }",
    // The ✓ is drawn, not read (aria-checked says it): alt text "".
    ".den-pop .den-mi[aria-checked='true']::after { content: '✓' / ''; margin-left: auto; color: var(--accent-text); }",
    ".den-pop .den-mi-l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-pop .den-mtag { font: 11px var(--mono); color: var(--muted); }",
    ".den-pop .den-hr { height: 1px; background: var(--border); margin: 6px 0; }",
    // The page's one main landmark (#den-content) holds all its content
    // and lays it out as the body did (a column), so pages keep their look.
    "body.den-has-shell > #den-content { display: flex; flex-direction: column; flex: 1 1 auto;",
    "  min-height: 0; min-width: 0; }",
    "body.den-has-shell > #den-content:focus { outline: none; }",
    // The page header (.ph, R20, 0.3.0-dev.32), the prototype's sizes: it
    // sits in .main's 20px/24px inset (pages keep their own content
    // full-bleed below it). .ptabs are the page tabs below it.
    "#den-content > .den-ph { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap;",
    "  flex: none; margin: 0 0 16px; padding: 20px 24px 0; font: 14px/1.45 var(--sans); color: var(--text); box-sizing: border-box; }",
    ".den-ph h1 { font: 600 22px/1.2 var(--display); margin: 0; padding: 0; text-wrap: balance; color: var(--text); }",
    ".den-ph .sub { color: var(--muted); font-size: 13px; margin: 4px 0 0; padding: 0; min-height: 1.45em; }",
    ".den-ph .act { margin-left: auto; display: flex; gap: 8px; }",
    ".den-ph [hidden], .den-ptabs[hidden], [role='tabpanel'][hidden] { display: none !important; }",
    // A tablist inside a .ptabs row beside a link (Local Dev's "Settings ↗")
    // lays its tabs out as the row does.
    ".ptabs > [role='tablist'] { display: flex; gap: 2px; flex: none; }",
    ".ptabs.den-ptabs { flex: none; margin: 0 24px 18px; }",
    ".ptabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); overflow-x: auto; }",
    // A link among the tabs (Local Dev's "Settings ↗") looks like one.
    ".ptabs [role='tab'], .ptabs > a { background: none; border: 0; padding: 8px 12px; color: var(--muted); cursor: pointer;",
    "  border-bottom: 2px solid transparent; margin: 0 0 -1px; white-space: nowrap; font: inherit; font-size: 14px;",
    "  line-height: 1.45; text-decoration: none; }",
    ".ptabs [role='tab']:hover, .ptabs > a:hover { color: var(--text); }",
    ".ptabs [role='tab'][aria-selected='true'] { color: var(--text); border-bottom-color: var(--accent); font-weight: 500; }",
    // Search (.search, kbd: R5). The prototype's sizes are content-box
    // (the pages reset everything to border-box).
    ".den-search { flex: 1 1 260px; max-width: 420px; margin: 0 auto; display: flex; align-items: center;",
    "  gap: 8px; background: var(--sunken); border: 1px solid var(--border); border-radius: var(--radius-button);",
    "  padding: 5px 10px; color: var(--faint); cursor: text; min-width: 0; font: inherit; box-sizing: content-box; }",
    ".den-search-ph { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }",
    ".den-search-ic { flex: none; }",
    ".den-top kbd, .den-pal kbd { font: 11px var(--mono); border: 1px solid var(--border); border-bottom-width: 2px;",
    "  border-radius: 4px; padding: 0 5px; color: var(--muted); background: var(--surface); }",
    // Chips (.chips, .chip, .dot: R6, R7, R8)
    ".den-chips { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }",
    ".den-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border);",
    "  border-radius: 999px; padding: 3px 10px; background: var(--surface); cursor: pointer; font: inherit;",
    "  font-size: 13px; white-space: nowrap; flex-shrink: 0; color: var(--text); }",
    ".den-chip:hover { border-color: var(--border-strong); }",
    ".den-chip.bad { border-color: color-mix(in srgb, var(--bad) 50%, var(--border)); }",
    ".den-chip .den-n { font-variant-numeric: tabular-nums; }",
    ".den-chip .den-dot, .den-drawer .den-dot, .den-pal .den-dot { margin: 0; }",
    ".den-chip[aria-expanded='true'] { border-color: var(--border-strong); }",
    ".den-dot.run { background: var(--accent); animation: den-pulse 1.2s infinite; }",
    ".den-dot.pending { background: var(--faint); animation: den-pulse 1.2s infinite; }",
    "@keyframes den-pulse { 50% { opacity: .35; } }",
    "@media (prefers-reduced-motion: reduce) { .den-dot.run, .den-dot.pending { animation: none; } }",
    ".den-user { display: contents; }",
    // Buttons in overlays (.btn, .btn.sm, .btn.primary)
    ".den-btn { border: 1px solid var(--border); background: var(--surface); border-radius: var(--radius-button);",
    "  padding: 6px 12px; cursor: pointer; font: inherit; font-weight: 500; white-space: nowrap; color: var(--text); }",
    ".den-btn:hover { border-color: var(--border-strong); }",
    ".den-btn.primary { background: var(--accent-fill); border-color: var(--accent-fill); color: var(--on-accent); }",
    ".den-btn.sm { padding: 2px 9px; font-size: 12.5px; }",
    ".den-btn:disabled { opacity: .6; cursor: default; }",
    // Status drawer (.scrim, .drawer, .prob-card, .grp, .svl: R15)
    ".den-scrim { position: fixed; inset: 0; background: rgb(0 0 0 / 0.35); z-index: 40; }",
    ".den-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100%); z-index: 41;",
    "  box-sizing: content-box; background: var(--surface); border-left: 1px solid var(--border);",
    "  box-shadow: var(--shadow); display: flex; flex-direction: column; font: 14px/1.45 var(--sans);",
    "  color: var(--text); }",
    ".den-drawer :focus-visible, .den-pal :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    ".den-drawer .den-dh { display: flex; align-items: center; gap: 10px; padding: 14px 16px;",
    "  border-bottom: 1px solid var(--border); }",
    ".den-drawer .den-dh h2 { margin: 0; font: 600 16px var(--display); flex: 1; }",
    ".den-drawer .den-db { overflow-y: auto; padding: 12px 16px 24px; display: grid; gap: 16px; align-content: start; }",
    ".den-drawer .den-none { margin: 0; color: var(--muted); }",
    ".den-sec { font: 600 13px var(--mono); text-transform: uppercase; letter-spacing: .07em; color: var(--muted);",
    "  margin: 0 0 10px; }",
    ".den-cards, .den-grps { display: grid; gap: 14px; }",
    ".den-cards { gap: 8px; }",
    ".den-prob-card { border: 1px solid color-mix(in srgb, var(--bad) 45%, var(--border));",
    "  background: color-mix(in srgb, var(--bad) 7%, var(--surface)); border-radius: var(--radius);",
    "  padding: 10px 12px; display: grid; gap: 6px; }",
    ".den-prob-card .den-t { display: flex; gap: 8px; align-items: center; font-weight: 600; }",
    ".den-prob-card .den-t .den-mono { font-weight: 400; color: var(--muted); }",
    ".den-prob-card .den-s { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }",
    ".den-prob-card .den-a { display: flex; gap: 6px; flex-wrap: wrap; }",
    ".den-grp h3 { margin: 0 0 6px; font: 600 12px var(--mono); color: var(--muted); display: flex;",
    "  justify-content: space-between; text-transform: uppercase; letter-spacing: .06em; }",
    ".den-svl { display: grid; gap: 2px; }",
    ".den-svl button { display: flex; align-items: center; gap: 8px; background: none; border: 0; padding: 4px 6px;",
    "  border-radius: 5px; cursor: pointer; text-align: left; font: inherit; color: inherit; min-width: 0; }",
    ".den-svl button:hover { background: var(--sunken); }",
    ".den-svl .den-mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-svl .den-ms { margin-left: auto; font: 12px var(--mono); color: var(--faint);",
    "  font-variant-numeric: tabular-nums; white-space: nowrap; }",
    // Command palette (.pal-wrap, .pal: R17)
    ".den-pal-wrap { position: fixed; inset: 0; z-index: 50; display: grid; justify-items: center;",
    "  align-items: start; padding: 12vh 16px 0; background: rgb(0 0 0 / 0.35); font: 14px/1.45 var(--sans);",
    "  color: var(--text); }",
    ".den-pal { width: min(620px, 100%); box-sizing: content-box; background: var(--raised);",
    "  border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }",
    ".den-pal input { width: 100%; box-sizing: border-box; border: 0; border-bottom: 1px solid var(--border);",
    "  background: transparent; padding: 14px 16px; font-family: var(--sans); font-size: 16px; color: var(--text);",
    // line-height too: a page's `input { font: inherit }` (Settings) must not reach it.
    "  line-height: normal; outline: none; margin: 0; }",
    ".den-pal ul { list-style: none; margin: 0; padding: 6px; max-height: 50vh; overflow-y: auto; }",
    ".den-pal li { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 7px; cursor: pointer; }",
    ".den-pal li[aria-selected='true'] { background: color-mix(in srgb, var(--accent) 16%, transparent); }",
    ".den-pal li .den-pal-l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-pal li .den-kind { margin-left: auto; font: 11px var(--mono); color: var(--faint); text-transform: uppercase;",
    "  letter-spacing: .05em; white-space: nowrap; }",
    ".den-pal li .den-sub { color: var(--faint); font: 12px var(--mono); white-space: nowrap; }",
    ".den-pal li.den-pal-empty { cursor: default; color: var(--muted); }",
    ".den-pal .den-foot { display: flex; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--border);",
    "  color: var(--faint); font-size: 12px; flex-wrap: wrap; }",
    // The lock popover (.pop form, .pop input, .note: R8)
    ".den-pop form { display: grid; gap: 8px; padding: 6px 8px 8px; width: 260px; box-sizing: content-box; margin: 0; }",
    ".den-pop input:not([type='checkbox']) { border: 1px solid var(--border); background: var(--bg); color: var(--text);",
    "  border-radius: var(--radius-button); padding: 6px 8px; font: inherit; font-size: 13.3333px; line-height: normal; }",
    ".den-pop .den-note, .den-pop .den-mnote { color: var(--muted); font-size: 12.5px; margin: 0; }",
    ".den-pop .den-mnote { padding: 4px 8px; max-width: 260px; }",
    ".den-pop .den-lock-save { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 12.5px; }",
    ".den-pop .den-lock-save[hidden], .den-pop .den-lock-err[hidden], .den-mslot[hidden] { display: none; }",
    ".den-pop .den-lock-err { color: var(--bad); font-size: 12.5px; }",
    ".den-pop .den-lock-desc { padding: 2px 8px 6px; color: var(--muted); font-size: 12.5px; max-width: 260px; }",
    // What's new (.ib.whatsnew + .badge-dot)
    "#den-shell .v-pill { font: inherit; padding: 4px 8px; border: 1px solid transparent;",
    "  border-radius: var(--radius-button); color: var(--muted); flex-shrink: 0; }",
    "#den-shell .v-pill:hover { background: var(--sunken); color: var(--text); border-color: transparent; }",
    "#den-shell .v-pip { position: static; width: 7px; height: 7px; border: 0; border-radius: 50%;",
    "  background: var(--accent); }",
    // ◐ ▾ (the prototype's user menu, an .ib: appearance.js)
    ".den-top .den-ib[aria-expanded='true'] { background: var(--sunken); color: var(--text); }",
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
    ".den-sr { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden;",
    "  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }",
    // Pinned row: the dot in place of the icon (.dot, margin 0 5px)
    ".den-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex: none;",
    "  display: inline-block; margin: 0 5px; }",
    ".den-dot.bad { background: var(--bad); } .den-dot.warn { background: var(--warn); }",
    ".den-dot.off { background: var(--faint); }",
    ".den-pin-row { position: relative; }",
    ".den-pin-sp { visibility: hidden; font-size: 12px; }",
    ".den-pin-x { position: absolute; top: 0; bottom: 0; right: 10px; display: flex; align-items: center;",
    "  padding: 0; border: 0; background: none; cursor: pointer; font: 12px var(--sans);",
    "  opacity: 0; color: var(--faint); }",
    ".den-pin-x:hover { color: var(--text); }",
    ".den-pin-row:hover .den-pin-x, .den-pin-row:focus-within .den-pin-x { opacity: 1; }",
    // Collapsed: icons only. The prototype hides headings and labels; they
    // stay here for screen readers (visually hidden, no space taken).
    "body.den-rail-collapsed .den-rail .den-lbl, body.den-rail-collapsed .den-rail .den-gh,",
    "body.den-rail-collapsed .den-rail .den-bdg, body.den-rail-collapsed .den-rail .den-pin-x,",
    "body.den-rail-collapsed .den-rail .den-pin-sp {",
    "  position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden;",
    "  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }",
    // Toast (.toast)
    ".den-toast { position: fixed; bottom: 70px; left: 50%; transform: translateX(-50%);",
    "  background: var(--raised); border: 1px solid var(--border-strong); border-radius: 8px;",
    "  padding: 8px 14px; box-shadow: var(--shadow); z-index: 60; font: 14px/1.45 var(--sans);",
    "  color: var(--text); }",
    // The runs dock (.dock, .bar, .runs, .rtab, pre: R16), at the foot of
    // the content column; content-box as in the prototype.
    ".den-dock { flex: none; order: 99; position: sticky; bottom: 0; z-index: 14; min-width: 0;",
    "  border-top: 1px solid var(--border); background: var(--surface); font: 14px/1.45 var(--sans);",
    "  color: var(--text); box-sizing: content-box; }",
    ".den-dock :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    ".den-dock .den-bar { display: flex; align-items: center; gap: 10px; box-sizing: content-box;",
    "  padding: 6px max(16px, env(safe-area-inset-right, 0px)) calc(6px + env(safe-area-inset-bottom, 0px)) 16px;",
    "  font-size: 13px; color: var(--muted); }",
    ".den-dock .den-bar b { color: var(--text); font-weight: 500; }",
    ".den-dock .den-runs-l { display: flex; gap: 6px; overflow-x: auto; flex: 1; min-width: 0; }",
    ".den-dock .den-rtab-w { position: relative; display: inline-flex; flex: none; }",
    ".den-dock .den-rtab { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--border);",
    "  border-radius: 6px; padding: 2px 8px; background: var(--bg); cursor: pointer; white-space: nowrap;",
    "  font: 12px var(--mono); color: inherit; box-sizing: content-box; margin: 0; }",
    ".den-dock .den-rtab[aria-selected='true'] { border-color: var(--accent); }",
    ".den-dock .den-rtab .den-dot { margin: 0; }",
    // A run closes from its tab (Local Dev's tabs did): room for the ×.
    ".den-dock .den-rtab.den-x { padding-right: 22px; }",
    ".den-dock .den-rtab-x { position: absolute; top: 0; bottom: 0; right: 4px; display: flex; align-items: center;",
    "  padding: 0 3px; border: 0; background: none; cursor: pointer; font: 13px var(--sans); color: var(--faint); }",
    ".den-dock .den-rtab-x:hover { color: var(--bad); }",
    ".den-dock .den-dock-acts { display: flex; gap: 2px; flex: none; }",
    ".den-dock pre { margin: 0; height: 170px; overflow: auto; max-height: 50vh; padding: 10px 16px; font: 12px/1.5 var(--mono);",
    "  background: var(--sunken); border-top: 1px solid var(--border); color: var(--muted);",
    "  box-sizing: content-box; white-space: pre-wrap; word-break: break-all; }",
    ".den-dock pre a { color: var(--accent-text); }",
    // The panes' line classes, kept.
    ".den-dock pre .cmd { color: var(--accent-text); }",
    ".den-dock pre .err, .den-dock pre .done-fail { color: var(--bad); }",
    ".den-dock pre .warn { color: var(--warn); }",
    ".den-dock pre .ok, .den-dock pre .done-ok { color: var(--ok); }",
    ".den-dock pre .phase { color: var(--text); font-weight: 600; }",
    ".den-dock-grip { display: none; position: absolute; left: 0; right: 0; top: -3px; height: 6px;",
    "  cursor: ns-resize; z-index: 1; }",
    ".den-dock.open .den-dock-grip { display: block; }",
    // Narrow (the prototype's 860 and 720px steps): chip labels hide, the
    // dots stay; then the scope hides and the search is its icon.
    // Den's chips are wider than the prototype's (the full version, real
    // counts): the scope's keys give way from 960px, not 860, so the bar
    // fits without the scope shrinking.
    "@media (max-width: 960px) { .den-scope .den-k { display: none; } }",
    "@media (max-width: 860px) { .den-scope .den-k, .den-scope .den-sep, .den-scope .den-opt { display: none; }",
    "  .den-chip .den-lbl-l { display: none; } }",
    "@media (max-width: 720px) {",
    "  body.den-has-shell, body.den-has-shell.den-rail-collapsed { --den-rail-w: 0px; --den-rail-cw: 244px; }",
    "  .den-menu-btn { display: inline-flex; }",
    "  .den-rail { transform: translateX(-105%); transition: transform .18s;",
    "    box-shadow: var(--shadow); z-index: 42; }",
    "  body.den-rail-open .den-rail { transform: none; }",
    "  .den-scrim { position: fixed; inset: 0; z-index: 41; background: color-mix(in srgb, var(--bg) 60%, transparent); }",
    "  body.den-rail-collapsed .den-rail .den-lbl, body.den-rail-collapsed .den-rail .den-gh,",
    "  body.den-rail-collapsed .den-rail .den-bdg { position: static; width: auto; height: auto;",
    "    clip: auto; overflow: hidden; }",
    "  .den-collapse-btn { display: none; }",
    "  .den-scope { display: none; }",
    "  .den-search { flex: 0 0 auto; margin: 0 0 0 auto; }",
    "  .den-search-ph, .den-search kbd { display: none; }",
    "  .den-top .v-pill { display: none; }",
    // Never wider than the window (SA's dev.20 run: 429px at 400): a long
    // product name gives way first, the stale-server pill keeps its ⚠.
    "  .den-brand { min-width: 0; flex: 0 1 auto; }",
    "  .den-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }",
    "  .den-top .stale-lbl { display: none; }",
    "  .den-chips { flex-shrink: 0; }",
    "}",
    // Below 480px only the mark shows: the title stays the link's name,
    // visually hidden (SA's dev.21 run).
    "@media (max-width: 479.98px) {",
    "  .den-title { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;",
    "    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }",
    "}",
    "@media (prefers-reduced-motion: reduce) { .den-rail { transition: none; } }",
  ].join("\n");
  document.head.appendChild(style);
})();
