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
import { linkOpen } from "/term-input.js";
import {
  commandTier,
  connections,
  entryOf,
  fmtMs,
  gw,
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
    label: "Visit ↗",
    for: ["service"],
    tier: "common",
    when: (s) => !!(s.open || s.target?.url),
    primaryWhen: (s) => s.health.ok !== false || !isLocal(s),
    // D35: a real link (actBtn, the menu), never window.open: Safari
    // blocks that from a delegated click. run is for ⌘K and the like.
    href: (s) => s.open || s.target?.url,
    run: (s) => linkOpen(s.open || s.target.url),
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
        ? gw("gr.act.autostartOn", "Auto-start: on (turn off)")
        : gw("gr.act.autostartOff", "Auto-start: off (turn on)"),
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
        ? gw("gr.act.useLocal", "Use my local checkout")
        : gw("gr.act.useManaged", "Use a managed clone"),
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
        ? gw("gr.act.clone", "Clone")
        : gw("gr.act.syncFull", "Sync (down, pull, setup)"),
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
        () => C.toast(gw("gr.copied", "Copied {id}", { id: s.id })),
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
  const label = on
    ? gw("gr.unpinX", "Unpin {s}", { s: id })
    : gw("gr.pinX", "Pin {s}", { s: id });
  return `<button class="dg-ib" data-pin-toggle="${esc(id)}" aria-pressed="${on}" title="${esc(label)}" aria-label="${esc(label)}">${on ? "★" : "☆"}</button>`;
}

/** The manifest's own commands (setup, seed, reset-db, …) become actions too. */
function commandActions(s) {
  if (!runsHere(s)) return [];
  return s.commands
    .filter((c) => !LIFECYCLE.includes(c))
    .map((c) => ({
      id: "cmd:" + c,
      label: gw("gr.act.cmd", "Run {cmd}", { cmd: c }),
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

/**
 * 0.4.45: the registries keep their English; these put it through the
 * catalog at render time. Repo actions share their service twin's words.
 */
const actKey = (id) =>
  "gr.act." +
  id
    .replace(/^repo-/, "")
    .replace(/^start-remote$/, "start")
    .replace(/-(\w)/g, (_m, c) => c.toUpperCase());
function actLabel(a, x) {
  if (a.labelFor) return a.labelFor(x);
  if (a.id.startsWith("cmd:")) return a.label;
  return gw(actKey(a.id), a.label);
}
const tabLabel = (t) => gw("gr.tab." + t.id, t.label);
const secTitle = (c) =>
  gw("gr.sec." + c.id.replace(/-(\w)/g, (_m, k) => k.toUpperCase()), c.title);
const K = (key, en) => gw("gr.k." + key, en);
const N = (key, en) => gw("gr.n." + key, en);

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
      : none(N("noneDeclared", "none declared"));
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
      `<p class="dg-callout">☁ ${gw(
        s.target?.account ? "gr.remoteNoteAcct" : "gr.remoteNote",
        s.target?.account
          ? "Runs in {env} · {account}. Start, stop and logs happen there, not on this machine."
          : "Runs in {env}. Start, stop and logs happen there, not on this machine.",
        {
          env: `<b>${esc(s.target?.env || gw("gr.remoteEnv", "a remote env"))}</b>`,
          account: esc(s.target?.account || ""),
        },
      )}</p>`,
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
          K("status", "Status"),
          `<span class="dg-pill ${status(s)}">${esc(statusWord(s))}</span> ${s.health.ms != null ? `<span class="dg-muted">${fmtMs(s.health.ms)}</span>` : ""}${s.health.error ? ` <span class="dg-muted">${esc(s.health.error)}</span>` : ""}`,
        ],
        [K("check", "Check"), checkText(s)],
        (s.open || s.target?.url) && [
          K("opens", "Opens"),
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
          K("services", "Services"),
          `<span class="dg-pill ${ok === r.services.length ? "ok" : "bad"}">${esc(gw("gr.okOf", "{ok}/{n} healthy", { ok, n: r.services.length }))}</span>`,
        ],
        [
          K("placement", "Placement"),
          esc(
            {
              local: () => `⌂ ${gw("gr.pl.allLocal", "all local")}`,
              remote: () => `☁ ${gw("gr.pl.allRemote", "all remote")}`,
              none: () => gw("gr.pl.none", "no runtime"),
              hybrid: () =>
                `⇄ ${gw("gr.pl.hybridList", "hybrid: {list}", {
                  list: r.services
                    .map((s) =>
                      gw("gr.pl.svcRuns", "{name} {runs}", {
                        name: s.name,
                        runs: gw("gr.runs." + s.runs, s.runs),
                      }),
                    )
                    .join(", "),
                })}`,
            }[p](),
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
      return `<div class="dg-conn"><div><h4>${esc(gw("gr.dependsOn", "Depends on"))}</h4>${c.deps.length ? `<div class="dg-chips">${c.deps.map(refChip).join("")}</div>` : none(N("nothing", "nothing"))}</div><div><h4>${esc(gw("gr.usedBy", "Used by"))}</h4>${c.users.length ? `<div class="dg-chips">${c.users.map(refChip).join("")}</div>` : none(N("nothingHere", "nothing in this project"))}</div></div>`;
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
      return `<p class="dg-muted" style="margin:0 0 8px;font-size:13px">${esc(gw("gr.missingWhy", "Declared but not in this project."))}</p><ul class="cmds">${deps.map((d) => `<li><code>${esc(d)}</code><button class="dg-btn sm" data-add-dep="${esc(d)}">${esc(gw("gr.add", "Add"))}</button></li>`).join("")}</ul>`;
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
          K("role", "Role"),
          esc(
            [
              s.entry && gw("gr.role.entry", "entry point"),
              s.infra && gw("gr.role.infra", "infrastructure"),
            ]
              .filter(Boolean)
              .join(", ") || gw("gr.role.service", "service"),
          ),
        ],
        [K("application", "Application"), esc(s.app)],
        [
          K("branch", "Branch"),
          s.branch ? `⎇ ${esc(s.branch)}` : none(N("unknown", "unknown")),
        ],
        [
          K("starts", "Starts"),
          esc(
            s.autostart
              ? gw("gr.starts.auto", "with the project")
              : gw("gr.starts.demand", "on demand (auto-start off)"),
          ),
        ],
        !s.cloned && [
          K("onDisk", "On disk"),
          esc(gw("gr.notClonedYet", "not cloned yet: Sync clones it")),
        ],
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
        [K("application", "Application"), esc(r.services[0].app)],
        [
          K("branch", "Branch"),
          r.services[0].branch
            ? `⎇ ${esc(r.services[0].branch)}`
            : none(N("unknown", "unknown")),
        ],
        [K("mode", "Mode"), esc(r.services[0].mode)],
        [
          K("starts", "Starts"),
          esc(
            r.services[0].autostart
              ? gw("gr.starts.auto", "with the project")
              : gw("gr.starts.demand", "on demand (auto-start off)"),
          ),
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
          return `<tr><td><span class="dg-dot ${status(s)}"></span></td><td><button class="nm" data-goto="${esc(s.id)}">${esc(s.name)}</button>${s.entry ? ` <span class="dg-tag entry">${esc(gw("gr.tag.entry", "entry"))}</span>` : ""}${!isLocal(s) ? ` <span class="dg-badge remote">☁ ${esc(s.target?.env || gw("gr.pl.remote", "remote"))}</span>` : ""}<div class="h">${esc(healthLine(s))}</div></td><td class="a">${a.primary ? actBtn(a.primary, s, "sm") : ""}</td></tr>`;
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
        ? `<ul class="cmds">${s.commands.map((c) => `<li><code>${esc(c)}</code>${runsHere(s) ? `<button class="dg-btn sm" data-run="${esc(c)}" data-key="${esc(s.id)}" ${commandTier(c) === "danger" || c === "down" ? "data-confirm" : ""}>${esc(gw("gr.run", "Run"))}</button>` : ""}</li>`).join("")}</ul>`
        : none(
            isLocal(s)
              ? N("noneDeclared", "none declared")
              : N("noneRemote", "none here: it runs remotely"),
          ),
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
        [
          K("repo", "Repo"),
          s.path
            ? `<code>${esc(s.path)}</code>`
            : none(N("unknown", "unknown")),
        ],
        [
          K("manifest", "Manifest"),
          s.manifestLayers.length
            ? `<span class="dg-layers">${s.manifestLayers.map((l) => `<span>${esc(l)}</span>`).join("")}</span>`
            : none(N("noneFound", "none found")),
        ],
        [K("mode", "Mode"), esc(s.mode)],
        !x.services && [
          K("logsFrom", "Logs from"),
          logsText(s.logs)
            ? `<code>${esc(logsText(s.logs))}</code>`
            : isLocal(s)
              ? none(N("ownLog", "the service's own log file"))
              : none(N("remoteEnv", "the remote env")),
        ],
        !x.services && [K("healthCheck", "Health check"), checkText(s)],
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

/** An http(s) URL for action `a` on `x` (D35), else "". */
function actionHref(a, x) {
  const url = a.href?.(x);
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : "";
}

function actBtn(a, x, cls = "") {
  const why = a.disabled?.(x);
  const label = actLabel(a, x);
  const href = !why && actionHref(a, x);
  if (href)
    return `<a class="dg-btn ${cls}" data-action-link="${esc(a.id)}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
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
    ? `<div class="dg-more"><button class="dg-btn" data-more aria-haspopup="menu" aria-expanded="false">${esc(gw("gr.more", "More"))} ▾</button><div class="dg-menu" role="menu" hidden>${groups
        .map(
          ([t, l]) =>
            `<div class="dg-mg ${t}" role="group" aria-label="${esc(gw("gr.grp." + t, GROUP_LABEL[t]))}"><div class="dg-ml">${esc(gw("gr.grp." + t, GROUP_LABEL[t]))}</div>${l
              .map((a) => {
                const why = a.disabled?.(x);
                const href = !why && actionHref(a, x);
                if (href)
                  return `<a role="menuitem" data-action-link="${esc(a.id)}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(actLabel(a, x))}</a>`;
                return `<button role="menuitem" data-action="${esc(a.id)}" data-key="${key}" ${a.confirm ? "data-confirm" : ""} ${why ? `disabled title="${esc(why)}"` : ""}>${esc(actLabel(a, x))}</button>`;
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
      ? gw("gr.okOf", "{ok}/{n} healthy", {
          ok: x.services.filter((s) => s.health.ok).length,
          n: x.services.length,
        })
      : statusWord(x);
  const place = kind === "repo" ? repoPlacement(m, x.repo) : x.runs;
  const placeLabel =
    kind === "repo"
      ? {
          local: `⌂ ${gw("gr.pl.local", "local")}`,
          remote: `☁ ${gw("gr.pl.remote", "remote")}`,
          hybrid: `⇄ ${gw("gr.pl.hybrid", "hybrid")}`,
          none: gw("gr.pl.none", "no runtime"),
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
  const popLabel = st.popped
    ? gw("gr.dock", "Dock as side panel")
    : gw("gr.popout", "Expand to pop-up");
  el.innerHTML = `${st.popped ? "" : `<div class="dg-resize" data-resize title="${esc(gw("gr.resize", "Drag to resize"))}"></div>`}<div class="dg-dh">
    <nav class="dg-crumbs" aria-label="${esc(gw("gr.location", "Location"))}"><span class="dg-crumb-org"><i style="background:${esc(org.color)}"></i>${esc(org.label)}</span> › <span>${esc(s0.app)}</span>${kind === "service" && m.byRepo.get(x.repo).length > 1 ? ` › <button data-goto-repo-panel="${esc(x.repo)}">${esc(x.repo)}</button>` : ""}</nav>
    <div class="t"><h2>${esc(kind === "repo" ? x.repo : x.name)}</h2><span class="dg-pill ${pillCls}">${esc(word)}</span>${place !== "local" || m.mixed ? `<span class="dg-badge ${place}">${esc(placeLabel)}</span>` : ""}
      <span class="dg-hbtns">${pinButton(kind === "repo" ? x.repo : x.id)}<button class="dg-ib" data-popout title="${esc(popLabel)}" aria-label="${esc(popLabel)}">${st.popped ? "⇲" : "⤢"}</button><button class="dg-ib" data-close aria-label="${esc(gw("gr.closeDetails", "Close details"))}">×</button></span></div>
    <div class="sub">${esc(kind === "repo" ? `${gw("gr.services", "{n} services", { n: x.services.length })} · ${s0.path}` : x.id)}</div>
    ${actionBar(x)}
    <div class="dg-tabs" role="tablist">${tabs.map((t) => `<button role="tab" aria-selected="${t.id === st.tab}" data-tab="${t.id}">${esc(tabLabel(t))}</button>`).join("")}</div>
  </div><div class="dg-pbody" role="tabpanel"></div>`;
  const body = el.querySelector(".dg-pbody");
  for (const c of SECTIONS.filter(
    (c) => c.tab === st.tab && c.for.includes(kind) && (!c.when || c.when(x)),
  ).sort((a, b) => a.order - b.order)) {
    const sec = document.createElement("section");
    sec.className = "dg-sec";
    sec.dataset.section = c.id;
    if (c.title)
      sec.insertAdjacentHTML("beforeend", `<h3>${esc(secTitle(c))}</h3>`);
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
  wrap.innerHTML = `<div class="dg-logbar"><button class="dg-btn sm" data-log="pause" aria-pressed="false">${esc(gw("gr.log.pause", "Pause"))}</button><button class="dg-btn sm" data-log="wrap" aria-pressed="false">${esc(gw("gr.log.wrap", "Wrap"))}</button><input type="search" placeholder="${esc(gw("gr.log.filterPh", "Filter lines"))}" aria-label="${esc(gw("gr.log.filter", "Filter log lines"))}"><button class="dg-btn sm" data-log="page">${esc(gw("gr.act.logsPage", "Open in Logs"))} ↗</button></div><pre class="dg-log" aria-live="off"></pre>`;
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
        ? gw("gr.log.waiting", "Waiting for log lines…")
        : gw("gr.log.ended", "The log stream ended.");
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
      b.textContent = paused
        ? gw("gr.log.resume", "Resume")
        : gw("gr.log.pause", "Pause");
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
  el.innerHTML = none(N("loading", "Loading…"));
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
        ? `<ol class="act">${entries.map((a) => `<li><time datetime="${esc(a.ts)}">${esc(hhmm(a.ts))}</time><span class="dg-who ${a.actor === "agent" ? "agent" : ""}">${esc(a.actor === "agent" ? (a.agent ? "[" + a.agent + "]" : `[${gw("gr.who.agent", "agent")}]`) + (a.client ? " " + a.client : "") : a.claimed && a.claimed.client ? gw("gr.who.youVia", "you · {client} (unverified)", { client: a.claimed.client }) : gw("gr.who.you", "you"))}</span><span>${esc(a.verb)} ${esc(a.detail)}${a.outcome === "refused" ? ` <em class="refused">${esc(gw("gr.refused", "refused: {reason}", { reason: a.reason || "" }))}</em>` : ""}</span></li>`).join("")}</ol>`
        : none(
            N(
              "noActivity",
              "No actions yet. Starts, restarts and syncs, yours and agents', show here.",
            ),
          );
    });
  return el;
}
