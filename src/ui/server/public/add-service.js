/**
 * Issue 806: Projects' Add Service, drawn by the kit's dialog frame
 * (dialogHtml and mountDialog, through dialog-den.js), in the page's
 * language. Before, it was a full-window pop-up of the page's own, in
 * English only.
 *
 * It chooses a repo to add to a project: from this machine (Local) or
 * from GitHub. A GitHub repo also takes its mode and branches. Add sends
 * POST /api/workspaces/services; a refusal is said inside the dialog,
 * which stays open. Esc and Close shut it, focus goes back to what opened
 * it, and the Report button sits in its footer (all the kit's).
 *
 *   setRepos({ local, managed, services })   what the page last fetched
 *   setGhRepos(list)                         GitHub's list, when known
 *   openAddService({ ws, filter, onAdded })  shows it; onAdded({ text,
 *                                            kind }) after an add
 */
import { comboHtml, pageLoad, wireCombo } from "/combobox.js";
import { dialogHtml, mountDialog } from "/dialog-den.js";
import { hydratePager, pagerHtml } from "/kit/pager.js";

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const st = {
  ws: null,
  local: [],
  managed: [],
  services: {},
  gh: null, // null: not loaded yet
  ghQ: "",
  selLocal: null,
  selGh: null,
  sort: "name", // "name" | "workspace"
  tab: "local",
  onAdded: null,
  frame: null,
  branchCombo: null,
};

/** The repos the page fetched for the project it shows. */
export function setRepos({ local, managed, services } = {}) {
  st.local = local ?? [];
  st.managed = managed ?? [];
  st.services = services ?? {};
}

/** GitHub's repos, fetched ahead so the dialog opens with them. */
export function setGhRepos(list) {
  const items = pageItems(list);
  if (items.length) st.gh = items;
}

const pageItems = (r) =>
  Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : [];
const ghQ = (v, re) => (re.test(v) ? v : "");
let ghSeq = 0;
let ghTimer = 0;
const pg = { per: 50, froms: [1], next: null, prev: null, ctl: null };
const PAGER_WORDS = [
  "range",
  "rangeOpen",
  "label",
  "first",
  "firstSr",
  "prev",
  "prevSr",
  "next",
  "nextSr",
  "last",
  "lastSr",
  "pageOf",
  "pageShort",
  "pageSr",
  "go",
  "perPage",
  "more",
];
const pagerWords = () =>
  Object.fromEntries(PAGER_WORDS.map((k) => [k, t(`pager.${k}`)]));

const dlg = () => st.frame?.dialog ?? null;
const $ = (sel) => dlg()?.querySelector(sel) ?? null;
const query = () => ($("#add-svc-global-search")?.value || "").toLowerCase();

function addedSet() {
  const s = new Set();
  for (const key of Object.keys(st.services)) {
    s.add(key);
    const slash = key.indexOf("/");
    if (slash > 0) s.add(key.slice(0, slash));
  }
  return s;
}

/** __DEN_WORKSPACES_DIR__/<name>/... → <name> */
function wsOf(relPath) {
  const m = /^__DEN_WORKSPACES_DIR__\/([^/]+)\//.exec(relPath);
  return m ? m[1] : null;
}

const empty = (text) => `<div class="add-svc-empty">${esc(text)}</div>`;
const label = (text) => `<div class="add-svc-section-label">${esc(text)}</div>`;
const pill = (cls, text) =>
  `<span class="add-svc-pill ${cls}">${esc(text)}</span>`;

function renderLocal() {
  const list = $("#add-svc-local-list");
  if (!list) return;
  const added = addedSet();
  const all = [...st.local, ...st.managed];
  if (!all.length) {
    list.innerHTML = empty(t("addSvc.noLocal"));
    $("#add-svc-local-count").textContent = "";
    return;
  }
  const q = query();
  const hit = (r) =>
    !q ||
    r.name.toLowerCase().includes(q) ||
    r.relPath.toLowerCase().includes(q) ||
    (r.absPath || "").toLowerCase().includes(q);
  const sorted = (arr) =>
    st.sort === "name"
      ? [...arr].sort((a, b) => a.name.localeCompare(b.name))
      : [...arr].sort(
          (a, b) =>
            (wsOf(a.relPath) || "").localeCompare(wsOf(b.relPath) || "") ||
            a.name.localeCompare(b.name),
        );
  const row = (r) => {
    const isAdded = added.has(r.relPath);
    const ws = wsOf(r.relPath);
    const cls =
      "add-svc-row" +
      (isAdded ? " already" : " selectable") +
      (st.selLocal?.relPath === r.relPath ? " selected" : "");
    return (
      `<button type="button" class="${cls}" data-as-local="${esc(r.relPath)}"` +
      ` aria-pressed="${st.selLocal?.relPath === r.relPath}"${isAdded ? " disabled" : ""}>` +
      `<span class="add-svc-row-info"><span class="add-svc-name" data-as-name>${esc(r.name + (r.currentBranch ? " @ " + r.currentBranch : ""))}</span>` +
      `<span class="add-svc-row-path">${esc(r.relPath)}</span></span>` +
      (ws ? `<span class="add-svc-ws-badge">${esc(ws)}</span>` : "") +
      (isAdded ? pill("added", t("addSvc.added")) : "") +
      `</button>`
    );
  };
  const mine = sorted(st.local.filter(hit));
  const ours = sorted(st.managed.filter(hit));
  const free = [...mine, ...ours].filter((r) => !added.has(r.relPath)).length;
  $("#add-svc-local-count").textContent = free ? `(${free})` : "";
  for (const b of dlg().querySelectorAll("[data-as-sort]")) {
    const on = b.dataset.asSort === st.sort;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  }
  let html = "";
  if (mine.length)
    html += label(t("addSvc.group.dev")) + mine.map(row).join("");
  if (ours.length)
    html += label(t("addSvc.group.managed")) + ours.map(row).join("");
  list.innerHTML = html || empty(t("addSvc.noResults"));
}

function loadGh(refresh, q = "", cursor = "") {
  if (!q && !cursor) st.gh = null;
  if (!cursor) pg.froms = [1];
  const seq = ++ghSeq;
  const p = new URLSearchParams({ limit: String(pg.per) });
  if (q) p.set("q", q);
  if (cursor) p.set("cursor", cursor);
  if (refresh) p.set("refresh", "1");
  fetch(`/api/github/repos?${p}`)
    .then((r) => r.json())
    .catch(() => [])
    .then((repos) => {
      if (seq !== ghSeq) return;
      st.gh = pageItems(repos);
      pg.next = repos?.next ?? null;
      pg.prev = repos?.prev ?? null;
      renderGh();
    });
}

function ghHref(target) {
  if (typeof target === "object") return target.per ? `?per=${target.per}` : "";
  const on = { first: pg.froms.length > 1, prev: !!pg.prev, next: !!pg.next };
  return on[target] ? `?gh=${target}` : "";
}

function ghNavigate(ask) {
  if (ask.kind === "per") {
    pg.per = Number(ask.target?.per) || pg.per;
    return loadGh(false, st.ghQ);
  }
  const from = pg.froms[pg.froms.length - 1];
  if (ask.target === "next" && pg.next) {
    pg.froms.push(from + (st.gh?.length ?? 0));
    loadGh(false, st.ghQ, pg.next);
  } else if (ask.target === "prev" && pg.prev) {
    const back = pg.froms.slice(0, -1);
    loadGh(false, st.ghQ, pg.prev);
    pg.froms = back.length ? back : [1];
  } else if (ask.target === "first") loadGh(false, st.ghQ);
}

function renderGhPager() {
  const foot = $("#add-svc-gh-pager");
  pg.ctl?.destroy();
  pg.ctl = null;
  if (!foot) return;
  const n = st.gh?.length ?? 0;
  const from = pg.froms[pg.froms.length - 1];
  foot.innerHTML = n
    ? pagerHtml({
        from,
        to: from + n - 1,
        page: pg.froms.length,
        hasNext: !!pg.next,
        per: pg.per,
        perOptions: [25, 50, 100],
        href: ghHref,
        lang: document.documentElement.lang || "en",
        words: pagerWords(),
      })
    : "";
  const nav = foot.querySelector(".den-pager");
  if (nav)
    pg.ctl = hydratePager(nav, {
      list: "add-svc-gh-list",
      onNavigate: ghNavigate,
    });
}

function renderGh() {
  drawGhList();
  renderGhPager();
}

function drawGhList() {
  const list = $("#add-svc-gh-list");
  if (!list) return;
  if (!st.gh) {
    list.innerHTML = empty(t("addSvc.ghLoading"));
    return;
  }
  const q = query();
  const added = addedSet();
  const shown = (r) =>
    !r.isArchived && (!q || r.name.toLowerCase().includes(q));
  const yes = st.gh.filter((r) => r.hasDen && shown(r));
  const no = st.gh.filter((r) => !r.hasDen && shown(r));
  const n = yes.length + no.length;
  $("#add-svc-gh-count").textContent = n ? `(${n})` : "";
  if (!n) {
    list.innerHTML = empty(
      q
        ? t("addSvc.ghNoMatch", { q: $("#add-svc-global-search").value })
        : t("addSvc.ghNone"),
    );
    return;
  }
  const row = (r) => {
    const sel = st.selGh?.name === r.name;
    return (
      `<button type="button" class="add-svc-row selectable${sel ? " selected" : ""}${added.has(r.name) ? " already" : ""}"` +
      ` data-as-gh="${esc(r.name)}" aria-pressed="${sel}">` +
      `<span class="add-svc-name" data-as-name>${esc(r.name)}</span>` +
      (r.hasDen
        ? `<span class="add-svc-pill supported" translate="no">✓ __DEN_CLI__</span>`
        : pill("no-manifest", t("addSvc.noManifest"))) +
      (added.has(r.name) ? pill("added", t("addSvc.added")) : "") +
      `</button>`
    );
  };
  let html = "";
  if (yes.length)
    html += label(t("addSvc.group.supported")) + yes.map(row).join("");
  if (no.length)
    html += label(t("addSvc.group.unsupported")) + no.map(row).join("");
  list.innerHTML = html;
}

function sync() {
  const local = st.tab === "local";
  for (const b of dlg().querySelectorAll("[data-as-tab]")) {
    const on = b.dataset.asTab === st.tab;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  }
  $("#add-svc-panel-local").hidden = !local;
  $("#add-svc-panel-gh").hidden = local;
  $("#add-svc-gh-config").hidden = local || !st.selGh;
  $('[data-as="add"]').disabled = local ? !st.selLocal : !st.selGh;
}

function setTab(tab) {
  st.tab = tab;
  if (tab === "local") st.selGh = null;
  else st.selLocal = null;
  renderLocal();
  renderGh();
  sync();
}

function say(text, kind) {
  const m = $("#add-svc-msg");
  if (!m) return;
  m.textContent = text;
  m.className = `add-svc-msg${kind ? ` ${kind}` : ""}`;
}

function pickGh(repo) {
  st.selGh = repo;
  renderGh();
  say("");
  $("#add-svc-config-name").textContent = repo.name;
  for (const r of dlg().querySelectorAll('input[name="add-svc-mode"]'))
    r.checked = r.value === "dev-managed";
  const first = repo.defaultBranch || "main";
  const branch = $("#add-svc-branch");
  branch.value = first;
  branch.placeholder = first;
  st.branchCombo?.set(first);
  $("#add-svc-newbranch").value = "";
  sync();
}

/** What the add sends, from what is chosen and filled. */
function request() {
  if (st.tab === "local") {
    const r = st.selLocal;
    if (!r) return null;
    const managed = r.source === "managed";
    return {
      name: r.relPath,
      body: {
        workspace: st.ws,
        address: r.relPath,
        mode: managed ? "managed" : "dev-managed",
        linkedPath: r.source === "local" ? r.absPath || undefined : undefined,
        branch: managed ? r.currentBranch || "main" : "main",
      },
    };
  }
  const r = st.selGh;
  if (!r) return null;
  return {
    name: r.name,
    body: {
      workspace: st.ws,
      address: r.name,
      mode:
        dlg().querySelector('input[name="add-svc-mode"]:checked')?.value ??
        "dev-managed",
      ghSlug: r.nameWithOwner,
      branch: $("#add-svc-branch").value.trim() || "main",
      newBranch: $("#add-svc-newbranch").value.trim() || undefined,
    },
  };
}

async function add() {
  const req = request();
  if (!req) return;
  const btn = $('[data-as="add"]');
  btn.disabled = true;
  say("");
  let data;
  try {
    // BUSY-1: through the working pop-up. A quick refusal (or no answer
    // before it opens) comes back here and says why inside the dialog.
    const run = (headers) =>
      window.denShell.api("POST", "/api/workspaces/services", req.body, {
        headers,
      });
    const busy = window.denShell?.busyAction;
    data = busy
      ? await busy("add-service", run, {
          button: btn,
          vars: { name: req.name },
          quietFail: true,
          inlineError: true,
          // The dialog says it was added (and what setup still needs).
          skipDone: () => true,
        })
      : await run({});
    // A slow failure: the failure pop-up said it; the dialog stays.
    if (data === null) {
      btn.disabled = false;
      return;
    }
  } catch (err) {
    // R26c: the server's message, inside the dialog.
    btn.disabled = false;
    say(err?.message || String(err), "err");
    return;
  }
  if (!data || typeof data !== "object") data = {};
  const missing = Array.isArray(data.missingDeps) ? data.missingDeps : [];
  let text = t(data.setupStarted ? "addSvc.doneSetup" : "addSvc.done", {
    name: req.name,
  });
  if (missing.length)
    text += ` ${t("addSvc.missingDeps", { deps: missing.join(", ") })}`;
  const done = st.onAdded;
  st.frame?.close("added");
  await done?.({ text, kind: missing.length ? "warn" : "ok" });
}

function bodyHtml() {
  return (
    `<div class="add-svc-top">` +
    `<input class="add-svc-search" id="add-svc-global-search" type="search" autocomplete="off"` +
    ` placeholder="${esc(t("addSvc.filterPh"))}" aria-label="${esc(t("addSvc.filter"))}">` +
    `<div class="add-svc-tabs" role="tablist">` +
    `<button type="button" class="add-svc-tab" role="tab" data-as-tab="local" aria-controls="add-svc-panel-local">${esc(t("addSvc.tab.local"))} <span class="add-svc-tab-count" id="add-svc-local-count"></span></button>` +
    `<button type="button" class="add-svc-tab" role="tab" data-as-tab="gh" aria-controls="add-svc-panel-gh">${esc(t("addSvc.tab.gh"))} <span class="add-svc-tab-count" id="add-svc-gh-count"></span></button>` +
    `</div></div>` +
    `<div class="add-svc-body" id="add-svc-panel-local" role="tabpanel">` +
    `<div class="add-svc-tools"><span class="add-svc-tools-l">${esc(t("addSvc.sortBy"))}</span>` +
    `<span class="svc-sort-btns">` +
    `<button type="button" class="svc-sort-btn" data-as-sort="name">${esc(t("addSvc.sort.name"))}</button>` +
    `<button type="button" class="svc-sort-btn" data-as-sort="workspace">${esc(t("addSvc.sort.project"))}</button>` +
    `</span></div>` +
    `<div id="add-svc-local-list">${empty(t("addSvc.loading"))}</div></div>` +
    `<div class="add-svc-body" id="add-svc-panel-gh" role="tabpanel" hidden>` +
    `<div class="add-svc-tools"><button type="button" class="add-svc-refresh-btn" data-as="refresh" title="${esc(t("addSvc.refreshTip"))}">↻ ${esc(t("addSvc.refresh"))}</button></div>` +
    `<div id="add-svc-gh-list"></div><div id="add-svc-gh-pager"></div></div>`
  );
}

function footHtml() {
  return (
    `<div class="add-svc-foot">` +
    `<div class="add-svc-gh-config" id="add-svc-gh-config" hidden>` +
    `<div class="add-svc-config-name" id="add-svc-config-name"></div>` +
    `<div class="add-svc-config-row" role="radiogroup" aria-label="${esc(t("addSvc.manage"))}">` +
    `<span class="add-svc-config-l">${esc(t("addSvc.manage"))}</span>` +
    `<span class="add-svc-radio">` +
    `<label><input type="radio" name="add-svc-mode" value="dev-managed" checked> ${esc(t("addSvc.mode.dev"))}</label>` +
    `<label><input type="radio" name="add-svc-mode" value="managed"> ${esc(t("addSvc.mode.managed"))}</label>` +
    `</span></div>` +
    `<div class="add-svc-config-row">` +
    `<label class="add-svc-config-l" for="add-svc-branch">${esc(t("addSvc.branch"))}</label>` +
    comboHtml({
      id: "add-svc-branch",
      label: t("addSvc.branch"),
      bare: true,
      cls: "add-svc-inp",
    }) +
    `<label class="add-svc-config-l" for="add-svc-newbranch">${esc(t("addSvc.newBranch"))}</label>` +
    `<input class="add-svc-inp" id="add-svc-newbranch" autocomplete="off" placeholder="${esc(t("addSvc.optional"))}">` +
    `</div></div>` +
    `<p class="add-svc-msg" id="add-svc-msg" role="status" aria-live="polite"></p>` +
    `</div>`
  );
}

/** Add Service for project `ws`; `filter` starts the search with a name. */
export function openAddService({ ws, filter = "", onAdded, opener } = {}) {
  st.ws = ws;
  st.selLocal = null;
  st.selGh = null;
  st.onAdded = onAdded ?? null;
  st.frame = mountDialog(
    dialogHtml({
      kind: "panel",
      id: "add-svc-dlg",
      className: "add-svc-dlg",
      title: t("addSvc.title", { ws }),
      body: bodyHtml(),
      foot: footHtml(),
      actions: [
        {
          label: t("addSvc.add"),
          type: "button",
          kind: "primary",
          attrs: { "data-as": "add", disabled: true },
        },
      ],
    }),
    { opener, focus: "#add-svc-global-search", show: false },
  );
  const d = st.frame.dialog;
  st.branchCombo = wireCombo(d, "add-svc-branch", {
    free: true,
    load: pageLoad(() =>
      st.selGh?.nameWithOwner
        ? `/api/github/branches?gh=${encodeURIComponent(st.selGh.nameWithOwner)}`
        : "",
    ),
    words: { more: t("combo.narrow"), none: t("combo.none") },
  });
  d.addEventListener("input", (e) => {
    if (e.target.id !== "add-svc-global-search") return;
    clearTimeout(ghTimer);
    const v = e.target.value.trim();
    renderLocal();
    renderGh();
    const q = ghQ(v, /^[A-Za-z0-9._-]{1,100}$/);
    if (q !== st.ghQ) {
      st.ghQ = q;
      ghTimer = setTimeout(() => loadGh(false, q), 250);
    }
  });
  d.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || !d.contains(b)) return;
    if (b.dataset.asTab) setTab(b.dataset.asTab);
    else if (b.dataset.asSort) {
      st.sort = b.dataset.asSort;
      renderLocal();
    } else if (b.dataset.asLocal != null) {
      st.selLocal =
        [...st.local, ...st.managed].find(
          (r) => r.relPath === b.dataset.asLocal,
        ) ?? null;
      renderLocal();
      sync();
    } else if (b.dataset.asGh != null) {
      const r = (st.gh ?? []).find((x) => x.name === b.dataset.asGh);
      if (r) pickGh(r);
    } else if (b.dataset.as === "refresh") {
      $("#add-svc-gh-list").innerHTML = empty(t("addSvc.refreshing"));
      loadGh(true);
    } else if (b.dataset.as === "add") void add();
  });
  $("#add-svc-global-search").value = filter;
  if (!st.gh) loadGh(false);
  const free = [...st.local, ...st.managed].some((r) => !r.alreadyAdded);
  setTab(free ? "local" : "gh");
  st.frame.show(opener);
  return st.frame;
}
