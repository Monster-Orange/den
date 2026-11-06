/**
 * The graph's details panel. Everything in it comes from three registries,
 * so a new panel (tests, security, releases, a distribution's own) is one
 * entry in each:
 *
 *   ACTIONS  { id, label, for: ["service"|"repo"], when(x), tier: "common"|"commands"|"tools"|"danger",
 *              primaryWhen?(x), disabled?(x) → reason string, confirm?: true, run(x) }
 *   TABS     { id, label, for, when?(x), order }
 *   SECTIONS { id, tab, title?, for, when?(x), order, render(x) → HTMLElement|string }
 *
 * Kinds: "service" (x = a model service) and "repo" (x = { repo, services }).
 * Tiering (graph-model.js resolveActions): one primary, up to two common
 * actions beside it, the rest in More grouped as Manifest commands / Tools /
 * Careful; Careful actions confirm inline on a second click.
 *
 * graph.js binds the context (model, hooks, view helpers) with bindPanel().
 */
import {
  commandTier,
  connections,
  entryOf,
  fmtMs,
  healthLine,
  isLocal,
  orgOf,
  placeGlyph,
  placementText,
  remoteWhy,
  repoPlacement,
  resolveActions,
  status,
  statusWord,
} from "/graph-model.js";

/** ctx: { model(), st, hooks, toast(msg), selectTab(id), focusOn(sel), refresh() } */
let C = null;
export function bindPanel(ctx) {
  C = ctx;
}

export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const has = (s, c) => s.commands.includes(c);
/** Runs here: local, has a runtime, and is on disk. */
const runsHere = (s) => isLocal(s) && s.runs !== "none" && s.cloned;
const repoEntry = (r) => entryOf(C.model(), r.repo);
const anyHere = (r) => r.services.some(runsHere);
const LIFECYCLE = ["up", "down", "restart"];

/** Restart is the declared command, or down + up when both exist (as the CLI). */
const canRestart = (s) => has(s, "restart") || (has(s, "up") && has(s, "down"));

export const ACTIONS = [
  // ── service ──
  {
    id: "start",
    label: "Start",
    for: ["service"],
    tier: "common",
    when: (s) => runsHere(s) && has(s, "up") && s.health.ok !== true,
    primaryWhen: (s) => s.health.ok === false,
    run: (s) => C.hooks.runCmd(s, "up"),
  },
  {
    id: "start-remote",
    label: "Start",
    for: ["service"],
    tier: "common",
    when: (s) => !isLocal(s),
    disabled: remoteWhy,
    run: () => {},
  },
  {
    id: "open",
    label: "Open ↗",
    for: ["service"],
    tier: "common",
    when: (s) => !!(s.open || s.target?.url),
    primaryWhen: (s) => s.health.ok !== false || !isLocal(s),
    run: (s) => window.open(s.open || s.target.url, "_blank", "noopener"),
  },
  {
    id: "logs",
    label: "Logs",
    for: ["service"],
    tier: "common",
    when: runsHere,
    primaryWhen: () => true,
    run: () => C.selectTab("logs"),
  },
  {
    id: "restart",
    label: "Restart",
    for: ["service"],
    tier: "common",
    when: (s) => runsHere(s) && canRestart(s),
    run: (s) => C.hooks.runCmd(s, "restart"),
  },
  {
    id: "up-deps",
    label: "Start with dependencies",
    for: ["service"],
    tier: "common",
    when: (s) => runsHere(s) && has(s, "up"),
    run: (s) => C.hooks.upWithDeps(s.repo),
  },
  // ── repo (system-level: runs against the repo's entrypoint, as the CLI does) ──
  {
    id: "repo-start",
    label: "Start",
    for: ["repo"],
    tier: "common",
    when: (r) => runsHere(repoEntry(r)) && has(repoEntry(r), "up"),
    primaryWhen: (r) =>
      r.services.some((s) => runsHere(s) && s.health.ok === false),
    run: (r) => C.hooks.runCmd(repoEntry(r), "up"),
  },
  {
    id: "repo-logs",
    label: "Logs",
    for: ["repo"],
    tier: "common",
    when: anyHere,
    primaryWhen: () => true,
    run: (r) => C.focusOn({ id: repoEntry(r).id, tab: "logs" }),
  },
  {
    id: "repo-restart",
    label: "Restart",
    for: ["repo"],
    tier: "common",
    when: (r) => runsHere(repoEntry(r)) && canRestart(repoEntry(r)),
    run: (r) => C.hooks.runCmd(repoEntry(r), "restart"),
  },
  {
    id: "repo-up-deps",
    label: "Start with dependencies",
    for: ["repo"],
    tier: "common",
    when: anyHere,
    run: (r) => C.hooks.upWithDeps(r.repo),
  },
  // ── tools ──
  {
    id: "terminal",
    label: "Terminal in repo",
    for: ["service", "repo"],
    tier: "tools",
    when: (x) => {
      const s = x.services ? x.services[0] : x;
      return isLocal(s) && s.cloned && !!s.path;
    },
    run: (x) => C.hooks.openTerminal((x.services ? x.services[0] : x).path),
  },
  {
    id: "editor",
    label: "Open in editor",
    for: ["service", "repo"],
    tier: "tools",
    when: (x) => {
      const s = x.services ? x.services[0] : x;
      return isLocal(s) && s.cloned && !!s.path;
    },
    run: (x) => C.hooks.openEditor((x.services ? x.services[0] : x).path),
  },
  {
    id: "logs-page",
    label: "Open in Logs",
    for: ["service"],
    tier: "tools",
    when: runsHere,
    run: (s) => C.hooks.openLogsPage(s),
  },
  {
    id: "output",
    label: "Show output pane",
    for: ["service", "repo"],
    tier: "tools",
    when: (x) => (x.services ? anyHere(x) : runsHere(x)),
    run: (x) => C.hooks.showOutput(x.services ? repoEntry(x) : x),
  },
  {
    id: "recheck",
    label: "Re-check health",
    for: ["service", "repo"],
    tier: "tools",
    when: () => true,
    run: (x) => C.recheck(x.services ? x.services : [x]),
  },
  {
    id: "autostart",
    label: "Auto-start",
    for: ["service", "repo"],
    tier: "tools",
    when: (x) => isLocal(x.services ? x.services[0] : x),
    labelFor: (x) =>
      (x.services ? x.services[0] : x).autostart
        ? "Auto-start: on (turn off)"
        : "Auto-start: off (turn on)",
    run: (x) => {
      const s = x.services ? x.services[0] : x;
      C.hooks.toggleAutostart(s.repo, !s.autostart);
    },
  },
  {
    id: "mode",
    label: "Switch mode",
    for: ["service", "repo"],
    tier: "tools",
    when: (x) => isLocal(x.services ? x.services[0] : x),
    labelFor: (x) =>
      (x.services ? x.services[0] : x).mode === "managed"
        ? "Use my local checkout"
        : "Use a managed clone",
    run: (x) => {
      const s = x.services ? x.services[0] : x;
      C.hooks.switchMode(
        s.repo,
        s.mode === "managed" ? "dev-managed" : "managed",
      );
    },
  },
  {
    id: "sync",
    label: "Sync",
    for: ["service", "repo"],
    tier: "tools",
    when: (x) => {
      const s = x.services ? x.services[0] : x;
      return isLocal(s) && s.mode === "managed";
    },
    labelFor: (x) =>
      (x.services ? x.services : [x]).some((s) => !s.cloned)
        ? "Clone"
        : "Sync (down, pull, setup)",
    run: (x) => C.hooks.sync(x.repo),
  },
  {
    id: "copy",
    label: "Copy address",
    for: ["service"],
    tier: "tools",
    when: () => true,
    run: (s) => {
      navigator.clipboard?.writeText(s.id).then(
        () => C.toast("Copied " + s.id),
        () => {},
      );
    },
  },
  // ── careful ──
  {
    id: "stop",
    label: "Stop",
    for: ["service"],
    tier: "danger",
    confirm: true,
    when: (s) => runsHere(s) && has(s, "down"),
    run: (s) => C.hooks.runCmd(s, "down"),
  },
  {
    id: "down-deps",
    label: "Stop with dependencies",
    for: ["service"],
    tier: "danger",
    confirm: true,
    when: (s) => runsHere(s) && has(s, "down"),
    run: (s) => C.hooks.downWithDeps(s.repo),
  },
  {
    id: "repo-stop",
    label: "Stop",
    for: ["repo"],
    tier: "danger",
    confirm: true,
    when: (r) => runsHere(repoEntry(r)) && has(repoEntry(r), "down"),
    run: (r) => C.hooks.runCmd(repoEntry(r), "down"),
  },
  {
    id: "repo-down-deps",
    label: "Stop with dependencies",
    for: ["repo"],
    tier: "danger",
    confirm: true,
    when: anyHere,
    run: (r) => C.hooks.downWithDeps(r.repo),
  },
];

/**
 * Pin or unpin to the rail (R14): the shell's Pinned group. A preference
 * only (/api/settings `shell.pins`). Absent outside the shell.
 */
function pinButton(id) {
  const sh = typeof window !== "undefined" ? window.denShell : null;
  if (!sh) return "";
  const on = sh.isPinned(id);
  const label = `${on ? "Unpin" : "Pin"} ${id}`;
  return `<button class="dg-ib" data-pin-toggle="${esc(id)}" aria-pressed="${on}" title="${esc(label)}" aria-label="${esc(label)}">${on ? "★" : "☆"}</button>`;
}

/** The manifest's own commands (setup, seed, reset-db, …) become actions too. */
function commandActions(s) {
  if (!runsHere(s)) return [];
  return s.commands
    .filter((c) => !LIFECYCLE.includes(c))
    .map((c) => ({
      id: "cmd:" + c,
      label: "Run " + c,
      for: ["service"],
      tier: commandTier(c),
      confirm: commandTier(c) === "danger",
      when: () => true,
      run: (x) => C.hooks.runCmd(x, c),
    }));
}

export function actionsFor(x) {
  const kind = x.services ? "repo" : "service";
  return resolveActions(
    [...ACTIONS, ...(kind === "service" ? commandActions(x) : [])],
    x,
    kind,
  );
}

export const TABS = [
  { id: "services", label: "Services", for: ["repo"], order: 0 },
  { id: "overview", label: "Overview", for: ["service", "repo"], order: 1 },
  { id: "logs", label: "Logs", for: ["service"], when: runsHere, order: 2 },
  { id: "config", label: "Config", for: ["service", "repo"], order: 3 },
  { id: "activity", label: "Activity", for: ["service", "repo"], order: 4 },
];

const kv = (rows) =>
  `<dl class="kv">${rows
    .filter(Boolean)
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join("")}</dl>`;
const none = (t) => `<span class="dg-none">${esc(t)}</span>`;
const checkText = (s) =>
  s.health.url
    ? `<code>GET ${esc(s.health.url)}</code>`
    : s.health.check
      ? `<code>${esc(s.health.check)}</code>`
      : none("none declared");
function chip(id) {
  const s = C.model().byId.get(id);
  if (!s) return `<span class="dg-chip">${esc(id)}</span>`;
  return `<button class="dg-chip" data-goto="${esc(id)}"><span class="dg-dot ${status(s)}"></span>${esc(id)}${s.runs === "remote" ? " ☁" : ""}</button>`;
}
const refChip = (r) =>
  r.id
    ? chip(r.id)
    : `<button class="dg-chip" data-goto-repo="${esc(r.repo)}">${esc(r.repo)} ${placeGlyph(repoPlacement(C.model(), r.repo))}</button>`;
function logsText(l) {
  if (!l) return null;
  if (typeof l === "string") return l;
  if (l.type === "shell") return l.cmd;
  if (l.type === "cloudwatch")
    return `cloudwatch ${l.logGroup}${l.logStream ? " / " + l.logStream : ""}`;
  return l.type;
}
const hhmm = (ts) => {
  const d = new Date(ts);
  return isNaN(d) ? "" : d.toTimeString().slice(0, 5);
};

export const SECTIONS = [
  // Overview: is it OK, where is it, what does it touch
  {
    id: "remote-note",
    tab: "overview",
    for: ["service"],
    order: 0,
    when: (s) => !isLocal(s),
    render: (s) =>
      `<p class="dg-callout">☁ Runs in <b>${esc(s.target?.env || "a remote env")}</b>${s.target?.account ? " · " + esc(s.target.account) : ""}. Start, stop and logs happen there, not on this machine.</p>`,
  },
  {
    id: "health",
    tab: "overview",
    title: "Health",
    for: ["service"],
    order: 10,
    render: (s) =>
      kv([
        [
          "Status",
          `<span class="dg-pill ${status(s)}">${esc(statusWord(s))}</span> ${s.health.ms != null ? `<span class="dg-muted">${fmtMs(s.health.ms)}</span>` : ""}${s.health.error ? ` <span class="dg-muted">${esc(s.health.error)}</span>` : ""}`,
        ],
        ["Check", checkText(s)],
        (s.open || s.target?.url) && [
          "Opens",
          `<a href="${esc(s.open || s.target.url)}" target="_blank" rel="noopener">${esc(s.open || s.target.url)}</a>`,
        ],
      ]),
  },
  {
    id: "health-roll",
    tab: "overview",
    title: "Health",
    for: ["repo"],
    order: 10,
    render: (r) => {
      const ok = r.services.filter((s) => s.health.ok).length;
      const p = repoPlacement(C.model(), r.repo);
      return kv([
        [
          "Services",
          `<span class="dg-pill ${ok === r.services.length ? "ok" : "bad"}">${ok}/${r.services.length} healthy</span>`,
        ],
        [
          "Placement",
          esc(
            {
              local: "⌂ all local",
              remote: "☁ all remote",
              none: "no runtime",
              hybrid:
                "⇄ hybrid: " +
                r.services.map((s) => `${s.name} ${s.runs}`).join(", "),
            }[p],
          ),
        ],
      ]);
    },
  },
  {
    id: "connections",
    tab: "overview",
    title: "Connections",
    for: ["service", "repo"],
    order: 20,
    render: (x) => {
      const c = connections(C.model(), x);
      return `<div class="dg-conn"><div><h4>Depends on</h4>${c.deps.length ? `<div class="dg-chips">${c.deps.map(refChip).join("")}</div>` : none("nothing")}</div><div><h4>Used by</h4>${c.users.length ? `<div class="dg-chips">${c.users.map(refChip).join("")}</div>` : none("nothing in this workspace")}</div></div>`;
    },
  },
  {
    id: "missing",
    tab: "overview",
    title: "Missing dependencies",
    for: ["service", "repo"],
    order: 25,
    when: (x) => (x.services ? x.services : [x]).some((s) => s.missing.length),
    render: (x) => {
      const deps = [
        ...new Set((x.services ? x.services : [x]).flatMap((s) => s.missing)),
      ];
      return `<p class="dg-muted" style="margin:0 0 8px;font-size:13px">Declared but not in this workspace.</p><ul class="cmds">${deps.map((d) => `<li><code>${esc(d)}</code><button class="dg-btn sm" data-add-dep="${esc(d)}">Add</button></li>`).join("")}</ul>`;
    },
  },
  {
    id: "about",
    tab: "overview",
    title: "About",
    for: ["service"],
    order: 30,
    render: (s) =>
      kv([
        [
          "Role",
          [s.entry && "entry point", s.infra && "infrastructure"]
            .filter(Boolean)
            .join(", ") || "service",
        ],
        ["Application", esc(s.app)],
        ["Branch", s.branch ? `⎇ ${esc(s.branch)}` : none("unknown")],
        [
          "Starts",
          s.autostart ? "with the workspace" : "on demand (auto-start off)",
        ],
        !s.cloned && ["On disk", "not cloned yet: Sync clones it"],
      ]),
  },
  {
    id: "about-repo",
    tab: "overview",
    title: "About",
    for: ["repo"],
    order: 30,
    render: (r) =>
      kv([
        ["Application", esc(r.services[0].app)],
        [
          "Branch",
          r.services[0].branch
            ? `⎇ ${esc(r.services[0].branch)}`
            : none("unknown"),
        ],
        ["Mode", esc(r.services[0].mode)],
        [
          "Starts",
          r.services[0].autostart
            ? "with the workspace"
            : "on demand (auto-start off)",
        ],
      ]),
  },
  // Services (repo): each row with its own primary action
  {
    id: "svc-list",
    tab: "services",
    for: ["repo"],
    order: 0,
    render: (r) =>
      `<table class="svc"><tbody>${r.services
        .map((s) => {
          const a = actionsFor(s);
          return `<tr><td><span class="dg-dot ${status(s)}"></span></td><td><button class="nm" data-goto="${esc(s.id)}">${esc(s.name)}</button>${s.entry ? ' <span class="dg-tag entry">entry</span>' : ""}${!isLocal(s) ? ' <span class="dg-badge remote">☁ ' + esc(s.target?.env || "remote") + "</span>" : ""}<div class="h">${esc(healthLine(s))}</div></td><td class="a">${a.primary ? actBtn(a.primary, s, "sm") : ""}</td></tr>`;
        })
        .join("")}</tbody></table>`,
  },
  // Logs: the live tail inline
  {
    id: "logs",
    tab: "logs",
    for: ["service"],
    order: 0,
    render: (s) => logTail(s),
  },
  // Config
  {
    id: "commands",
    tab: "config",
    title: "Commands",
    for: ["service"],
    order: 10,
    render: (s) =>
      s.commands.length
        ? `<ul class="cmds">${s.commands.map((c) => `<li><code>${esc(c)}</code>${runsHere(s) ? `<button class="dg-btn sm" data-run="${esc(c)}" data-key="${esc(s.id)}" ${commandTier(c) === "danger" || c === "down" ? "data-confirm" : ""}>Run</button>` : ""}</li>`).join("")}</ul>`
        : none(isLocal(s) ? "none declared" : "none here: it runs remotely"),
  },
  {
    id: "source",
    tab: "config",
    title: "Where it comes from",
    for: ["service", "repo"],
    order: 20,
    render: (x) => {
      const s = x.services ? x.services[0] : x;
      return kv([
        ["Repo", s.path ? `<code>${esc(s.path)}</code>` : none("unknown")],
        [
          "Manifest",
          s.manifestLayers.length
            ? `<span class="dg-layers">${s.manifestLayers.map((l) => `<span>${esc(l)}</span>`).join("")}</span>`
            : none("none found"),
        ],
        ["Mode", esc(s.mode)],
        !x.services && [
          "Logs from",
          logsText(s.logs)
            ? `<code>${esc(logsText(s.logs))}</code>`
            : isLocal(s)
              ? none("the service's own log file")
              : none("the remote env"),
        ],
        !x.services && ["Health check", checkText(s)],
      ]);
    },
  },
  // Activity: the audit trail (R14), yours and agents'
  {
    id: "activity",
    tab: "activity",
    for: ["service", "repo"],
    order: 0,
    render: (x) => activityList(x),
  },
];

function actBtn(a, x, cls = "") {
  const why = a.disabled?.(x);
  const label = a.labelFor ? a.labelFor(x) : a.label;
  return `<button class="dg-btn ${cls}" data-action="${esc(a.id)}" data-key="${esc(x.services ? "repo:" + x.repo : x.id)}" ${a.confirm ? "data-confirm" : ""} ${why ? `disabled title="${esc(why)}"` : ""}>${esc(label)}</button>`;
}
export { actBtn };

const GROUP_LABEL = {
  common: "More actions",
  commands: "Manifest commands",
  tools: "Tools",
  danger: "Careful",
};
function actionBar(x) {
  const { primary, common, groups } = actionsFor(x);
  const key = esc(x.services ? "repo:" + x.repo : x.id);
  const menu = groups.length
    ? `<div class="dg-more"><button class="dg-btn" data-more aria-haspopup="menu" aria-expanded="false">More ▾</button><div class="dg-menu" role="menu" hidden>${groups
        .map(
          ([t, l]) =>
            `<div class="dg-mg ${t}" role="group" aria-label="${GROUP_LABEL[t]}"><div class="dg-ml">${GROUP_LABEL[t]}</div>${l
              .map((a) => {
                const why = a.disabled?.(x);
                return `<button role="menuitem" data-action="${esc(a.id)}" data-key="${key}" ${a.confirm ? "data-confirm" : ""} ${why ? `disabled title="${esc(why)}"` : ""}>${esc(a.labelFor ? a.labelFor(x) : a.label)}</button>`;
              })
              .join("")}</div>`,
        )
        .join("")}</div></div>`
    : "";
  return `<div class="dg-actions">${primary ? actBtn(primary, x, "primary") : ""}${common.map((a) => actBtn(a, x)).join("")}${menu}</div>`;
}

/** The entity behind a selection: { kind, x }. */
export function entity(sel) {
  const m = C.model();
  if (sel.repo)
    return m.byRepo.has(sel.repo)
      ? {
          kind: "repo",
          x: { repo: sel.repo, services: m.byRepo.get(sel.repo) },
        }
      : null;
  const s = m.byId.get(sel.id);
  return s ? { kind: "service", x: s } : null;
}

// Live sections (log tail, activity fetch) register a disposer here; a
// re-render or close disposes them, so one panel holds at most one stream.
let disposers = [];
export function disposePanel() {
  for (const d of disposers) d();
  disposers = [];
}

/** Fill `el` with the panel for `sel`. Returns false if the selection is gone. */
export function renderPanel(el, sel) {
  disposePanel();
  const e = entity(sel);
  if (!e) return false;
  const { kind, x } = e;
  const st = C.st;
  const m = C.model();
  const s0 = kind === "repo" ? x.services[0] : x;
  const org = orgOf(m, s0.org);
  const tabs = TABS.filter(
    (t) => t.for.includes(kind) && (!t.when || t.when(x)),
  ).sort((a, b) => a.order - b.order);
  if (!tabs.find((t) => t.id === st.tab)) st.tab = tabs[0].id;
  const ok =
    kind === "repo" ? x.services.every((s) => s.health.ok) : x.health.ok;
  const word =
    kind === "repo"
      ? `${x.services.filter((s) => s.health.ok).length}/${x.services.length} healthy`
      : statusWord(x);
  const place = kind === "repo" ? repoPlacement(m, x.repo) : x.runs;
  const placeLabel =
    kind === "repo"
      ? {
          local: "⌂ local",
          remote: "☁ remote",
          hybrid: "⇄ hybrid",
          none: "no runtime",
        }[place]
      : placementText(x);
  const pillCls = ok
    ? "ok"
    : kind === "repo"
      ? x.services.some((s) => s.health.ok === false)
        ? "bad"
        : ""
      : ok === false
        ? "bad"
        : "";
  el.innerHTML = `${st.popped ? "" : '<div class="dg-resize" data-resize title="Drag to resize"></div>'}<div class="dg-dh">
    <nav class="dg-crumbs" aria-label="Location"><span class="dg-crumb-org"><i style="background:${esc(org.color)}"></i>${esc(org.label)}</span> › <span>${esc(s0.app)}</span>${kind === "service" && m.byRepo.get(x.repo).length > 1 ? ` › <button data-goto-repo-panel="${esc(x.repo)}">${esc(x.repo)}</button>` : ""}</nav>
    <div class="t"><h2>${esc(kind === "repo" ? x.repo : x.name)}</h2><span class="dg-pill ${pillCls}">${esc(word)}</span>${place !== "local" || m.mixed ? `<span class="dg-badge ${place}">${esc(placeLabel)}</span>` : ""}
      <span class="dg-hbtns">${pinButton(kind === "repo" ? x.repo : x.id)}<button class="dg-ib" data-popout title="${st.popped ? "Dock as side panel" : "Expand to pop-up"}" aria-label="${st.popped ? "Dock as side panel" : "Expand to pop-up"}">${st.popped ? "⇲" : "⤢"}</button><button class="dg-ib" data-close aria-label="Close details">×</button></span></div>
    <div class="sub">${esc(kind === "repo" ? `${x.services.length} services · ${s0.path}` : x.id)}</div>
    ${actionBar(x)}
    <div class="dg-tabs" role="tablist">${tabs.map((t) => `<button role="tab" aria-selected="${t.id === st.tab}" data-tab="${t.id}">${esc(t.label)}</button>`).join("")}</div>
  </div><div class="dg-pbody" role="tabpanel"></div>`;
  const body = el.querySelector(".dg-pbody");
  for (const c of SECTIONS.filter(
    (c) => c.tab === st.tab && c.for.includes(kind) && (!c.when || c.when(x)),
  ).sort((a, b) => a.order - b.order)) {
    const sec = document.createElement("section");
    sec.className = "dg-sec";
    sec.dataset.section = c.id;
    if (c.title)
      sec.insertAdjacentHTML("beforeend", `<h3>${esc(c.title)}</h3>`);
    const out = c.render(x);
    if (typeof out === "string") sec.insertAdjacentHTML("beforeend", out);
    else if (out) sec.appendChild(out);
    body.appendChild(sec);
  }
  return true;
}

/** Run an action by id for a data-key ("repo:<r>" or a service id). */
export function runAction(id, key) {
  const e = entity(
    key.startsWith("repo:") ? { repo: key.slice(5) } : { id: key },
  );
  if (!e) return;
  const a = actionsFor(e.x).all.find((y) => y.id === id);
  if (a && !a.disabled?.(e.x)) a.run(e.x);
}

const TAIL_MAX = 500;
function logTail(s) {
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div class="dg-logbar"><button class="dg-btn sm" data-log="pause" aria-pressed="false">Pause</button><button class="dg-btn sm" data-log="wrap" aria-pressed="false">Wrap</button><input type="search" placeholder="Filter lines" aria-label="Filter log lines"><button class="dg-btn sm" data-log="page">Open in Logs ↗</button></div><pre class="dg-log" aria-live="off"></pre>`;
  const pre = wrap.querySelector("pre");
  const filter = wrap.querySelector("input");
  const lines = [];
  let paused = false,
    queued = false,
    open = true;
  const draw = () => {
    queued = false;
    const q = filter.value.trim().toLowerCase();
    const shown = q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
    const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
    pre.textContent = shown.length
      ? shown.join("\n")
      : open
        ? "Waiting for log lines…"
        : "The log stream ended.";
    if (atEnd) pre.scrollTop = pre.scrollHeight;
  };
  const schedule = () => {
    if (!queued && !paused) {
      queued = true;
      requestAnimationFrame(draw);
    }
  };
  draw();
  const es = new EventSource(
    `/api/service/taillog?${new URLSearchParams({ repo: s.repo, service: s.name })}`,
  );
  es.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type !== "line") return;
    lines.push(msg.text);
    if (lines.length > TAIL_MAX) lines.splice(0, lines.length - TAIL_MAX);
    schedule();
  };
  es.onerror = () => {
    es.close();
    open = false;
    schedule();
  };
  disposers.push(() => es.close());
  filter.addEventListener("input", () => {
    queued = false;
    draw();
  });
  wrap.addEventListener("click", (e) => {
    const b = e.target.closest("[data-log]");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.log === "pause") {
      paused = !paused;
      b.setAttribute("aria-pressed", String(paused));
      b.textContent = paused ? "Resume" : "Pause";
      if (!paused) draw();
    }
    if (b.dataset.log === "wrap") {
      const on = pre.classList.toggle("wrap");
      b.setAttribute("aria-pressed", String(on));
    }
    if (b.dataset.log === "page") C.hooks.openLogsPage(s);
  });
  return wrap;
}

function activityList(x) {
  const el = document.createElement("div");
  el.innerHTML = none("Loading…");
  const q = x.services
    ? `repo=${encodeURIComponent(x.repo)}`
    : `address=${encodeURIComponent(x.repo + "/" + x.name)}`;
  let live = true;
  disposers.push(() => (live = false));
  fetch(`/api/activity?${q}`)
    .then((r) => (r.ok ? r.json() : { entries: [] }))
    .catch(() => ({ entries: [] }))
    .then(({ entries = [] }) => {
      if (!live) return;
      el.innerHTML = entries.length
        ? `<ol class="act">${entries.map((a) => `<li><time datetime="${esc(a.ts)}">${esc(hhmm(a.ts))}</time><span class="dg-who ${a.actor === "agent" ? "agent" : ""}">${esc(a.actor === "agent" ? (a.agent ? "[" + a.agent + "]" : "[agent]") + (a.client ? " " + a.client : "") : "you")}</span><span>${esc(a.verb)} ${esc(a.detail)}${a.outcome === "refused" ? ` <em class="refused">refused: ${esc(a.reason || "")}</em>` : ""}</span></li>`).join("")}</ol>`
        : none(
            "No actions yet. Starts, restarts and syncs, yours and agents', show here.",
          );
    });
  return el;
}
