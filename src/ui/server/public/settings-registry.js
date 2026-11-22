/**
 * Den's own settings (R21, 0.3.0-dev.19): every setting Den has, as rows
 * of the SETTINGS registry in shell.js (window.denShell.registerSetting).
 * The Settings page (/settings, settings-page.js) draws only what the
 * registry holds; no row is written anywhere else. A distribution or a
 * plugin adds its own the same way (through window.denShellQueue).
 *
 * A category: { id, label, order, description?, from? }.
 * A row: { id, category, label, description, keywords, scope, control,
 *   read(ctx), write?(value, ctx), keys? }
 *   scope    "user" (config/local/user.yml), "workspace" (the workspace's
 *            entry in config/local/workspaces.yml) or "distribution" (the
 *            distribution's tracked config: read-only, so no write).
 *   control  { type: seg | radio | select | number | toggle | langmap |
 *            theme | navlist | pins | workspace-editor | readonly |
 *            custom, … } (settings-page.js draws each)
 *   keys     the /api/settings keys the row stores; every key POST
 *            /api/settings accepts has a row (settings-inventory.test.ts)
 *
 * ctx (settings-page.js): { data (GET /api/settings), appearance (the
 * themes and your prefs), scope (GET /api/scope), workspace (the one the
 * Workspace rows are about), wsSettings, shell (denShell), post(body),
 * setAppearance(patch), saveWorkspace(body) }.
 *
 * Writes go only to per-user, gitignored state: POST /api/settings
 * (config/local/user.yml) and POST /api/workspaces/settings
 * (config/local/workspaces.yml). Nothing here writes the distribution's
 * config.
 */
import { themeNotice, themeOptions } from "./appearance.js";
import {
  browserTimeZone,
  formatTime,
  formatTitle,
  setTimeZone,
  timeZones,
  upgradeTimes,
} from "/kit/time.js";
import { qrSvg } from "./qr.js";
import { openAgentModeMenu, renderPersonasSettings } from "./persona-ui.js";
import { comboHtml, wireCombo } from "./combobox.js";
import { restartDen } from "./restart-den.js";
import { dialogHtml, mountDialog } from "./dialog-den.js";
import { chosenColour, pickProjectColour } from "./project-colour-picker.js";
import { projectColour, projectLabel } from "./workspace-picker.js";
import { pushOff, pushOn, pushSubscription, pushSupported } from "./alerts.js";

export const DEN_SETTING_CATEGORIES = [
  {
    id: "appearance",
    label: "Appearance",
    order: 10,
    description: "Mode follows your system unless you pick one.",
  },
  {
    id: "editor",
    label: "Editor & terminal",
    order: 20,
    description:
      "Where ↗ opens a repository and >_ opens a terminal to a service.",
  },
  {
    id: "navigation",
    label: "Navigation",
    order: 30,
    description:
      "Hide pages you never use and choose their order. Pins sit at the top of the rail.",
  },
  {
    id: "graph",
    label: "Graph",
    order: 40,
    description:
      "How the graph is laid out, and how the Projects page shows its projects. The pages' own controls set these too.",
  },
  {
    id: "workspace",
    label: "Project setup",
    order: 50,
    description:
      "Settings for one project. They follow the project you view in the top bar.",
  },
  {
    id: "agents",
    label: "Agents",
    order: 55,
    description:
      "The runtimes agents run on, installed first. Paths you set are this machine's only: everywhere (config/local/user.yml) or for one project (config/local/workspaces.yml), which wins.",
  },
  {
    // issue 267: Hub has a section of its own: its address, the connection,
    // what agents get from it, and its notifications.
    id: "hub",
    label: "Hub",
    order: 55.5,
    description:
      "Den Hub is where your company's docs, mocks, comments and approvals live. Connect this install, and every agent can search and publish there, and gets the comments and decisions on its work. See docs/hub.md in Den's docs.",
  },
  {
    // Bell v6 (0.4.45): the person's bell.
    id: "notifications",
    label: "Notifications",
    order: 56,
    description:
      "What shows in the bell and counts on its badge. These are your own choices. Off means no bell item and no badge. The activity trail still records it.",
  },
  {
    // SEC-2a: who may come in from other devices.
    id: "access",
    label: "Access",
    order: 57,
    description:
      "Reach this Den from your other devices: sign in with GitHub as its owner, or pair a device with a one-time link. On localhost nothing asks.",
  },
  {
    // Issue 103: other web apps reach an agent (links, the embedded pane).
    id: "embed",
    label: "Embedding",
    order: 57.5,
    description:
      "Let other web apps link to your agents. A link fills an agent's message box. Nothing is sent until you press Send.",
  },
  {
    id: "secrets",
    label: "Secrets",
    order: 58,
    description:
      "Where this machine gets the credentials Den resolves secrets with. Per machine (config/local/user.yml); only the source is shown, never a secret.",
  },
  {
    // D64: the server this page talks to; Restart Den is always here.
    id: "server",
    label: "Server",
    order: 59,
    description:
      "The Den web server this page talks to. A restart keeps agents and services running.",
  },
  {
    id: "cli",
    label: "Command line",
    order: 60,
    description:
      "Also yours (config/local/user.yml), set from the command line: __DEN_CLI__ config <key>=<value>.",
  },
  {
    id: "distribution",
    label: "Distribution",
    order: 90,
    description:
      "What the distribution sets for everyone. Read-only here: it lives in the distribution's tracked config.",
  },
];

const seg = (options) => ({ type: "seg", options });
const graphRow = (key, label, description, keywords, control) => ({
  id: `graph.${key}`,
  category: "graph",
  label,
  description,
  keywords,
  scope: "user",
  control,
  keys: [`graph.${key}`],
  read: (ctx) => ctx.data.graph?.[key],
  write: (v, ctx) => ctx.post({ graph: { [key]: v } }),
});
const distRow = (id, label, description, keywords, value) => ({
  id: `distribution.${id}`,
  category: "distribution",
  label,
  description,
  keywords: ["distribution", "org", ...keywords],
  scope: "distribution",
  control: { type: "readonly" },
  read: (ctx) => value(ctx.data.distribution || {}),
});
/** SRV-P6: a time from the update check, in the person's zone (issue 206). */
const shortTime = (iso) => formatTime(iso) || iso;
/** SRV-P6: the Update checks row's text. */
function updateCheckText(data) {
  const from = data.server_agent_self_update_from ?? "default";
  const parts = [
    from === "user"
      ? L("set.ui.suFrom.user", "Set by you (config/local/user.yml)")
      : from === "org"
        ? L(
            "set.ui.suFrom.dist",
            "From the distribution's config, copied to config/local/user.yml at the next start",
          )
        : L("set.ui.suFrom.default", "The default: Ask"),
  ];
  const c = data.update_check;
  if (!c || !c.everyMinutes) {
    parts.push(
      c
        ? L("set.ui.ucOff", "Checks are off")
        : L("set.ui.ucNone", "No check yet"),
    );
    return parts.join(" · ");
  }
  const l = c.last;
  if (l) {
    const v = { v: l.version ?? "" };
    const did =
      l.did === "asked"
        ? L("set.ui.ucDid.asked", "{v} is out, waiting for your Allow", v)
        : l.did === "waiting"
          ? l.wait === "permission" || l.wait === "approval"
            ? L(
                "set.ui.ucDid.waitAllow",
                "{v} is out, waiting: the __DEN_TITLE__ agent is waiting on your Allow",
                v,
              )
            : l.wait === "asked"
              ? L(
                  "set.ui.ucDid.waitAsked",
                  "{v} is out, waiting: the __DEN_TITLE__ agent asked you a question",
                  v,
                )
              : L(
                  "set.ui.ucDid.waiting",
                  "{v} is out, waiting for a quiet moment",
                  v,
                )
          : l.did === "updating"
            ? L("set.ui.ucDid.updating", "updating to {v}", v)
            : l.did === "failed"
              ? L("set.ui.ucDid.failed", "couldn't update to {v}", v)
              : l.did === "skipped"
                ? L("set.ui.ucDid.skipped", "skipped")
                : L("set.ui.ucDid.current", "on the newest version");
    parts.push(
      L("set.ui.ucLast", "Last check {t}: {did}", { t: shortTime(l.at), did }),
    );
  } else parts.push(L("set.ui.ucNone", "No check yet"));
  if (c.next)
    parts.push(L("set.ui.ucNext", "next {t}", { t: shortTime(c.next) }));
  return parts.join(" · ");
}
const effective = (list, chosen) =>
  chosen ?? (list || []).find((e) => e.available)?.key ?? null;

// ── Access (SEC-2a) ──────────────────────────────────────────────────────
// What these rows draw, and the routes they use (github-routes.ts). Pure
// helpers are exported for tests.

function escHtml(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/**
 * A built-in word in the page's language (0.4.45): the catalog's when its
 * en is `en` word for word (denShell.tr), else `en` (and in a unit test,
 * where there is no shell). {name} placeholders filled from `vars`.
 */
function L(key, en, vars) {
  const sh = typeof window !== "undefined" ? window.denShell : null;
  const s = sh && typeof sh.tr === "function" ? sh.tr(key, en) : en;
  return String(s).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] != null ? String(vars[k]) : m,
  );
}

/**
 * Bell v6 (0.4.45): Settings › Notifications: one switch per kind (all on
 * but "finished its turn"), and when items fold as older. user.yml's
 * notifications.kinds and notifications.fold_days, via /api/settings.
 */

function bellRows() {
  // Here, not at the top: the registry's list calls this as it loads.
  const BELL_ROWS = [
    [
      "waiting",
      "Agent is waiting for you",
      "An agent is waiting for you, or asked you a question, and can't go on.",
    ],
    [
      "finished",
      "Agent finished its turn",
      "An agent stopped and is idle. Off by default.",
    ],
    [
      "hub",
      "Replies and comments in Hub",
      "Someone answered a comment on something you made.",
    ],
    ["pr", "Pull requests", "A pull request needs a look or changed state."],
    ["release", "Releases and checks", "A release shipped, or a check failed."],
    [
      "pick",
      "Projects need your pick",
      "Den can't tell which Hub project fits a project.",
    ],
    ["shared", "Shared with you", "An agent shared a doc or mock with you."],
  ];
  const on = (ctx, k) => {
    const v = ctx.data.bell_kinds?.[k];
    return typeof v === "boolean" ? v : k !== "finished";
  };
  return [
    ...BELL_ROWS.map(([k, label, description]) => ({
      id: `notifications.${k}`,
      // issue 267: Hub's own kinds sit in Settings › Hub.
      category: HUB_BELL_KINDS.has(k) ? "hub" : "notifications",
      label,
      description,
      keywords: ["notifications", "bell", "badge", "kinds", k],
      scope: "user",
      control: {
        type: "toggle",
        // "Waiting for you" is the one kind not to hide by accident.
        ...(k === "waiting"
          ? {
              notice: (ctx) =>
                on(ctx, "waiting")
                  ? ""
                  : L(
                      "set.notifications.waiting.warn",
                      "While this is off, agents waiting for you won't show here or on the badge.",
                    ),
            }
          : {}),
      },
      keys: ["bell_kinds"],
      read: (ctx) => on(ctx, k),
      write: (v, ctx) => ctx.post({ bell_kinds: { [k]: v === true } }),
    })),
    ...alertRows(),
    {
      id: "notifications.fold_days",
      category: "notifications",
      label: "Fold items older than",
      description:
        "Older items move under \u201cOlder than N days\u201d. Nothing is deleted.",
      keywords: ["notifications", "bell", "fold", "older", "days"],
      scope: "user",
      control: seg(
        [3, 7, 14, 30].map((n) => ({ value: String(n), label: `${n} days` })),
      ),
      keys: ["bell_fold_days"],
      read: (ctx) => String(ctx.data.bell_fold_days ?? 7),
      write: (v, ctx) => ctx.post({ bell_fold_days: Number(v) }),
    },
  ];
}

/**
 * Issue 172: alerts outside the bell (alerts.js). Desktop alerts is on
 * when the person has it on (user.yml alerts.desktop, default on) and
 * this browser lets the page notify; turning it on asks the browser.
 */
const notifyApi = () =>
  typeof window !== "undefined" && typeof window.Notification === "function"
    ? window.Notification
    : null;

function alertRows() {
  return [
    {
      id: "notifications.desktop",
      category: "notifications",
      label: "Desktop alerts",
      description:
        "When an agent needs you (a permission, a question, an Allow), this browser shows a notification, even while __DEN_TITLE__ is in the background. Click it to open the agent. The browser asks once.",
      keywords: ["notifications", "alerts", "desktop", "browser", "push"],
      scope: "user",
      control: {
        type: "toggle",
        notice: () => {
          const N = notifyApi();
          if (!N)
            return L(
              "set.notifications.desktop.none",
              "This browser can't show notifications.",
            );
          return N.permission === "denied"
            ? L(
                "set.notifications.desktop.denied",
                "This browser blocks notifications from this page. Allow them in its site settings, then turn this on.",
              )
            : "";
        },
      },
      keys: ["alerts.desktop"],
      read: (ctx) =>
        ctx.data.alerts?.desktop !== false &&
        notifyApi()?.permission === "granted",
      write: async (v, ctx) => {
        const N = notifyApi();
        if (v === true && N && N.permission === "default")
          await N.requestPermission();
        return ctx.post({ alerts: { desktop: v === true } });
      },
    },
    {
      // S2: push, to this device (a phone, or a computer with no tab open).
      id: "notifications.phone",
      category: "notifications",
      label: "Alerts on this device by push",
      description:
        "Open __DEN_TITLE__ on your phone and turn this on there: when an agent needs you, the phone shows it, even with __DEN_TITLE__ closed. Here it works with every tab closed. Each device turns it on for itself.",
      keywords: [
        "notifications",
        "alerts",
        "phone",
        "push",
        "mobile",
        "iphone",
      ],
      scope: "user",
      control: { type: "custom", render: drawPush },
      keys: ["alerts.phone"],
      read: (ctx) => ctx.data.alerts?.phone !== false,
      write: (v, ctx) => ctx.post({ alerts: { phone: v === true } }),
    },
    {
      // Issue 172: which devices get push, a test alert to each, and
      // Forget for one no longer used (a lost phone).
      id: "notifications.push_devices",
      category: "notifications",
      label: "Devices that get push",
      description:
        "Each device that turned on push. Send a test alert to check that your phone gets it: each device says whether its push service took it. Forget one you no longer use.",
      keywords: [
        "notifications",
        "alerts",
        "phone",
        "push",
        "devices",
        "test",
        "iphone",
      ],
      scope: "user",
      control: { type: "custom", render: drawPushDevices },
      read: () => null,
    },
    ...[
      [
        "quiet_from",
        "Quiet hours start",
        "From this time, no alerts outside the bell until quiet hours end. The bell still has everything. In your time zone.",
      ],
      [
        "quiet_to",
        "Quiet hours end",
        "Alerts outside the bell start again at this time.",
      ],
    ].map(([k, label, description]) => ({
      id: `notifications.${k}`,
      category: "notifications",
      label,
      description,
      keywords: ["notifications", "alerts", "quiet", "hours", "night"],
      scope: "user",
      control: {
        type: "select",
        options: () => [
          { value: "", label: L("set.notifications.quiet.off", "Off") },
          ...Array.from({ length: 24 }, (_, h) => {
            const t = `${String(h).padStart(2, "0")}:00`;
            return { value: t, label: t };
          }),
        ],
        notice: (ctx) => {
          const a = ctx.data.alerts ?? {};
          return k === "quiet_from" && !a.quiet_from !== !a.quiet_to
            ? L(
                "set.notifications.quiet.half",
                "Quiet hours need a start and an end.",
              )
            : "";
        },
      },
      keys: [`alerts.${k}`],
      read: (ctx) => ctx.data.alerts?.[k] ?? "",
      write: (v, ctx) => ctx.post({ alerts: { [k]: v || null } }),
    })),
    {
      // Issue 367: the push limits (user.yml alerts.push_*).
      id: "notifications.push_timeout",
      category: "notifications",
      label: "Push wait",
      description:
        "How long __DEN_TITLE__ waits for a push service to take one alert for a device. After this, that alert is left; the next one tries again. __DEN_CLI__ config alerts.push_timeout_seconds=30",
      keywords: ["notifications", "alerts", "push", "timeout", "wait"],
      scope: "user",
      keys: ["alerts.push_timeout_seconds"],
      control: { type: "number", min: 1, max: 3600, step: 1, unit: "s" },
      read: (ctx) => ctx.data.alerts?.push_timeout_seconds ?? 30,
      write: (v, ctx) => ctx.post({ alerts: { push_timeout_seconds: v } }),
    },
    {
      id: "notifications.push_ttl",
      category: "notifications",
      label: "Push kept for",
      description:
        "How long a push service keeps an alert for a device that is off or offline, in seconds. 86400 is a day; 0 drops it unless the device is on now. __DEN_CLI__ config alerts.push_ttl_seconds=86400",
      keywords: ["notifications", "alerts", "push", "ttl", "offline", "keep"],
      scope: "user",
      keys: ["alerts.push_ttl_seconds"],
      control: { type: "number", min: 0, max: 2419200, step: 1, unit: "s" },
      read: (ctx) => ctx.data.alerts?.push_ttl_seconds ?? 86400,
      write: (v, ctx) => ctx.post({ alerts: { push_ttl_seconds: v } }),
    },
  ];
}

/**
 * Issue 172 S2: this device's push switch. On: the browser's permission,
 * the service worker, the subscription (alerts.js pushOn), and
 * alerts.phone on. Off: this device only stops; others keep theirs.
 */
function drawPush(host, ctx, io) {
  const api = (m, p, b) => ctx.shell.api(m, p, b);
  // BUSY-1: the subscription's write goes through the working pop-up,
  // the switch held while it runs; data, or null when it didn't succeed.
  const send = (path, body) => {
    const run = (headers) => ctx.shell.api("POST", path, body, { headers });
    if (!ctx.shell.busyAction) return run({}).catch(() => null);
    const button = host.querySelector("input") || undefined;
    return ctx.shell.busyAction("save", run, { button, toastFast: false });
  };
  const draw = (on, note) => {
    host.innerHTML =
      `<input type="checkbox" class="set-check" id="set-phone-push" aria-labelledby="l-notifications-phone"${on ? " checked" : ""}>` +
      (note ? `<p class="set-warn" role="status">${escHtml(note)}</p>` : "");
    host
      .querySelector("input")
      .addEventListener("change", (e) => void flip(e.target.checked));
  };
  const why = {
    unsupported: () =>
      L(
        "set.notifications.phone.none",
        "This browser can't get push. On an iPhone, add __DEN_TITLE__ to the Home Screen (Share, then Add to Home Screen) and open it from there.",
      ),
    denied: () =>
      L(
        "set.notifications.desktop.denied",
        "This browser blocks notifications from this page. Allow them in its site settings, then turn this on.",
      ),
    failed: () =>
      L("set.notifications.phone.failed", "Couldn't turn on push here."),
  };
  const flip = async (on) => {
    let got = "ok";
    try {
      if (on) got = await pushOn(api, send);
      else await pushOff(send);
    } catch {
      got = "failed";
    }
    if (got === "ok" && on) await io.save(true);
    if (got === "ok" && typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent("den:push-devices"));
    const now = !!(await pushSubscription());
    draw(now, got === "ok" ? "" : why[got]());
  };
  draw(false, pushSupported() ? "" : why.unsupported());
  void pushSubscription().then((s) => {
    if (s && ctx.data.alerts?.phone !== false) draw(true, "");
  });
}

/** A push service, as the device list says it. */
const pushServiceName = (svc) =>
  ({
    apple: () => L("set.notifications.svc.apple", "Apple push"),
    google: () => L("set.notifications.svc.google", "Google push"),
    mozilla: () => L("set.notifications.svc.mozilla", "Firefox push"),
    microsoft: () => L("set.notifications.svc.microsoft", "Microsoft push"),
  })[svc]?.() ?? L("set.notifications.svc.other", "Other push service");

/** This browser's device id (the server's: a hash of its endpoint), or "". */
async function thisDeviceId() {
  try {
    const sub = await pushSubscription();
    if (!sub?.endpoint || !globalThis.crypto?.subtle) return "";
    const d = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(sub.endpoint),
    );
    return [...new Uint8Array(d)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  } catch {
    return "";
  }
}

/**
 * Issue 172: the person's devices that get push. Each one: what it is,
 * its push service, when it was added (local time), "this device", and
 * Forget. Send a test alert pushes to each and says, per device, whether
 * its push service took it. Both writes go through the working pop-up.
 */
export function drawPushDevices(host, ctx) {
  let result = null; // the last test's answer, by device id
  // The pressed button, named ({ button }), holds the kit's dots (issue 698).
  const busy = (name, path, body, { button }) => {
    const run = (headers) => ctx.shell.api("POST", path, body, { headers });
    return ctx.shell.busyAction
      ? ctx.shell.busyAction(name, run, { button, toastFast: false })
      : run({}).catch(() => null);
  };
  const outcome = (d) =>
    d.reached
      ? L("set.notifications.test.reached", "Sent: its push service took it.")
      : d.gone
        ? L(
            "set.notifications.test.gone",
            "Gone: this device no longer takes push, so it was removed.",
          )
        : d.status
          ? L(
              "set.notifications.test.refused",
              "Not sent: its push service answered {status}.",
              { status: d.status },
            )
          : L(
              "set.notifications.test.noAnswer",
              "Not sent: no answer from its push service in time (Push wait).",
            );
  const draw = (devices, mine) => {
    const rows = devices
      .map((d) => {
        const what = [d.device, pushServiceName(d.service)]
          .filter(Boolean)
          .join(" \u00b7 ");
        const r = result?.get(d.id);
        return (
          `<li class="set-push-device" data-device="${escHtml(d.id)}" data-service="${escHtml(d.service ?? "")}"${d.id === mine ? " data-this" : ""}>` +
          `<span><b>${escHtml(what)}</b>` +
          (d.id === mine
            ? ` <span class="set-note">${escHtml(L("set.notifications.devices.this", "(this device)"))}</span>`
            : "") +
          `<br><span class="set-note">${escHtml(L("set.notifications.devices.added", "Added {t}", { t: shortTime(d.at) }))}</span>` +
          (r
            ? `<br><span class="${r.reached ? "set-note" : "set-warn"}" data-test-result role="status">${escHtml(outcome(r))}</span>`
            : "") +
          `</span> <button type="button" class="btn" data-forget="${escHtml(d.id)}">${escHtml(L("set.notifications.devices.forget", "Forget"))}</button></li>`
        );
      })
      .join("");
    const gone = result
      ? [...result.values()].filter(
          (r) => r.gone && !devices.some((d) => d.id === r.id),
        )
      : [];
    host.innerHTML =
      (devices.length
        ? `<ul id="set-push-devices" style="list-style:none;margin:0 0 8px;padding:0;display:grid;gap:8px">${rows}</ul>`
        : `<p class="set-note" id="set-push-none">${escHtml(L("set.notifications.devices.none", "No device gets push yet. Open __DEN_TITLE__ on your phone (Pair a device, under Access, signs it in), then turn on Alerts on this device by push there."))}</p>`) +
      gone
        .map(
          (r) =>
            `<p class="set-warn" data-test-result role="status">${escHtml([r.device, pushServiceName(r.service)].filter(Boolean).join(" \u00b7 "))}: ${escHtml(outcome(r))}</p>`,
        )
        .join("") +
      `<button type="button" class="btn" id="set-push-test"${devices.length ? "" : " disabled"}>${escHtml(L("set.notifications.devices.test", "Send a test alert"))}</button>`;
    host.querySelector("#set-push-test")?.addEventListener("click", (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      void busy("push-test", "/api/alerts/test", {}, { button: btn })
        .then((r) => {
          if (r && Array.isArray(r.devices))
            result = new Map(r.devices.map((d) => [d.id, d]));
        })
        .finally(() => void load());
    });
    host.querySelectorAll("[data-forget]").forEach((btn) =>
      btn.addEventListener("click", () => {
        btn.disabled = true;
        result?.delete(btn.dataset.forget);
        void busy(
          "push-forget",
          "/api/alerts/forget",
          { id: btn.dataset.forget },
          { button: btn },
        ).finally(() => void load());
      }),
    );
  };
  const load = async () => {
    let devices = [];
    try {
      const r = await ctx.shell.api("GET", "/api/alerts/devices");
      devices = Array.isArray(r?.devices) ? r.devices : [];
    } catch {
      devices = [];
    }
    if (host.isConnected !== false) draw(devices, await thisDeviceId());
  };
  // This device's push switch (drawPush) changed the list: read it again.
  const changed = () =>
    host.isConnected === false
      ? window.removeEventListener("den:push-devices", changed)
      : void load();
  if (typeof window !== "undefined")
    window.addEventListener("den:push-devices", changed);
  void load();
}

/** "3 min ago", "2 h ago", "5 d ago", or "just now"; `now` for tests. */
export function seenAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return L("set.ui.justNow", "just now");
  if (s < 5400)
    return L("set.ui.minAgo", "{n} min ago", { n: Math.round(s / 60) });
  if (s < 129600)
    return L("set.ui.hAgo", "{n} h ago", { n: Math.round(s / 3600) });
  return L("set.ui.dAgo", "{n} d ago", { n: Math.round(s / 86400) });
}

/**
 * 0.4.45: a device's name (the server's English: "Chrome on Linux", "A
 * browser on macOS", "Unknown browser") in the page's words; the browser's
 * and the system's names stay as they are.
 */
export function deviceWords(name, tr = L) {
  const s = String(name ?? "").trim();
  if (!s || s === "Unknown browser")
    return tr("set.ui.unknownBrowser", "Unknown browser");
  const any = /^A browser on (.+)$/.exec(s);
  if (any) return tr("set.ui.aBrowserOn", "A browser on {os}", { os: any[1] });
  const on = /^(.+?) on (.+)$/.exec(s);
  if (on)
    return tr("set.ui.deviceOn", "{browser} on {os}", {
      browser: on[1],
      os: on[2],
    });
  return s;
}

/**
 * One linked device's line (SEC-2a: every sign-in, whatever the method):
 * its browser and OS, "This device" for this browser, then how it signed
 * in, when, from where (the client address and the browser), and when it
 * was last seen.
 */
export function deviceLine(d, now = Date.now()) {
  const how =
    d.via === "github"
      ? d.login
        ? L("set.ui.viaGithubAs", "signed in with GitHub (@{login})", {
            login: d.login,
          })
        : L("set.ui.viaGithub", "signed in with GitHub")
      : d.via === "code"
        ? L("set.ui.viaCode", "approved with a code")
        : d.via === "claim"
          ? L("set.ui.viaClaim", "claimed with a setup link")
          : d.via === "agent-view"
            ? L("set.ui.viaAgentView", "{agent}'s read-only view", {
                agent: d.agent || "",
              })
            : L("set.ui.viaLink", "signed in with a one-time link");
  const name = deviceWords(d.name);
  const from = d.client || d.host;
  return {
    title: name,
    current: !!d.current,
    // issue 206: the full local date-times, on hover.
    tip: [
      d.createdAt
        ? L("set.ui.created", "created {ago}", {
            ago: formatTitle(d.createdAt),
          })
        : "",
      d.lastSeenAt
        ? L("set.ui.lastSeen", "last seen {ago}", {
            ago: formatTitle(d.lastSeenAt),
          })
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    detail: [
      how,
      L("set.ui.created", "created {ago}", { ago: seenAgo(d.createdAt, now) }),
      from ? L("set.ui.fromAt", "from {from} ({name})", { from, name }) : "",
      L("set.ui.lastSeen", "last seen {ago}", {
        ago: seenAgo(d.lastSeenAt, now),
      }),
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

const ROW_STYLE =
  "display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%;padding:6px 0;border-top:1px solid var(--border)";
const CODE_STYLE =
  "font:22px/1.4 var(--mono);letter-spacing:0.12em;padding:6px 12px;border:1px solid var(--border);border-radius:var(--radius-button);background:var(--sunken)";

/** Linking the owner in the page: start, show the code, poll the server. */
function drawOwner(host, ctx) {
  const api = (m, p, b) => ctx.shell.api(m, p, b);
  let timer = null;
  const draw = (o) => {
    clearTimeout(timer);
    if (o.owner) {
      host.innerHTML =
        `<output class="set-ro" id="set-owner">${escHtml(L("set.ui.ownerIs", "Owner:"))} <b>@${escHtml(o.owner.login)}</b> <span class="set-note">(${escHtml(o.owner.id)})</span></output> ` +
        `<button type="button" class="btn" id="set-owner-unlink">${escHtml(L("set.ui.unlink", "Unlink"))}</button>`;
      host.querySelector("#set-owner-unlink").addEventListener("click", () =>
        api("POST", "/api/web/owner/unlink", {})
          .then(load)
          .catch((e) => fail(e.message)),
      );
      return;
    }
    host.innerHTML =
      `<output class="set-ro" id="set-owner">${escHtml(L("set.ui.noOwner", "This Den has no owner identity yet."))}</output> ` +
      (o.clientId
        ? `<button type="button" class="btn primary" id="set-owner-link">${escHtml(L("set.ui.linkGithub", "Link your GitHub account"))}</button>`
        : `<span class="set-note" id="set-owner-noclient" style="flex-basis:100%">${L(
            "set.ui.noClient",
            "Linking needs a GitHub App client id, and none is configured: set {key} in config/local/user.yml, then restart the server.", // words-ok: moved word for word into the catalog (0.4.45)
            { key: "<code>web.github_client_id</code>" },
          )}</span>`) +
      '<div id="set-owner-flow" style="flex-basis:100%" aria-live="polite"></div>';
    host.querySelector("#set-owner-link")?.addEventListener("click", startLink);
  };
  const fail = (text) => {
    const box = host.querySelector("#set-owner-flow");
    if (box)
      box.innerHTML = `<span class="set-note set-warn" role="alert">${escHtml(text)}</span>`;
    const b = host.querySelector("#set-owner-link");
    if (b) b.disabled = false;
  };
  const poll = (id) =>
    fetch(`/api/web/owner/link/${encodeURIComponent(id)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((b) => {
        if (b.state === "pending") {
          timer = setTimeout(() => poll(id), 1500);
          return;
        }
        if (b.state === "ok") return load();
        fail(b.error || L("set.ui.linkFailed", "Linking failed. Try again."));
      })
      .catch(
        () =>
          fail(L("set.ui.noAnswer", "The server didn't answer. Try again.")), // words-ok: moved word for word into the catalog (0.4.45)
      );
  function startLink() {
    const b = host.querySelector("#set-owner-link");
    if (b) b.disabled = true;
    api("POST", "/api/web/owner/link", {})
      .then((f) => {
        const box = host.querySelector("#set-owner-flow");
        const url = f.verificationUri || "https://github.com/login/device";
        box.innerHTML =
          `<p class="set-note" style="margin:8px 0">${L(
            "set.ui.enterCode",
            "Enter this code at {link} and approve the app. It asks for no permissions.",
            {
              link: `<a href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${escHtml(url.replace(/^https:\/\//, ""))}</a>`,
            },
          )}</p>` +
          `<span id="set-owner-code" style="${CODE_STYLE}">${escHtml(f.userCode)}</span> ` +
          `<a class="btn" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">${escHtml(L("set.ui.openGithub", "Open GitHub"))}</a>` +
          `<p class="set-note" style="margin:8px 0 0">${escHtml(L("set.ui.waitingGithub", "Waiting for GitHub…"))}</p>`;
        timer = setTimeout(() => poll(f.id), 1500);
      })
      .catch((e) => fail(e.message));
  }
  function load() {
    fetch("/api/web/owner", { cache: "no-store" })
      .then((r) => r.json())
      .then(draw)
      .catch(() => {
        host.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.ownerSignedIn", "The owner can only be shown signed in."))}</output>`;
      });
  }
  load();
}

function drawDevices(host, ctx) {
  const load = () =>
    fetch("/api/web/sessions", { cache: "no-store" })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
      )
      .then((b) => {
        const list = b.sessions || [];
        if (!list.length) {
          host.innerHTML = `<output class="set-ro" id="set-devices">${escHtml(L("set.ui.noDevices", "No linked devices. A browser that signs in with GitHub, is approved with a code, or opens a one-time link appears here."))}</output>`;
          return;
        }
        const now = Date.now();
        host.innerHTML =
          '<div id="set-devices" style="width:100%">' +
          list
            .map((d) => {
              const l = deviceLine(d, now);
              return (
                `<div class="set-device" data-id="${escHtml(d.id)}" style="${ROW_STYLE}">` +
                `<div style="flex:1 1 220px;min-width:0"><div>${escHtml(l.title)}` +
                (l.current
                  ? ` <b class="set-this-device" style="font-weight:600">· ${escHtml(L("set.ui.thisDevice", "This device"))}</b>`
                  : "") +
                `</div>` +
                `<div class="set-note" style="overflow-wrap:anywhere"${l.tip ? ` title="${escHtml(l.tip)}"` : ""}>${escHtml(l.detail)}</div></div>` +
                `<button type="button" class="btn" data-revoke="${escHtml(d.id)}">${escHtml(L("set.ui.revoke", "Revoke"))}</button></div>`
              );
            })
            .join("") +
          "</div>" +
          // MODE-5: `web logout` (and --all) from the page, asked first.
          `<div data-signout-box style="margin-top:10px"><button type="button" class="btn" data-signout-all>${escHtml(L("set.ui.signOutAll", "Sign out everywhere"))}</button></div>`;
        const box = host.querySelector("[data-signout-box]");
        const idle = box.innerHTML;
        box.addEventListener("click", (e) => {
          const b = e.target.closest?.("button");
          if (!b) return;
          if (b.hasAttribute("data-signout-all")) {
            box.innerHTML =
              `<div data-signout-ask role="group" aria-label="${escHtml(L("set.ui.signOutAll", "Sign out everywhere"))}" style="display:grid;gap:8px">` +
              `<p class="set-note" style="margin:0">${escHtml(L("set.ui.signOutAllB", "This signs out every browser and phone, including this one. Each signs in again the usual way."))}</p>` +
              `<label class="set-note" style="display:flex;gap:6px;align-items:flex-start"><input type="checkbox" data-signout-rotate> ${escHtml(L("set.ui.signOutRotate", "Also replace the sign-in secret. Running agents stop until they are restarted."))}</label>` +
              `<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="btn" data-signout-yes>${escHtml(L("set.ui.signOutAll", "Sign out everywhere"))}</button><button type="button" class="btn" data-signout-no>${escHtml(L("set.ui.cancel", "Cancel"))}</button></div></div>`;
            box.querySelector("[data-signout-no]")?.focus();
            return;
          }
          if (b.hasAttribute("data-signout-no")) {
            box.innerHTML = idle;
            box.querySelector("[data-signout-all]")?.focus();
            return;
          }
          if (b.hasAttribute("data-signout-yes")) {
            const rotate = !!box.querySelector("[data-signout-rotate]")
              ?.checked;
            ctx.shell
              .busyAction(
                "sign-out-all",
                (headers) =>
                  ctx.shell.api(
                    "POST",
                    "/api/web/logout",
                    rotate ? { rotate: true } : {},
                    { headers },
                  ),
                { button: b },
              )
              .then((r) => {
                // This browser is signed out too: the page shows sign-in.
                if (r !== undefined) location.reload();
              });
          }
        });
        host.querySelectorAll("[data-revoke]").forEach((btn) =>
          btn.addEventListener("click", () => {
            btn.disabled = true;
            ctx.shell
              .api("POST", "/api/web/logout", { id: btn.dataset.revoke })
              .then(load)
              .catch(() => {
                btn.disabled = false;
              });
          }),
        );
      })
      .catch(() => {
        host.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.devicesSignedIn", "The devices can only be listed signed in."))}</output>`;
      });
  load();
}

/** "10:42" in the person's chosen time zone (the kit's). */
function clockOf(iso) {
  return formatTime(iso, { style: "time" });
}

/**
 * One waiting device's line: its browser and OS, address, age, and the
 * `web login` run it came from. Issue 819: never its code (the person reads
 * that off the new device's own screen and types it).
 */
export function waitingLine(w, now = Date.now()) {
  return {
    title: deviceWords(w.device),
    tip: w.createdAt
      ? L("set.ui.asked", "asked {ago}", { ago: formatTitle(w.createdAt) })
      : "",
    detail: [
      w.client,
      L("set.ui.asked", "asked {ago}", { ago: seenAgo(w.createdAt, now) }),
      w.fromLogin
        ? L("set.ui.fromLogin", "from the web login run at {time}", {
            time: clockOf(w.fromLogin),
          })
        : "",
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/**
 * Issue 819: a typed pairing code as the server reads it: any case, spaces
 * and dashes ignored. Approve is offered once it has six characters.
 */
export function typedPairCode(v) {
  return String(v ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "");
}

/** Issue 819: whether a typed code can be sent (six characters). */
export function pairCodeReady(v) {
  return typedPairCode(v).length === 6;
}

/**
 * Issue 819: an Approve or Deny refused, in this page's language when the
 * server says why (only a person's signed-in browser approves a device,
 * with the code that device's screen shows).
 */
export function approveRefusal(e) {
  const code = e && e.code;
  if (code === "approve_not_agent" || code === "fixture_cannot_approve")
    return L(
      "set.access.approveNotAgent",
      "Only a person approves a device, from their own signed-in browser.",
    );
  if (code === "approve_needs_browser" || code === "signin_to_approve")
    return L(
      "set.access.approveNeedsBrowser",
      "Approving a device needs a signed-in browser. Sign in again on this page, then approve it.",
    );
  if (code === "wrong" || code === "malformed")
    return L(
      "set.access.wrongCode",
      "That code doesn't match the one on that computer's screen. Check it and type it again.",
    );
  if (code === "rate_limited")
    return L(
      "set.access.tooManyTries",
      "Too many tries. Wait a minute and try again.",
    );
  if (code === "ended" || code === "expired" || code === "unknown")
    return L(
      "set.access.ended",
      "That request ended or expired. Nothing was allowed.",
    );
  return String((e && e.message) || e);
}

/**
 * Waiting devices (SEC-2a; issue 819): the computers whose signed-out page
 * shows a code (a sign-in link opened there among them), each with a field
 * for that code, Approve and Deny. Approving needs the code typed off that
 * computer's own screen; it then signs in by itself. Only a person's
 * signed-in browser may. A request past its time is dropped.
 */
function drawWaiting(host, ctx) {
  let timer = null;
  let shown = "";
  let first = true;
  const load = () => {
    clearTimeout(timer);
    if (!host.isConnected && timer !== null) return;
    fetch("/api/web/waiting", { cache: "no-store" })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
      )
      .then((b) => {
        const now = Date.now();
        const list = (b.waiting || []).filter(
          (w) =>
            w &&
            typeof w.ref === "string" &&
            !(w.expiresAt && Date.parse(w.expiresAt) <= now),
        );
        const refs = list.map((w) => w.ref).join(",");
        // A new request shows up without a reload.
        timer = setTimeout(load, 5000);
        if (refs === shown && list.length) {
          // The same requests: only their ages change; typed codes stay.
          list.forEach((w) => {
            const el = host.querySelector(
              `.set-waiting[data-ref="${CSS.escape(w.ref)}"] .set-note`,
            );
            if (el) el.textContent = waitingLine(w, now).detail;
          });
          return;
        }
        // Typed codes survive a redraw (a request came or went).
        const typed = {};
        host.querySelectorAll("input[data-code-for]").forEach((i) => {
          typed[i.dataset.codeFor] = i.value;
        });
        const focused =
          document.activeElement && document.activeElement.dataset
            ? document.activeElement.dataset.codeFor
            : undefined;
        shown = refs;
        host.innerHTML = list.length
          ? '<div id="set-waiting" style="width:100%">' +
            list
              .map((w, i) => {
                const l = waitingLine(w, now);
                const ref = escHtml(w.ref);
                const id = `set-waiting-code-${i}`;
                return (
                  `<div class="set-waiting" data-ref="${ref}" style="${ROW_STYLE}">` +
                  `<div style="flex:1 1 220px;min-width:0"><div>${escHtml(l.title)}</div>` +
                  `<div class="set-note" style="overflow-wrap:anywhere"${l.tip ? ` title="${escHtml(l.tip)}"` : ""}>${escHtml(l.detail)}</div></div>` +
                  `<label for="${id}" class="set-note">${escHtml(L("set.ui.codeLabel", "Code on its screen"))}</label>` +
                  `<input id="${id}" class="mono" data-code-for="${ref}" autocomplete="off" spellcheck="false" autocapitalize="characters" maxlength="12" placeholder="K7Q-42M" style="width:10ch">` +
                  `<button type="button" class="btn primary" data-approve="${ref}" disabled>${escHtml(L("set.ui.approve", "Approve"))}</button>` +
                  `<button type="button" class="btn" data-deny="${ref}">${escHtml(L("set.ui.deny", "Deny"))}</button></div>`
                );
              })
              .join("") +
            '</div><div id="set-waiting-out" style="flex-basis:100%" aria-live="polite"></div>'
          : `<output class="set-ro" id="set-waiting">${escHtml(L("set.ui.noWaiting", "No computers are waiting. A signed-out page on another computer shows a code; it appears here to approve."))}</output>`;
        const act = (btn, path, body) => {
          btn.disabled = true;
          // Issue 698: the kit's dots on the button until the server answers.
          const release = window.denShell?.holdDots?.(btn) ?? (async () => {});
          ctx.shell
            .api("POST", path, body)
            .then(async () => {
              await release();
              shown = "";
              load();
            })
            .catch(async (e) => {
              await release();
              btn.disabled = false;
              const out = host.querySelector("#set-waiting-out");
              if (out)
                out.innerHTML = `<span class="set-note set-warn" role="alert">${escHtml(approveRefusal(e))}</span>`;
              if (e && (e.code === "ended" || e.code === "expired")) {
                shown = "";
                load();
              }
            });
        };
        host.querySelectorAll("input[data-code-for]").forEach((input) => {
          const ref = input.dataset.codeFor;
          const go = host.querySelector(`[data-approve="${CSS.escape(ref)}"]`);
          const sync = () => {
            go.disabled = !pairCodeReady(input.value);
          };
          if (typed[ref] !== undefined) input.value = typed[ref];
          sync();
          input.addEventListener("input", sync);
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !go.disabled) {
              e.preventDefault();
              go.click();
            }
          });
          go.addEventListener("click", () =>
            act(go, "/api/web/approve", {
              ref,
              code: typedPairCode(input.value),
            }),
          );
          if (focused === ref) input.focus();
        });
        // The first (newest, or a link's) request's field is ready to type.
        if (first && list.length && !focused) {
          host.querySelector("input[data-code-for]")?.focus();
          first = false;
        }
        host
          .querySelectorAll("[data-deny]")
          .forEach((b) =>
            b.addEventListener("click", () =>
              act(b, "/api/web/deny", { ref: b.dataset.deny }),
            ),
          );
      })
      .catch(() => {
        shown = "";
        host.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.waitingSignedIn", "Waiting devices can only be listed signed in, or on this machine."))}</output>`;
      });
  };
  load();
}

function drawPair(host, ctx) {
  let timer = null;
  fetch("/api/web/pair", { cache: "no-store" })
    .then((r) => r.json())
    .then((b) => {
      const hosts = b.hosts || [];
      if (!hosts.length) {
        host.innerHTML = `<output class="set-ro" id="set-pair">${L(
          "set.ui.noPairHost",
          "No edge hostname routes to __DEN_TITLE__, so there is no address another device could open. Add one to the config's edge block (edge.aliases for a VPN name), then use the button below: it starts the edge, or applies the change to the one running. {cmd}",
          { cmd: "<code>__DEN_CLI__ edge up</code>" },
        )}</output>`;
        drawEdgeUp(host, ctx);
        return;
      }
      host.innerHTML =
        `<select id="set-pair-host" aria-label="${escHtml(L("set.ui.edgeHost", "Edge hostname"))}">` +
        hosts
          .map((h) => `<option value="${escHtml(h)}">${escHtml(h)}</option>`)
          .join("") +
        "</select> " +
        `<button type="button" class="btn primary" id="set-pair-go">${escHtml(L("set.access.pair", "Pair a device"))}</button>` +
        '<div id="set-pair-out" style="flex-basis:100%" aria-live="polite"></div>';
      const out = host.querySelector("#set-pair-out");
      const go = () => {
        clearTimeout(timer);
        ctx.shell
          .api("POST", "/api/web/pair", {
            host: host.querySelector("#set-pair-host").value,
          })
          .then((p) => {
            out.innerHTML =
              `<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start;margin-top:8px">` +
              `<div id="set-pair-qr" style="line-height:0">${qrSvg(p.url, { scale: 4, margin: 4 })}</div>` +
              `<div style="flex:1 1 220px;min-width:0"><p class="set-note" style="margin:0 0 8px">${escHtml(L("set.ui.pairScan", "Scan it with the other device, or open the link there. It works once, until it expires (below), and signs that browser in for good."))}</p>` +
              `<a id="set-pair-link" href="${escHtml(p.url)}" style="font:12px var(--mono);overflow-wrap:anywhere">${escHtml(p.url)}</a>` +
              `<p class="set-note" id="set-pair-left" style="margin:8px 0 0"></p></div></div>`;
            const until = Date.parse(p.expiresAt);
            const left = out.querySelector("#set-pair-left");
            const tick = () => {
              const s = Math.max(0, Math.round((until - Date.now()) / 1000));
              left.textContent = s
                ? L("set.ui.expiresIn", "Expires in {s} s.", { s })
                : L(
                    "set.ui.pairExpired",
                    "This link expired. Pair again for a new one.",
                  );
              if (s) timer = setTimeout(tick, 1000);
            };
            tick();
          })
          .catch((e) => {
            out.innerHTML = `<span class="set-note set-warn" role="alert">${escHtml(e.message)}</span>`;
          });
      };
      host.querySelector("#set-pair-go").addEventListener("click", go);
    })
    .catch(() => {
      host.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.pairSignedIn", "Pairing works only signed in."))}</output>`;
    });
}

/**
 * Issue 395: Start the edge (Apply, when it runs): what `edge up` runs, on
 * the server (POST /api/edge/up, a person's only), with the working pop-up
 * until it answers; then what it did: started, up to date (nothing
 * restarted), or recreated and why, and about how long it was unreachable.
 */
function edgeUpText(o) {
  if (o?.kind === "started") return L("set.ui.edgeStarted", "Edge started");
  if (o?.kind === "current")
    return L("set.ui.edgeCurrent", "Edge up to date, nothing restarted");
  const why = (o?.changes || [])
    .map((c) => `${c.field}: ${c.old} → ${c.new}`)
    .join(", ");
  return L(
    "set.ui.edgeRecreated",
    "Edge recreated because {why}; it was unreachable for about {s} s",
    {
      why: why || L("set.ui.edgeWhy", "its settings changed"),
      s: o?.downSeconds ?? 1,
    },
  );
}

function drawEdgeUp(host, ctx) {
  const box = document.createElement("div");
  box.style.cssText = "flex-basis:100%;margin-top:8px";
  box.innerHTML =
    `<button type="button" class="btn sm" id="set-edge-up">${escHtml(L("set.ui.edgeStart", "Start the edge"))}</button>` +
    '<p class="set-note" id="set-edge-up-out" aria-live="polite" hidden></p>';
  host.appendChild(box);
  const btn = box.querySelector("#set-edge-up");
  const out = box.querySelector("#set-edge-up-out");
  // Running already: the button applies the config to it.
  fetch("/api/edge", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((b) => {
      if (b?.up) btn.textContent = L("set.ui.edgeApply", "Apply");
    })
    .catch(() => {});
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    out.hidden = true;
    try {
      const r = await ctx.shell.busyAction(
        "edge-up",
        (headers) => ctx.shell.api("POST", "/api/edge/up", {}, { headers }),
        { button: btn, success: (r) => edgeUpText(r?.outcome) },
      );
      if (r?.outcome) {
        out.textContent = edgeUpText(r.outcome);
        out.hidden = false;
        if (r.outcome.kind !== "current")
          btn.textContent = L("set.ui.edgeApply", "Apply");
      }
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * Issue 103: the web apps that may frame the embedded agent pane: one
 * origin a line, saved as a list (the server checks each, exactly).
 */
function drawOrigins(host, ctx, api) {
  const list = Array.isArray(ctx.data?.embed?.origins)
    ? ctx.data.embed.origins
    : [];
  host.innerHTML =
    `<textarea id="set-embed-origins" rows="3" spellcheck="false" style="width:100%;min-width:0;font:inherit" ` +
    `aria-label="${escHtml(L("set.embed.origins", "Web apps that may embed agents"))}" ` +
    `placeholder="https://app.example.com">${escHtml(list.join("\n"))}</textarea>` +
    `<button type="button" class="btn sm" id="set-embed-origins-save">${escHtml(L("set.ui.saveOrigins", "Save list"))}</button>`;
  host
    .querySelector("#set-embed-origins-save")
    .addEventListener("click", () => {
      const v = host
        .querySelector("#set-embed-origins")
        .value.split(/\s+/)
        .map((x) => x.trim())
        .filter(Boolean);
      void api.save(v);
    });
}

/**
 * Issue 334: app keys, for a web app's own server: it relays its person's
 * messages to one agent (typed after the agent's turn) and reads that
 * agent's state. Make and Revoke are held writes: Den's Allow dialog asks
 * the person, and the new key is shown here once, after the Allow.
 */
function drawAppKeys(host, ctx) {
  // Under an invalid config the agents and the keys answer 422: ask nothing.
  if (ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return;
  }
  const shell = ctx.shell;
  const origins = Array.isArray(ctx.data?.embed?.origins)
    ? ctx.data.embed.origins
    : [];
  const when = appKeyWhen;
  let asked = null;
  const ask = (action, args, button) =>
    shell
      .busyAction(
        "ask-allow",
        (headers) =>
          shell.api("POST", "/api/approvals", { action, args }, { headers }),
        { button },
      )
      .then((b) => {
        asked = b && b.id;
        out.innerHTML = `<span class="set-note">${escHtml(L("set.ui.appKeyAllow", "Allow it in the dialog."))}</span>`;
        window.dispatchEvent(new CustomEvent("den:approvals-poll"));
      });
  host.innerHTML =
    `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;flex-basis:100%">` +
    `<select id="set-appkey-agent" aria-label="${escHtml(L("set.ui.appKeyAgent", "Agent"))}"></select>` +
    `<select id="set-appkey-origin" aria-label="${escHtml(L("set.ui.appKeyOrigin", "Web app"))}">` +
    origins
      .map((o) => `<option value="${escHtml(o)}">${escHtml(o)}</option>`)
      .join("") +
    `</select>` +
    `<input id="set-appkey-label" type="text" maxlength="80" aria-label="${escHtml(L("set.ui.appKeyLabel", "Name (optional)"))}" placeholder="${escHtml(L("set.ui.appKeyLabel", "Name (optional)"))}">` +
    `<button type="button" class="btn sm" id="set-appkey-make">${escHtml(L("set.ui.appKeyMake", "Make key"))}</button>` +
    `</div>` +
    `<div id="set-appkey-out" style="flex-basis:100%" aria-live="polite"></div>` +
    `<div id="set-appkey-list" style="flex-basis:100%"></div>`;
  const out = host.querySelector("#set-appkey-out");
  const list = host.querySelector("#set-appkey-list");
  const make = host.querySelector("#set-appkey-make");
  if (!origins.length) {
    make.disabled = true;
    out.innerHTML = `<span class="set-note">${escHtml(L("set.ui.appKeyNoOrigin", "Add the web app to the list above first."))}</span>`;
  }
  shell
    .api("GET", "/api/sessions")
    .then((b) => {
      const agents = ((b && b.sessions) || []).filter(
        (r) => r.kind === "agent" && !r.server,
      );
      host.querySelector("#set-appkey-agent").innerHTML = agents
        .map(
          (r) =>
            `<option value="${escHtml(r.workspace + "/" + r.agent)}">${escHtml(r.workspace + " / " + (r.displayName || r.agent))}</option>`,
        )
        .join("");
      if (!agents.length) make.disabled = true;
    })
    .catch(() => {});
  const draw = () =>
    shell
      .api("GET", "/api/embed/app-keys")
      .then((b) => {
        const keys = (b && b.keys) || [];
        if (!keys.length) {
          list.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.appKeyNone", "No app keys yet."))}</output>`;
          return;
        }
        list.innerHTML =
          `<ul class="set-list" style="list-style:none;padding:0;margin:6px 0 0">` +
          keys
            .map(
              (k) =>
                `<li data-key="${escHtml(k.id)}" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:4px 0">` +
                `<span>${escHtml(k.label || k.id)}: ${escHtml(k.project + " / " + k.agent)} · ${escHtml(k.origin)}</span>` +
                `<span class="set-note">${escHtml(
                  k.lastUsedAt
                    ? L("set.ui.appKeyUsed", "last used {when}", {
                        when: when(k.lastUsedAt),
                      })
                    : L("set.ui.appKeyUnused", "never used"),
                )}</span>` +
                (k.revokedAt
                  ? `<span class="set-note">${escHtml(L("set.ui.appKeyRevoked", "revoked {when}", { when: when(k.revokedAt) }))}</span>`
                  : `<button type="button" class="btn sm" data-revoke="${escHtml(k.id)}">${escHtml(L("set.ui.appKeyRevoke", "Revoke"))}</button>`) +
                `</li>`,
            )
            .join("") +
          `</ul>`;
        for (const btn of list.querySelectorAll("[data-revoke]"))
          btn.addEventListener(
            "click",
            () =>
              void ask(
                "embed_key_revoke",
                { id: btn.getAttribute("data-revoke") },
                btn,
              ).catch((e) => {
                out.innerHTML = `<span class="set-note set-warn" role="alert">${escHtml(e.message)}</span>`;
              }),
          );
      })
      .catch(() => {});
  make.addEventListener("click", () => {
    const pick = host.querySelector("#set-appkey-agent").value.split("/");
    void ask(
      "embed_key_create",
      {
        project: pick[0],
        agent: pick[1],
        origin: host.querySelector("#set-appkey-origin").value,
        label: host.querySelector("#set-appkey-label").value.trim(),
      },
      make,
    ).catch((e) => {
      out.innerHTML = `<span class="set-note set-warn" role="alert">${escHtml(e.message)}</span>`;
    });
  });
  // The shell's Allow says what ran; a new key is in it once (never again).
  window.addEventListener("den:approval-done", (ev) => {
    const d = ev.detail || {};
    if (!asked || d.id !== asked || !host.isConnected) return;
    asked = null;
    const key = d.result && d.result.once && d.result.once.key;
    if (key) {
      out.innerHTML =
        `<p class="set-note">${escHtml(L("set.ui.appKeyOnce", "Copy this key into the web app's backend now. It is not shown again."))}</p>` +
        `<input type="text" readonly id="set-appkey-new" style="width:100%;font-family:var(--mono)" aria-label="${escHtml(L("set.ui.appKeyNew", "New app key"))}">` +
        `<button type="button" class="btn sm" id="set-appkey-copy">${escHtml(L("set.ui.copy", "Copy"))}</button>`;
      const box = out.querySelector("#set-appkey-new");
      box.value = key;
      out.querySelector("#set-appkey-copy").addEventListener("click", () => {
        box.select();
        if (navigator.clipboard) void navigator.clipboard.writeText(box.value);
      });
    } else out.innerHTML = "";
    draw();
  });
  draw();
}

/**
 * Issue 621: the gate-only runner tokens (names and dates; never a token).
 * An agent asks for one with a held write the person allows; the person
 * revokes one here, and it answers 401 at once.
 */
function drawRunnerTokens(host, ctx) {
  const shell = ctx.shell;
  host.innerHTML =
    `<div id="set-runner-out" style="flex-basis:100%" aria-live="polite"></div>` +
    `<div id="set-runner-list" style="flex-basis:100%"></div>`;
  const out = host.querySelector("#set-runner-out");
  const list = host.querySelector("#set-runner-list");
  const when = appKeyWhen;
  const draw = () =>
    shell
      .api("GET", "/api/gate-slots/runners")
      .then((b) => {
        const runners = (b && b.runners) || [];
        if (!runners.length) {
          list.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.runnerNone", "No runner tokens yet."))}</output>`;
          return;
        }
        list.innerHTML =
          `<ul class="set-list" style="list-style:none;padding:0;margin:6px 0 0">` +
          runners
            .map(
              (r) =>
                `<li data-runner="${escHtml(r.id)}" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:4px 0">` +
                `<span>${escHtml(r.name)}</span>` +
                `<span class="set-note">${escHtml(
                  r.lastUsedAt
                    ? L("set.ui.appKeyUsed", "last used {when}", {
                        when: when(r.lastUsedAt),
                      })
                    : L("set.ui.appKeyUnused", "never used"),
                )}</span>` +
                (r.revokedAt
                  ? `<span class="set-note">${escHtml(L("set.ui.appKeyRevoked", "revoked {when}", { when: when(r.revokedAt) }))}</span>`
                  : `<button type="button" class="btn sm" data-revoke="${escHtml(r.id)}">${escHtml(L("set.ui.appKeyRevoke", "Revoke"))}</button>`) +
                `</li>`,
            )
            .join("") +
          `</ul>`;
        for (const btn of list.querySelectorAll("[data-revoke]"))
          btn.addEventListener("click", () => {
            shell
              .busyAction(
                "save",
                (headers) =>
                  shell.api(
                    "POST",
                    "/api/gate-slots/runners/revoke",
                    { id: btn.getAttribute("data-revoke") },
                    { headers },
                  ),
                { button: btn },
              )
              .then(() => {
                out.innerHTML = "";
                draw();
              })
              .catch((e) => {
                out.innerHTML = `<span class="set-note set-warn" role="alert">${escHtml(e.message)}</span>`;
              });
          });
      })
      .catch(() => {});
  draw();
}

/**
 * Issue 625: the test boxes, browser slots on other machines. A person
 * adds one (its name, how Den reaches it, its slots, its hold file and
 * time scale, its window in this machine's time, its recheck time, on or
 * off), turns one on or off, and removes one. Saving a box of the same
 * name replaces it.
 * Never a key: ssh names a key file on this machine.
 */
function drawGateBoxes(host, ctx) {
  const shell = ctx.shell;
  const field = (id, key, en, type, extra) =>
    `<label style="display:flex;flex-direction:column;gap:2px;min-width:140px;flex:1 1 140px">` +
    `<span class="set-note">${escHtml(L(key, en))}</span>` +
    `<input id="${id}" type="${type}" ${extra || ""}></label>`;
  host.innerHTML =
    `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;flex-basis:100%">` +
    field("set-box-name", "set.ui.boxName", "Name", "text", 'maxlength="64"') +
    field(
      "set-box-ssh",
      "set.ui.boxSsh",
      "ssh (login@host)",
      "text",
      'maxlength="320"',
    ) +
    field(
      "set-box-port",
      "set.ui.boxPort",
      "ssh port",
      "number",
      'min="1" max="65535" step="1"',
    ) +
    field(
      "set-box-key",
      "set.ui.boxKey",
      "ssh key file",
      "text",
      'maxlength="512"',
    ) +
    field(
      "set-box-pw",
      "set.ui.boxPw",
      "Playwright address (ws://)",
      "text",
      'maxlength="512"',
    ) +
    field(
      "set-box-slots",
      "set.ui.boxSlots",
      "Browser slots",
      "number",
      'min="1" max="64" step="1" value="1"',
    ) +
    field(
      "set-box-hold",
      "set.ui.boxHold",
      "Hold file (on the box)",
      "text",
      'maxlength="512"',
    ) +
    field(
      "set-box-scale",
      "set.ui.boxScale",
      "Time scale",
      "number",
      'min="1" max="10" step="0.1" value="1"',
    ) +
    field(
      "set-box-mem",
      "set.ui.boxMem",
      "Keep free memory (MB)",
      "number",
      'min="0" step="256" placeholder="2048"',
    ) +
    field(
      "set-box-pwv",
      "set.ui.boxPwv",
      "Playwright version on the box",
      "text",
      'maxlength="48" placeholder="1.48.0"',
    ) +
    field(
      "set-box-pws",
      "set.ui.boxPws",
      "Or Playwright by version (1.61=ws://…, 1.63=ws://…)",
      "text",
      `maxlength="2048" placeholder="${escHtml(L("set.ui.boxPwsEx", "1.61=ws://box:3931, 1.63=ws://box:3932"))}"`,
    ) +
    field(
      "set-box-window",
      "set.ui.boxWindow",
      "Window (this machine's time)",
      "text",
      'maxlength="11" placeholder="00:00-08:00"',
    ) +
    field(
      "set-box-recheck",
      "set.ui.boxRecheck",
      "Recheck after, in seconds",
      "number",
      'min="1" max="86400" step="1"',
    ) +
    `<label style="display:flex;gap:4px;align-items:center"><input type="checkbox" id="set-box-on" checked> ${escHtml(L("set.ui.boxOn", "On"))}</label>` +
    `<button type="button" class="btn sm" id="set-box-save">${escHtml(L("set.ui.boxSave", "Save box"))}</button>` +
    `</div>` +
    `<div id="set-box-out" style="flex-basis:100%" aria-live="polite"></div>` +
    `<div id="set-box-list" style="flex-basis:100%"></div>`;
  const out = host.querySelector("#set-box-out");
  const list = host.querySelector("#set-box-list");
  const save = host.querySelector("#set-box-save");
  const val = (id) => host.querySelector(id).value.trim();
  const num = (id) => (val(id) === "" ? undefined : Number(val(id)));
  const pwPairs = (text) => {
    if (!text) return undefined;
    const map = {};
    for (const part of text.split(",")) {
      const p = part.trim();
      if (!p) continue;
      const eq = p.indexOf("=");
      // A pair without "=" goes to the server as is, which says what is wrong.
      if (eq < 1) map[p] = "";
      else map[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    }
    return map;
  };
  const warn = (e) => {
    out.innerHTML = `<span class="set-note set-warn" role="alert">${escHtml(e.message)}</span>`;
  };
  const post = (path, body, button) =>
    shell
      .busyAction(
        "save",
        (headers) => shell.api("POST", path, body, { headers }),
        { button },
      )
      .then(() => {
        out.innerHTML = "";
        draw();
      });
  const draw = () =>
    shell
      .api("GET", "/api/gate-slots/boxes")
      .then((b) => {
        const boxes = (b && b.boxes) || [];
        if (!boxes.length) {
          list.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.boxNone", "No test boxes. Browser runs use this machine only."))}</output>`;
          return;
        }
        list.innerHTML =
          `<ul class="set-list" style="list-style:none;padding:0;margin:6px 0 0">` +
          boxes
            .map(
              (x) =>
                `<li style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:4px 0">` +
                `<span>${escHtml(x.name)}</span>` +
                `<span class="set-note">${escHtml(
                  L("set.ui.boxSlotsN", "{n} browser slots", {
                    n: x.browser_slots,
                  }),
                )}</span>` +
                `<span class="set-note mono">${escHtml(
                  [
                    x.ssh,
                    x.playwright,
                    ...Object.entries(x.playwright_endpoints || {}).map(
                      ([v, ws]) => `${v}=${ws}`,
                    ),
                  ]
                    .filter(Boolean)
                    .join(" · "),
                )}</span>` +
                (x.hold_file
                  ? `<span class="set-note">${escHtml(L("set.ui.boxHoldIs", "hold file {path}", { path: x.hold_file }))}</span>`
                  : "") +
                (x.time_scale && x.time_scale !== 1
                  ? `<span class="set-note">${escHtml(L("set.ui.boxScaleIs", "time ×{n}", { n: x.time_scale }))}</span>`
                  : "") +
                (x.window
                  ? `<span class="set-note">${escHtml(L("set.ui.boxWindowIs", "{window}, this machine's time", { window: x.window }))}</span>`
                  : "") +
                (x.enabled === false
                  ? `<span class="set-note set-warn">${escHtml(L("set.ui.boxIsOff", "turned off"))}</span>`
                  : "") +
                `<button type="button" class="btn sm" data-box-on="${escHtml(x.name)}" data-on="${x.enabled === false ? "1" : "0"}">${escHtml(
                  x.enabled === false
                    ? L("set.ui.boxTurnOn", "Turn on")
                    : L("set.ui.boxTurnOff", "Turn off"),
                )}</button>` +
                `<button type="button" class="btn sm" data-box-rm="${escHtml(x.name)}">${escHtml(L("set.ui.boxRemove", "Remove"))}</button>` +
                `</li>`,
            )
            .join("") +
          `</ul>`;
        for (const btn of list.querySelectorAll("[data-box-on]"))
          btn.addEventListener("click", () => {
            post(
              "/api/gate-slots/boxes/enable",
              {
                name: btn.getAttribute("data-box-on"),
                enabled: btn.getAttribute("data-on") === "1",
              },
              btn,
            ).catch(warn);
          });
        for (const btn of list.querySelectorAll("[data-box-rm]"))
          btn.addEventListener("click", () => {
            post(
              "/api/gate-slots/boxes/remove",
              { name: btn.getAttribute("data-box-rm") },
              btn,
            ).catch(warn);
          });
      })
      .catch(() => {});
  save.addEventListener("click", () => {
    const box = {
      name: val("#set-box-name"),
      ssh: val("#set-box-ssh") || undefined,
      ssh_port: num("#set-box-port"),
      ssh_identity: val("#set-box-key") || undefined,
      playwright: val("#set-box-pw") || undefined,
      browser_slots: num("#set-box-slots"),
      hold_file: val("#set-box-hold") || undefined,
      time_scale: num("#set-box-scale"),
      min_free_mem_mb: num("#set-box-mem"),
      playwright_version: val("#set-box-pwv") || undefined,
      // Issue 1017: "1.61=ws://…, 1.63=ws://…" → version → address.
      playwright_endpoints: pwPairs(val("#set-box-pws")),
      window: val("#set-box-window") || undefined,
      recheck_seconds: num("#set-box-recheck"),
      enabled: host.querySelector("#set-box-on").checked,
    };
    post("/api/gate-slots/boxes", { box }, save).catch(warn);
  });
  draw();
}

/** Issue 103: Settings › Embedding (user.yml embed.*, embed-settings.ts). */
const EMBED_ROWS = [
  {
    id: "embed.app_keys",
    category: "embed",
    label: "App keys",
    description:
      "A key for a web app's own backend on this computer: it can pass on its person's messages to one agent, typed after the agent's turn, and read that agent's state. Nothing else. You allow each key, it is shown once, and you can revoke it here.",
    keywords: ["embed", "key", "app key", "web app", "message", "revoke"],
    scope: "user",
    control: { type: "custom", render: drawAppKeys },
    read: () => null,
  },
  {
    id: "embed.origins",
    category: "embed",
    label: "Web apps that may embed agents",
    description:
      "Each web app's address, exactly, one a line: https://app.example.com. Only these can show an agent pane inside their pages, and only after you allow it. No other site can show any page of this Den inside its own.",
    keywords: ["embed", "frame", "iframe", "origin", "allow", "web app"],
    scope: "user",
    keys: ["embed.origins"],
    control: { type: "custom", render: drawOrigins },
    read: (ctx) => ctx.data.embed?.origins ?? [],
    write: (v, ctx) => ctx.post({ embed: { origins: v.length ? v : null } }),
  },
  {
    id: "embed.context_max_kb",
    category: "embed",
    label: "Largest shared page",
    description:
      "The largest page another web app may share with an agent. A larger one is refused, and the pane says why.",
    keywords: ["embed", "share", "page", "context", "size", "limit"],
    scope: "user",
    keys: ["embed.context_max_kb"],
    control: { type: "number", min: 1, max: 10240, step: 1, unit: "KB" },
    read: (ctx) => ctx.data.embed?.context_max_kb ?? 256,
    write: (v, ctx) => ctx.post({ embed: { context_max_kb: v } }),
  },
  {
    id: "embed.key_minutes",
    category: "embed",
    label: "Embedded pane's permission lasts",
    description:
      "How long an embedded agent pane may send before it asks again.",
    keywords: ["embed", "key", "minutes", "expire"],
    scope: "user",
    keys: ["embed.key_minutes"],
    control: { type: "number", min: 1, max: 1440, step: 1, unit: "min" },
    read: (ctx) => ctx.data.embed?.key_minutes ?? 15,
    write: (v, ctx) => ctx.post({ embed: { key_minutes: v } }),
  },
  {
    id: "embed.app_key_audit",
    category: "embed",
    label: "App key reads in one activity line",
    description:
      "An app key's state reads go into the activity trail as one line per this many seconds, with how many there were, so a web app that checks often doesn't flood it.",
    keywords: ["embed", "app key", "audit", "activity", "window", "seconds"],
    scope: "user",
    keys: ["embed.app_key_audit_window_seconds"],
    control: { type: "number", min: 1, max: 86400, step: 1, unit: "s" },
    read: (ctx) => ctx.data.embed?.app_key_audit_window_seconds ?? 60,
    write: (v, ctx) => ctx.post({ embed: { app_key_audit_window_seconds: v } }),
  },
  {
    // Issue 459: app event feeds read at once, across every project.
    id: "embed.feed_max_streams",
    category: "embed",
    label: "App feeds read at once",
    description:
      "The most app event feeds Den reads at one time, across every project. Past it, a feed isn't read, and its project's notifications say so.",
    keywords: ["feed", "events", "stream", "limit"],
    scope: "user",
    keys: ["embed.feed_max_streams"],
    control: { type: "number", min: 1, max: 10000, step: 1 },
    read: (ctx) => ctx.data.embed?.feed_max_streams ?? 50,
    write: (v, ctx) => ctx.post({ embed: { feed_max_streams: v } }),
  },
  {
    id: "embed.feed_event_max_kb",
    category: "embed",
    label: "Largest app feed event",
    description:
      "The largest event an app feed keeps for its agent. A larger one is kept as a note that it came, without its data, and the project's notifications say so.",
    keywords: ["feed", "event", "size", "limit"],
    scope: "user",
    keys: ["embed.feed_event_max_kb"],
    control: { type: "number", min: 1, max: 10240, step: 1, unit: "KB" },
    read: (ctx) => ctx.data.embed?.feed_event_max_kb ?? 32,
    write: (v, ctx) => ctx.post({ embed: { feed_event_max_kb: v } }),
  },
  {
    id: "embed.feed_events_per_minute",
    category: "embed",
    label: "App feed events a minute",
    description:
      "How many events Den reads from one app feed in a minute. Past it, Den reads the rest as the rate allows, and the project's notifications say so.",
    keywords: ["feed", "events", "rate", "minute", "limit"],
    scope: "user",
    keys: ["embed.feed_events_per_minute"],
    control: { type: "number", min: 1, max: 1000000, step: 1 },
    read: (ctx) => ctx.data.embed?.feed_events_per_minute ?? 600,
    write: (v, ctx) => ctx.post({ embed: { feed_events_per_minute: v } }),
  },
  {
    id: "embed.feed_keep_events",
    category: "embed",
    label: "Events one app feed keeps",
    description:
      "The most events Den keeps for one app feed. Past it, the oldest go, and the project's notifications say so when one wasn't read yet.",
    keywords: ["feed", "events", "keep", "limit"],
    scope: "user",
    keys: ["embed.feed_keep_events"],
    control: { type: "number", min: 1, max: 1000000, step: 1 },
    read: (ctx) => ctx.data.embed?.feed_keep_events ?? 1000,
    write: (v, ctx) => ctx.post({ embed: { feed_keep_events: v } }),
  },
  {
    id: "embed.feed_read_max_kb",
    category: "embed",
    label: "Most app feed data in one read",
    description:
      "The most event data one app_feed_read call gives an agent. It reads the rest with another call.",
    keywords: ["feed", "read", "size", "limit"],
    scope: "user",
    keys: ["embed.feed_read_max_kb"],
    control: { type: "number", min: 1, max: 102400, step: 1, unit: "KB" },
    read: (ctx) => ctx.data.embed?.feed_read_max_kb ?? 256,
    write: (v, ctx) => ctx.post({ embed: { feed_read_max_kb: v } }),
  },
  {
    id: "embed.feed_list_timeout",
    category: "embed",
    label: "App feed list wait",
    description:
      "How long Den waits for an app's list of events (it fills a gap after a cut) before it tries again later.",
    keywords: ["feed", "list", "timeout", "wait"],
    scope: "user",
    keys: ["embed.feed_list_timeout_seconds"],
    control: { type: "number", min: 1, max: 3600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.embed?.feed_list_timeout_seconds ?? 30,
    write: (v, ctx) => ctx.post({ embed: { feed_list_timeout_seconds: v } }),
  },
  {
    id: "embed.feed_list_max_mb",
    category: "embed",
    label: "Largest app feed list answer",
    description:
      "The largest list of events Den reads from an app at once. A larger answer is refused and tried again later.",
    keywords: ["feed", "list", "size", "limit"],
    scope: "user",
    keys: ["embed.feed_list_max_mb"],
    control: { type: "number", min: 1, max: 1024, step: 1, unit: "MB" },
    read: (ctx) => ctx.data.embed?.feed_list_max_mb ?? 8,
    write: (v, ctx) => ctx.post({ embed: { feed_list_max_mb: v } }),
  },
  {
    id: "embed.paste_max_kb",
    category: "embed",
    label: "Most text typed into an agent at once",
    description:
      "The most text Den types into an agent in one go: Hub comments, relayed messages and app feed lines. The rest are typed next.",
    keywords: ["paste", "type", "agent", "limit", "size"],
    scope: "user",
    keys: ["embed.paste_max_kb"],
    control: { type: "number", min: 1, max: 102400, step: 1, unit: "KB" },
    read: (ctx) => ctx.data.embed?.paste_max_kb ?? 256,
    write: (v, ctx) => ctx.post({ embed: { paste_max_kb: v } }),
  },
  {
    id: "embed.url_max",
    category: "embed",
    label: "Longest link context",
    description:
      "The longest web address a link to an agent may carry for its message box. A longer one opens a page that says so.",
    keywords: ["link", "deep link", "context", "url", "length", "embed"],
    scope: "user",
    keys: ["embed.url_max_chars"],
    control: { type: "number", min: 64, max: 1000000, step: 1 },
    read: (ctx) => ctx.data.embed?.url_max_chars ?? 8192,
    write: (v, ctx) => ctx.post({ embed: { url_max_chars: v } }),
  },
];

const ACCESS_ROWS = [
  {
    id: "access.owner",
    category: "access",
    label: "Owner",
    description:
      "The GitHub account this Den belongs to. Linking stores only its id (the token is thrown away), and from then on that account can sign in from any device. __DEN_CLI__ web owner link does the same from the command line.",
    keywords: ["owner", "github", "identity", "link", "account"],
    scope: "user",
    control: { type: "custom", render: drawOwner },
    read: () => null,
  },
  {
    id: "access.devices",
    category: "access",
    label: "Linked devices",
    description:
      "The browsers signed in to this Den. Revoke ends one at once. __DEN_CLI__ web logout --all ends them all.",
    keywords: ["devices", "sessions", "revoke", "browsers", "signed in"],
    scope: "user",
    control: { type: "custom", render: drawDevices },
    read: () => null,
  },
  {
    id: "access.waiting",
    category: "access",
    label: "Waiting devices",
    description:
      "Computers whose signed-out page shows a code. Type the code that computer's screen shows to approve it, and its page signs in by itself; a request lasts 10 minutes. __DEN_CLI__ web approve --list lists them.",
    keywords: ["waiting", "approve", "code", "pair", "device", "deny"],
    scope: "user",
    control: { type: "custom", render: drawWaiting },
    read: () => null,
  },
  {
    // Issue 819: how many new devices one address may ask for a minute.
    id: "access.pair_requests",
    category: "access",
    label: "New sign-in requests per address, a minute",
    description:
      "How many new devices one address may ask to sign in a minute. More are turned away until the minute is up. __DEN_CLI__ config web.pair_requests_per_minute=30",
    keywords: [
      "pair",
      "sign-in",
      "requests",
      "limit",
      "rate",
      "web.pair_requests_per_minute",
    ],
    scope: "user",
    keys: ["web_pairing.requests_per_minute"],
    control: { type: "number", min: 1, max: 10000, step: 1 },
    read: (ctx) => ctx.data.web_pairing?.requestsPerMinute ?? 30,
    write: (v, ctx) => ctx.post({ web_pairing: { requests_per_minute: v } }),
  },
  {
    // Issue 819: wrong codes approving a device may take, per window.
    id: "access.approve_attempts",
    category: "access",
    label: "Wrong codes allowed when approving",
    description:
      "How many wrong codes approving a device may take in the window below before it waits. __DEN_CLI__ config web.approve_attempts=10",
    keywords: ["approve", "code", "wrong", "limit", "web.approve_attempts"],
    scope: "user",
    keys: ["web_pairing.approve_attempts"],
    control: { type: "number", min: 1, max: 1000, step: 1 },
    read: (ctx) => ctx.data.web_pairing?.approveAttempts ?? 10,
    write: (v, ctx) => ctx.post({ web_pairing: { approve_attempts: v } }),
  },
  {
    id: "access.approve_window",
    category: "access",
    label: "Wrong-code window, in seconds",
    description:
      "How long wrong codes are counted for. Once it passes, approving can be tried again. __DEN_CLI__ config web.approve_window_seconds=30",
    keywords: [
      "approve",
      "code",
      "wrong",
      "window",
      "web.approve_window_seconds",
    ],
    scope: "user",
    keys: ["web_pairing.approve_window_seconds"],
    control: { type: "number", min: 1, max: 3600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.web_pairing?.approveWindowSeconds ?? 30,
    write: (v, ctx) => ctx.post({ web_pairing: { approve_window_seconds: v } }),
  },
  {
    // Issue 796: an agent's read-only view of these pages (MCP page_view).
    id: "access.agent_view",
    category: "access",
    label: "Agents may view pages, read-only",
    description:
      "On, an agent running here may open these pages read-only, as itself, to look or take a screenshot (page_view). It changes nothing, and each page it opens is logged with its name. Off, the agent is told views are off. __DEN_CLI__ config web.agent_view=true",
    keywords: ["agent", "view", "read-only", "page_view", "web.agent_view"],
    scope: "user",
    keys: ["web_agent_view.on"],
    control: { type: "toggle" },
    read: (ctx) => ctx.data.web_agent_view?.on !== false,
    write: (v, ctx) => ctx.post({ web_agent_view: { on: !!v } }),
  },
  {
    id: "access.agent_view_minutes",
    category: "access",
    label: "An agent's view lasts, in minutes",
    description:
      "How long an agent's read-only view of these pages lasts, then it ends. __DEN_CLI__ config web.agent_view_minutes=10",
    keywords: ["agent", "view", "read-only", "minutes", "web.agent_view"],
    scope: "user",
    keys: ["web_agent_view.minutes"],
    control: { type: "number", min: 1, max: 60, step: 1, unit: "min" },
    read: (ctx) => ctx.data.web_agent_view?.minutes ?? 10,
    write: (v, ctx) => ctx.post({ web_agent_view: { minutes: v } }),
  },
  {
    id: "access.machine_name",
    category: "access",
    label: "Machine name",
    description:
      'What the signed-out page calls this machine ("runs on <name>"), so people on other computers know where to run a command. Empty: its short hostname.',
    keywords: ["machine", "name", "hostname", "host", "signed out"],
    scope: "user",
    control: { type: "text" },
    keys: ["machine_name"],
    read: (ctx) => ctx.data.machine_name ?? "",
    write: (v, ctx) =>
      ctx.post({ machine_name: String(v ?? "").trim() || null }),
  },
  {
    id: "access.pair",
    category: "access",
    label: "Pair a device",
    description:
      "Without GitHub, or offline: a one-time link and QR code for one edge hostname (__DEN_CLI__ web login --host <name>).",
    keywords: ["pair", "qr", "device", "link", "phone", "edge"],
    scope: "user",
    control: { type: "custom", render: drawPair },
    read: () => null,
  },
  {
    id: "access.test_install",
    category: "access",
    label: "Test install",
    description:
      "Whether this install is marked a test install: web.test_install in the distribution config, set by hand. Only then can live checks sign in, as a test person (never you, never an agent). Set up test person makes it once, here in your browser.",
    keywords: ["test", "test install", "live checks", "fixture", "gate"],
    scope: "user",
    control: { type: "custom", render: drawTestInstall },
    read: () => null,
  },
  {
    id: "access.test_installs_here",
    category: "access",
    label: "Test installs on this computer",
    description:
      "Test installs on this computer whose launcher announces them and that wait for their test person. Set up test person sets it up from here, in any browser, on your own Allow.",
    keywords: ["test", "test install", "test person", "live checks", "bed"],
    scope: "user",
    control: { type: "custom", render: drawTestInstallsHere },
    read: () => null,
  },
];

/**
 * Issue 816: the row's list. `installs`: GET /api/web/test-installs's,
 * each {id, where, port}. `t(key, en, vars)` words it.
 */
export function testInstallsHereHtml(installs, t = (_k, en) => en) {
  if (!installs || !installs.length)
    return `<output class="set-ro" id="set-test-installs" data-count="0">${escHtml(t("set.ui.testInstallsNone", "No test install on this computer is waiting for its test person."))}</output>`;
  return (
    `<ul class="set-list" id="set-test-installs" data-count="${installs.length}">` +
    installs
      .map(
        (i) =>
          `<li><span>${escHtml(t("set.ui.testInstallsOne", "{where} (test install {id})", { where: i.where, id: i.id }))}</span> ` +
          `<button type="button" class="btn sm" data-test-install-setup="${escHtml(i.id)}">${escHtml(t("set.ui.testPersonSetUp", "Set up test person"))}</button></li>`,
      )
      .join("") +
    `</ul>`
  );
}

/**
 * Issue 816: Settings › Access › Test installs on this computer. Set up
 * test person asks for the held write test_person_setup; the shell's Allow
 * dialog takes it from there, and the list is read again when it's done.
 */
function drawTestInstallsHere(host, ctx) {
  const load = () =>
    fetch("/api/web/test-installs", { cache: "no-store" })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
      )
      .then((b) => {
        host.innerHTML = testInstallsHereHtml(b.installs || [], L);
        for (const btn of host.querySelectorAll("[data-test-install-setup]"))
          btn.addEventListener("click", () => {
            const id = btn.getAttribute("data-test-install-setup");
            const run = (headers) =>
              ctx.shell.api(
                "POST",
                "/api/approvals",
                { action: "test_person_setup", args: { id } },
                { headers },
              );
            void (
              ctx.shell.busyAction
                ? ctx.shell.busyAction("ask-allow", run, {
                    button: btn,
                  })
                : run({})
            )
              .then(() =>
                window.dispatchEvent(new CustomEvent("den:approvals-poll")),
              )
              .catch((e) => {
                host.insertAdjacentHTML(
                  "beforeend",
                  `<p class="set-note set-warn" role="alert">${escHtml(e.message)}</p>`,
                );
              });
          });
      })
      .catch(() => {
        host.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.testInstallsSignedIn", "Only the signed-in person sees the test installs on this computer."))}</output>`;
      });
  load();
  window.addEventListener("den:approval-done", (ev) => {
    if (host.isConnected && ev.detail?.action === "test_person_setup") load();
  });
}

/**
 * Issue 810: Settings › Access › Test install. Read only: whether this is a
 * test install (set by hand in the distribution config) and whether its
 * test person is set up. Set up test person shows on a test install only.
 */
function drawTestInstall(host, ctx) {
  const draw = (b) => {
    const lines = [
      b.testInstall
        ? L("set.ui.testInstallYes", "This is a test install.")
        : L(
            "set.ui.testInstallNo",
            "Not a test install. Live checks can't sign in here. A person marks a test install by hand in the distribution config (web.test_install: true).",
          ),
    ];
    if (b.testInstall)
      lines.push(
        b.ready
          ? L("set.ui.testPersonReady", "The test person is set up.")
          : L("set.ui.testPersonMissing", "The test person isn't set up yet."),
      );
    host.innerHTML =
      `<output class="set-ro" id="set-test-install" data-test-install="${b.testInstall ? "yes" : "no"}" data-ready="${b.ready ? "yes" : "no"}">${lines.map(escHtml).join(" ")}</output>` +
      (b.testInstall
        ? ` <button type="button" class="btn" id="set-test-person">${escHtml(L("set.ui.testPersonSetUp", "Set up test person"))}</button>`
        : "");
    const btn = host.querySelector("#set-test-person");
    if (!btn) return;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const run = (headers) =>
          ctx.shell.api("POST", "/api/web/fixture-person", {}, { headers });
        const r = ctx.shell.busyAction
          ? await ctx.shell.busyAction("test-person", run, { button: btn })
          : await run({});
        if (r?.ok) draw(r);
      } finally {
        btn.disabled = false;
      }
    });
  };
  fetch("/api/web/fixture-person", { cache: "no-store" })
    .then((r) =>
      r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
    )
    .then(draw)
    .catch(() => {
      host.innerHTML = `<output class="set-ro">${escHtml(L("set.ui.testInstallSignedIn", "The test install can only be read signed in, or on this machine."))}</output>`;
    });
}

/**
 * Issue 163: Apply for Keep agents running after logout. The server says
 * when sudo needs the password (needsSudo, LK-0); only then the page asks
 * (askSudo), and applies again. Applied: Den re-installs its jobs and
 * restarts, and the page waits for it (waitBack). Resolves with
 * { state: applied | saved | refused | failed, mode? }.
 */
export async function applyKeepRunning(on, { post, askSudo, waitBack }) {
  let r = await post({ on });
  if (r?.needsSudo) {
    if (!(await askSudo(r.needsSudo))) return { state: "refused" };
    r = await post({ on });
  }
  if (!r?.ok) return { state: "failed" };
  if (!r.applied) return { state: "saved", mode: r.mode };
  await waitBack();
  return { state: "applied", mode: r.mode };
}

/**
 * Issue 163 (b): what the Settings row says about the agents' sign-in
 * token under the always-on service: none set (agents will not be able to
 * sign in after logout), the store's credential in the login keychain,
 * old, or when it was set. Never the token: the
 * server sends whether one is configured and when it was set.
 */
export function keepTokenLine(s, t) {
  // Issue 163 (dev.2 gate): per mode, as the CLI says it. No store comes
  // first; not under the always-on service, nothing about logout.
  if (!s || !s.configured)
    return {
      state: "missing",
      text: s?.no_store
        ? t("keep.noStore")
        : s && s.mode !== "token"
          ? t("keep.noTokenNotNeeded")
          : t("keep.noToken", { runtime: tokenRuntime(s, t) }),
      // Issue 399: the line points at the Sign-in token field below.
      ...(s?.no_store || (s && s.mode !== "token") ? {} : { go: true }),
    };
  // The store's own credential in the login keychain: the daemon may not
  // reach it, so the token can't be read either.
  if (s.cred_keychain) return { state: "cred", text: t("keep.credKeychain") };
  if (s.old)
    return {
      state: "old",
      text: t("keep.tokenOld", { n: s.age_days, runtime: tokenRuntime(s, t) }),
      go: true,
    };
  if (s.set_at) {
    const set = t("keep.tokenSet", { date: localDay(s.set_at) });
    return {
      state: "set",
      text: s.process_local ? `${set} ${t("keep.processLocal")}` : set,
    };
  }
  return { state: "set", text: t("keep.tokenStore", { store: s.store || "" }) };
}

/**
 * A set date in the person's chosen zone and the page's language, the
 * kit's way (issue 668); the ISO date when it can't be read.
 */
function localDay(iso) {
  return formatTime(iso, { style: "date" }) || String(iso ?? "").slice(0, 10);
}

/** An app key's used or revoked time, the kit's way (issue 668). */
export function appKeyWhen(iso) {
  return iso ? formatTime(iso) : "";
}

/**
 * Issue 339: what an account's row says (never a token): no token, or
 * when it was set.
 */
export function accountLine(a, t) {
  if (!a?.configured) return { state: "missing", text: t("acct.none") };
  if (!a.set_at) return { state: "set", text: t("acct.setUnknown") };
  return { state: "set", text: t("acct.set", { date: localDay(a.set_at) }) };
}

/**
 * Issue 339: an account's name, or "<vendor> account A" in the reader's
 * words (a vendor's own account, never a person: words.js, 2026-11-17).
 */
export function accountName(a, t, vendor) {
  return (
    a.name ||
    t("acct.default", { vendor: vendor || "", letter: a.letter || a.id })
  );
}

/**
 * Issue 339: a vendor shows its rows once it has more than one account
 * (or isn't Claude Code, whose account one is today's single field).
 */
function accountRows(v) {
  return v.runtime !== "den-claude" || v.accounts.length > 1;
}

function renderAccountList(list, t) {
  return (list || [])
    .map((v) => {
      const rows = accountRows(v)
        ? v.accounts
            .map((a, i) => {
              const name = accountName(a, t, v.account || v.name);
              const l = accountLine(a, t);
              const last = i === v.accounts.length - 1;
              return (
                `<div class="set-note" data-acct="${escR(a.id)}" data-acct-state="${l.state}" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">` +
                `<strong>${escR(name)}</strong> <span data-acct-status>${escR(l.text)}${a.first ? ` ${escR(t("acct.first"))}` : ""}</span>` +
                `<input type="password" autocomplete="off" spellcheck="false" data-acct-token aria-label="${escR(t("acct.tokenLabel", { name }))}">` +
                `<button type="button" class="btn sm" data-acct-save>${escR(t("acct.tokenSave"))}</button>` +
                `<button type="button" class="btn sm" data-acct-up aria-label="${escR(t("acct.up"))}" title="${escR(t("acct.up"))}"${i === 0 ? " disabled" : ""}>↑</button>` +
                `<button type="button" class="btn sm" data-acct-down aria-label="${escR(t("acct.down"))}" title="${escR(t("acct.down"))}"${last ? " disabled" : ""}>↓</button>` +
                `</div>`
              );
            })
            .join("")
        : "";
      return (
        `<div data-acct-runtime="${escR(v.runtime)}" style="display:grid;gap:6px">` +
        `<p class="set-note"><strong>${escR(t("acct.title", { vendor: v.account || v.name }))}</strong></p>` +
        rows +
        `<div><button type="button" class="btn sm" data-acct-add>${escR(t("acct.add", { vendor: v.account || v.name }))}</button></div>` +
        `<p class="set-note" data-acct-note hidden></p>` +
        `</div>`
      );
    })
    .join("");
}

/**
 * Issue 339: Settings' sign-in accounts, per vendor: Add account, Set
 * sign-in token (the same hidden field as today, cleared before the
 * answer comes, never filled from the server) and Move up / down. Each
 * answer is the new list, drawn again.
 */
function wireAccounts(host, ctx, t) {
  const box = host.querySelector("[data-acct-list]");
  if (!box) return;
  const legacyRow = host.querySelector("[data-keep-token-row]");
  const draw = (list) => {
    ctx.data.agent_accounts = list;
    box.innerHTML = renderAccountList(list, t);
    // Claude Code with more than one account: each has its own field.
    const claude = (list || []).find((v) => v.runtime === "den-claude");
    // (Its inline display: flex would win over the hidden attribute.)
    if (legacyRow)
      legacyRow.style.display = claude && accountRows(claude) ? "none" : "flex";
  };
  draw(ctx.data.agent_accounts || []);
  const post = (url, body, button) =>
    ctx.shell.busyAction(
      "save",
      (headers) => ctx.shell.api("POST", url, body, { headers }),
      { button },
    );
  box.addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button");
    if (!btn || btn.disabled) return;
    const vbox = btn.closest("[data-acct-runtime]");
    if (!vbox) return;
    const runtime = vbox.getAttribute("data-acct-runtime");
    const note = vbox.querySelector("[data-acct-note]");
    note.hidden = true;
    const row = btn.closest("[data-acct]");
    let url = "";
    let body = null;
    if (btn.hasAttribute("data-acct-add")) {
      url = "/api/agents/accounts";
      body = { runtime };
    } else if (row && btn.hasAttribute("data-acct-save")) {
      const input = row.querySelector("[data-acct-token]");
      const token = input.value;
      input.value = "";
      if (!token.trim()) {
        input.focus();
        return;
      }
      url = "/api/agents/accounts/token";
      body = { runtime, account: row.getAttribute("data-acct"), token };
    } else if (
      row &&
      (btn.hasAttribute("data-acct-up") || btn.hasAttribute("data-acct-down"))
    ) {
      const ids = [...vbox.querySelectorAll("[data-acct]")].map((r) =>
        r.getAttribute("data-acct"),
      );
      const i = ids.indexOf(row.getAttribute("data-acct"));
      const j = btn.hasAttribute("data-acct-up") ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      url = "/api/agents/accounts/order";
      body = { runtime, order: ids };
    } else return;
    btn.disabled = true;
    try {
      const r = await post(url, body, btn);
      if (r?.ok) return draw(r.accounts);
      note.textContent = t("acct.failed", { error: r?.error || "" });
      note.hidden = false;
    } catch (e) {
      note.textContent = t("acct.failed", {
        error: String(e?.message || ""),
      });
      note.hidden = false;
    }
    btn.disabled = false;
  });
}

/** Issue 399: the runtime that makes the token (the catalog's name). */
function tokenRuntime(s, t) {
  return s?.runtime || t("keep.runtimeAny");
}

/**
 * Issue 399: the token line as HTML. A line that says where the token
 * comes from links the vendor's own sign-in docs ({docs}, the runtime
 * catalog's signIn.docs, never a URL of the page's own) and the Sign-in
 * token field below ({field}, which focuses it): no command to run.
 */
export function keepTokenHtml(l, s, t) {
  const html = escR(l.text);
  if (!l.go) return html;
  const docs =
    typeof s?.docs === "string" && /^https:\/\//.test(s.docs)
      ? `<a href="${escR(s.docs)}" target="_blank" rel="noopener noreferrer" data-keep-token-docs>${escR(t("keep.docs"))}</a>`
      : escR(t("keep.docs"));
  const field = `<a href="#" data-keep-token-go>${escR(t("keep.tokenLabel"))}</a>`;
  return html.replace("{docs}", docs).replace("{field}", field);
}

/** Issue 299: the only terminal step for the agents' sign-in token. */
export const SETUP_TOKEN_CMD = "claude setup-token";

/**
 * Issue 299: Settings' Sign-in token field. Save sends the pasted token once
 * (the working pop-up), clears the field before the answer comes, and
 * shows what the server says: set <date>, or why not. The token is never
 * put back in the page.
 */
function wireTokenField(host, ctx, line, t) {
  const input = host.querySelector("[data-keep-token-input]");
  const save = host.querySelector("[data-keep-token-save]");
  const note = host.querySelector("[data-keep-token-note]");
  host.querySelector("[data-keep-copy]").addEventListener("click", () => {
    void navigator.clipboard?.writeText(SETUP_TOKEN_CMD);
  });
  // No secrets store: nothing can keep the token, so the field says so
  // before any paste and Save stays off (the server answers 409 besides).
  const noStore = () => {
    note.textContent = t("keep.noStore");
    note.hidden = false;
    input.disabled = true;
    save.disabled = true;
  };
  if (ctx.data.agent_signin?.no_store) noStore();
  // Issue 163: Clear removes it from the store, the way it was kept; the
  // kit's confirm dialog first. A person's only (the server refuses an agent).
  const clear = host.querySelector("[data-keep-token-clear]");
  // Issue 399: "paste it into Sign-in token below" goes to the field; with
  // more than one Claude Code account (issue 339), the first one's.
  line.addEventListener("click", (e) => {
    const go = e.target?.closest?.("[data-keep-token-go]");
    if (!go) return;
    e.preventDefault();
    const row = host.querySelector("[data-keep-token-row]");
    const to =
      row && row.style.display === "none"
        ? host.querySelector(
            '[data-acct-runtime="den-claude"] [data-acct-token]',
          ) || input
        : input;
    to.scrollIntoView({ block: "center" });
    to.focus();
  });
  const showLine = (signin) => {
    const l = keepTokenLine(signin, t);
    line.dataset.keepToken = l.state;
    line.innerHTML = keepTokenHtml(l, signin, t);
    line.hidden = false;
    clear.hidden = l.state === "missing";
  };
  clear.addEventListener("click", async () => {
    note.hidden = true;
    const { askConfirm } = await import("/dialog-den.js");
    const ok = await askConfirm({
      title: t("keep.clearTitle"),
      message: t("keep.clearAsk"),
      okLabel: t("keep.clearOk"),
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await ctx.shell.busyAction(
        "clear-token",
        (headers) =>
          ctx.shell.api("DELETE", "/api/agents/signin-token", undefined, {
            headers,
          }),
        { button: clear },
      );
      if (r?.ok) showLine(r.signin);
    } catch (e) {
      if (e?.code === "no_secrets_store") noStore();
    } finally {
      clear.disabled = false;
    }
  });
  save.addEventListener("click", async () => {
    const token = input.value;
    input.value = "";
    note.hidden = true;
    if (!token.trim()) {
      input.focus();
      return;
    }
    save.disabled = true;
    try {
      const r = await ctx.shell.busyAction(
        "save",
        (headers) =>
          ctx.shell.api(
            "POST",
            "/api/agents/signin-token",
            { token },
            { headers },
          ),
        { button: save },
      );
      if (r?.ok) {
        showLine(r.signin);
      } else if (r?.code === "no_secrets_store") {
        noStore();
        return;
      } else {
        note.textContent = t("keep.tokenFailed", {
          error: r?.error || "",
        });
        note.hidden = false;
      }
    } catch (e) {
      if (e?.code === "no_secrets_store") {
        noStore();
        return;
      }
      note.textContent = t("keep.tokenFailed", {
        error: String(e?.message || ""),
      });
      note.hidden = false;
    }
    save.disabled = false;
  });
}

/** Issue 163: the switch, Apply, and what it means under the daemon. */
function renderKeepRunning(host, ctx) {
  const t = (k, v) => ctx.shell.t(k, v);
  const on0 = ctx.data.keep_running_after_logout === true;
  const mode = ctx.data.service_mode;
  // Set one way, running the other: Apply hasn't run (or didn't take).
  const pending = mode && (mode === "always") !== on0;
  // Issue 163 (a): an existing login install, the Setting never set.
  const offer = ctx.data.keep_running_unset === true;
  // Issue 163 (b): the agents' sign-in token, when it is on.
  const signLine = keepTokenLine(ctx.data.agent_signin, t);
  host.innerHTML =
    `<div data-keep style="display:grid;gap:8px">` +
    `<label class="set-note" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-keep-on${on0 ? " checked" : ""}> ${escR(t("keep.label"))}</label>` +
    `<p class="set-note" data-keep-offer${offer ? "" : " hidden"}>${escR(t("keep.offer"))}</p>` +
    `<p class="set-note" data-keep-warn${on0 ? "" : " hidden"}>${escR(t("keep.warn"))}</p>` +
    `<p class="set-note" data-keep-token="${signLine.state}"${on0 ? "" : " hidden"}>${keepTokenHtml(signLine, ctx.data.agent_signin, t)}</p>` +
    // Issue 299: the token is pasted here; the one terminal step is named, with
    // a copy button. The field is never filled from the server.
    `<div data-keep-signin style="display:grid;gap:6px"${on0 ? "" : " hidden"}>` +
    `<p class="set-note" data-keep-setup style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${escR(t("keep.setup"))} <code>${escR(SETUP_TOKEN_CMD)}</code> <button type="button" class="btn sm" data-keep-copy>${escR(t("keep.copy"))}</button></p>` +
    `<label class="set-note" data-keep-token-row style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${escR(t("keep.tokenLabel"))} <input type="password" autocomplete="off" spellcheck="false" data-keep-token-input aria-label="${escR(t("keep.tokenLabel"))}"> <button type="button" class="btn sm" data-keep-token-save>${escR(t("keep.tokenSave"))}</button> <button type="button" class="btn sm" data-keep-token-clear${signLine.state === "missing" ? " hidden" : ""}>${escR(t("keep.tokenClear"))}</button></label>` +
    `<p class="set-note" data-keep-token-note hidden></p>` +
    // Issue 339: the sign-in accounts, per vendor.
    `<div data-acct-list style="display:grid;gap:10px"></div>` +
    `</div>` +
    `<div><button type="button" class="btn sm" data-keep-apply>${escR(t("keep.apply"))}</button></div>` +
    `<p class="set-note" data-keep-note${pending ? "" : " hidden"}>${escR(pending ? t("keep.pending") : "")}</p>` +
    `</div>`;
  const box = host.querySelector("[data-keep-on]");
  const warn = host.querySelector("[data-keep-warn]");
  const btn = host.querySelector("[data-keep-apply]");
  const note = host.querySelector("[data-keep-note]");
  const say = (msg) => {
    note.hidden = !msg;
    note.textContent = msg || "";
  };
  const token = host.querySelector("[data-keep-token]");
  const signin = host.querySelector("[data-keep-signin]");
  box.addEventListener("change", () => {
    warn.hidden = !box.checked;
    token.hidden = !box.checked;
    signin.hidden = !box.checked;
  });
  wireTokenField(host, ctx, token, t);
  wireAccounts(host, ctx, t);
  btn.addEventListener("click", async () => {
    const on = box.checked;
    btn.disabled = true;
    say("");
    try {
      const r = await applyKeepRunning(on, {
        // The working pop-up while the server answers.
        post: (body) =>
          ctx.shell.busyAction(
            "keep-running",
            (headers) =>
              ctx.shell.api("POST", "/api/keep-running-after-logout", body, {
                headers,
              }),
            {
              button: btn,
              success: (r) =>
                r?.needsSudo
                  ? t("keep.needs")
                  : r?.applied
                    ? t("keep.s")
                    : t("busy.saveS"),
            },
          ),
        askSudo: async (need) => (await import("/topbar.js")).askSudo(need),
        // Den restarts under its new jobs: wait for it, in place.
        waitBack: () => restartDen({ confirm: false, post: false }),
      });
      say(
        r.state === "applied"
          ? t(on ? "keep.onNow" : "keep.offNow")
          : r.state === "saved"
            ? t(mode ? "keep.saved" : "keep.noService")
            : r.state === "refused"
              ? t("keep.refused")
              : t("keep.failed"),
      );
    } finally {
      btn.disabled = false;
    }
  });
}

/** D64: Settings › Server's Restart Den button. */
function drawRestart(host) {
  const label = window.denShell?.t?.("rd.setButton") ?? "Restart Den";
  host.innerHTML = `<button type="button" class="btn sm" id="set-restart-den">${escR(label)}</button>`;
  host
    .querySelector("#set-restart-den")
    .addEventListener("click", () => void restartDen({ from: "settings" }));
}

/** issue 267: the bell's kinds that come from Hub, shown in Settings › Hub. */
const HUB_BELL_KINDS = new Set(["hub", "pick", "shared"]);

export const DEN_SETTINGS = [
  {
    // MODE-5: the web app's crash-loop guard (user.yml web.crash_loop_*).
    id: "server.crash_loop",
    category: "server",
    label: "Restart guard",
    description:
      "When __DEN_TITLE__'s web app stops without a clean stop this many times within the minutes below, the next start waits before it serves, longer each time, and the bell says so. __DEN_CLI__ config web.crash_loop_restarts=5",
    keywords: [
      "crash",
      "restart",
      "loop",
      "memory",
      "backoff",
      "web.crash_loop",
    ],
    scope: "user",
    keys: ["crash_loop.restarts"],
    control: { type: "number", min: 1, max: 1000, step: 1 },
    read: (ctx) => ctx.data.crash_loop?.restarts ?? 5,
    write: (v, ctx) => ctx.post({ crash_loop: { restarts: v } }),
  },
  {
    id: "server.crash_loop_minutes",
    category: "server",
    label: "Restart guard window, in minutes",
    description:
      "The minutes the unclean stops above are counted in. __DEN_CLI__ config web.crash_loop_minutes=10",
    keywords: [
      "crash",
      "restart",
      "loop",
      "window",
      "minutes",
      "web.crash_loop",
    ],
    scope: "user",
    keys: ["crash_loop.minutes"],
    control: { type: "number", min: 1, max: 10080, step: 1 },
    read: (ctx) => ctx.data.crash_loop?.minutes ?? 10,
    write: (v, ctx) => ctx.post({ crash_loop: { minutes: v } }),
  },
  {
    id: "server.crash_loop_wait",
    category: "server",
    label: "Restart guard's longest wait",
    description:
      "The longest the next start waits. 0 never waits. __DEN_CLI__ config web.crash_loop_max_wait_seconds=300",
    keywords: ["crash", "restart", "wait", "backoff", "web.crash_loop"],
    scope: "user",
    keys: ["crash_loop.max_wait_seconds"],
    control: { type: "number", min: 0, max: 86400, step: 1, unit: "s" },
    read: (ctx) => ctx.data.crash_loop?.maxWaitSeconds ?? 300,
    write: (v, ctx) => ctx.post({ crash_loop: { max_wait_seconds: v } }),
  },
  {
    // Issue 403: a filed report's masked screenshot, kept on this install
    // (user.yml reports.screenshot_keep_days). A person's only.
    id: "server.report_screenshot_days",
    category: "server",
    label: "Report screenshots, kept for",
    description:
      "How many days __DEN_TITLE__ keeps the masked screenshot of a report filed from here, for you and this install's own agent to read (report_screenshot). Then it is deleted. __DEN_CLI__ config reports.screenshot_keep_days=30",
    keywords: ["report", "screenshot", "feedback", "keep", "days", "issue"],
    scope: "user",
    keys: ["reports.screenshot_keep_days"],
    control: { type: "number", min: 1, max: 3650, step: 1, unit: "d" },
    read: (ctx) => ctx.data.reports?.screenshot_keep_days ?? 30,
    write: (v, ctx) => ctx.post({ reports: { screenshot_keep_days: v } }),
  },
  {
    // Issue 403: the largest report screenshot kept here (reports.*).
    id: "server.report_screenshot_max",
    category: "server",
    label: "Report screenshots, largest kept",
    description:
      "The largest masked screenshot __DEN_TITLE__ keeps with a report. A larger one is refused before anything is filed. __DEN_CLI__ config reports.screenshot_max_mb=8",
    keywords: ["report", "screenshot", "feedback", "size", "limit"],
    scope: "user",
    keys: ["reports.screenshot_max_mb"],
    control: { type: "number", min: 1, max: 64, step: 1, unit: "MB" },
    read: (ctx) => ctx.data.reports?.screenshot_max_mb ?? 8,
    write: (v, ctx) => ctx.post({ reports: { screenshot_max_mb: v } }),
  },
  {
    // Issue 403: the largest report screenshot sent to Hub.
    id: "server.report_screenshot_hub_max",
    category: "server",
    label: "Report screenshots, largest sent to Hub",
    description:
      "The largest masked screenshot __DEN_TITLE__ sends to Hub. A larger one is still kept here, and the report is still filed. __DEN_CLI__ config reports.hub_screenshot_max_mb=6",
    keywords: ["report", "screenshot", "feedback", "hub", "size", "limit"],
    scope: "user",
    keys: ["reports.hub_screenshot_max_mb"],
    control: { type: "number", min: 1, max: 64, step: 1, unit: "MB" },
    read: (ctx) => ctx.data.reports?.hub_screenshot_max_mb ?? 6,
    write: (v, ctx) => ctx.post({ reports: { hub_screenshot_max_mb: v } }),
  },
  {
    // Issue 403: how long a report's screenshot waits for Hub.
    id: "server.report_screenshot_hub_wait",
    category: "server",
    label: "Report screenshots, wait for Hub",
    description:
      "How long __DEN_TITLE__ waits for Hub to take a report's screenshot. After this, the screenshot is kept here, and the report is already filed. __DEN_CLI__ config reports.hub_timeout_seconds=10",
    keywords: ["report", "screenshot", "feedback", "hub", "timeout", "wait"],
    scope: "user",
    keys: ["reports.hub_timeout_seconds"],
    control: { type: "number", min: 1, max: 300, step: 1, unit: "s" },
    read: (ctx) => ctx.data.reports?.hub_timeout_seconds ?? 10,
    write: (v, ctx) => ctx.post({ reports: { hub_timeout_seconds: v } }),
  },
  {
    // Issue 415: Report says who can see a report: each destination's
    // visibility on GitHub, kept and waited for (user.yml feedback.*).
    id: "server.report_visibility_cache",
    category: "server",
    label: "Report: repository visibility kept for",
    description:
      "How long __DEN_TITLE__ keeps whether each Report repository is public or private. After this, it asks GitHub again. __DEN_CLI__ config feedback.visibility_cache_hours=24",
    keywords: ["report", "feedback", "visibility", "private", "cache"],
    scope: "user",
    keys: ["feedback.visibility_cache_hours"],
    control: { type: "number", min: 0, max: 720, step: 1, unit: "h" },
    read: (ctx) => ctx.data.feedback?.visibility_cache_hours ?? 24,
    write: (v, ctx) => ctx.post({ feedback: { visibility_cache_hours: v } }),
  },
  {
    id: "server.report_visibility_wait",
    category: "server",
    label: "Report: repository visibility wait",
    description:
      "How long Report waits for GitHub to say whether a repository is public or private. After this, it says not known (with the caution), and the answer shows the next time. __DEN_CLI__ config feedback.visibility_timeout_seconds=3",
    keywords: ["report", "feedback", "visibility", "timeout", "wait"],
    scope: "user",
    keys: ["feedback.visibility_timeout_seconds"],
    control: { type: "number", min: 0.5, max: 60, step: 0.5, unit: "s" },
    read: (ctx) => ctx.data.feedback?.visibility_timeout_seconds ?? 3,
    write: (v, ctx) =>
      ctx.post({ feedback: { visibility_timeout_seconds: v } }),
  },
  {
    id: "server.report_visibility_retry",
    category: "server",
    label: "Report: repository visibility retry",
    description:
      "When GitHub doesn't answer whether a repository is public or private, how long before Report asks again. 0 asks on every open. __DEN_CLI__ config feedback.visibility_retry_seconds=60",
    keywords: ["report", "feedback", "visibility", "retry", "failure"],
    scope: "user",
    keys: ["feedback.visibility_retry_seconds"],
    control: { type: "number", min: 0, max: 3600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.feedback?.visibility_retry_seconds ?? 60,
    write: (v, ctx) => ctx.post({ feedback: { visibility_retry_seconds: v } }),
  },
  {
    // Issue 609: how long Den's process lookups wait (user.yml process_lookup.*).
    id: "server.lookup_first",
    category: "server",
    label: "Process lookup wait",
    description:
      "How long __DEN_TITLE__ waits on its first try when it asks the system which process holds a connection (lsof, ps). An agent's own calls are placed this way. __DEN_CLI__ config process_lookup.first_seconds=5",
    keywords: ["timeout", "lookup", "lsof", "process", "agent"],
    scope: "user",
    keys: ["process_lookup.first_seconds"],
    control: { type: "number", min: 0.5, max: 600, step: 0.5, unit: "s" },
    read: (ctx) => ctx.data.process_lookup?.first_seconds ?? 5,
    write: (v, ctx) => ctx.post({ process_lookup: { first_seconds: v } }),
  },
  {
    id: "server.lookup_retry",
    category: "server",
    label: "Process lookup retry wait",
    description:
      "How long the second try waits when the first ran out of time. A busy machine can be slow to answer. __DEN_CLI__ config process_lookup.retry_seconds=20",
    keywords: ["timeout", "lookup", "retry", "process"],
    scope: "user",
    keys: ["process_lookup.retry_seconds"],
    control: { type: "number", min: 1, max: 600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.process_lookup?.retry_seconds ?? 20,
    write: (v, ctx) => ctx.post({ process_lookup: { retry_seconds: v } }),
  },
  {
    // Issue 455: the address check's limits (user.yml web.address_check_*).
    id: "server.address_check_timeout",
    category: "server",
    label: "Address check wait",
    description:
      "How long __DEN_TITLE__ waits for an address to answer when it checks that the address reaches this __DEN_TITLE__, before it prints or opens it. __DEN_CLI__ config web.address_check_timeout_seconds=5",
    keywords: ["address", "check", "edge", "port", "timeout", "wait"],
    scope: "user",
    keys: ["address_check.timeout_seconds"],
    control: { type: "number", min: 0.5, max: 600, step: 0.5, unit: "s" },
    read: (ctx) => ctx.data.address_check?.timeout_seconds ?? 5,
    write: (v, ctx) => ctx.post({ address_check: { timeout_seconds: v } }),
  },
  {
    id: "server.address_check_retries",
    category: "server",
    label: "Address check retries",
    description:
      "How many more times __DEN_TITLE__ asks an address that didn't answer in time. __DEN_CLI__ config web.address_check_retries=2",
    keywords: ["address", "check", "edge", "retries"],
    scope: "user",
    keys: ["address_check.retries"],
    control: { type: "number", min: 0, max: 20, step: 1 },
    read: (ctx) => ctx.data.address_check?.retries ?? 2,
    write: (v, ctx) => ctx.post({ address_check: { retries: v } }),
  },
  {
    id: "server.address_check_cache",
    category: "server",
    label: "Address check kept for",
    description:
      "How long the page banner and Edge reuse the last check of __DEN_TITLE__'s address. 0 checks on every read. __DEN_CLI__ config web.address_check_cache_seconds=60",
    keywords: ["address", "check", "edge", "cache"],
    scope: "user",
    keys: ["address_check.cache_seconds"],
    control: { type: "number", min: 0, max: 86400, step: 1, unit: "s" },
    read: (ctx) => ctx.data.address_check?.cache_seconds ?? 60,
    write: (v, ctx) => ctx.post({ address_check: { cache_seconds: v } }),
  },
  {
    // The sign-in lives on __DEN_TITLE__'s own address once it is proven:
    // how many definite failures in a row move it back.
    id: "server.address_check_drop_after",
    category: "server",
    label: "Address failures before sign-in moves back",
    description:
      "Once __DEN_TITLE__'s https address is proven, the sign-in lives only there. How many checks in a row must find something else, or nothing, answering at that address before sign-in works on this machine's own name again. A check that can't tell is ignored. __DEN_CLI__ config web.address_check_drop_after=2",
    keywords: ["address", "check", "edge", "sign-in", "cookie", "failures"],
    scope: "user",
    keys: ["address_check.drop_after"],
    control: { type: "number", min: 1, max: 100, step: 1 },
    read: (ctx) => ctx.data.address_check?.drop_after ?? 2,
    write: (v, ctx) => ctx.post({ address_check: { drop_after: v } }),
  },
  {
    id: "server.address_unknown_keep",
    category: "server",
    label: "Address held while checks can't tell",
    description:
      "Once __DEN_TITLE__'s https address is proven, how long checks that can't tell (no answer in time) keep sign-in there, from its last answer. After that they count as failures, so sign-in comes back on this machine's own name. Keep it short. __DEN_CLI__ config web.address_unknown_keep_seconds=300",
    keywords: ["address", "check", "edge", "sign-in", "timeout", "window"],
    scope: "user",
    keys: ["address_check.unknown_keep_seconds"],
    control: { type: "number", min: 0, max: 3600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.address_check?.unknown_keep_seconds ?? 300,
    write: (v, ctx) => ctx.post({ address_check: { unknown_keep_seconds: v } }),
  },
  {
    // 0.4.48: on Linux, Den also listens on the Docker bridge for the edge
    // (user.yml web.bridge_listen). A person's only.
    id: "server.bridge_listen",
    category: "server",
    label: "Docker bridge, for the edge",
    description:
      "Linux only, with an edge set up here: __DEN_TITLE__ also listens on the Docker bridge's address, where the edge reaches this machine. Off: only 127.0.0.1, and the edge can't reach __DEN_TITLE__. Applies at the next start. __DEN_CLI__ config web.bridge_listen=off",
    keywords: [
      "bridge",
      "docker",
      "edge",
      "linux",
      "listen",
      "502",
      "web.bridge_listen",
    ],
    scope: "user",
    keys: ["web_bridge.listen"],
    control: seg([
      { value: "auto", label: "Auto" },
      { value: "off", label: "Off" },
    ]),
    read: (ctx) => ctx.data.web_bridge?.listen ?? "auto",
    write: (v, ctx) => ctx.post({ web_bridge: { listen: v } }),
  },
  {
    id: "server.bridge_probe",
    category: "server",
    label: "Docker bridge check, in seconds",
    description:
      "How long __DEN_TITLE__ waits for Docker to name the bridge's address at its start. It never delays the start. __DEN_CLI__ config web.bridge_probe_seconds=10",
    keywords: [
      "bridge",
      "docker",
      "edge",
      "timeout",
      "web.bridge_probe_seconds",
    ],
    scope: "user",
    keys: ["web_bridge.probe_seconds"],
    control: { type: "number", min: 1, max: 600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.web_bridge?.probeSeconds ?? 10,
    write: (v, ctx) => ctx.post({ web_bridge: { probe_seconds: v } }),
  },
  {
    // Issue 406: the owner's display name, for the account entry.
    id: "server.owner_name_timeout",
    category: "server",
    label: "GitHub name check at start, in seconds",
    description:
      "How long __DEN_TITLE__ waits at its start for the owner's name from their public GitHub profile, when it doesn't have the name yet. It never delays the start. __DEN_CLI__ config web.owner_name_timeout_seconds=10",
    keywords: [
      "github",
      "name",
      "owner",
      "account",
      "timeout",
      "web.owner_name_timeout_seconds",
    ],
    scope: "user",
    keys: ["web_github.owner_name_timeout_seconds"],
    control: { type: "number", min: 1, max: 600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.web_github?.ownerNameTimeoutSeconds ?? 10,
    write: (v, ctx) =>
      ctx.post({ web_github: { owner_name_timeout_seconds: v } }),
  },
  // The shared GitHub watcher (MCP github_watch): its pace and API budget.
  {
    id: "server.github_watch_interval",
    category: "server",
    label: "GitHub watch: first interval, in seconds",
    description:
      "How often __DEN_TITLE__'s one GitHub watcher looks at the pull requests and runs agents watch (MCP github_watch). It doubles while nothing changes, and starts again on a change. __DEN_CLI__ config github.watch_interval_seconds=60",
    keywords: [
      "github",
      "watch",
      "checks",
      "interval",
      "poll",
      "github.watch_interval_seconds",
    ],
    scope: "user",
    keys: ["github.watch_interval_seconds"],
    control: { type: "number", min: 10, max: 3600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.github?.watch_interval_seconds ?? 60,
    write: (v, ctx) => ctx.post({ github: { watch_interval_seconds: v } }),
  },
  {
    id: "server.github_watch_max_interval",
    category: "server",
    label: "GitHub watch: longest interval, in seconds",
    description:
      "The most the GitHub watcher waits between looks while nothing changes. __DEN_CLI__ config github.watch_max_interval_seconds=300",
    keywords: [
      "github",
      "watch",
      "checks",
      "interval",
      "backoff",
      "github.watch_max_interval_seconds",
    ],
    scope: "user",
    keys: ["github.watch_max_interval_seconds"],
    control: { type: "number", min: 10, max: 86400, step: 1, unit: "s" },
    read: (ctx) => ctx.data.github?.watch_max_interval_seconds ?? 300,
    write: (v, ctx) => ctx.post({ github: { watch_max_interval_seconds: v } }),
  },
  {
    id: "server.github_api_budget_floor",
    category: "server",
    label: "GitHub watch: API calls kept in reserve",
    description:
      "Below this many GitHub API calls left this hour, the GitHub watcher asks GitHub nothing and refuses new watches until GitHub's reset, and says so with the reset time. __DEN_CLI__ config github.api_budget_floor=500",
    keywords: [
      "github",
      "api",
      "rate limit",
      "budget",
      "floor",
      "github.api_budget_floor",
    ],
    scope: "user",
    keys: ["github.api_budget_floor"],
    control: { type: "number", min: 0, max: 100000, step: 1 },
    read: (ctx) => ctx.data.github?.api_budget_floor ?? 500,
    write: (v, ctx) => ctx.post({ github: { api_budget_floor: v } }),
  },
  {
    id: "server.github_watches_max",
    category: "server",
    label: "GitHub watch: watches at once",
    description:
      "How many pull requests and runs the GitHub watcher watches at once, for every agent here together. One more is refused, saying why. __DEN_CLI__ config github.watches_max=50",
    keywords: ["github", "watch", "limit", "github.watches_max"],
    scope: "user",
    keys: ["github.watches_max"],
    control: { type: "number", min: 1, max: 1000, step: 1 },
    read: (ctx) => ctx.data.github?.watches_max ?? 50,
    write: (v, ctx) => ctx.post({ github: { watches_max: v } }),
  },
  {
    // den#143: how long `web up` waits for the server (user.yml
    // web.ready_probe_seconds, web.start_wait_seconds). A person's only.
    id: "server.ready_probe",
    category: "server",
    label: "Readiness check, in seconds",
    description:
      "How long one check that __DEN_TITLE__ is up waits for its answer. A busy machine answers late; a late answer still counts. __DEN_CLI__ config web.ready_probe_seconds=10",
    keywords: [
      "ready",
      "probe",
      "timeout",
      "busy",
      "web up",
      "web.ready_probe_seconds",
    ],
    scope: "user",
    keys: ["web_ready.probe_seconds"],
    control: { type: "number", min: 1, max: 3600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.web_ready?.probeSeconds ?? 10,
    write: (v, ctx) => ctx.post({ web_ready: { probe_seconds: v } }),
  },
  {
    id: "server.start_wait",
    category: "server",
    label: "Start wait, in seconds",
    description:
      "How long `web up` waits for __DEN_TITLE__ to be ready before it says it didn't start. A start that fails ends the wait at once. __DEN_CLI__ config web.start_wait_seconds=120",
    keywords: [
      "start",
      "ready",
      "timeout",
      "busy",
      "web up",
      "web.start_wait_seconds",
    ],
    scope: "user",
    keys: ["web_ready.start_seconds"],
    control: { type: "number", min: 1, max: 3600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.web_ready?.startSeconds ?? 120,
    write: (v, ctx) => ctx.post({ web_ready: { start_seconds: v } }),
  },
  {
    // Issue 144: the machine's gate slots (gates/store.ts settings.json),
    // shared by every install here. A person's only.
    id: "server.gate_cpu",
    category: "server",
    label: "Unit test runs at once, on this machine",
    description:
      "How many unit-test runs (`gate run --kind cpu`) share this machine. Unit and browser test runs wait in separate lines. Every install and repo here shares the same queue. __DEN_CLI__ gate settings --cpu-slots 2",
    keywords: ["gate", "slot", "tests", "queue", "cpu", "parallel"],
    scope: "user",
    keys: ["gate_slots.cpu_slots"],
    control: { type: "number", min: 1, max: 64, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.cpuSlots ?? 2,
    write: (v, ctx) => ctx.post({ gate_slots: { cpu_slots: v } }),
  },
  {
    // Issue 751: cpu runs beside a browser run on this machine.
    id: "server.gate_cpu_beside",
    category: "server",
    label: "Unit test runs beside a browser test run",
    description:
      "How many unit-test runs may run on this machine while a browser test run does, never more than the unit test runs at once. 0: a browser test run runs alone. A browser run on a test box doesn't count. __DEN_CLI__ gate settings --cpu-slots-beside-browser 2",
    keywords: ["gate", "slot", "tests", "queue", "cpu", "browser", "beside"],
    scope: "user",
    keys: ["gate_slots.cpu_slots_beside_browser"],
    control: { type: "number", min: 0, max: 64, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.cpuSlotsBesideBrowser ?? 2,
    write: (v, ctx) =>
      ctx.post({ gate_slots: { cpu_slots_beside_browser: v } }),
  },
  {
    // Issue 751 follow-up: cpu runs beside a release browser run (0).
    id: "server.gate_cpu_beside_release",
    category: "server",
    label: "Unit test runs beside a release browser test run",
    description:
      "How many unit-test runs may run on this machine while a release-priority browser test run does. 0 (the default): a release run runs alone, so other runs don't slow its checks. Other browser runs use the setting above. __DEN_CLI__ gate settings --cpu-slots-beside-release-browser 0",
    keywords: [
      "gate",
      "slot",
      "tests",
      "queue",
      "cpu",
      "browser",
      "beside",
      "release",
      "priority",
    ],
    scope: "user",
    keys: ["gate_slots.cpu_slots_beside_release_browser"],
    control: { type: "number", min: 0, max: 64, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.cpuSlotsBesideReleaseBrowser ?? 0,
    write: (v, ctx) =>
      ctx.post({ gate_slots: { cpu_slots_beside_release_browser: v } }),
  },
  {
    // Issue 1009: cpu runs wait at this load under a release browser run.
    id: "server.gate_cpu_hold_load",
    category: "server",
    label:
      "Machine load that holds unit test runs during a release browser run",
    description:
      "While this machine's 5-minute load average is at or above this, and a release-priority browser test run holds a browser slot, unit-test runs wait. Runs already going are never stopped. The default is the machine's cores × 4 / 3. 0 turns it off. __DEN_CLI__ gate settings --cpu-hold-load 24",
    keywords: [
      "gate",
      "slot",
      "tests",
      "queue",
      "cpu",
      "load",
      "release",
      "priority",
    ],
    scope: "user",
    keys: ["gate_slots.cpu_hold_load"],
    control: { type: "number", min: 0, max: 1024, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.cpuHoldLoad ?? 0,
    write: (v, ctx) => ctx.post({ gate_slots: { cpu_hold_load: v } }),
  },
  {
    // Browser runs that may hold this machine at once (each in a container).
    id: "server.gate_local_browser",
    category: "server",
    label: "Browser runs at once on this machine",
    description:
      "How many browser test runs may run on this machine at once, each in its own container. A browser run on a test box doesn't count. 1: one at a time. __DEN_CLI__ gate settings --local-browser-slots 1",
    keywords: ["gate", "slot", "tests", "queue", "browser", "container"],
    scope: "user",
    keys: ["gate_slots.local_browser_slots"],
    control: { type: "number", min: 1, max: 64, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.localBrowserSlots ?? 1,
    write: (v, ctx) => ctx.post({ gate_slots: { local_browser_slots: v } }),
  },
  {
    id: "server.gate_overrun",
    category: "server",
    label: "Test run flagged past its estimate, in minutes",
    description:
      "A test run still going this long after its estimate is flagged in `gate status` and on the Agents page. It is never stopped. __DEN_CLI__ gate settings --overrun-margin-minutes 15",
    keywords: ["gate", "slot", "overrun", "estimate", "tests"],
    scope: "user",
    keys: ["gate_slots.overrun_margin_minutes"],
    control: { type: "number", min: 0, max: 1440, step: 1, unit: "min" },
    read: (ctx) => ctx.data.gate_slots?.overrunMarginMinutes ?? 15,
    write: (v, ctx) => ctx.post({ gate_slots: { overrun_margin_minutes: v } }),
  },
  {
    // Issue 993: a slot past this many times its estimate: the bell.
    id: "server.gate_overrun_bell",
    category: "server",
    label: "Test slot in the bell past this many times its estimate",
    description:
      "A test slot held this many times longer than its estimate shows in the bell under Needs you, with End. If an agent holds it, Den tells that agent once to release it. 2: twice its estimate. __DEN_CLI__ gate settings --overrun-bell-multiple 2",
    keywords: ["gate", "slot", "overrun", "estimate", "bell", "end"],
    scope: "user",
    keys: ["gate_slots.overrun_bell_multiple"],
    control: { type: "number", min: 1, max: 100, step: 0.5 },
    read: (ctx) => ctx.data.gate_slots?.overrunBellMultiple ?? 2,
    write: (v, ctx) => ctx.post({ gate_slots: { overrun_bell_multiple: v } }),
  },
  {
    // Issue 621: a CI runner (a job in a VM) holds its slot by lease.
    id: "server.gate_remote_renew",
    category: "server",
    label: "CI runner renews its gate slot every, in seconds",
    description:
      "A CI job in a runner VM holds its gate slot by renewing it this often (it is told the number when it asks). __DEN_CLI__ gate settings --remote-renew-seconds 30",
    keywords: ["gate", "slot", "ci", "runner", "lease", "renew"],
    scope: "user",
    keys: ["gate_slots.remote_renew_seconds"],
    control: { type: "number", min: 5, max: 3600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.gate_slots?.remoteRenewSeconds ?? 30,
    write: (v, ctx) => ctx.post({ gate_slots: { remote_renew_seconds: v } }),
  },
  {
    id: "server.gate_remote_lapse",
    category: "server",
    label: "CI runner's gate slot taken back after, in seconds",
    description:
      "A CI runner that hasn't renewed its gate slot for this long loses it, and the next in line starts. At least twice the renew time. __DEN_CLI__ gate settings --remote-lapse-seconds 120",
    keywords: ["gate", "slot", "ci", "runner", "lease", "lapse", "timeout"],
    scope: "user",
    keys: ["gate_slots.remote_lapse_seconds"],
    control: { type: "number", min: 10, max: 86400, step: 1, unit: "s" },
    read: (ctx) => ctx.data.gate_slots?.remoteLapseSeconds ?? 120,
    write: (v, ctx) => ctx.post({ gate_slots: { remote_lapse_seconds: v } }),
  },
  {
    id: "server.gate_remote_slots",
    category: "server",
    label: "Gate slots one CI runner may have at once",
    description:
      "Held or waiting. One more ask is refused, saying why, until the runner gives one back. __DEN_CLI__ gate settings --remote-max-slots 4",
    keywords: ["gate", "slot", "ci", "runner", "limit"],
    scope: "user",
    keys: ["gate_slots.remote_max_slots"],
    control: { type: "number", min: 1, max: 256, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.remoteMaxSlots ?? 4,
    write: (v, ctx) => ctx.post({ gate_slots: { remote_max_slots: v } }),
  },
  {
    id: "server.gate_remote_asks",
    category: "server",
    label: "Asks one CI runner may have waiting at once",
    description:
      "Asks for a gate slot still waiting on an answer. One more is refused, saying why, until one answers. __DEN_CLI__ gate settings --remote-max-asks 4",
    keywords: ["gate", "slot", "ci", "runner", "limit", "ask"],
    scope: "user",
    keys: ["gate_slots.remote_max_asks"],
    control: { type: "number", min: 1, max: 256, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.remoteMaxAsks ?? 4,
    write: (v, ctx) => ctx.post({ gate_slots: { remote_max_asks: v } }),
  },
  {
    // Issue 715: release runs a person waits on (`gate run --priority
    // release --reason <why>`) go to the front of their kind's queue.
    id: "server.gate_priority_max",
    category: "server",
    label: "Release priority runs at a time, per kind",
    description:
      "A release run a person waits on, marked for release priority, goes ahead of the other waiting runs of its kind. It never stops a running one. A second such run waits behind the first. 0 turns this off. __DEN_CLI__ gate settings --priority-max 1",
    keywords: ["gate", "slot", "priority", "release", "queue", "jump"],
    scope: "user",
    keys: ["gate_slots.priority_max"],
    control: { type: "number", min: 0, max: 16, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.priorityMax ?? 1,
    // Issue 963: 0 turns release priority off for the whole machine: it
    // asks first, saying what it does. Cancelled, nothing changes.
    write: async (v, ctx) => {
      if (Number(v) === 0 && (ctx.data.gate_slots?.priorityMax ?? 1) !== 0) {
        const t = (k, x) => ctx.shell.t(k, x);
        const { askConfirm } = await import("/dialog-den.js");
        const ok = await askConfirm({
          title: t("gate.priorityOffTitle"),
          message: t("gate.priorityOffAsk"),
          okLabel: t("gate.priorityOffOk"),
          danger: true,
        });
        if (!ok) return false;
      }
      return ctx.post({ gate_slots: { priority_max: v } });
    },
  },
  {
    id: "server.gate_priority_pass",
    category: "server",
    label:
      "Waiting this long, a marked release run is never passed, in minutes",
    description:
      "A release run with priority goes ahead of every other waiting run of its kind. Among runs marked for release priority, it never passes one that has waited this long. 0: it never passes another marked run. __DEN_CLI__ gate settings --priority-pass-limit-minutes 0",
    keywords: ["gate", "slot", "priority", "release", "starvation", "wait"],
    scope: "user",
    keys: ["gate_slots.priority_pass_limit_minutes"],
    control: { type: "number", min: 0, max: 1440, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.priorityPassLimitMinutes ?? 0,
    write: (v, ctx) =>
      ctx.post({ gate_slots: { priority_pass_limit_minutes: v } }),
  },
  {
    id: "server.gate_priority_agents",
    category: "server",
    label: "Agents may ask for release priority",
    description:
      "On, an agent may mark a release run for an issue you reported. Off, only you can. Every jump is in the slot log, with who and why. __DEN_CLI__ gate settings --priority-agents 1",
    keywords: ["gate", "slot", "priority", "release", "agent", "person"],
    scope: "user",
    keys: ["gate_slots.priority_agents"],
    control: { type: "toggle" },
    read: (ctx) => ctx.data.gate_slots?.priorityAgents !== false,
    write: (v, ctx) => ctx.post({ gate_slots: { priority_agents: v ? 1 : 0 } }),
  },
  {
    // Issue 739: a CI runner's ask over HTTP may carry release priority.
    id: "server.gate_priority_runners",
    category: "server",
    label: "CI runners may ask for release priority",
    description:
      "On, a CI job with a runner token may mark its run as a release run, with a reason. Off, its ask is refused and it waits in the normal queue. Every jump is in the slot log, with the runner and why. __DEN_CLI__ gate settings --priority-runners 1",
    keywords: ["gate", "slot", "priority", "release", "runner", "ci"],
    scope: "user",
    keys: ["gate_slots.priority_runners"],
    control: { type: "toggle" },
    read: (ctx) => ctx.data.gate_slots?.priorityRunners !== false,
    write: (v, ctx) =>
      ctx.post({ gate_slots: { priority_runners: v ? 1 : 0 } }),
  },
  {
    // A browser run on a macOS host declares a container browser.
    id: "server.gate_browser_container",
    category: "server",
    label: "Browser runs need a container",
    description:
      "On, a browser test run on this machine must say where its browser runs: a container's Playwright endpoint (ws:// or wss://, also from DEN_PW_WS, HUB_PW_WEBKIT_WS or E2E_WEBKIT_WS), or self when the run starts its own container. A run without one is refused, so no test starts a browser on this Mac itself. On by default on macOS, off elsewhere. __DEN_CLI__ gate settings --browser-requires-container 1",
    keywords: [
      "gate",
      "slot",
      "browser",
      "container",
      "webkit",
      "playwright",
      "mac",
    ],
    scope: "user",
    keys: ["gate_slots.browser_requires_container"],
    control: { type: "toggle" },
    read: (ctx) => ctx.data.gate_slots?.browserRequiresContainer === true,
    write: (v, ctx) =>
      ctx.post({ gate_slots: { browser_requires_container: v ? 1 : 0 } }),
  },
  {
    // Issue 714: an agent's gate slot held over MCP.
    id: "server.gate_claim",
    category: "server",
    label: "An agent's gate slot: minutes to claim it",
    description:
      "When a slot an agent waited for is granted, Den tells the agent. Not claimed within this time, it goes to the next in line and the agent goes back in line. __DEN_CLI__ gate settings --claim-minutes 3",
    keywords: ["gate", "slot", "agent", "claim", "mcp"],
    scope: "user",
    keys: ["gate_slots.claim_minutes"],
    control: { type: "number", min: 1, max: 1440, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.claimMinutes ?? 3,
    write: (v, ctx) => ctx.post({ gate_slots: { claim_minutes: v } }),
  },
  {
    // Issue 714: an agent's gate slot held over MCP.
    id: "server.gate_mcp_renew",
    category: "server",
    label: "An agent's gate slot: renew it every, in minutes",
    description:
      "How often an agent holding a slot is asked to renew it while it works. __DEN_CLI__ gate settings --mcp-renew-minutes 5",
    keywords: ["gate", "slot", "agent", "renew", "lease", "mcp"],
    scope: "user",
    keys: ["gate_slots.mcp_renew_minutes"],
    control: { type: "number", min: 1, max: 1440, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.mcpRenewMinutes ?? 5,
    write: (v, ctx) => ctx.post({ gate_slots: { mcp_renew_minutes: v } }),
  },
  {
    // Issue 714: an agent's gate slot held over MCP.
    id: "server.gate_mcp_lapse",
    category: "server",
    label: "An agent's gate slot lapses unrenewed after, in minutes",
    description:
      "A slot an agent holds and doesn't renew this long, once past its estimate plus the grace, goes to the next in line. The bell says so. __DEN_CLI__ gate settings --mcp-lapse-minutes 15",
    keywords: ["gate", "slot", "agent", "lapse", "lease", "mcp"],
    scope: "user",
    keys: ["gate_slots.mcp_lapse_minutes"],
    control: { type: "number", min: 1, max: 10080, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.mcpLapseMinutes ?? 15,
    write: (v, ctx) => ctx.post({ gate_slots: { mcp_lapse_minutes: v } }),
  },
  {
    // Issue 714: an agent's gate slot held over MCP.
    id: "server.gate_mcp_grace",
    category: "server",
    label: "An agent's gate slot: grace past its estimate, in minutes",
    description:
      "An unrenewed slot keeps holding until it is this far past its estimate. __DEN_CLI__ gate settings --mcp-grace-minutes 15",
    keywords: ["gate", "slot", "agent", "grace", "estimate", "mcp"],
    scope: "user",
    keys: ["gate_slots.mcp_grace_minutes"],
    control: { type: "number", min: 0, max: 10080, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.mcpGraceMinutes ?? 15,
    write: (v, ctx) => ctx.post({ gate_slots: { mcp_grace_minutes: v } }),
  },
  {
    // Issue 803: priority classes per project; empty is first-come.
    id: "server.gate_class_order",
    category: "server",
    label: "Gate classes, highest first",
    description:
      "Comma-separated, for example release, lane, other. A waiting run of a higher class starts first; within a class, first come. A run that holds its slot is never stopped. Empty: first come for all. __DEN_CLI__ gate settings --class-order release,lane,other",
    keywords: ["gate", "slot", "class", "priority", "release", "queue"],
    scope: "user",
    keys: ["gate_slots.class_order"],
    control: { type: "text" },
    read: (ctx) => ctx.data.gate_slots?.classOrder ?? "",
    write: (v, ctx) =>
      ctx.post({
        gate_slots: { class_order: String(v ?? "").trim() || null },
      }),
  },
  {
    id: "server.gate_class_map",
    category: "server",
    label: "Gate class of each project",
    description:
      "Comma-separated: <project>=<class>, label:<pattern>=<class> (* matches any text), and *=<class> for every other project. Without *, the last class. __DEN_CLI__ gate settings --class-map den=lane,label:release*=release,*=other",
    keywords: ["gate", "slot", "class", "project", "label", "priority"],
    scope: "user",
    keys: ["gate_slots.class_map"],
    control: { type: "text" },
    read: (ctx) => ctx.data.gate_slots?.classMap ?? "",
    write: (v, ctx) =>
      ctx.post({ gate_slots: { class_map: String(v ?? "").trim() || null } }),
  },
  {
    id: "server.gate_class_windows",
    category: "server",
    label: "Gate class windows",
    description:
      "Comma-separated: <class>=HH:MM-HH:MM/<minutes>, in this machine's time. Outside its window, a run of that class estimated at least that many minutes waits while a higher-class run holds or waits; with none, it runs at once. __DEN_CLI__ gate settings --class-windows other=22:00-06:00/30",
    keywords: ["gate", "slot", "class", "window", "night", "overnight"],
    scope: "user",
    keys: ["gate_slots.class_windows"],
    control: { type: "text" },
    read: (ctx) => ctx.data.gate_slots?.classWindows ?? "",
    write: (v, ctx) =>
      ctx.post({
        gate_slots: { class_windows: String(v ?? "").trim() || null },
      }),
  },
  {
    // Issue 621: the gate-only runner tokens; an agent asks for one (a
    // held write the person allows), and the person revokes one here.
    id: "server.gate_runners",
    category: "server",
    label: "CI runner tokens",
    description:
      "Tokens that let a CI job in a runner VM ask for, renew and give back gate slots on this machine. Nothing else. An agent asks for one and you allow it; revoke one here.",
    keywords: ["gate", "slot", "ci", "runner", "token", "revoke"],
    scope: "user",
    control: { type: "custom", render: drawRunnerTokens },
    read: () => null,
  },
  {
    // Issue 625: test boxes, a browser slot source each.
    id: "server.gate_boxes",
    category: "server",
    label: "Test boxes",
    description:
      "Other machines that run browser tests. Each has its own browser slots. A browser run that may use a box takes whichever slot frees first, here or on a box. A box whose hold file is there takes no new runs. One that doesn't answer is skipped, never waited on. A box with a window takes runs only within it, in this machine's time. Outside it, or turned off, Den never contacts the box; a run already on it finishes. __DEN_CLI__ gate box add <name> --ssh login@host --slots 1",
    keywords: [
      "gate",
      "slot",
      "box",
      "remote",
      "browser",
      "tests",
      "machine",
      "window",
      "off",
    ],
    scope: "user",
    control: { type: "custom", render: drawGateBoxes },
    read: () => null,
  },
  {
    id: "server.gate_box_check",
    category: "server",
    label: "Test box check waits, in seconds",
    description:
      "How long Den waits for a test box to answer when a slot on it is about to be given. No answer: the box is skipped. __DEN_CLI__ gate settings --box-check-timeout-seconds 8",
    keywords: ["gate", "slot", "box", "timeout", "check"],
    scope: "user",
    keys: ["gate_slots.box_check_timeout_seconds"],
    control: { type: "number", min: 1, max: 120, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.boxCheckTimeoutSeconds ?? 8,
    write: (v, ctx) =>
      ctx.post({ gate_slots: { box_check_timeout_seconds: v } }),
  },
  {
    id: "server.gate_box_recheck",
    category: "server",
    label: "A skipped test box is checked again after, in seconds",
    description:
      "A box that was held or didn't answer is passed over this long, then checked again the next time a slot on it is wanted. Never on a timer. __DEN_CLI__ gate settings --box-recheck-seconds 30",
    keywords: ["gate", "slot", "box", "hold", "recheck"],
    scope: "user",
    keys: ["gate_slots.box_recheck_seconds"],
    control: { type: "number", min: 1, max: 86400, step: 1 },
    read: (ctx) => ctx.data.gate_slots?.boxRecheckSeconds ?? 30,
    write: (v, ctx) => ctx.post({ gate_slots: { box_recheck_seconds: v } }),
  },
  {
    // Issue 1033: a browser run with no --box takes a test box by default.
    id: "server.gate_box_default",
    category: "server",
    label: "Browser runs go to",
    description:
      "Where a browser test run with no --box goes. Here or a test box: the first free browser slot, here or on a test box. A run with no --base-url, or no box for its Playwright version, stays here and says why. Here only: as before; a run goes to a box only with --box. __DEN_CLI__ gate settings --browser-box-default any",
    keywords: ["gate", "slot", "box", "browser", "default", "any", "local"],
    scope: "user",
    keys: ["gate_slots.browser_box_default"],
    control: {
      type: "select",
      options: () => [
        {
          value: "any",
          label: L("set.server.gate_box_default.any", "Here or a test box"),
        },
        {
          value: "local",
          label: L("set.server.gate_box_default.local", "Here only"),
        },
      ],
    },
    read: (ctx) => ctx.data.gate_slots?.browserBoxDefault ?? "any",
    write: (v, ctx) =>
      ctx.post({ gate_slots: { browser_box_default: v || null } }),
  },
  {
    id: "server.gate_host_only",
    category: "server",
    label: "Browser runs kept here",
    description:
      "Comma-separated: <project>, label:<pattern> (* matches any text). These browser runs never go to a test box, for example layout suites or WebKit on macOS. Empty: none. __DEN_CLI__ gate settings --browser-host-only den,label:*webkit*",
    keywords: ["gate", "slot", "box", "browser", "host", "label", "project"],
    scope: "user",
    keys: ["gate_slots.browser_host_only"],
    control: { type: "text" },
    read: (ctx) => ctx.data.gate_slots?.browserHostOnly ?? "",
    write: (v, ctx) =>
      ctx.post({
        gate_slots: { browser_host_only: String(v ?? "").trim() || null },
      }),
  },
  {
    // SRV-P6 (0.4.48): how this install takes a new version
    // (user.yml server_agent.self_update). A person's only.
    id: "server.self_update",
    category: "server",
    label: "New versions",
    description:
      "When a new __DEN_TITLE__ is out. Ask: an update waits in the bell for your Allow. Auto: __DEN_TITLE__ updates at a quiet moment, and goes back by itself if the new version doesn't come up.",
    keywords: ["update", "upgrade", "version", "npm", "self_update", "auto"],
    scope: "user",
    keys: ["server_agent_self_update"],
    control: seg([
      { value: "ask", label: "Ask" },
      { value: "auto", label: "Auto" },
    ]),
    read: (ctx) => ctx.data.server_agent_self_update ?? "ask",
    write: (v, ctx) => ctx.post({ server_agent_self_update: v }),
  },
  {
    // SRV-P6: where that choice came from, and the checks' last and next
    // pass (the running Den writes them; doctor says the same).
    id: "server.update_check",
    category: "server",
    label: "Update checks",
    description:
      "Where the New versions choice comes from, and when __DEN_TITLE__ last looked for a new version and looks next.",
    keywords: ["update", "version", "check", "npm", "self_update"],
    scope: "user",
    control: { type: "readonly" },
    read: (ctx) => updateCheckText(ctx.data),
  },
  {
    // MODE-5 (0.4.46): this install's address (web.url, D80) as a page
    // control: Check and save asks the address to answer first.
    id: "server.address",
    category: "server",
    label: "__DEN_TITLE__'s address",
    description:
      "The address people and other devices open this __DEN_TITLE__ at, for example https://__DEN_CLI__.local.example.com. Check and save asks it to answer first, and saves only if it does. Same as __DEN_CLI__ web url.",
    keywords: ["address", "url", "web.url", "domain", "hostname", "link"],
    scope: "user",
    control: { type: "custom", render: renderAddress },
    read: () => null,
  },
  {
    // Issue 532: the terminal limits (user.yml sessions.*, over den.yml).
    id: "server.sessions_max",
    category: "server",
    label: "Terminals at once",
    description:
      "How many plain terminals may run at once. Agents never count. A new one past this is refused, and says so. __DEN_CLI__ config sessions.max_concurrent=8",
    keywords: ["terminal", "sessions", "limit", "max_concurrent", "pty"],
    scope: "user",
    keys: ["sessions.max_concurrent"],
    control: { type: "number", min: 1, max: 1000, step: 1 },
    read: (ctx) => ctx.data.sessions?.max_concurrent ?? 8,
    write: (v, ctx) => ctx.post({ sessions: { max_concurrent: v } }),
  },
  {
    id: "server.sessions_close_grace",
    category: "server",
    label: "Terminal close grace",
    description:
      "How long a terminal has to end after you close it before it is stopped by force. __DEN_CLI__ config sessions.close_grace_seconds=5",
    keywords: ["terminal", "close", "grace", "kill", "close_grace_seconds"],
    scope: "user",
    keys: ["sessions.close_grace_seconds"],
    control: { type: "number", min: 0, max: 300, step: 1, unit: "s" },
    read: (ctx) => ctx.data.sessions?.close_grace_seconds ?? 5,
    write: (v, ctx) => ctx.post({ sessions: { close_grace_seconds: v } }),
  },
  {
    id: "server.sessions_pty_close",
    category: "server",
    label: "Terminal close after exit",
    description:
      "How long after a terminal's program ends its terminal is closed. 0 closes it at once. Its scrollback stays readable either way. Applies when the terminal host next starts. __DEN_CLI__ config sessions.pty_close_seconds=0",
    keywords: ["terminal", "pty", "exit", "close", "pty_close_seconds"],
    scope: "user",
    keys: ["sessions.pty_close_seconds"],
    control: { type: "number", min: 0, max: 86400, step: 1, unit: "s" },
    read: (ctx) => ctx.data.sessions?.pty_close_seconds ?? 0,
    write: (v, ctx) => ctx.post({ sessions: { pty_close_seconds: v } }),
  },
  {
    id: "server.sessions_pty_warn",
    category: "server",
    label: "Terminal count warning",
    description:
      "Doctor fails when the terminal host holds more terminals than this. __DEN_CLI__ config sessions.pty_warn_above=400",
    keywords: ["terminal", "pty", "doctor", "warn", "pty_warn_above"],
    scope: "user",
    keys: ["sessions.pty_warn_above"],
    control: { type: "number", min: 1, max: 100000, step: 1 },
    read: (ctx) => ctx.data.sessions?.pty_warn_above ?? 400,
    write: (v, ctx) => ctx.post({ sessions: { pty_warn_above: v } }),
  },
  {
    id: "server.sessions_pty_machine",
    category: "server",
    label: "Machine terminal warning, in percent",
    description:
      "Doctor fails when the terminals in use on this machine reach this share of its limit. __DEN_CLI__ config sessions.pty_machine_warn_percent=90",
    keywords: [
      "terminal",
      "pty",
      "doctor",
      "machine",
      "percent",
      "pty_machine_warn_percent",
    ],
    scope: "user",
    keys: ["sessions.pty_machine_warn_percent"],
    control: { type: "number", min: 1, max: 100, step: 1, unit: "%" },
    read: (ctx) => ctx.data.sessions?.pty_machine_warn_percent ?? 90,
    write: (v, ctx) => ctx.post({ sessions: { pty_machine_warn_percent: v } }),
  },
  {
    id: "server.restart",
    category: "server",
    label: "Restart Den",
    description:
      "Restarts the web server on the same port. Agents, services and deploys keep running; this page reconnects in place. Same as __DEN_CLI__ web restart.",
    keywords: ["restart", "server", "reload", "web", "den"],
    scope: "user",
    control: { type: "custom", render: drawRestart },
    read: () => null,
  },
  // ── Appearance ─────────────────────────────────────────────────────────
  {
    id: "appearance.mode",
    category: "appearance",
    label: "Mode",
    description: "System follows your computer's light or dark setting.",
    keywords: ["dark", "light", "system", "color scheme", "theme"],
    scope: "user",
    control: seg([
      { value: "system", label: "System" },
      { value: "dark", label: "Dark" },
      { value: "light", label: "Light" },
    ]),
    keys: ["appearance.mode"],
    read: (ctx) => ctx.appearance.mode,
    write: (v, ctx) => ctx.setAppearance({ mode: v }),
  },
  {
    id: "appearance.theme",
    category: "appearance",
    label: "Theme",
    description:
      "Org default follows the distribution's theme. Picking a theme by name keeps it, even when the distribution changes its own.",
    keywords: [
      "theme",
      "brand",
      "colors",
      "palette",
      "swatches",
      "org default",
    ],
    scope: "user",
    control: {
      type: "theme",
      options: (ctx) =>
        themeOptions(
          ctx.appearance.themes,
          ctx.appearance.prefsTheme,
          ctx.appearance.orgDefault,
        ),
      notice: (ctx) =>
        themeNotice(
          ctx.appearance.themes,
          ctx.appearance.prefsTheme,
          ctx.appearance.active,
        ),
    },
    keys: ["appearance.theme"],
    read: (ctx) => ctx.appearance.prefsTheme || "",
    write: (v, ctx) => ctx.setAppearance({ theme: v || null }),
  },
  // The UI's language (R19, R21; 0.3.0-dev.39): a user pref, `language`
  // in user.yml. Each is named in itself. A change reloads the page, which
  // the server then serves with that language's catalog.
  {
    id: "language",
    category: "appearance",
    label: "Language",
    description:
      "The language of Den's own words. Names, logs and command output stay as they are. Changing it reloads the page.",
    keywords: [
      "language",
      "locale",
      "translation",
      "english",
      "japanese",
      "spanish",
      "日本語",
      "español",
    ],
    scope: "user",
    control: {
      type: "seg",
      options: (ctx) =>
        (ctx.shell?.languages?.() ?? []).map((l) => ({
          value: l.id,
          label: l.name,
        })),
    },
    keys: ["language"],
    read: (ctx) => ctx.data.language ?? ctx.shell?.lang?.() ?? "en",
    write: (v, ctx) => ctx.shell.setLanguage(v),
  },
  // issue 206: the time zone date-times are shown in, a pref like
  // `language` (user.yml time_zone). Unset is the browser's own zone. A
  // change redraws every date-time on the page in place, no reload.
  {
    id: "time_zone",
    category: "appearance",
    label: "Time zone",
    description:
      "Dates and times on these pages show in this zone. They are stored the same either way.",
    keywords: ["time zone", "timezone", "zone", "clock", "date", "time", "utc"],
    scope: "user",
    control: {
      type: "select",
      options: (ctx) => {
        const own = browserTimeZone();
        const zones = timeZones();
        const picked = ctx.data.time_zone;
        if (picked && !zones.includes(picked)) zones.unshift(picked);
        return [
          {
            value: "",
            label: L("set.ui.tzBrowser", "Your browser's ({zone})", {
              zone: own,
            }),
          },
          ...zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") })),
        ];
      },
    },
    keys: ["time_zone"],
    read: (ctx) => ctx.data.time_zone ?? "",
    write: async (v, ctx) => {
      const ok = await ctx.post({ time_zone: v || null });
      if (ok) {
        setTimeZone(v || null);
        upgradeTimes();
      }
      return ok;
    },
  },
  {
    id: "appearance.org-theme",
    category: "appearance",
    label: "Org default theme",
    description: "The theme everyone gets until they pick one (brand.theme).",
    keywords: ["theme", "brand", "org default", "distribution"],
    scope: "distribution",
    control: { type: "readonly" },
    read: (ctx) => {
      const d = ctx.data.distribution || {};
      const org = ctx.appearance.orgDefault;
      if (d.theme) return org ? `${org.name} (${d.theme})` : d.theme;
      return org
        ? L("set.ui.themeUnset", "{name} (not set: Den's own)", {
            name: org.name,
          })
        : L("set.ui.notSet", "not set");
    },
  },

  // ── Editor & terminal ──────────────────────────────────────────────────
  {
    id: "editor",
    category: "editor",
    label: "Default IDE",
    description:
      "__DEN_TITLE__ opens repositories in this editor when you click ↗.",
    keywords: ["editor", "ide", "open", "code", "vscode", "cursor"],
    scope: "user",
    control: {
      type: "radio",
      options: (ctx) =>
        (ctx.data.editors || []).map((e) => ({
          value: e.key,
          label: e.name,
          disabled: !e.available,
          tags: [
            e.terminal ? L("set.ui.terminalTag", "terminal") : null,
            e.available ? null : L("set.ui.notFound", "not found"),
          ],
        })),
    },
    keys: ["editor"],
    read: (ctx) => effective(ctx.data.editors, ctx.data.editor),
    write: (v, ctx) => ctx.post({ editor: v || null }),
  },
  {
    id: "editor.open",
    category: "editor",
    label: "Open file links in",
    description:
      "⌘-click (Ctrl-click on Windows and Linux) on a file path in an agent's pane opens it here, at the line. None copies the path instead.",
    keywords: [
      "editor",
      "link",
      "path",
      "file",
      "agents",
      "vscode",
      "cursor",
      "zed",
    ],
    scope: "user",
    control: seg([
      { value: "vscode", label: "VS Code" },
      { value: "cursor", label: "Cursor" },
      { value: "zed", label: "Zed" },
      { value: "none", label: "None (copy)" },
    ]),
    keys: ["editor_open"],
    read: (ctx) => ctx.data.editor_open ?? "none",
    write: (v, ctx) => ctx.post({ editor_open: v }),
  },
  {
    id: "editor_overrides",
    category: "editor",
    label: "Per-language IDE",
    description:
      "For repos whose stack.yml names a language, open this editor instead of the default.",
    keywords: [
      "language",
      "override",
      "editor",
      "ide",
      "go",
      "python",
      "stack",
    ],
    scope: "user",
    control: {
      type: "langmap",
      languages: (ctx) => ctx.data.languages || [],
      options: (ctx) =>
        (ctx.data.editors || [])
          .filter((e) => e.available)
          .map((e) => ({ value: e.key, label: e.name })),
    },
    keys: ["editor_overrides"],
    read: (ctx) => ctx.data.editor_overrides || {},
    write: (map, ctx) =>
      ctx.post({
        editor_overrides: Object.keys(map).length > 0 ? map : null,
      }),
  },
  {
    id: "terminal",
    category: "editor",
    label: "Default terminal",
    description:
      "__DEN_TITLE__ opens a terminal to the service directory when you click >_.",
    keywords: ["terminal", "shell", "iterm", "ghostty", "console"],
    scope: "user",
    control: {
      type: "radio",
      options: (ctx) =>
        (ctx.data.terminals || []).map((t) => ({
          value: t.key,
          label: t.name,
          disabled: !t.available,
          tags: [t.available ? null : L("set.ui.notFound", "not found")],
        })),
    },
    keys: ["terminal"],
    read: (ctx) => effective(ctx.data.terminals, ctx.data.terminal),
    write: (v, ctx) => ctx.post({ terminal: v || null }),
  },

  // ── Navigation ─────────────────────────────────────────────────────────
  {
    id: "shell.pages",
    category: "navigation",
    label: "Pages",
    description: "Show or hide each page, and move it within its group.",
    keywords: ["rail", "sidebar", "hide", "order", "reorder", "pages", "menu"],
    scope: "user",
    control: { type: "navlist" },
    keys: ["shell.hidden", "shell.order"],
    read: (ctx) => {
      const s = ctx.shell.getState();
      return { hidden: s.hidden || [], order: s.order || [] };
    },
    write: (v, ctx) => ctx.shell.setNavPrefs(v),
  },
  {
    // 0.4.45: this person's project order (Manage projects); never Hub's.
    id: "shell.projectOrder",
    category: "navigation",
    label: "Project order",
    description:
      "The order of projects in the header's picker and Manage projects. A to Z by the name shown unless you move them in Manage projects. Yours only: never shared and never sent to Hub.",
    keywords: ["project", "order", "sort", "reorder", "picker", "a to z"],
    scope: "user",
    control: { type: "custom", render: renderProjectOrder },
    keys: ["shell.projectOrder"],
    read: (ctx) => ctx.data?.shell?.projectOrder ?? [],
    // null is A to Z (Reset).
    write: (v, ctx) =>
      ctx.post({ shell: { projectOrder: v && v.length ? v : null } }),
  },
  {
    id: "shell.pins",
    category: "navigation",
    label: "Pinned",
    description:
      "Services and repos at the top of the rail. Pin them from Services, the graph or the health row.",
    keywords: ["pin", "pins", "pinned", "favorite", "rail"],
    scope: "user",
    control: { type: "pins" },
    keys: ["shell.pins"],
    read: (ctx) => ctx.shell.getState().pins || [],
    write: (v, ctx) => ctx.shell.setPins(v),
  },
  {
    id: "shell.collapsed",
    category: "navigation",
    label: "Collapse the rail",
    description:
      "Icons only. The rail's own button at the bottom does the same.",
    keywords: ["rail", "collapse", "icons", "sidebar", "compact"],
    scope: "user",
    control: { type: "toggle" },
    keys: ["shell.collapsed"],
    read: (ctx) => ctx.shell.getState().collapsed === true,
    write: (v, ctx) => ctx.shell.setCollapsed(v),
  },
  {
    id: "shell.dock",
    category: "navigation",
    label: "Open the runs dock",
    description:
      "The output of runs, at the foot of every page. Off, it is just its bar: a run's tab appears and the Runs chip pulses, and you open it. Drag its top edge to resize it, up to half the window.",
    keywords: ["runs", "dock", "output", "log", "panel", "console", "height"],
    scope: "user",
    control: { type: "toggle" },
    keys: ["shell.dock", "shell.dockHeight"],
    read: (ctx) => ctx.shell.getState().dock === true,
    write: (v, ctx) => ctx.shell.setDock(v),
  },

  // ── Graph ──────────────────────────────────────────────────────────────
  graphRow(
    "workspaces",
    "Project list",
    "The Projects page's project list, open or collapsed to a strip so the table gets the width.",
    ["workspaces", "list", "sidebar", "collapse", "strip", "local dev"],
    seg([
      { value: "open", label: "Open" },
      { value: "collapsed", label: "Collapsed" },
    ]),
  ),
  graphRow(
    "groupBy",
    "Group repos by",
    "The Projects page's repo table: one list, or grouped by application (as __DEN_CLI__ apps) or by company.",
    [
      "workspaces",
      "group",
      "application",
      "apps",
      "org",
      "company",
      "table",
      "local dev",
    ],
    seg([
      { value: "none", label: "None" },
      { value: "app", label: "Application" },
      { value: "org", label: "Company" },
    ]),
  ),
  graphRow(
    "direction",
    "Direction",
    "Lay the graph out top-down or left to right.",
    ["layout", "direction", "orientation", "horizontal", "vertical"],
    seg([
      { value: "down", label: "Top-down" },
      { value: "right", label: "Left to right" },
    ]),
  ),
  graphRow(
    "group",
    "Frames",
    "The outer frames: by company or by application.",
    ["group", "frames", "org", "company", "application", "cluster"],
    seg([
      { value: "org", label: "By company" },
      { value: "app", label: "By application" },
    ]),
  ),
  graphRow(
    "density",
    "Cards",
    "Detailed cards show more; compact ones fit more on screen.",
    ["density", "cards", "compact", "detailed", "size"],
    seg([
      { value: "detailed", label: "Detailed" },
      { value: "compact", label: "Compact" },
    ]),
  ),
  graphRow(
    "panelWidth",
    "Details panel",
    "The width of the graph's details panel, in pixels (360 to 760).",
    ["panel", "width", "details", "sidebar"],
    { type: "number", min: 360, max: 760, step: 10, unit: "px" },
  ),

  // ── Workspace ──────────────────────────────────────────────────────────
  {
    // 0.4.45 project names v5: Hub's name when linked, else its own.
    id: "workspace.name",
    category: "workspace",
    label: "Name",
    description:
      "The name Den shows for this project in the header, lists and pages. Linked to a Hub project, it is Hub's name. The slug never changes.",
    // Mock v6: one help line on screen, the state's own (the control
    // draws it); this one is for search and screen readers.
    helpInControl: true,
    keywords: ["name", "rename", "project", "hub", "slug", "title"],
    scope: "workspace",
    control: { type: "custom", render: renderProjectName },
    read: () => null,
  },
  {
    // Issue 168: the project's colour, the person's own (Manage projects
    // has the same control on its dot).
    id: "workspace.colour",
    category: "workspace",
    label: "Colour",
    description:
      "The colour of this project's agents, tabs, To line and top bar chip. Automatic picks one, the same every time; yours only, never shared or sent to Hub.",
    keywords: ["colour", "color", "hue", "project"],
    scope: "workspace",
    control: { type: "custom", render: renderProjectColour },
    keys: ["shell.projectColours"],
    read: () => null,
    // The control saves through the choice (project-colour-picker.js);
    // a write sets this project's colour, "" or null for Automatic.
    write: (v, ctx) =>
      ctx.post({
        shell: { projectColours: { [ctx.workspace]: v || null } },
      }),
  },
  {
    id: "workspace.editor",
    category: "workspace",
    label: "IDE for this project",
    description:
      "Opening this project, or a repo in it without a per-language override, uses this editor instead of your default.",
    keywords: ["workspace", "editor", "ide", "override"],
    scope: "workspace",
    control: { type: "workspace-editor" },
    read: (ctx) => ctx.wsSettings?.editor ?? "",
    write: (v, ctx) => ctx.saveWorkspace({ editor: v || null }),
  },

  {
    // H5: the Hub project this project's agents file their Hub work in.
    id: "workspace.hub",
    category: "workspace",
    label: "Hub project",
    description:
      "The Hub project this project's agents file their Hub work in: docs, mocks, comments. Den never links on its own: Hub suggests one with the same repos or name, and you confirm. Not linked, Hub files the work in Unfiled. __DEN_CLI__ hub link -p <project>",
    keywords: ["hub", "hub project", "link", "unfiled", "company", "project"],
    scope: "workspace",
    control: { type: "custom", render: renderHubProject },
    read: () => null,
  },

  {
    // Issue 158: the Hub delivery loop for this project, over the install.
    id: "workspace.hub_delivery_loop",
    category: "workspace",
    label: "Hub delivery loop: this project",
    description:
      "Whether this project's agents get the Hub delivery loop in their instructions, over the install's Hub delivery loop. Reaches an agent at its next start.",
    keywords: [
      "hub",
      "delivery",
      "loop",
      "instructions",
      "project",
      "override",
    ],
    scope: "workspace",
    control: seg([
      { value: "install", label: "As everywhere" },
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ]),
    read: (ctx) =>
      ctx.wsSettings?.hub_delivery_loop === true
        ? "on"
        : ctx.wsSettings?.hub_delivery_loop === false
          ? "off"
          : "install",
    write: (v, ctx) =>
      ctx.saveWorkspace({
        hub_delivery_loop: v === "on" ? true : v === "off" ? false : null,
      }),
  },
  {
    // Issue 158: the project's own text after Den's copy of the loop.
    id: "workspace.hub_delivery_loop_extra",
    category: "workspace",
    label: "Added to the Hub delivery loop",
    description:
      "This project's own text, added after Den's copy of the loop in its agents' instructions. Den's copy can't be edited. Empty adds nothing.",
    keywords: ["hub", "delivery", "loop", "add", "project", "instructions"],
    scope: "workspace",
    // The server's limit (HUB_LOOP_EXTRA_MAX), so a long paste stops here.
    control: { type: "text", maxLength: 2000 },
    read: (ctx) => ctx.wsSettings?.hub_delivery_loop_extra ?? "",
    write: (v, ctx) =>
      ctx.saveWorkspace({
        hub_delivery_loop_extra: String(v ?? "").trim() || null,
      }),
  },

  {
    // Issue 225: the project's mode, and each agent's actual mode with
    // where it comes from; agents with their own setting can follow it.
    // Issue 268: named as the override of the Den-wide default.
    id: "workspace.agents_mode",
    category: "workspace",
    label: "Agents' mode: this project (overrides the Den-wide default)",
    description:
      "The mode this project's agents run in, over the Den-wide default. Which wins: an agent's own setting, then the project, then the Den-wide default, then its persona. Each agent below says its mode and where it comes from. A change reaches running agents after their turn, on its own.",
    keywords: [
      "agents",
      "mode",
      "permission",
      "auto",
      "ask",
      "own setting",
      "override",
      "den-wide",
    ],
    scope: "workspace",
    control: { type: "custom", render: renderProjectMode },
    read: () => null,
  },

  {
    // Issue 160: this project's approval policy (workspaces.yml
    // <project>.approvals), over the install's. A person's only.
    id: "workspace.approvals_policy",
    category: "workspace",
    label: "Agents' writes here",
    description:
      "What an agent in this project may do without your Allow, over Agent writes. A write that widens what an agent may do, touches secrets, deletes data or spends money always asks.",
    keywords: ["approval", "allow", "policy", "notify", "ask", "auto"],
    scope: "workspace",
    control: seg([
      { value: "install", label: "As everywhere" },
      { value: "auto", label: "Run, no note" },
      { value: "notify", label: "Run and tell me" },
      { value: "ask", label: "Ask me" },
    ]),
    read: (ctx) => ctx.wsSettings?.approvals_policy ?? "install",
    write: (v, ctx) =>
      ctx.saveWorkspace({ approvals_policy: v === "install" ? null : v }),
  },
  {
    id: "workspace.approvals_watch",
    category: "workspace",
    label: "Watched here",
    description:
      "An agent's write on any of these asks you first, whatever its kind. Comma-separated: project:<name>, repo:<name>, service:<repo>/<name>, persona:<id>, agent:<id>, or a bare name.",
    keywords: ["watch", "watched", "favorite", "approval", "allow", "ask"],
    scope: "workspace",
    control: { type: "text" },
    read: (ctx) => (ctx.wsSettings?.approvals_watch ?? []).join(", "),
    write: (v, ctx) =>
      ctx.saveWorkspace({ approvals_watch: String(v ?? "").trim() || null }),
  },
  {
    id: "workspace.approvals_critical",
    category: "workspace",
    label: "Critical here",
    description:
      "Kinds of agent write that always ask you in this project. Comma-separated, for example repo_clone, service_try.",
    keywords: ["critical", "approval", "allow", "ask", "policy"],
    scope: "workspace",
    control: { type: "text" },
    read: (ctx) => (ctx.wsSettings?.approvals_critical ?? []).join(", "),
    write: (v, ctx) =>
      ctx.saveWorkspace({
        approvals_critical: String(v ?? "").trim() || null,
      }),
  },
  {
    // Issue 335: the project's extra HTTP MCP servers, names and
    // addresses only. An agent adds one with a held write; the person
    // Allows it.
    id: "workspace.mcp_servers",
    category: "workspace",
    label: "Agents' extra MCP servers: this project",
    description:
      "HTTP MCP servers this project's agents get, besides Den's and Hub's, by name and address. A bearer is read from the install's secrets store at each call and is never shown. Change or remove one here. An agent asks with project_mcp_add, project_mcp_update or project_mcp_remove, and you Allow it.",
    keywords: ["agents", "mcp", "mcp server", "tools", "bearer", "http"],
    scope: "workspace",
    control: { type: "custom", render: renderProjectMcp },
    read: () => null,
  },
  {
    // Issue 459: the project's app event feeds (agents.event_feeds in
    // workspaces.yml), each with its state. Names, agents and addresses
    // only: a bearer is read from the install's secrets store and never shown.
    id: "workspace.event_feeds",
    category: "workspace",
    label: "App event feeds: this project",
    description:
      "Events an app of this project sends on its own stream, for one agent. Den types the agent a short line when some are unread, when it is idle, never mid-turn; the agent reads them with app_feed_read. Each feed says whether it is connected and when its last event came. Add one in agents.event_feeds; a bearer is a secrets.refs name.",
    keywords: ["feed", "events", "stream", "app", "sse"],
    scope: "workspace",
    control: { type: "custom", render: renderAppFeeds },
    read: () => null,
  },

  // ── Agents ─────────────────────────────────────────────────────────────
  {
    // Issue 160: the install's approval policy (user.yml approvals). A
    // person's only: an agent asks with approval_policy.
    id: "agents.approvals_policy",
    category: "agents",
    label: "Agent writes",
    description:
      "What an agent may do without your Allow. Run and tell me: it runs, and your updates say so. A write that widens what an agent may do, touches secrets, deletes data or spends money always asks, as does one on something you watch or pinned.",
    keywords: ["approval", "allow", "policy", "notify", "ask", "auto"],
    scope: "user",
    keys: ["approvals_policy"],
    control: seg([
      { value: "auto", label: "Run, no note" },
      { value: "notify", label: "Run and tell me" },
      { value: "ask", label: "Ask me" },
    ]),
    read: (ctx) => ctx.data.approvals_policy ?? "notify",
    write: (v, ctx) => ctx.post({ approvals_policy: v }),
  },
  {
    id: "agents.approvals_watch",
    category: "agents",
    label: "Watched",
    description:
      "An agent's write on any of these asks you first, whatever its kind; so does one on a repo or service you pinned. Comma-separated: project:<name>, repo:<name>, service:<repo>/<name>, persona:<id>, agent:<id>, or a bare name.",
    keywords: ["watch", "watched", "favorite", "pinned", "approval", "ask"],
    scope: "user",
    keys: ["approvals_watch"],
    control: { type: "text" },
    read: (ctx) => (ctx.data.approvals_watch ?? []).join(", "),
    write: (v, ctx) =>
      ctx.post({ approvals_watch: String(v ?? "").trim() || null }),
  },
  {
    id: "agents.approvals_critical",
    category: "agents",
    label: "Critical",
    description:
      "Kinds of agent write that always ask you, in every project. Comma-separated, for example repo_clone, service_try.",
    keywords: ["critical", "approval", "allow", "ask", "policy"],
    scope: "user",
    keys: ["approvals_critical"],
    control: { type: "text" },
    read: (ctx) => (ctx.data.approvals_critical ?? []).join(", "),
    write: (v, ctx) =>
      ctx.post({ approvals_critical: String(v ?? "").trim() || null }),
  },
  {
    // Issue 742: how long an agent's request waits for your Allow
    // (user.yml held_writes.wait_minutes). A person's only.
    id: "agents.held_wait",
    category: "agents",
    label: "Requests wait for your Allow",
    description:
      "How long an agent's request waits for your Allow before it lapses: 10 minutes to 7 days (10080). It stays in the bell the whole time, and survives a restart. Allowing an old one checks it again first. __DEN_CLI__ config held_writes.wait_minutes=1440",
    keywords: [
      "approval",
      "allow",
      "wait",
      "expire",
      "lapse",
      "held",
      "request",
    ],
    scope: "user",
    keys: ["held_writes.wait_minutes"],
    control: { type: "number", min: 10, max: 10080, step: 1, unit: "min" },
    read: (ctx) => ctx.data.held_writes?.wait_minutes ?? 1440,
    write: (v, ctx) => ctx.post({ held_writes: { wait_minutes: v } }),
  },
  {
    // issue_write: which persona roles write GitHub issues in their
    // project's repos (user.yml agents.issue_writes). A person's only.
    id: "agents.issue_writes",
    category: "agents",
    label: "Who writes GitHub issues",
    description:
      "The roles whose agents may create issues, comment, label and set milestones in their own project's GitHub repos, at once and recorded. Comma-separated; empty: none. Unset: planner, orchestrator, lead, sde, builder, reviewer and install (__DEN_TITLE__'s own agent). __DEN_CLI__ config agents.issue_writes=[planner,sde]",
    keywords: [
      "issue",
      "issues",
      "github",
      "role",
      "comment",
      "label",
      "agents.issue_writes",
    ],
    scope: "user",
    keys: ["agent_issue_writes.roles"],
    control: { type: "text" },
    read: (ctx) => (ctx.data.agent_issue_writes?.roles ?? []).join(", "),
    write: (v, ctx) =>
      ctx.post({
        agent_issue_writes: {
          roles: String(v ?? "")
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean),
        },
      }),
  },
  {
    id: "agents.issue_writes_per_hour",
    category: "agents",
    label: "GitHub issue writes an hour",
    description:
      "How many issue writes all agents together may make in an hour. Past it, an agent is told how long to wait. __DEN_CLI__ config agents.issue_writes_per_hour=60",
    keywords: [
      "issue",
      "issues",
      "github",
      "limit",
      "rate",
      "hour",
      "agents.issue_writes",
    ],
    scope: "user",
    keys: ["agent_issue_writes.per_hour"],
    control: { type: "number", min: 1, max: 10000, step: 1 },
    read: (ctx) => ctx.data.agent_issue_writes?.per_hour ?? 60,
    write: (v, ctx) => ctx.post({ agent_issue_writes: { per_hour: v } }),
  },
  {
    // 0.4.46 MODE-UI: one mode for every agent, set once. Issue 268:
    // named as the Den-wide default, with what is in effect and the
    // projects that override it.
    id: "agents.default_mode",
    category: "agents",
    label: "Agents' mode: Den-wide default",
    description:
      "The mode every agent runs in, the __DEN_TITLE__ agent too, unless its project overrides it. Which wins: an agent's own setting, then the project, then the Den-wide default, then its persona. A change reaches running agents after their turn, on its own.",
    keywords: [
      "agents",
      "mode",
      "permission",
      "auto",
      "ask",
      "approve",
      "den-wide",
      "default",
      "override",
    ],
    scope: "user",
    control: { type: "custom", render: renderDenWideMode },
    keys: ["agents_default_mode"],
    read: (ctx) => ctx.data.agents_default_mode ?? "persona",
    write: (v, ctx) =>
      ctx.post({ agents_default_mode: v === "persona" ? null : v }),
  },
  {
    // MODE-5: how a terminal pane reconnects on its own (user.yml panes.*).
    id: "agents.pane_reconnect",
    category: "agents",
    label: "Terminal reconnect tries",
    description:
      "A terminal whose connection drops tries again on its own, waiting longer each time. After this many failed tries within the time below, it stops and shows Reconnect. __DEN_CLI__ config panes.reconnect_max_failures=20",
    keywords: ["reconnect", "terminal", "pane", "disconnected", "retry"],
    scope: "user",
    keys: ["panes_reconnect.max_failures"],
    control: { type: "number", min: 1, max: 10000, step: 1 },
    read: (ctx) => ctx.data.panes_reconnect?.max_failures ?? 10,
    write: (v, ctx) => ctx.post({ panes_reconnect: { max_failures: v } }),
  },
  {
    id: "agents.pane_reconnect_window",
    category: "agents",
    label: "Terminal reconnect window",
    description:
      "The time the failed tries above are counted in. __DEN_CLI__ config panes.reconnect_window_seconds=300",
    keywords: ["reconnect", "terminal", "window", "retry"],
    scope: "user",
    keys: ["panes_reconnect.window_seconds"],
    control: { type: "number", min: 1, max: 86400, step: 1, unit: "s" },
    read: (ctx) => ctx.data.panes_reconnect?.window_seconds ?? 300,
    write: (v, ctx) => ctx.post({ panes_reconnect: { window_seconds: v } }),
  },
  {
    id: "agents.pane_reconnect_wait",
    category: "agents",
    label: "Longest wait between tries",
    description:
      "The first try waits 1 s, and each wait doubles, up to this. __DEN_CLI__ config panes.reconnect_max_seconds=30",
    keywords: ["reconnect", "terminal", "wait", "backoff"],
    scope: "user",
    keys: ["panes_reconnect.max_seconds"],
    control: { type: "number", min: 1, max: 3600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.panes_reconnect?.max_seconds ?? 30,
    write: (v, ctx) => ctx.post({ panes_reconnect: { max_seconds: v } }),
  },
  {
    // den#156: the Agents list's waits (user.yml agents_list.*).
    id: "agents.list_host_wait",
    category: "agents",
    label: "Terminal host wait",
    description:
      "How long the Agents list waits for the terminal host. After this, the list says it couldn't reach it and tries again. __DEN_CLI__ config agents_list.host_timeout_seconds=10",
    keywords: ["timeout", "terminal", "host", "list", "wait"],
    scope: "user",
    keys: ["agents_list.host_timeout_seconds"],
    control: { type: "number", min: 1, max: 600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.agents_list?.host_timeout_seconds ?? 10,
    write: (v, ctx) => ctx.post({ agents_list: { host_timeout_seconds: v } }),
  },
  {
    // Issue 456: how long Den waits for your shell's PATH (-lc and -ilc).
    id: "agents.shell_path_wait",
    category: "agents",
    label: "Shell PATH wait",
    description:
      "How long __DEN_TITLE__ waits for your shell to say its PATH when it looks for agent CLIs: the PATH a new shell gets, startup files and all. After this, it looks in the usual places instead. __DEN_CLI__ config agents.shell_path_timeout_seconds=10",
    keywords: ["timeout", "shell", "path", "zshrc", "cli", "runtime", "wait"],
    scope: "user",
    keys: ["agents_shell.path_timeout_seconds"],
    control: { type: "number", min: 1, max: 120, step: 1, unit: "s" },
    read: (ctx) => ctx.data.agents_shell?.path_timeout_seconds ?? 10,
    write: (v, ctx) => ctx.post({ agents_shell: { path_timeout_seconds: v } }),
  },
  {
    id: "agents.list_refresh_wait",
    category: "agents",
    label: "Agents list wait",
    description:
      "How long the Agents page waits for its list. After this, it says the list may be out of date and tries again. __DEN_CLI__ config agents_list.refresh_timeout_seconds=15",
    keywords: ["timeout", "list", "refresh", "wait", "out of date"],
    scope: "user",
    keys: ["agents_list.refresh_timeout_seconds"],
    control: { type: "number", min: 1, max: 600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.agents_list?.refresh_timeout_seconds ?? 15,
    write: (v, ctx) =>
      ctx.post({ agents_list: { refresh_timeout_seconds: v } }),
  },
  {
    // Issue 609: how agents' hooks wait for Den, and retry (agent_hooks.*).
    id: "agents.hook_wait",
    category: "agents",
    label: "Agent hook wait",
    description:
      "How long an agent's hooks wait for __DEN_TITLE__ on each try when they tell it the agent needs you, or check the Hub inbox. A busy machine can be slow to answer. Applies when an agent next starts. __DEN_CLI__ config agent_hooks.timeout_seconds=20",
    keywords: ["timeout", "hook", "attention", "bell", "wait"],
    scope: "user",
    keys: ["agent_hooks.timeout_seconds"],
    control: { type: "number", min: 1, max: 600, step: 1, unit: "s" },
    read: (ctx) => ctx.data.agent_hooks?.timeout_seconds ?? 20,
    write: (v, ctx) => ctx.post({ agent_hooks: { timeout_seconds: v } }),
  },
  {
    id: "agents.hook_retries",
    category: "agents",
    label: "Agent hook retries",
    description:
      "How many more times an agent's hook tries when __DEN_TITLE__ didn't answer in time or turned the call away. Applies when an agent next starts. __DEN_CLI__ config agent_hooks.retries=2",
    keywords: ["retry", "hook", "attention", "bell"],
    scope: "user",
    keys: ["agent_hooks.retries"],
    control: { type: "number", min: 0, max: 10, step: 1 },
    read: (ctx) => ctx.data.agent_hooks?.retries ?? 2,
    write: (v, ctx) => ctx.post({ agent_hooks: { retries: v } }),
  },
  {
    id: "agents.hook_backoff",
    category: "agents",
    label: "Agent hook pause",
    description:
      "How long an agent's hook waits before its first retry. Each later pause doubles. Applies when an agent next starts. __DEN_CLI__ config agent_hooks.backoff_seconds=1",
    keywords: ["retry", "backoff", "pause", "hook"],
    scope: "user",
    keys: ["agent_hooks.backoff_seconds"],
    control: { type: "number", min: 0, max: 60, step: 0.5, unit: "s" },
    read: (ctx) => ctx.data.agent_hooks?.backoff_seconds ?? 1,
    write: (v, ctx) => ctx.post({ agent_hooks: { backoff_seconds: v } }),
  },
  {
    // Issue 278: agents stuck compacting; instruction size (agent_context.*).
    id: "agents.compaction_loop",
    category: "agents",
    label: "Compacting repeatedly: compactions",
    description:
      "How many automatic compactions an agent may have within the minutes below before the bell says it is compacting repeatedly. One bell per episode. __DEN_CLI__ config agent_context.compaction_loop_count=3",
    keywords: ["compaction", "compact", "loop", "context", "bell"],
    scope: "user",
    keys: ["agent_context.compaction_loop_count"],
    control: { type: "number", min: 1, max: 1000, step: 1 },
    read: (ctx) => ctx.data.agent_context?.compaction_loop_count ?? 3,
    write: (v, ctx) =>
      ctx.post({ agent_context: { compaction_loop_count: v } }),
  },
  {
    id: "agents.compaction_minutes",
    category: "agents",
    label: "Compacting repeatedly: minutes",
    description:
      "The window the compactions above are counted in. __DEN_CLI__ config agent_context.compaction_loop_minutes=10",
    keywords: ["compaction", "compact", "loop", "minutes", "window"],
    scope: "user",
    keys: ["agent_context.compaction_loop_minutes"],
    control: { type: "number", min: 1, max: 1440, step: 1, unit: "min" },
    read: (ctx) => ctx.data.agent_context?.compaction_loop_minutes ?? 10,
    write: (v, ctx) =>
      ctx.post({ agent_context: { compaction_loop_minutes: v } }),
  },
  {
    id: "agents.compaction_pause",
    category: "agents",
    label: "Hold deliveries after a compaction loop",
    description:
      "On: once the bell says an agent is compacting repeatedly, new deliveries to it (Hub comments, notes) wait until a person clears it on the Agents page. Off (the default): they go as usual. __DEN_CLI__ config agent_context.pause_after_loop=true",
    keywords: ["compaction", "pause", "hold", "deliveries", "loop"],
    scope: "user",
    keys: ["agent_context.pause_after_loop"],
    control: { type: "toggle" },
    read: (ctx) => ctx.data.agent_context?.pause_after_loop === true,
    write: (v, ctx) => ctx.post({ agent_context: { pause_after_loop: v } }),
  },
  {
    id: "agents.instruction_share",
    category: "agents",
    label: "Instruction files: warn above",
    description:
      "When the instruction files an agent loads at start (CLAUDE.md, AGENTS.md and the like, up its folders) are more than this share of its model's context, its row and doctor warn, naming the largest. Sizes are estimated as bytes / 4 tokens. __DEN_CLI__ config agent_context.instruction_share_percent=15",
    keywords: ["instructions", "CLAUDE.md", "AGENTS.md", "context", "size"],
    scope: "user",
    keys: ["agent_context.instruction_share_percent"],
    control: { type: "number", min: 1, max: 100, step: 1, unit: "%" },
    read: (ctx) => ctx.data.agent_context?.instruction_share_percent ?? 15,
    write: (v, ctx) =>
      ctx.post({ agent_context: { instruction_share_percent: v } }),
  },
  {
    id: "agents.context_tokens",
    category: "agents",
    label: "Context size when unknown",
    description:
      "The context size, in tokens, the share above is taken of when __DEN_TITLE__ doesn't know the model's own. __DEN_CLI__ config agent_context.context_tokens=200000",
    keywords: ["context", "tokens", "size", "model"],
    scope: "user",
    keys: ["agent_context.context_tokens"],
    control: { type: "number", min: 1000, max: 100000000, step: 1000 },
    read: (ctx) => ctx.data.agent_context?.context_tokens ?? 200000,
    write: (v, ctx) => ctx.post({ agent_context: { context_tokens: v } }),
  },
  {
    id: "agents.layout",
    category: "agents",
    label: "Agents tab layout",
    description:
      "Focus shows one agent, Tabs shows one with a tab for each, Tile shows up to four in a grid. The Agents tab's switch, ⌃⇧1, ⌃⇧2, ⌃⇧3 and ⌘K set it too.",
    keywords: ["agents", "layout", "focus", "tabs", "tile", "grid", "panes"],
    scope: "user",
    control: seg([
      { value: "focus", label: "Focus" },
      { value: "tabs", label: "Tabs" },
      { value: "tile", label: "Tile" },
    ]),
    keys: ["agents_layout"],
    read: (ctx) => ctx.data.agents_layout ?? "focus",
    write: (v, ctx) => ctx.post({ agents_layout: v }),
  },
  ...bellRows(),
  {
    id: "agents.helpers_shown",
    category: "agents",
    label: "Show up to this many helpers under an agent",
    description:
      "More open in Show all. The badge always counts every running helper.",
    keywords: ["agents", "helpers", "subagents", "badge", "shown", "list"],
    scope: "user",
    control: seg([
      { value: "1", label: "1" },
      { value: "3", label: "3" },
      { value: "5", label: "5" },
      { value: "10", label: "10" },
    ]),
    keys: ["agents_helpers_shown"],
    read: (ctx) => String(ctx.data.agents_helpers_shown ?? 3),
    write: (v, ctx) => ctx.post({ agents_helpers_shown: Number(v) }),
  },
  {
    id: "agents.runtimes",
    category: "agents",
    label: "Runtimes",
    description:
      "Each runtime's status and version, the path in use and where it came from. Set path… runs its version command first and refuses a path that isn't that runtime.",
    keywords: [
      "runtime",
      "claude",
      "codex",
      "gemini",
      "grok",
      "path",
      "bin",
      "cli",
      "agent",
    ],
    scope: "user",
    control: { type: "custom", render: renderRuntimes },
    read: () => null,
  },

  {
    id: "agents.rotation",
    category: "agents",
    label: "Rotation",
    description:
      "When an agent's conversation has compacted this many times (or its pull request merged), Den starts it again from its handoff: a fresh conversation, the same name, persona, project and folder. Auto asks the agent for its handoff when it is idle, then relaunches it by itself; Ask shows buttons on the agent; Off does nothing. Overrides win over this install's value: agent, persona in a project, persona, project, service. __DEN_CLI__ agents rotate",
    keywords: [
      "rotation",
      "rotate",
      "relaunch",
      "handoff",
      "compaction",
      "compactions",
      "context",
      "restart",
      "agent",
    ],
    scope: "user",
    control: { type: "custom", render: renderRotation },
    read: () => null,
  },

  {
    id: "agents.hub",
    category: "hub",
    label: "Hub",
    description:
      "Connect this install to your company's Hub: sign in there and approve it. Every agent then gets Hub's tools: search Hub, publish docs and mocks there. Its company comes from this install's token, its Hub project from Project setup › Hub project.",
    keywords: [
      "hub",
      "den hub",
      "connect",
      "disconnect",
      "mcp",
      "team",
      "company",
      "token",
      "docs",
      "mocks",
    ],
    scope: "user",
    control: { type: "custom", render: renderHub },
    keys: ["hub_allow_tools", "hub_url"],
    read: () => null,
    write: (v, ctx) => ctx.post({ hub_allow_tools: v }),
  },

  {
    // Issue 158: the Hub delivery loop, built into every Den.
    id: "agents.hub_delivery_loop",
    category: "hub",
    label: "Hub delivery loop",
    description:
      "On, every agent Den starts in a project connected to Hub gets the delivery loop in its instructions: requirement docs in Hub, issues linked in full, review and feedback in Hub's threads, status from git. Off for every project here unless a project turns it on. Reaches an agent at its next start.",
    keywords: ["hub", "delivery", "loop", "instructions", "agents", "review"],
    scope: "user",
    keys: ["hub_delivery_loop"],
    control: { type: "toggle" },
    read: (ctx) => ctx.data.hub_delivery_loop !== false,
    write: (v, ctx) =>
      ctx.post({ hub_delivery_loop: v === true ? null : false }),
  },

  {
    id: "agents.hub_link_all",
    category: "hub",
    // Issue 167 (mock v6 B): the anchor stays; the row is Unclear matches.
    label: "Unclear matches",
    description:
      "Linking ties a project to its Hub project, so its agents file docs, mocks and comments there. Den lists a project here only when it can't tell which Hub project fits. Pick one and press Link. Until then, nothing is filed for that project.",
    keywords: ["hub", "link", "projects", "unclear", "pick", "match"],
    scope: "user",
    control: { type: "custom", render: renderHubLinkAll },
    read: () => null,
  },

  {
    id: "agents.hub_github",
    category: "agents",
    label: "Den Hub's GitHub access",
    description:
      "How many of your company's GitHub repos Den Hub can read, asked live from Hub, with GitHub's link to give it access or change its repos.",
    keywords: ["hub", "github", "access", "app", "install", "repos"],
    scope: "user",
    control: { type: "custom", render: renderHubGithub },
    read: () => null,
  },

  {
    id: "agents.personas",
    category: "agents",
    label: "Personas",
    description:
      "Agent setups you can start from. Built-in ones ship with Den, distribution ones with your distribution, and yours live on this machine. View or Edit, Duplicate, + New persona; only your own can be edited or deleted.",
    keywords: [
      "persona",
      "role",
      "agent",
      "model",
      "version",
      "permission",
      "allowed commands",
      "instructions",
    ],
    scope: "user",
    control: { type: "custom", render: renderPersonasSettings },
    read: () => null,
  },

  {
    // Issue 163: on by default for a new install (0.4.63); an existing one
    // is offered it. Apply re-installs Den's launchd jobs: on, as
    // LaunchDaemons (mode always) that outlive a logout.
    id: "agents.keep_running",
    category: "agents",
    label: "Keep agents running after logout",
    description:
      "On (the default for a new install): __DEN_TITLE__ runs as a LaunchDaemon, so agents keep running after you log out. There they sign in with a long-lived token from your secrets store, not the login keychain: your agents' CLI makes it when you sign in to it, and you paste it into Sign-in token below. Off: agents stop when you log out. __DEN_CLI__ config agents.keep_running_after_logout=true, then __DEN_CLI__ service install",
    keywords: [
      "logout",
      "log out",
      "daemon",
      "launchd",
      "always",
      "background",
    ],
    scope: "user",
    control: { type: "custom", render: renderKeepRunning },
    read: () => null,
  },

  // ── Command line ───────────────────────────────────────────────────────
  {
    id: "cli.local_dev",
    category: "cli",
    label: "Local environment",
    description:
      "Off hides Projects and the project APIs for you. __DEN_CLI__ config local_dev=false",
    keywords: ["local", "local dev", "environment", "disable"],
    scope: "user",
    keys: ["local_dev"],
    control: { type: "toggle" },
    read: (ctx) => ctx.data.local_dev !== false,
    // On is the default: it is stored only when off.
    write: (v, ctx) => ctx.post({ local_dev: v ? null : false }),
  },
  {
    id: "cli.cli_tabs",
    category: "cli",
    label: "Terminal tabs",
    description:
      "Whether up and restart open terminal tabs by default. __DEN_CLI__ config cli_tabs=true",
    keywords: ["tabs", "terminal", "up", "restart", "cli"],
    scope: "user",
    keys: ["cli_tabs"],
    control: { type: "toggle" },
    read: (ctx) => ctx.data.cli_tabs === true,
    write: (v, ctx) => ctx.post({ cli_tabs: v ? true : null }),
  },
  {
    id: "cli.log_window_lines",
    category: "cli",
    label: "Log pane lines",
    description:
      "How many lines a Logs pane keeps loaded; full-history search is unaffected. __DEN_CLI__ config log_window_lines=50000",
    keywords: ["logs", "lines", "window", "history", "buffer"],
    scope: "user",
    keys: ["log_window_lines"],
    control: { type: "number", min: 1000, max: 1000000, step: 1000 },
    read: (ctx) => Number(ctx.data.log_window_lines ?? 20000),
    write: (v, ctx) => ctx.post({ log_window_lines: v }),
  },
  {
    id: "cli.web_port",
    category: "cli",
    label: "Your web port",
    description:
      "web.port in config/local/user.yml overrides the distribution's. It applies when the web server next starts.",
    keywords: ["port", "web", "server", "url"],
    scope: "user",
    control: { type: "readonly" },
    read: (ctx) =>
      ctx.data.user_web_port != null
        ? String(ctx.data.user_web_port)
        : L("set.ui.portUnset", "Not set: the distribution's applies"),
  },
  {
    // SEC-1b: whether this browser is signed in, and Sign out. Issue 393:
    // signed out, a Sign in button opens Den's own sign-in page (GitHub,
    // or a code another device approves). `again=1` shows that page even
    // on loopback, where nothing asks (D67's approvals banner does the
    // same); after it, back here. `web login` stays in the description,
    // a bare equivalent.
    id: "cli.signin",
    category: "cli",
    label: "Browser sign-in",
    description:
      "Every browser signs in once, on this machine too, and stays signed in. Here, __DEN_CLI__ web up opens a one-time sign-in link; a browser that isn't signed in can look but change nothing. From another machine: Sign in with GitHub, or a one-time link (__DEN_CLI__ web login). Settings › Access lists the signed-in browsers.",
    keywords: ["sign in", "sign out", "login", "logout", "session", "browser"],
    scope: "user",
    control: {
      type: "custom",
      render(host, ctx) {
        const draw = (signedIn) => {
          host.innerHTML = signedIn
            ? `<output class="set-ro">${escR(L("set.ui.signedIn", "Signed in"))}</output> ` +
              `<button type="button" class="btn" id="set-signout">${escR(L("set.ui.signOut", "Sign out"))}</button>`
            : `<output class="set-ro">${escR(L("set.ui.notSignedIn", "Not signed in"))}</output> ` +
              `<button type="button" class="btn primary" id="set-signin">${escR(L("set.ui.signIn", "Sign in"))}</button>`;
          host
            .querySelector("#set-signin")
            ?.addEventListener("click", () =>
              location.assign(
                "/signin?again=1&next=" +
                  encodeURIComponent(
                    location.pathname + location.search + location.hash,
                  ),
              ),
            );
          host.querySelector("#set-signout")?.addEventListener("click", () =>
            ctx.shell
              .api("POST", "/api/session/logout", {})
              .then(() => draw(false))
              .catch(() => {}),
          );
        };
        // Until /api/session answers, an unseen button holds the row at its
        // drawn height: a row that grows later moves the sections below it,
        // and a link to the last one (#distribution) would end short of the
        // foot, with the category above it marked current.
        host.innerHTML = `<button type="button" class="btn" style="visibility:hidden" aria-hidden="true" tabindex="-1">${escR(L("set.ui.signIn", "Sign in"))}</button>`;
        fetch("/api/session", { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((b) => draw(b?.signedIn === true))
          .catch(() => draw(false));
      },
    },
    read: () => null,
  },
  {
    // R8, LK-0: the admin password is for sudo, and nothing else. Den asks
    // for it only when a command it runs needs sudo; here is whether it is
    // saved, and Forget. Reading never wakes the vault.
    id: "cli.sudo",
    category: "cli",
    label: "Admin password",
    description:
      "Used only when a command Den runs needs sudo, and asked for only then. It is no sign-in: nothing else needs it.",
    keywords: ["admin", "password", "sudo", "forget", "vault", "1password"],
    scope: "user",
    control: {
      type: "custom",
      render(host, ctx) {
        const draw = (st) => {
          const saved = st?.saved;
          const where =
            saved === "vault"
              ? L("set.ui.savedIn", "Saved in {vault}", {
                  vault: st.vault?.label || L("set.ui.theVault", "the vault"),
                })
              : saved === "session"
                ? L("set.ui.savedMemory", "Held in memory until Den restarts")
                : L("set.ui.notSaved", "Not saved");
          host.innerHTML =
            '<output class="set-ro" id="set-sudo"></output>' +
            (saved
              ? ` <button type="button" class="btn" id="set-sudo-forget">${escR(L("set.ui.forget", "Forget"))}</button>`
              : "");
          host.querySelector("output").textContent = where;
          host
            .querySelector("#set-sudo-forget")
            ?.addEventListener("click", () =>
              ctx.shell
                .api("POST", "/api/sudo-password/forget", {})
                .then(load)
                .catch(load),
            );
        };
        const load = () =>
          fetch("/api/sudo-password/status", { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then(draw)
            .catch(() => draw(null));
        void load();
      },
    },
    read: () => null,
  },

  {
    // 1Password for a Den running as a service: where its service-account
    // token comes from (secrets.onepassword.token in user.yml). The source
    // only, never the token.
    id: "cli.op_token",
    category: "secrets",
    label: "1Password token source",
    description:
      "Where this machine's 1Password service-account token comes from, for a Den running as a service. Set secrets.onepassword.token in config/local/user.yml: keychain:<service>, file:<path> or env:<VAR>. The token itself is never shown.",
    keywords: ["secrets", "1password", "op", "service account", "token"],
    scope: "user",
    control: { type: "readonly" },
    read: (ctx) =>
      ctx.data.op_token_source && ctx.data.op_token_source !== "not set"
        ? ctx.data.op_token_source
        : L("set.ui.notSet", "not set"),
  },

  ...ACCESS_ROWS,
  ...EMBED_ROWS,

  // ── Distribution (read-only) ───────────────────────────────────────────
  distRow(
    "brand",
    "Product name",
    "brand.name: the name on pages, the CLI banner and help.",
    ["brand", "name", "product", "title"],
    (d) => d.brand || L("set.ui.notSet", "not set"),
  ),
  distRow(
    "github_org",
    "GitHub org",
    "github_org: the org whose repos Den clones and lists.",
    ["github", "repos", "clone"],
    (d) => d.github_org || L("set.ui.notSet", "not set"),
  ),
  {
    // H5: how much of the org Den Hub's GitHub App can read, live from Hub.
    id: "distribution.hub_github",
    category: "hub",
    label: "Den Hub's GitHub access",
    description:
      "How many of your company's GitHub repos Den Hub can read, asked live from Hub. Den Hub reads a repo only through your company's GitHub App install; the button opens GitHub to install it or change its repos. When you come back, Den sends its projects to Hub again and the repos link by themselves.",
    keywords: [
      "distribution",
      "github",
      "hub",
      "access",
      "app",
      "install",
      "repos",
    ],
    scope: "distribution",
    control: { type: "custom", render: renderHubGithub },
    read: () => null,
  },
  distRow(
    "orgs",
    "Org labels",
    "orgs: display names for the GitHub orgs repos belong to.",
    ["orgs", "labels", "names"],
    (d) => {
      const e = Object.entries(d.orgs || {});
      return e.length
        ? e.map(([id, l]) => `${id}: ${l}`).join(", ")
        : L("set.ui.none", "none");
    },
  ),
  distRow(
    "web_port",
    "Web port",
    "web.port: the port the web UI listens on, unless yours overrides it.",
    ["port", "web", "server", "url"],
    (d) =>
      d.web_port != null
        ? String(d.web_port)
        : L("set.ui.portDefault", "not set ({port})", { port: 7777 }),
  ),
  distRow(
    "environments",
    "Environments",
    "environments: the envs the Env menu offers.",
    ["environments", "env", "local", "dev", "prod"],
    (d) =>
      d.environments
        ? d.environments.join(", ")
        : L("set.ui.envsAll", "not set: all"),
  ),
  distRow(
    "domain",
    "Edge domain",
    "edge.domain: services are served at https://<service>.<domain>.",
    ["edge", "domain", "https", "routes"],
    (d) => d.domain || L("set.ui.notSet", "not set"),
  ),
];

// ── Settings › Agents › Runtimes (AG-0.5) ────────────────────────────────

const escR = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** Where a runtime's path came from, as the row says it (en; see rtSource). */
export const RUNTIME_SOURCE = {
  workspace: "project",
  setting: "global",
  "login-shell": "detected · login shell",
  PATH: "detected · PATH",
  "well-known": "detected · install directory",
  "interactive-shell": "detected · interactive shell",
};

/** Where a runtime's path came from, in the page's language. */
const rtSource = (src) =>
  RUNTIME_SOURCE[src]
    ? L(`set.ui.rt.src.${src}`, RUNTIME_SOURCE[src])
    : src || "";

/** One runtime's row (r: GET /api/agents/runtimes' entry). */
export function runtimeRowHtml(r, scopeWs) {
  const id = escR(r.id);
  // A runtime's and its maker's names are names (translate="no").
  const name =
    `<b translate="no">${escR(r.label || r.id)}</b>` +
    (r.vendor
      ? ` <span class="rt-v" translate="no">${escR(r.vendor)}</span>`
      : "") +
    (r.denTools === false
      ? ` <span class="set-tag" data-den-tools="coming">${escR(L("set.ui.rt.toolsComing", "Den tools: coming"))}</span>`
      : "");
  const set = r.source === "workspace" || r.source === "setting";
  // Issue 456: a quarantined CLI is never run, so it has no checked version.
  const status = r.available
    ? r.quarantined
      ? `<span class="rt-bad" data-quarantined="true">${escR(r.version ? `${r.version} · ` : "")}${escR(rtQuarantined())}</span>`
      : `<span class="rt-ok">✓ ${escR(r.version ? r.version : L("set.ui.rt.installed", "installed"))}</span>`
    : `<span class="rt-bad">${escR(set ? r.why : L("set.ui.rt.notInstalled", "Not installed"))}</span>`;
  const where = r.path
    ? `<span class="den-mono rt-p">${escR(r.path)}</span> <span class="set-tag" data-src="${escR(r.source || "")}">${escR(rtSource(r.source))}</span>`
    : set
      ? `<span class="set-tag" data-src="${escR(r.source)}">${escR(rtSource(r.source))}</span>`
      : "";
  // A path set at the scope shown can be cleared from here.
  const mine = scopeWs ? r.source === "workspace" : r.source === "setting";
  return (
    `<div class="rt" role="listitem" data-runtime="${id}" data-available="${r.available ? "true" : "false"}">` +
    `<div class="rt-n">${name}</div>` +
    `<div class="rt-s">${status}</div>` +
    `<div class="rt-w">${where}</div>` +
    `<div class="rt-a"><button type="button" class="btn sm" data-set-path="${id}">${escR(L("set.ui.rt.setPath", "Set path…"))}</button>` +
    (mine
      ? ` <button type="button" class="btn sm" data-clear-path="${id}">${escR(L("set.ui.rt.clear", "Clear"))}</button>`
      : "") +
    `</div>` +
    `<form class="rt-f" data-path-form="${id}" hidden>` +
    `<label class="rt-fl" for="rt-in-${id}">${escR(scopeWs ? L("set.ui.rt.pathToIn", "Path to {name} for {ws}", { name: r.label || r.id, ws: scopeWs }) : L("set.ui.rt.pathToAll", "Path to {name} (every project)", { name: r.label || r.id }))}</label>` +
    `<input type="text" id="rt-in-${id}" class="den-mono" spellcheck="false" autocomplete="off" placeholder="/absolute/path/to/${escR(r.id === "den-claude" ? "claude" : r.id)}" value="${escR(mine ? r.path || "" : "")}">` +
    `<button type="submit" class="btn sm primary">${escR(L("set.ui.rt.save", "Save"))}</button> <button type="button" class="btn sm" data-cancel-path>${escR(L("set.ui.rt.cancel", "Cancel"))}</button>` +
    `<div class="rt-err" role="alert" hidden></div></form>` +
    otherCopiesHtml(r) +
    `</div>`
  );
}

const rtQuarantined = () => L("set.ui.rt.quarantined", "quarantined, not run");

/**
 * Issue 456: the other copies of a runtime Den found, each with the
 * version its install says (never run) and a button that pins it
 * (agents.runtimes.<id>.bin at the scope shown).
 */
function otherCopiesHtml(r) {
  const others = r.others || [];
  if (!others.length) return "";
  const name = r.label || r.id;
  return (
    `<div class="rt-o" data-others="${escR(r.id)}">` +
    `<div class="rt-oh">${escR(L("set.ui.rt.alsoFound", "Also found:"))}</div>` +
    `<div role="list">` +
    others
      .map(
        (o) =>
          `<div class="rt-oi" role="listitem" data-copy="${escR(o.path)}">` +
          `<span class="den-mono rt-p">${escR(o.path)}</span> ` +
          `<span class="rt-ov">${escR(o.version || L("set.ui.rt.versionUnknown", "version unknown"))}</span> ` +
          `<span class="set-tag" data-src="${escR(o.source)}">${escR(rtSource(o.source))}</span>` +
          (o.quarantined
            ? ` <span class="rt-bad" data-quarantined="true">${escR(rtQuarantined())}</span>`
            : "") +
          ` <button type="button" class="btn sm" data-pin-path="${escR(r.id)}" data-bin="${escR(o.path)}" aria-label="${escR(L("set.ui.rt.useThisFor", "Use {path} for {name}", { path: o.path, name }))}">${escR(L("set.ui.rt.useThis", "Use this"))}</button>` +
          `</div>`,
      )
      .join("") +
    `</div>` +
    `<div class="rt-err" role="alert" hidden></div>` +
    `</div>`
  );
}

/** The Runtimes row: the list, a workspace selector, Set path… and Clear. */
/**
 * Issue 479: the runtime row a link opens (?runtime=<id>), and the project
 * whose paths to show (?project=<ws>, when it is one; else every project).
 */
export function runtimeFocusFrom(search, wss) {
  const p = new URLSearchParams(search || "");
  const ws = p.get("project") || "";
  return {
    runtime: p.get("runtime") || "",
    ws: (wss || []).includes(ws) ? ws : "",
  };
}

function renderRuntimes(host, ctx) {
  const wss = ctx.workspaces || [];
  const focus = runtimeFocusFrom(globalThis.location?.search, wss);
  let ws = focus.ws;
  const draw = (rows, note) => {
    host.innerHTML =
      `<div class="rt-scope"><label for="rt-ws">${escR(L("set.ui.rt.pathsFor", "Paths for"))}</label> <select id="rt-ws" data-focus-key="rt-ws">` +
      `<option value="">${escR(L("set.ui.rt.everyProject", "every project (user.yml)"))}</option>` +
      wss
        .map(
          (w) =>
            `<option value="${escR(w)}"${w === ws ? " selected" : ""}>${escR(w)} (workspaces.yml)</option>`,
        )
        .join("") +
      `</select></div>` +
      (note ? `<div class="set-note">${escR(note)}</div>` : "") +
      `<div class="rt-list" role="list">${rows.map((r) => runtimeRowHtml(r, ws)).join("")}</div>`;
  };
  const load = () => {
    // Under an invalid config the runtimes answer 422: say why, ask nothing.
    if (ctx.shell?.configInvalid?.() === true)
      return draw(
        [],
        L(
          "set.ui.rt.fixConfig",
          "Fix the config first: the runtimes are read from it.",
        ),
      );
    return ctx.shell
      .api(
        "GET",
        `/api/agents/runtimes${ws ? `?workspace=${encodeURIComponent(ws)}` : ""}`,
      )
      .then((b) => {
        // Only what has a CLI to find: generic is the persona's argv.
        draw((b?.runtimes || []).filter((r) => r.setting));
        showFocused();
      })
      .catch((e) =>
        draw(
          [],
          e?.message || L("set.ui.rt.noLoad", "The runtimes did not load."),
        ),
      );
  };
  // Issue 479: a link to a runtime's row (a refused start): scrolled to
  // and marked once.
  function showFocused() {
    if (!focus.runtime) return;
    const row = [...host.querySelectorAll(".rt[data-runtime]")].find(
      (x) => x.dataset.runtime === focus.runtime,
    );
    focus.runtime = "";
    if (!row) return;
    row.dataset.focused = "true";
    row.setAttribute("tabindex", "-1");
    row.scrollIntoView?.({ block: "center" });
    row.focus?.({ preventScroll: true });
  }
  host.addEventListener("change", (e) => {
    if (e.target.id !== "rt-ws") return;
    ws = e.target.value;
    void load();
  });
  host.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const row = b.closest(".rt");
    const form = row?.querySelector(".rt-f");
    if (b.dataset.setPath && form) {
      form.hidden = false;
      form.querySelector("input").focus();
    } else if (b.hasAttribute("data-cancel-path") && form) {
      form.hidden = true;
    } else if (b.dataset.clearPath) {
      await savePath(b.dataset.clearPath, null, form);
    } else if (b.dataset.pinPath && b.dataset.bin) {
      // Issue 456: one click pins that copy; a refusal shows under the list.
      await savePath(b.dataset.pinPath, b.dataset.bin, b.closest(".rt-o"));
    }
  });
  host.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target.closest(".rt-f");
    if (!form) return;
    const bin = form.querySelector("input").value.trim();
    if (!bin) return;
    await savePath(form.dataset.pathForm, bin, form);
  });
  async function savePath(id, bin, form) {
    const err = form?.querySelector(".rt-err");
    const btns = form ? [...form.querySelectorAll("button")] : [];
    btns.forEach((x) => (x.disabled = true));
    try {
      await ctx.shell.api(
        "POST",
        `/api/agents/runtimes/${encodeURIComponent(id)}/path`,
        {
          scope: ws ? "workspace" : "global",
          ...(ws ? { workspace: ws } : {}),
          bin,
        },
      );
      await load();
    } catch (x) {
      // Its refusal is shown here, under the field, not as a toast.
      if (err) {
        err.textContent = x?.message || L("set.ui.notSaved", "Not saved");
        err.hidden = false;
      }
    } finally {
      btns.forEach((x) => (x.disabled = false));
    }
  }
  void load();
}

/** "an agent", "a persona": the article for a lowercase noun. */
export const withArticle = (w) => `${/^[aeiou]/.test(w) ? "an" : "a"} ${w}`;

const ROT_SCOPES = [
  ["agent", "Agent", "agent id"],
  ["persona-workspace", "Persona in a project", "persona@project"],
  ["persona", "Persona", "persona id"],
  ["workspace", "Project", "project"],
  ["service", "Service", "service, as the project names it"],
];
const ROT_KEYS = [
  ["after_compactions", "After compactions", "a number, or never"],
  ["on_due", "When due", "auto, ask or off"],
  ["on_pr_merged", "When its PR merges", "true or false"],
];
const rotVal = (v) => (v === undefined ? "" : String(v));
/** A rotation scope's or setting's name in the page's language (0.4.45). */
const rotScope = (v) => {
  const x = ROT_SCOPES.find((r) => r[0] === v);
  return x ? L(`set.ui.rot.scope.${v}`, x[1]) : v;
};
const rotKey = (k) => {
  const x = ROT_KEYS.find((r) => r[0] === k);
  return x ? L(`set.ui.rot.key.${k}`, x[1]) : k;
};
const rotAuto = () => L("set.ui.rot.auto", "Auto");
const rotAsk = () => L("set.ui.rot.ask", "Ask");
const rotOff = () => L("set.ui.off", "Off");
const rotRelaunch = () => L("set.ui.rot.relaunch", "Relaunch");
const rotKeep = () => L("set.ui.rot.keep", "Keep going");
/** A value as a person reads it (D30): "never", "Auto", "Relaunch". */
function rotValText(k, v) {
  if (k === "on_due")
    return { auto: rotAuto, ask: rotAsk, off: rotOff }[v]?.() ?? rotVal(v);
  if (k === "on_pr_merged")
    return v === true ? rotRelaunch() : v === false ? rotKeep() : rotVal(v);
  return rotVal(v);
}

/**
 * D30: an override's target as a name, from the pickers' choices. One that
 * no longer exists: its id, and gone.
 */
export function rotTargetName(scope, target, c = {}) {
  const find = (list, id) => (list || []).find((x) => x.id === id);
  if (scope === "agent") {
    const a = find(c.agents, target);
    return a
      ? { name: a.workspace ? `${a.name} (${a.workspace})` : a.name }
      : { name: target, gone: true };
  }
  if (scope === "persona-workspace") {
    const [pid, ws] = String(target).split("@");
    const p = find(c.personas, pid);
    const w = find(c.workspaces, ws);
    return p && w
      ? { name: `${p.name} in ${w.name}` }
      : { name: target, gone: true };
  }
  const list =
    scope === "persona"
      ? c.personas
      : scope === "workspace"
        ? c.workspaces
        : c.services;
  const x = find(list, target);
  return x ? { name: x.name } : { name: target, gone: true };
}

/** D30: each picker's rows, from GET /api/agents/rotation?choices=1. */
export function rotPickItems(kind, c = {}) {
  if (kind === "agent")
    return (c.agents || []).map((a) => ({
      id: a.id,
      label: a.name,
      sub: [a.workspace, a.state].filter(Boolean).join(" · "),
    }));
  if (kind === "persona")
    return (c.personas || []).map((p) => ({
      id: p.id,
      label: p.name,
      sub: p.category,
    }));
  if (kind === "workspace")
    return (c.workspaces || []).map((w) => ({ id: w.id, label: w.name }));
  return (c.services || []).map((x) => ({
    id: x.id,
    label: x.name,
    sub: x.workspace,
  }));
}

/** A value typed in the overrides form, as the key takes it. */
export function rotationValue(key, raw) {
  const v = String(raw ?? "").trim();
  if (key === "after_compactions")
    return v === "never" || v === "0"
      ? "never"
      : /^\d+$/.test(v)
        ? Number(v)
        : v;
  if (key === "on_pr_merged")
    return v === "true" ? true : v === "false" ? false : v;
  return v;
}

/** The Rotation row's HTML (b: GET /api/agents/rotation). */
export function rotationHtml(b) {
  const inherited = (k) =>
    b.org?.[k] !== undefined
      ? L("set.ui.rot.org", "org config: {v}", { v: rotVal(b.org[k]) }) // words-ok: moved word for word into the catalog (0.4.45)
      : L("set.ui.rot.default", "default: {v}", {
          v: rotVal(b.defaults?.[k]),
        });
  const inst = b.install || {};
  const after = inst.after_compactions;
  const field = (k, control) =>
    `<div class="rot-f" data-rot-key="${k}"><label for="rot-${k}">${escR(rotKey(k))}</label>${control}<span class="set-tag" data-rot-src>${escR(inst[k] !== undefined ? L("set.ui.rot.install", "this install") : inherited(k))}</span></div>`;
  const sel = (k, opts) =>
    `<select id="rot-${k}" data-focus-key="rot-${k}"><option value=""${inst[k] === undefined ? " selected" : ""}>${escR(L("set.ui.rot.inherit", "inherit ({v})", { v: rotVal(b.org?.[k] !== undefined ? b.org[k] : b.defaults?.[k]) }))}</option>` +
    opts
      .map(
        ([v, l]) =>
          `<option value="${escR(v)}"${rotVal(inst[k]) === v ? " selected" : ""}>${escR(l)}</option>`,
      )
      .join("") +
    `</select>`;
  const rows = [];
  for (const [scope, byTarget] of Object.entries(b.overrides || {}))
    for (const [target, vals] of Object.entries(byTarget || {}))
      for (const [k, v] of Object.entries(vals || {})) {
        const who = rotTargetName(scope, target, b.choices);
        const setting = rotKey(k);
        rows.push(
          `<tr data-rot-row${who.gone ? " data-rot-gone" : ""}><td data-l="${escR(L("set.ui.rot.thScope", "Scope"))}">${escR(rotScope(scope))}</td>` +
            `<td data-l="${escR(L("set.ui.rot.thFor", "For"))}"${who.gone ? ' class="rot-gone"' : ""}>${who.gone ? L("set.ui.rot.gone", "{name} (gone)", { name: `<span class="den-mono">${escR(who.name)}</span>` }) : escR(who.name)}</td>` +
            `<td data-l="${escR(L("set.ui.rot.thSetting", "Setting"))}">${escR(setting)}</td><td data-l="${escR(L("set.ui.rot.thValue", "Value"))}">${escR(rotValText(k, v))}</td>` +
            `<td class="rot-act"><button type="button" class="btn sm" data-rot-clear data-scope="${escR(scope)}" data-target="${escR(target)}" data-key="${escR(k)}" aria-label="${escR(L(who.gone ? "set.ui.rot.removeX" : "set.ui.rot.clearX", who.gone ? "Remove {setting} for {name}" : "Clear {setting} for {name}", { setting, name: who.name }))}">${escR(who.gone ? L("set.ui.rot.remove", "Remove") : L("set.ui.rot.clear", "Clear"))}</button></td></tr>`,
        );
      }
  return (
    `<div class="rot" data-rotation-settings>` +
    `<div class="rot-inst">` +
    field(
      "after_compactions",
      `<input type="text" id="rot-after_compactions" data-focus-key="rot-after_compactions" inputmode="numeric" spellcheck="false" autocomplete="off" placeholder="${escR(inherited("after_compactions"))}" value="${escR(after === undefined ? "" : rotVal(after))}"> <button type="button" class="btn sm" data-rot-save-after>${escR(L("set.ui.save", "Save"))}</button>`,
    ) +
    field(
      "on_due",
      sel("on_due", [
        ["auto", rotAuto()],
        ["ask", rotAsk()],
        ["off", rotOff()],
      ]),
    ) +
    field(
      "on_pr_merged",
      sel("on_pr_merged", [
        ["true", rotRelaunch()],
        ["false", rotKeep()],
      ]),
    ) +
    `</div>` +
    `<div class="tablewrap"><table class="svc rot-ov"><caption>${escR(L("set.ui.rot.caption", "Overrides (the most specific wins)"))}</caption><thead><tr><th scope="col">${escR(L("set.ui.rot.thScope", "Scope"))}</th><th scope="col">${escR(L("set.ui.rot.thFor", "For"))}</th><th scope="col">${escR(L("set.ui.rot.thSetting", "Setting"))}</th><th scope="col">${escR(L("set.ui.rot.thValue", "Value"))}</th><th scope="col"><span class="den-sr">${escR(L("set.ui.rot.thActions", "Actions"))}</span></th></tr></thead><tbody>` +
    (rows.length
      ? rows.join("")
      : `<tr><td colspan="5" class="set-note">${escR(L("set.ui.rot.none", "No overrides: every agent uses this install's values."))}</td></tr>`) +
    `</tbody></table></div>` +
    `<form class="rot-add" data-rot-add>` +
    `<span class="rot-pick"><label for="rot-a-scope">${escR(L("set.ui.rot.thScope", "Scope"))}</label> <select id="rot-a-scope">${ROT_SCOPES.map(([v]) => `<option value="${v}">${escR(rotScope(v))}</option>`).join("")}</select></span>` +
    // The target: picked by name, never typed as an id (D30).
    `<span class="rot-pick" data-for="agent">${comboHtml({ id: "rot-a-agent", label: rotScope("agent"), placeholder: L("set.ui.rot.findAgent", "Type to find an agent") })}</span>` +
    `<span class="rot-pick" data-for="persona persona-workspace" hidden>${comboHtml({ id: "rot-a-persona", label: rotScope("persona"), placeholder: L("set.ui.rot.findPersona", "Type to find a persona") })}</span>` +
    `<span class="rot-pick" data-for="workspace persona-workspace" hidden>${comboHtml({ id: "rot-a-ws", label: rotScope("workspace"), placeholder: L("set.ui.rot.findProject", "Type to find a project") })}</span>` +
    `<span class="rot-pick" data-for="service" hidden>${comboHtml({ id: "rot-a-service", label: rotScope("service"), placeholder: L("set.ui.rot.findService", "Type to find a service") })}</span>` +
    `<span class="rot-pick"><label for="rot-a-key">${escR(L("set.ui.rot.thSetting", "Setting"))}</label> <select id="rot-a-key">${ROT_KEYS.map(([v]) => `<option value="${v}">${escR(rotKey(v))}</option>`).join("")}</select></span>` +
    `<span class="rot-pick" data-val="after_compactions"><label for="rot-a-n">${escR(L("set.ui.rot.thValue", "Value"))}</label> <input type="number" id="rot-a-n" min="1" max="100" step="1" value="3"> <label class="rot-never"><input type="checkbox" id="rot-a-never"> ${escR(L("set.ui.rot.never", "never"))}</label></span>` +
    `<span class="rot-pick" data-val="on_due" hidden><label for="rot-a-due">${escR(L("set.ui.rot.thValue", "Value"))}</label> <select id="rot-a-due"><option value="auto">${escR(rotAuto())}</option><option value="ask">${escR(rotAsk())}</option><option value="off">${escR(rotOff())}</option></select></span>` +
    `<span class="rot-pick" data-val="on_pr_merged" hidden><label for="rot-a-pr">${escR(L("set.ui.rot.thValue", "Value"))}</label> <select id="rot-a-pr"><option value="true">${escR(rotRelaunch())}</option><option value="false">${escR(rotKeep())}</option></select></span>` +
    `<button type="submit" class="btn sm primary">${escR(L("set.ui.rot.add", "Add override"))}</button></form>` +
    `<div class="rt-err" role="alert" hidden></div>` +
    `</div>`
  );
}

/** HUB-1.7: what came back from Hub's redirect (?hub=…), when the server has no words for it. */
const HUB_FLASH = {
  connected: [true, "Connected to Hub."],
  denied: [false, "Not connected: the request was declined on Hub."],
  expired: [
    false,
    "That connect link was used or too old: press Connect again.",
  ],
  failed: [false, "Connect didn't finish: press Connect again."],
};

/**
 * HUB-1.5/1.7: Settings › Hub (b: GET /api/hub; flash: what the
 * last Connect came to). Not connected: Hub's address and Connect.
 * Connected: the company (a link), role, who signed in, this install,
 * Disconnect. A token Hub refuses offers Reconnect; a role that no longer
 * may connect says to ask an admin (never a retry).
 */
/** A distribution's own note after an edition's line (no default). */
const eNote = (n) => (n ? ` ${escR(n)}` : "");

/** 0.4.45: den.yml hub_editions as lines; a line without its value goes. */
function editionsHtml(e) {
  if (!e) return "";
  const lines = [];
  if (e.teamsHost)
    lines.push(
      `<p class="set-note"><b>Den Hub for Teams:</b> ${escR(L("set.ui.hub.teams", "a shared Hub at {host}.", { host: e.teamsHost }))}${eNote(e.teamsNote)}</p>`,
    );
  if (e.enterpriseDomain)
    lines.push(
      `<p class="set-note"><b>Den Hub for Enterprise:</b> ${escR(L("set.ui.hub.ent", "your own isolated runtime, at your own domain or a unique subdomain on {domain}.", { domain: e.enterpriseDomain }))}${eNote(e.enterpriseNote)}</p>`,
    );
  if (lines.length && /^https:\/\//.test(e.talkUrl || ""))
    lines.push(
      `<p class="set-note"><a href="${escR(e.talkUrl)}" target="_blank" rel="noopener">${escR(L("set.ui.hub.talk", "Talk to us"))} ↗</a></p>`,
    );
  return lines.length ? `<div class="hub-eds">${lines.join("")}</div>` : "";
}

/**
 * issue 267: what's wrong with an address for Hub, in the person's words, or
 * null. The same rule as the server's hubUrlProblem: https, or http only
 * to this machine. Empty is fine (it clears the address).
 */
export function hubAddressProblem(v) {
  const url = String(v ?? "").trim();
  if (!url) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return L(
      "set.ui.hub.addrNotUrl",
      "That isn't a web address. It starts with https://",
    );
  }
  const local =
    ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.hostname.endsWith(".localhost");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local))
    return L(
      "set.ui.hub.addrHttps",
      "Hub's address must start with https:// (http:// only for this machine).",
    );
  return null;
}

/** issue 267: Hub's address, with Save and Clear, in every state but the first. */
function hubAddressHtml(b) {
  return (
    `<form class="hub-addr" data-hub-addr>` +
    `<label for="hub-addr">${escR(L("set.ui.hub.address", "Hub's address"))}</label> ` +
    `<input type="url" id="hub-addr" class="den-mono" spellcheck="false" autocomplete="url" placeholder="https://hub.example.com" value="${escR(b.url || "")}">` +
    ` <button type="submit" class="btn sm" data-hub-action="save-url">${escR(L("set.ui.hub.save", "Save"))}</button>` +
    (b.url
      ? ` <button type="button" class="btn sm" data-hub-action="clear-url">${escR(L("set.ui.hub.clear", "Clear"))}</button>`
      : "") +
    `</form>` +
    `<p class="set-note set-warn" data-hub-addr-problem role="status" hidden></p>` +
    `<p class="set-note" data-hub-addr-note>${escR(L("set.ui.hub.saveNote", "Save keeps it in your settings and restarts Den. Clear disconnects; agents lose Hub's tools when they next restart."))}</p>`
  );
}

export function hubHtml(b, flash, t = (k) => k) {
  b = b || { configured: false };
  const state = b.configured
    ? b.state || (b.connected ? "connected" : "no_token")
    : "no_token";
  const note = (t, attr) => `<p class="set-note" ${attr}>${escR(t)}</p>`;
  const flashHtml = flash
    ? `<p class="set-note hub-flash ${flash.ok ? "ok" : "warn"}" role="status" data-hub-flash="${flash.ok ? "ok" : "failed"}">${escR(flash.message)}</p>`
    : "";
  if (state === "bad_config")
    return (
      flashHtml +
      note(
        b.problem || L("set.ui.hub.badConfig", "hub in user.yml is not valid"),
        "data-hub-problem",
      ) +
      // issue 267: fix it here, no file to edit.
      hubAddressHtml(b) +
      `<div class="rt-err" role="alert" hidden></div>`
    );
  if (state === "no_token")
    return (
      flashHtml +
      `<form class="hub-connect" data-hub-connect>` +
      `<label for="hub-url">${escR(L("set.ui.hub.address", "Hub's address"))}</label> ` +
      `<input type="url" id="hub-url" class="den-mono" spellcheck="false" autocomplete="url" placeholder="https://hub.example.com" value="${escR(b.url || "")}">` +
      ` <button type="submit" class="btn sm primary" data-hub-action="connect">${escR(L("set.ui.hub.connect", "Connect"))}</button>` +
      ` <button type="button" class="btn sm" data-hub-action="save-url">${escR(L("set.ui.hub.save", "Save"))}</button>` +
      (b.url
        ? ` <button type="button" class="btn sm" data-hub-action="clear-url">${escR(L("set.ui.hub.clear", "Clear"))}</button>`
        : "") +
      `</form>` +
      `<p class="set-note set-warn" data-hub-addr-problem role="status" hidden></p>` +
      // issue 267: with no Hub yet, what it is.
      (b.url
        ? ""
        : `<p class="set-note" data-hub-empty>${escR(L("set.ui.hub.empty", "No Hub yet. Type your company's Hub address, then Connect. Save only keeps the address."))}</p>`) +
      `<p class="set-note" data-hub-connect-does>${escR(L("set.ui.hub.connectLinks", "Connect also links each project here to its Hub project. Where Den can't tell which fits, it asks you."))}</p>` +
      `<p class="set-note">${escR(L("set.ui.hub.connectNote", "Connect opens Hub. Sign in there and approve this install; you come back here connected. The token is kept in this install's secrets store, never shown."))}</p>` +
      // 0.4.45: the two editions, until this install is connected, where
      // the distribution says they are. The names stay in English.
      editionsHtml(b.editions) +
      (b.problem && b.url && !/^not connected yet/.test(b.problem)
        ? note(b.problem, "data-hub-problem")
        : "") +
      `<div class="rt-err" role="alert" hidden></div>`
    );
  const status = {
    connected: ["ok", L("set.ui.hub.connected", "Connected")],
    rejected: ["warn", L("set.ui.hub.rejected", "Token not accepted")],
    forbidden: ["warn", L("set.ui.hub.forbidden", "Not allowed")],
    unreachable: ["warn", L("set.ui.hub.unreachable", "Can't reach Hub")],
  }[state] || ["warn", L("set.ui.hub.notConnected", "Not connected")];
  const team = b.team
    ? b.teamUrl && /^https?:\/\//i.test(b.teamUrl)
      ? // D51: Den → Hub is a plain link, in this tab (⌘-click: a new one).
        `<a href="${escR(b.teamUrl)}">${escR(b.team)}</a>`
      : escR(b.team)
    : "";
  const rows = [
    ["Hub", `<span class="den-mono">${escR(b.url || "")}</span>`],
    [
      L("set.ui.hub.status", "Status"),
      `<span class="set-tag ${status[0]}" data-hub-state="${escR(state)}">${escR(status[1])}</span>`,
    ],
    ...(team ? [[L("set.ui.hub.company", "Company"), team]] : []),
    ...(b.role ? [[L("set.ui.hub.role", "Role"), escR(b.role)]] : []),
    ...(b.login
      ? [[L("set.ui.hub.signedInAs", "Signed in as"), escR(b.login)]]
      : []),
    ...(b.label
      ? [[L("set.ui.hub.thisInstall", "This install"), escR(b.label)]]
      : []),
  ];
  const why =
    state === "rejected"
      ? L(
          "set.ui.hub.whyRejected",
          "Hub no longer accepts this install's token (revoked or expired). Reconnect signs you in again.",
        )
      : state === "forbidden"
        ? L(
            "set.ui.hub.whyForbidden",
            "Your role on Hub no longer allows connecting installs. Ask a Hub admin to change your role, then Reconnect.",
          )
        : state === "unreachable"
          ? b.problem || L("set.ui.hub.noAnswer", "Hub didn't answer.")
          : // #71: a token Den can't replace itself; Reconnect moves it over.
            b.legacy
            ? t("hub.legacy")
            : "";
  const tools =
    `<label class="hub-tools"><input type="checkbox" id="hub-allow-tools"${b.allowTools !== false ? " checked" : ""}> ${escR(L("set.ui.hub.tools", "Agents use Hub's tools without asking"))}</label>` +
    `<p class="set-note" data-hub-tools-note>${escR(
      b.allowTools !== false
        ? L(
            "set.ui.hub.toolsOn",
            "Agents can publish and comment in Hub without asking; writes are versioned and stay in this install's team.", // words-ok: moved word for word into the catalog (0.4.45)
          )
        : L("set.ui.hub.toolsOff", "Agents ask before each Hub tool runs."),
    )}</p>`;
  return (
    flashHtml +
    hubAddressHtml(b) +
    `<dl class="hub-st" data-hub>` +
    rows.map(([k, v]) => `<dt>${escR(k)}</dt><dd>${v}</dd>`).join("") +
    `</dl>` +
    (why ? note(why, "data-hub-problem") : "") +
    `<div class="hub-acts">` +
    (state === "rejected" || b.legacy
      ? `<button type="button" class="btn sm primary" data-hub-action="connect">${escR(t("hub.reconnect"))}</button> `
      : "") +
    `<button type="button" class="btn sm" data-hub-action="disconnect">${escR(L("set.ui.hub.disconnect", "Disconnect"))}</button>` +
    `</div>` +
    // Disconnect asks first, saying what it does (Hub revokes the key).
    `<div class="hub-confirm" data-hub-confirm hidden>` +
    `<p class="set-note set-warn">${escR(L("set.ui.hub.disconnectWarn", "This revokes this Den's Hub key on Hub. Agents lose Hub until you Connect again."))}</p>` +
    `<button type="button" class="btn sm primary" data-hub-action="disconnect-yes">${escR(L("set.ui.hub.disconnect", "Disconnect"))}</button> ` +
    `<button type="button" class="btn sm" data-hub-action="disconnect-no">${escR(L("set.ui.cancel", "Cancel"))}</button>` +
    `</div>` +
    `<div class="rt-err" role="alert" hidden></div>` +
    tools
  );
}

/**
 * issue 267: Hub's address. The check as you type; Save writes it to your
 * settings and restarts Den, then the row says where it stands. Clear
 * disconnects first (Hub revokes the key; unreachable, it's removed here
 * anyway), clears it and restarts.
 */
function wireHubAddress(host, ctx, err, busy) {
  const input =
    host.querySelector("#hub-addr") || host.querySelector("#hub-url");
  const problem = host.querySelector("[data-hub-addr-problem]");
  const save = host.querySelector('[data-hub-action="save-url"]');
  const clear = host.querySelector('[data-hub-action="clear-url"]');
  if (!input || !save) return;
  const check = () => {
    const p = hubAddressProblem(input.value);
    if (problem) {
      problem.hidden = !p;
      problem.textContent = p || "";
    }
    save.disabled = !!p || !input.value.trim();
    return p;
  };
  input.addEventListener("input", check);
  check();
  const t = (k, v) => ctx.shell.t(k, v);
  const connected = !!host.querySelector("[data-hub]");
  const was = input.defaultValue.trim().replace(/\/+$/, "");
  // One working pop-up for the whole step. Connected and moving away: the
  // old Hub revokes its token first (unreachable: removed here anyway; the
  // server drops a token whose address changed too). Then the address.
  const apply = async (url, button) => {
    busy(true);
    err("");
    try {
      const r = await ctx.shell.busyAction(
        "save",
        async (headers) => {
          if (connected && url !== was)
            await ctx.shell
              .api("POST", "/api/hub/disconnect", {}, { headers })
              .catch(() =>
                ctx.shell.api(
                  "POST",
                  "/api/hub/disconnect",
                  { force: true },
                  { headers },
                ),
              )
              .catch(() => undefined);
          return ctx.shell.api(
            "POST",
            "/api/settings",
            { hub_url: url },
            { headers },
          );
        },
        { button, onFail: (e) => err(e?.message || t("busy.saveF")) },
      );
      if (!r) return busy(false);
      // Den reads Hub's address at start: restart it, and wait.
      await restartDen({ confirm: false, from: "settings" });
      await drawHub(host, ctx, null, {
        ok: true,
        message: url
          ? L(
              "set.ui.hub.saved",
              "Saved. Den restarted with Hub's new address.",
            )
          : L("set.ui.hub.cleared", "Cleared. Den restarted without Hub."),
      });
    } catch (e) {
      busy(false);
      err(e?.message || t("busy.saveF"));
    }
  };
  const submit = (ev) => {
    ev?.preventDefault?.();
    if (check()) return;
    void apply(input.value.trim().replace(/\/+$/, ""), save);
  };
  save.addEventListener("click", submit);
  host.querySelector("[data-hub-addr]")?.addEventListener("submit", submit);
  clear?.addEventListener("click", () => void apply(null, clear));
}

/**
 * D44: running agents whose tools predate Hub's Connect or Disconnect
 * (from GET /api/agents/stale), and the offer to restart them at their
 * next idle, each keeping its conversation. "" when there are none.
 */
export function restartOfferHtml(agents) {
  const n = Array.isArray(agents) ? agents.length : 0;
  if (!n) return "";
  const adds = agents.some((a) => a?.stale?.adds?.length);
  const who = n === 1 ? "1 agent" : `${n} agents`;
  const what = adds
    ? `${who} started before Hub was connected, so ${n === 1 ? "it doesn't" : "they don't"} have Hub's tools yet.`
    : `${who} started while Hub was connected, so ${n === 1 ? "it still lists" : "they still list"} Hub's tools.`;
  return (
    `<div class="hub-restart" data-hub-restart="${n}">` +
    `<p class="set-note">${escR(what)} A restart keeps each conversation and never cuts a turn.</p>` +
    `<button type="button" class="btn sm primary" data-hub-action="restart-stale">Restart ${escR(who)} at ${n === 1 ? "its" : "their"} next idle</button>` +
    `</div>`
  );
}

function offerRestart(host, ctx, fresh) {
  return ctx.shell
    .api("GET", `/api/agents/stale${fresh ? "?fresh=1" : ""}`)
    .then((r) => {
      const html = restartOfferHtml(r?.agents);
      if (!html) return;
      host.insertAdjacentHTML("beforeend", html);
      const box = host.querySelector("[data-hub-restart]");
      const btn = box?.querySelector('[data-hub-action="restart-stale"]');
      btn?.addEventListener("click", () => {
        btn.disabled = true;
        ctx.shell
          .api("POST", "/api/agents/restart-stale", {})
          .then((x) => {
            const k = Array.isArray(x?.pending) ? x.pending.length : 0;
            box.innerHTML = `<p class="set-note" role="status" data-hub-restarting="${k}">${escR(
              k === 1
                ? "1 agent restarts at its next idle, in the same conversation."
                : `${k} agents restart at their next idle, each in the same conversation.`,
            )}</p>`;
          })
          .catch((e) => {
            btn.disabled = false;
            box.insertAdjacentHTML(
              "beforeend",
              `<p class="set-note set-warn" role="alert">${escR(e?.message || "Not restarted")}</p>`,
            );
          });
      });
    })
    .catch(() => undefined);
}

/** Read and clear ?hub=… (set by Hub's redirect back through /hub/callback). */
function takeHubFlash() {
  try {
    const u = new URL(location.href);
    const v = u.searchParams.get("hub");
    if (!v) return null;
    u.searchParams.delete("hub");
    history.replaceState(history.state, "", u.pathname + u.search + u.hash);
    return v;
  } catch {
    return null;
  }
}

/** HUB-1.5/1.7: the Hub row: always shown, so a person can Connect. */
/**
 * H5: Settings › Project setup › Hub project (hubProjectHtml has its
 * states). Nothing is linked until the person presses Link or Switch, and
 * Unlink asks first.
 */
const PMODES = ["none", "ask", "edits", "auto", "all"];

const DW_MODES = ["persona", "ask", "edits", "auto", "all"];

/** Issue 268: a mode's words in the status lines (none: each persona's). */
const modeWords = (m, t) =>
  m && m !== "persona" ? t(`pm.${m}`) : t("dwmode.persona");

/**
 * Issue 268: Settings › Agents › the Den-wide default. `v` is its value
 * ("persona": unset); `overrides` the projects that override it
 * (agents_mode_overrides), each a link to its own row.
 */
export function denWideModeHtml(v, overrides, t) {
  const now = DW_MODES.includes(v) ? v : "persona";
  const btns = DW_MODES.map(
    (m) =>
      `<button type="button" data-dwmode="${m}" aria-pressed="${m === now}">${escR(t(`set.agents.default_mode.o.${m}`))}</button>`,
  ).join("");
  const list = Array.isArray(overrides) ? overrides : [];
  const over = list.length
    ? `${escR(t("dwmode.over", { n: list.length }))} ` +
      list
        .map(
          (ws) =>
            `<a href="/settings?project=${encodeURIComponent(ws)}#workspace.agents_mode">${escR(ws)}</a>`,
        )
        .join(", ")
    : escR(t("dwmode.overNone"));
  return (
    `<div class="seg" role="group" data-dwmode-seg aria-label="${escR(t("set.agents.default_mode"))}">${btns}</div>` +
    `<p class="set-note" data-dw-now>${escR(t("dwmode.now", { m: modeWords(now, t) }))}</p>` +
    `<p class="set-note" data-dw-overrides="${list.length}">${over}</p>`
  );
}

function renderDenWideMode(host, ctx, api) {
  const t = (k, v) => ctx.shell.t(k, v);
  host.innerHTML = denWideModeHtml(
    api?.value,
    ctx.data?.agents_mode_overrides,
    t,
  );
  host.querySelectorAll("[data-dwmode]").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.getAttribute("aria-pressed") === "true") return;
      api?.save(b.getAttribute("data-dwmode"));
    }),
  );
}

/**
 * Issue 225: Settings › Project › Agents' mode. `v` is GET
 * /api/workspaces/:ws/agent-modes: { mode, install, agents, own }. The
 * project's mode as buttons; each agent's mode and where it comes from
 * ("runs as Ask until restarted" when its process differs); and, when
 * agents have their own setting, the offer to make them follow.
 */
export function projectModeHtml(v, t) {
  const now = v?.mode ?? "none";
  const name = (m) => t(`pm.name.${m}`);
  const btns = PMODES.map(
    (m) =>
      `<button type="button" data-pmode="${m}" aria-pressed="${m === now}">${escR(m === "none" ? t("pmode.none") : t(`pm.${m}`))}</button>`,
  ).join("");
  const agents = Array.isArray(v?.agents) ? v.agents : [];
  const rows = agents
    .map((a) => {
      const vars = {
        name: a.name || a.agent,
        m: name(a.mode),
        src: t(`ag.mode.src.${a.source}`),
      };
      const line = a.running
        ? t("pmode.runsAs", { ...vars, running: name(a.running) })
        : t("pmode.agent", vars);
      // Issue 252: the whole row opens its mode (the choices and Follow
      // project).
      return (
        `<li data-pmode-agent="${escR(a.agent)}" data-pmode-source="${escR(a.source)}"${a.running ? ` data-pmode-running="${escR(a.running)}"` : ""}>` +
        `<button type="button" class="pmode-row" data-pmode-pick="${escR(a.agent)}" aria-haspopup="menu" aria-expanded="false" aria-label="${escR(`${line}. ${t("ag.mode.pick", { id: a.name || a.agent })}`)}">` +
        escR(line) +
        (a.stopped
          ? ` <span class="faint">${escR(t("pmode.stopped"))}</span>`
          : "") +
        `</button></li>`
      );
    })
    .join("");
  const n = Number(v?.own) || 0;
  const offer = n
    ? `<div data-pmode-offer="${n}"><button type="button" class="btn sm primary" data-pmode-follow>${escR(t("pmode.follow", { n }))}</button></div>`
    : "";
  // Issue 268: what is in effect for this project, and where from.
  const dw = modeWords(v?.install, t);
  const status = v?.mode
    ? t("pmode.setHere", { m: modeWords(v.mode, t), dw })
    : t("pmode.following", { m: dw });
  return (
    `<div class="seg" role="group" data-pmode-seg aria-label="${escR(t("set.workspace.agents_mode"))}">${btns}</div>` +
    `<p class="set-note"><span data-pmode-now="${v?.mode ? "project" : "den-wide"}">${escR(status)}</span> ` +
    `<a href="/settings#agents.default_mode" data-pmode-dw>${escR(t("pmode.changeDw"))}</a></p>` +
    (agents.length
      ? `<ul class="set-note" data-pmode-list>${rows}</ul>`
      : `<p class="set-note" data-pmode-none>${escR(t("pmode.noAgents"))}</p>`) +
    offer +
    `<div class="rt-err" role="alert" hidden></div>`
  );
}

function renderProjectMode(host, ctx) {
  const ws = ctx.workspace;
  if (!ws || ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  const url = `/api/workspaces/${encodeURIComponent(ws)}/agent-modes`;
  const fail = (e, fallback) => {
    const err = host.querySelector(".rt-err");
    if (!err) return;
    err.hidden = false;
    err.textContent = e?.message || fallback;
  };
  const post = (kind, body, button) =>
    ctx.shell.busyAction(
      kind,
      (headers) => ctx.shell.api("POST", url, body, { headers }),
      {
        button,
        ...(kind === "save" ? { toastFast: false } : {}),
        onFail: (e) =>
          fail(e, t(kind === "save" ? "busy.saveF" : "pmode.followF")),
      },
    );
  return ctx.shell
    .api("GET", url)
    .then((v) => {
      host.innerHTML = projectModeHtml(v, t);
      host.querySelectorAll("[data-pmode]").forEach((b) =>
        b.addEventListener("click", () => {
          const m = b.getAttribute("data-pmode");
          if (m === (v?.mode ?? "none")) return;
          return post("save", { mode: m === "none" ? null : m }, b).then(
            (r) => {
              if (r !== undefined && r !== null)
                return renderProjectMode(host, ctx);
            },
          );
        }),
      );
      host.querySelectorAll("[data-pmode-pick]").forEach((b) =>
        b.addEventListener("click", () => {
          const a = (v?.agents ?? []).find(
            (x) => x.agent === b.getAttribute("data-pmode-pick"),
          );
          if (!a) return;
          openAgentModeMenu(
            b,
            {
              workspace: ws,
              agent: a.agent,
              ...(a.name ? { name: a.name } : {}),
              ...(a.source === "own" ? { own: a.mode } : {}),
              ...((v?.mode ?? v?.install)
                ? { project: v.mode ?? v.install }
                : {}),
              ...(a.stopped ? { stopped: true } : {}),
            },
            () => renderProjectMode(host, ctx),
          );
        }),
      );
      const follow = host.querySelector("[data-pmode-follow]");
      follow?.addEventListener("click", () =>
        post("follow-project", { follow: true }, follow).then((r) => {
          if (r !== undefined && r !== null)
            return renderProjectMode(host, ctx);
        }),
      );
    })
    .catch((e) => {
      host.innerHTML = `<p class="set-note" data-pmode-error>${escR(e?.message || t("pmode.failed"))}</p>`;
    });
}

/**
 * Issue 335: Settings › Project › Agents' extra MCP servers. `v` is GET
 * /api/workspaces/:ws/mcp-servers: { servers: [{ name, url }] }. Issue
 * 352: each row has Change (its url, or its bearer's secrets.refs name)
 * and Remove; a bearer's name is never shown, and a value never asked.
 */
export function projectMcpHtml(v, t) {
  const servers = Array.isArray(v?.servers) ? v.servers : [];
  if (!servers.length)
    return `<p class="set-note" data-pmcp-none>${escR(t("pmcp.none"))}</p>`;
  return (
    `<ul class="set-note" data-pmcp-list>` +
    servers
      .map((sv) => {
        const n = escR(sv.name);
        return (
          `<li data-pmcp="${n}"><span data-pmcp-text>${escR(t("pmcp.row", { name: sv.name, url: sv.url }))}</span> ` +
          `<button type="button" class="btn sm" data-pmcp-edit="${n}" aria-label="${escR(t("pmcp.editL", { name: sv.name }))}">${escR(t("pmcp.edit"))}</button> ` +
          `<button type="button" class="btn sm" data-pmcp-remove="${n}" aria-label="${escR(t("pmcp.removeL", { name: sv.name }))}">${escR(t("pmcp.remove"))}</button>` +
          `<div data-pmcp-form="${n}" hidden><div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">` +
          `<label>${escR(t("pmcp.url"))} <input type="url" spellcheck="false" autocomplete="off" data-pmcp-url value="${escR(sv.url)}"></label>` +
          `<label>${escR(t("pmcp.bearer"))} <input type="text" spellcheck="false" autocomplete="off" data-pmcp-bearer placeholder="${escR(t("pmcp.bearerKeep"))}"></label>` +
          `<label><input type="checkbox" data-pmcp-nobearer> ${escR(t("pmcp.noBearer"))}</label>` +
          `<button type="button" class="btn sm primary" data-pmcp-save>${escR(t("pmcp.save"))}</button>` +
          `<button type="button" class="btn sm" data-pmcp-cancel>${escR(t("pmcp.cancel"))}</button>` +
          `</div></div></li>`
        );
      })
      .join("") +
    `</ul>` +
    `<div class="rt-err" role="alert" hidden></div>`
  );
}

/**
 * Issue 459: Settings › Project setup › App event feeds, as GET
 * /api/workspaces/:ws/event-feeds serves them: each feed's name, agent,
 * address and state, with its last event's time. `fmt`: a time's words.
 */
export function appFeedsHtml(v, t, fmt = (ms) => new Date(ms).toISOString()) {
  const feeds = Array.isArray(v?.feeds) ? v.feeds : [];
  const problems = Array.isArray(v?.problems) ? v.problems : [];
  const STATES = [
    "connecting",
    "connected",
    "retrying",
    "no_secret",
    "over_limit",
    "no_agent",
    "stopped",
  ];
  const rows = feeds.map((f) => {
    const state = STATES.includes(f.state) ? f.state : "connecting";
    const last =
      typeof f.last_event_at === "number"
        ? t("feed.last", { time: fmt(f.last_event_at) })
        : t("feed.noEvents");
    const waiting = f.unread > 0 ? ` ${t("feed.unread", { n: f.unread })}` : "";
    return (
      `<li data-feed="${escR(f.name)}" data-feed-state="${escR(state)}">` +
      `<span data-feed-text>${escR(t("feed.row", { name: f.name, agent: f.agent, url: f.url }))}</span> ` +
      `<strong data-feed-st>${escR(t(`feed.st.${state}`))}</strong>` +
      ` <span data-feed-last>${escR(last)}${escR(waiting)}</span></li>`
    );
  });
  const list = rows.length
    ? `<ul class="set-note" data-feed-list>${rows.join("")}</ul>`
    : `<p class="set-note" data-feed-none>${escR(t("feed.none"))}</p>`;
  const bad = problems.length
    ? `<p class="set-note" data-feed-problems>${escR(t("feed.problems", { n: problems.length }))}</p>` +
      `<ul class="set-note">${problems.map((p) => `<li>${escR(p)}</li>`).join("")}</ul>`
    : "";
  return list + bad;
}

function renderAppFeeds(host, ctx) {
  const ws = ctx.workspace;
  if (!ws || ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  return ctx.shell
    .api("GET", `/api/workspaces/${encodeURIComponent(ws)}/event-feeds`)
    .then((v) => {
      host.innerHTML = appFeedsHtml(v, t, (ms) =>
        formatTime(new Date(ms).toISOString()),
      );
    })
    .catch(() => {
      host.innerHTML = `<p class="set-note">${escR(t("feed.failed"))}</p>`;
    });
}

function renderProjectMcp(host, ctx) {
  const ws = ctx.workspace;
  if (!ws || ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  const base = `/api/workspaces/${encodeURIComponent(ws)}/mcp-servers`;
  const fail = (e, fallback) => {
    const err = host.querySelector(".rt-err");
    if (!err) return;
    err.hidden = false;
    err.textContent = e?.message || fallback;
  };
  // Issue 352: a person's own click is the decision; the server checks
  // it as the held writes are, and answers the list as it is now.
  const send = (kind, method, name, body, button) =>
    ctx.shell
      .busyAction(
        kind,
        (headers) =>
          ctx.shell.api(method, `${base}/${encodeURIComponent(name)}`, body, {
            headers,
          }),
        {
          button,
          onFail: (e) =>
            fail(e, t(kind === "save" ? "busy.saveF" : "pmcp.rmF")),
        },
      )
      .then((r) => {
        if (r !== undefined && r !== null) return renderProjectMcp(host, ctx);
      });
  return ctx.shell
    .api("GET", base)
    .then((v) => {
      host.innerHTML = projectMcpHtml(v, t);
      host.querySelectorAll("[data-pmcp-edit]").forEach((b) =>
        b.addEventListener("click", () => {
          const name = b.getAttribute("data-pmcp-edit");
          const form = host.querySelector(
            `[data-pmcp-form="${CSS.escape(name)}"]`,
          );
          if (!form) return;
          form.hidden = !form.hidden;
          if (!form.hidden) form.querySelector("[data-pmcp-url]")?.focus();
        }),
      );
      host.querySelectorAll("[data-pmcp-form]").forEach((form) => {
        const name = form.getAttribute("data-pmcp-form");
        const cur = (Array.isArray(v?.servers) ? v.servers : []).find(
          (s) => s.name === name,
        );
        form
          .querySelector("[data-pmcp-cancel]")
          ?.addEventListener("click", () => {
            form.hidden = true;
          });
        const save = form.querySelector("[data-pmcp-save]");
        save?.addEventListener("click", () => {
          const url = form.querySelector("[data-pmcp-url]").value.trim();
          const bearer = form.querySelector("[data-pmcp-bearer]").value.trim();
          const none = form.querySelector("[data-pmcp-nobearer]").checked;
          const body = {
            ...(url && url !== cur?.url ? { url } : {}),
            ...(none ? { bearer: null } : bearer ? { bearer } : {}),
          };
          if (!Object.keys(body).length) {
            form.hidden = true;
            return;
          }
          return send("save", "POST", name, body, save);
        });
      });
      host.querySelectorAll("[data-pmcp-remove]").forEach((b) =>
        b.addEventListener("click", async () => {
          const name = b.getAttribute("data-pmcp-remove");
          const { askConfirm } = await import("/dialog-den.js");
          const ok = await askConfirm({
            title: t("pmcp.rmT"),
            message: t("pmcp.rmAsk", { name, project: ws }),
            okLabel: t("pmcp.remove"),
            danger: true,
          });
          if (!ok) return;
          return send("remove-mcp", "DELETE", name, undefined, b);
        }),
      );
    })
    .catch((e) => {
      host.innerHTML = `<p class="set-note" data-pmcp-error>${escR(e?.message || t("pmcp.failed"))}</p>`;
    });
}

function renderHubProject(host, ctx) {
  const ws = ctx.workspace;
  if (!ws || ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  const url = `/api/workspaces/${encodeURIComponent(ws)}/hub-project`;
  const name = (p) =>
    p.name === p.slug ? escR(p.slug) : `${escR(p.name)} (${escR(p.slug)})`;
  return ctx.shell
    .api("GET", url)
    .then((b) => {
      host.innerHTML = hubProjectHtml(b, t, name);
      wireHubProject(host, ctx, url, t, b);
    })
    .catch((e) => {
      host.innerHTML = `<p class="set-note" data-hubp-error>${escR(e?.message || t("hubp.failed"))}</p>`;
    });
}

/** 0.4.45: Navigation › Project order: its state, Reset, and where to move. */
export function projectOrderHtml(custom, t, href = "/local-dev") {
  return (
    `<div data-porder data-porder-state="${custom ? "mine" : "az"}">` +
    `<p class="set-status">${escR(t(custom ? "ws.order.mine" : "ws.order.az"))}</p>` +
    (custom
      ? `<button type="button" class="btn sm" data-porder-reset>${escR(t("ws.order.reset"))}</button> `
      : "") +
    `<a href="${escR(href)}">${escR(t("ws.manage"))}</a>` +
    `<div class="rt-err" role="alert" hidden></div></div>`
  );
}

function renderProjectOrder(host, ctx) {
  const t = (k, v) => ctx.shell.t(k, v);
  const custom =
    Array.isArray(ctx.data?.shell?.projectOrder) &&
    ctx.data.shell.projectOrder.length > 0;
  host.innerHTML = projectOrderHtml(custom, t);
  host.querySelector("[data-porder-reset]")?.addEventListener("click", () =>
    Promise.resolve(ctx.post({ shell: { projectOrder: null } }))
      .then((ok) => {
        if (!ok) throw new Error(t("pname.failed"));
        if (ctx.data?.shell) ctx.data.shell.projectOrder = [];
        return renderProjectOrder(host, ctx);
      })
      .catch((e) => {
        const err = host.querySelector(".rt-err");
        if (err) {
          err.hidden = false;
          err.textContent = e?.message || t("pname.failed");
        }
      }),
  );
  return Promise.resolve();
}

/** The longest project name Settings takes (mock v5). */
const PNAME_MAX = 60;

/**
 * 0.4.45: a typed project name, checked: trimmed, 1 to 60 characters, and
 * not the name it has now.
 */
export function projectNameCheck(raw, current) {
  const name = String(raw ?? "").trim();
  if (!name) return { ok: false, why: "empty" };
  if (name.length > PNAME_MAX) return { ok: false, why: "long" };
  if (name === String(current ?? "").trim()) return { ok: false, why: "same" };
  return { ok: true, name };
}

/**
 * Issue 167 (mock v6 A6): whether Hub's names are stale: Den's last check
 * of them failed, after the last that worked. "never": Hub never answered.
 * Else the whole minutes since Hub last answered.
 */
export function hubNamesStale(check, now = Date.now()) {
  const ok = Date.parse(check?.okAt ?? "");
  const fail = Date.parse(check?.failAt ?? "");
  if (Number.isNaN(fail) || (!Number.isNaN(ok) && ok >= fail)) return null;
  if (Number.isNaN(ok)) return "never";
  return Math.max(0, Math.round((now - ok) / 60000));
}

/**
 * 0.4.45 Settings › Project setup › Name (mock v5 A1, A4). `p` is
 * { slug, cfg, check?, now? } with cfg the project's workspaces.yml entry
 * and check GET /api/hub/names-check's answer. Linked to Hub: Hub's name,
 * read-only, "Named in Hub" in words; Hub not reachable (issue 167, A6):
 * how old the name is, and Try again. Not linked: an input and Save name,
 * off until the name changed.
 */
export function projectNameHtml(p, t) {
  const hub = p?.cfg?.hub_project?.name;
  if (typeof hub === "string" && hub.trim()) {
    const stale = hubNamesStale(p?.check, p?.now ?? Date.now());
    const offline =
      stale === null
        ? ""
        : `<p class="set-status" data-pname-offline><span class="rt-dot warn"></span> ${escR(
            stale === "never"
              ? t("pname.offlineNever")
              : t("pname.offline", { n: stale }),
          )}</p>` +
          `<button type="button" class="btn sm" data-pname-retry>${escR(t("pname.retry"))}</button>`;
    // Issue 167 (A3): a rename asked of Hub, waiting there. Withdraw
    // waits on mo-den-hub issue 72 (Hub has no API to take it back yet).
    const ask = p?.cfg?.hub_rename;
    const waiting =
      ask && typeof ask.to === "string" && ask.to
        ? `<div class="pname-held" data-pname-pending><p class="set-status"><span class="rt-dot warn"></span> ${escR(t("pname.pending", { to: ask.to }))}</p>` +
          (typeof ask.url === "string" && /^https?:\/\//.test(ask.url)
            ? `<a class="btn sm" href="${escR(ask.url)}" target="_blank" rel="noopener noreferrer" data-pname-open>${escR(t("pname.openHub"))}</a>`
            : "") +
          `</div>`
        : "";
    const off = waiting || stale !== null;
    return (
      `<div data-pname data-pname-state="hub">` +
      `<p class="set-note">${escR(t("pname.hubHelp"))}</p>` +
      `<p class="set-status pname-nm"><strong data-pname-value>${escR(hub.trim())}</strong> ` +
      `<span class="pname-chip" data-pname-chip><i aria-hidden="true"></i>${escR(t("pname.hubChip"))}</span> ` +
      `<button type="button" class="btn sm" data-pname-rename${off ? " disabled" : ""}>${escR(t("pname.rename"))}</button></p>` +
      `<div data-pname-slot></div>` +
      waiting +
      offline +
      `</div>`
    );
  }
  const own =
    typeof p?.cfg?.name === "string" && p.cfg.name.trim()
      ? p.cfg.name.trim()
      : String(p?.slug ?? "");
  return (
    `<form data-pname data-pname-state="local" class="pname-form">` +
    `<input id="pname-in" type="text" aria-label="${escR(t("pname.label"))}" data-pname-input value="${escR(own)}" maxlength="${PNAME_MAX}" autocomplete="off"> ` +
    `<button type="submit" class="btn sm primary" data-pname-save disabled>${escR(t("pname.save"))}</button>` +
    `<p class="set-note">${escR(t("pname.localHelp"))}</p>` +
    `<div class="rt-err" role="alert" data-pname-err hidden></div>` +
    `<p class="set-note" role="status" data-pname-ok hidden>${escR(t("pname.saved"))}</p></form>`
  );
}

/**
 * Issue 167 (mock v6 A2): Rename for a linked project: a new name, sent to
 * Hub as a held change; the name here stays until a person approves it.
 */
export function pnameRenameHtml(current, t) {
  return (
    `<form class="pname-held" data-pname-ask-form novalidate>` +
    `<label for="pname-new">${escR(t("pname.newName"))}</label>` +
    `<input id="pname-new" type="text" value="${escR(current)}" maxlength="${PNAME_MAX}" autocomplete="off" aria-describedby="pname-new-help">` +
    `<p class="set-note" id="pname-new-help">${escR(t("pname.askHelp"))}</p>` +
    `<div class="rt-err" role="alert" data-pname-ask-err hidden></div>` +
    `<div class="pname-acts"><button type="submit" class="btn sm primary" data-pname-ask>${escR(t("pname.ask"))}</button>` +
    `<button type="button" class="btn sm" data-pname-cancel>${escR(t("pname.cancel"))}</button></div>` +
    `</form>`
  );
}

/** Issue 167: Rename… opens the form; Ask Hub to rename sends it. */
function wireHubRename(host, ctx, ws, current, t) {
  const btn = host.querySelector("[data-pname-rename]");
  const slot = host.querySelector("[data-pname-slot]");
  if (!btn || !slot) return;
  const close = () => {
    slot.innerHTML = "";
    btn.hidden = false;
    btn.focus();
  };
  btn.addEventListener("click", () => {
    btn.hidden = true;
    slot.innerHTML = pnameRenameHtml(current, t);
    const form = slot.querySelector("form");
    const input = form.querySelector("input");
    const err = form.querySelector("[data-pname-ask-err]");
    const say = (msg) => {
      err.hidden = !msg;
      err.textContent = msg || "";
    };
    input.focus();
    input.select();
    form.querySelector("[data-pname-cancel]").addEventListener("click", close);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const c = projectNameCheck(input.value, current);
      if (!c.ok) {
        if (c.why === "empty") say(t("pname.empty"));
        else if (c.why === "same") close();
        return;
      }
      say("");
      const ask = form.querySelector("[data-pname-ask]");
      ctx.shell
        .busyAction(
          "ask-hub",
          (headers) =>
            ctx.shell.api(
              "POST",
              `/api/workspaces/${encodeURIComponent(ws)}/hub-rename`,
              { name: c.name },
              { headers },
            ),
          {
            button: ask,
            vars: { name: c.name },
            onFail: (x) => say(x?.message || t("pname.askF")),
          },
        )
        .then((r) => {
          if (r !== undefined) return renderProjectName(host, ctx);
        });
    });
  });
}

/**
 * Issue 168: Settings › Project setup › Colour: the project's dot and its
 * colour's name (Automatic, or the one chosen), and Change colour, which
 * opens the same choice as Manage projects.
 */
export function projectColourHtml(data, slug, t) {
  const c = projectColour(data, slug);
  if (!c) return "";
  const said = chosenColour(data, slug)
    ? t(`pc.${c}`)
    : t("pc.autoIs", { colour: t(`pc.${c}`) });
  return (
    `<span class="pcp-now" data-pc-now data-pc="${escR(c)}"><span class="den-pc" aria-hidden="true"></span><span data-pc-said>${escR(said)}</span></span> ` +
    `<button type="button" class="den-btn sm" data-pc-change>${escR(t("pc.change"))}</button>`
  );
}

function renderProjectColour(host, ctx) {
  const ws = ctx.workspace;
  if (!ws || ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  return ctx.shell.api("GET", "/api/workspaces").then((data) => {
    host.innerHTML = projectColourHtml(data, ws, t);
    const btn = host.querySelector("[data-pc-change]");
    btn?.addEventListener("click", () =>
      pickProjectColour({
        slug: ws,
        name: projectLabel(data, ws),
        data,
        opener: btn,
      }).then((saved) => {
        if (saved) return renderProjectColour(host, ctx);
      }),
    );
  });
}

function renderProjectName(host, ctx) {
  const ws = ctx.workspace;
  if (!ws || ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  return ctx.shell
    .api("GET", "/api/workspaces")
    .then((b) => {
      const cfg = b?.workspaces?.[ws] ?? {};
      // Issue 167: linked, when Hub last answered (A6).
      return cfg?.hub_project
        ? ctx.shell
            .api("GET", "/api/hub/names-check")
            .catch(() => null)
            .then((check) => ({ cfg, check }))
        : { cfg, check: null };
    })
    .then(({ cfg, check }) => {
      host.innerHTML = projectNameHtml({ slug: ws, cfg, check }, t);
      wireHubRename(host, ctx, ws, cfg?.hub_project?.name ?? "", t);
      const retry = host.querySelector("[data-pname-retry]");
      retry?.addEventListener("click", () =>
        ctx.shell
          .busyAction(
            "check-hub",
            (headers) =>
              ctx.shell.api("POST", "/api/hub/names-check", {}, { headers }),
            {
              button: retry,
              success: (r) =>
                t(hubNamesStale(r) === null ? "pname.retryS" : "pname.retryF"),
            },
          )
          .then((r) => {
            if (r !== undefined) return renderProjectName(host, ctx);
          }),
      );
      const form = host.querySelector("form[data-pname]");
      if (!form) return;
      const input = form.querySelector("[data-pname-input]");
      const save = form.querySelector("[data-pname-save]");
      const err = form.querySelector("[data-pname-err]");
      const ok = form.querySelector("[data-pname-ok]");
      const start = input.value;
      const say = (msg) => {
        err.hidden = !msg;
        err.textContent = msg || "";
      };
      input.addEventListener("input", () => {
        const c = projectNameCheck(input.value, start);
        save.disabled = !c.ok;
        ok.hidden = true;
        say(c.why === "empty" ? t("pname.empty") : "");
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          input.value = start;
          save.disabled = true;
          say("");
        }
      });
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const c = projectNameCheck(input.value, start);
        if (!c.ok) {
          say(c.why === "empty" ? t("pname.empty") : "");
          return;
        }
        save.disabled = true;
        ctx.shell
          .api("POST", "/api/workspaces/rename", {
            oldName: ws,
            newName: c.name,
          })
          .then(() => renderProjectName(host, ctx))
          .then(() => {
            const done = host.querySelector("[data-pname-ok]");
            if (done) done.hidden = false;
          })
          .catch((x) => {
            save.disabled = false;
            say(x?.message || t("pname.failed"));
          });
      });
    })
    .catch((e) => {
      host.innerHTML = `<p class="set-note">${escR(e?.message || t("pname.failed"))}</p>`;
    });
}

/** MODE-5: the address row's HTML (its value, the field, the note). */
export function addressHtml(w, t) {
  const now = w?.url
    ? `<p class="set-status" data-addr-now>${escR(t("addr.now", { url: w.url }))}</p>`
    : `<p class="set-status" data-addr-now><span class="rt-dot warn"></span> ${escR(t("addr.unset"))}</p>`;
  // Issue 666: a loopback address is said as a problem, and this install's
  // own alias is offered in one click (the owner's only, server-checked).
  const loop =
    w?.url && w.loopback
      ? `<p class="set-status" data-addr-loopback><span class="rt-dot bad"></span> ${escR(t("addr.loopback", { url: w.url }))}</p>`
      : "";
  const offer = w?.offer
    ? `<div class="set-inline"><button type="button" class="den-btn sm primary" data-addr-adopt="${escR(w.offer)}">${escR(t("addr.adopt", { alias: w.offer }))}</button></div>`
    : "";
  return (
    now +
    loop +
    offer +
    `<form data-addr class="set-inline" novalidate>` +
    `<label class="sr-only" for="addr-in">${escR(t("addr.label"))}</label>` +
    `<input id="addr-in" type="url" data-addr-in value="${escR(w?.url ?? "")}" placeholder="https://__DEN_CLI__.local.example.com" autocomplete="off" spellcheck="false">` +
    `<button type="submit" class="den-btn sm" data-addr-save>${escR(t("addr.check"))}</button>` +
    `</form>` +
    `<p class="set-note" data-addr-note role="status" hidden></p>`
  );
}

function renderAddress(host, ctx) {
  const t = (k, v) => ctx.shell.t(k, v);
  return ctx.shell
    .api("GET", "/api/web-url")
    .then((w) => {
      host.innerHTML = addressHtml(w, t);
      const form = host.querySelector("form[data-addr]");
      const input = form.querySelector("[data-addr-in]");
      const btn = form.querySelector("[data-addr-save]");
      const note = host.querySelector("[data-addr-note]");
      const say = (msg, bad) => {
        note.hidden = !msg;
        note.textContent = msg || "";
        note.classList.toggle("bad", !!bad);
      };
      const adoptBtn = host.querySelector("[data-addr-adopt]");
      adoptBtn?.addEventListener("click", () => {
        const url = adoptBtn.getAttribute("data-addr-adopt");
        say("");
        ctx.shell
          .busyAction(
            "check-address",
            (headers) =>
              ctx.shell.api("POST", "/api/web-url/adopt", { url }, { headers }),
            {
              button: adoptBtn,
              vars: { url },
              success: (r) => t("addr.adopted", { url: r?.url ?? url }),
              onFail: (x) => say(x?.message || t("addr.notSaved"), true),
            },
          )
          .then((r) => {
            if (r === undefined) return;
            return renderAddress(host, ctx).then(() => {
              const n = host.querySelector("[data-addr-note]");
              if (n) {
                n.hidden = false;
                n.textContent = t("addr.adopted", { url: r?.url ?? url });
              }
            });
          });
      });
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const url = input.value.trim();
        if (!url) return say(t("addr.empty"), true);
        say("");
        input.disabled = true;
        // BUSY-1: the working pop-up says it is checking, then what happened;
        // issue 698: Check shows the kit's dots until the answer.
        ctx.shell
          .busyAction(
            "check-address",
            (headers) =>
              ctx.shell.api("POST", "/api/web-url", { url }, { headers }),
            {
              button: btn,
              vars: { url },
              success: (r) => t("addr.saved", { url: r?.url ?? url }),
              onFail: (x) => say(x?.message || t("addr.notSaved"), true),
            },
          )
          .then((r) => {
            if (r === undefined) return;
            return renderAddress(host, ctx).then(() => {
              const n = host.querySelector("[data-addr-note]");
              if (n) {
                n.hidden = false;
                n.textContent = t("addr.saved", { url: r?.url ?? url });
              }
            });
          })
          .finally(() => {
            input.disabled = false;
          });
      });
    })
    .catch((e) => {
      host.innerHTML = `<p class="set-note">${escR(e?.message || t("addr.notSaved"))}</p>`;
    });
}

/** H5: repos Den Hub can't see, with one button per org. */
export function hubUncoveredHtml(list, t) {
  const un = Array.isArray(list) ? list : [];
  if (!un.length) return "";
  // Issue 526: org names match whatever their case: one button per org.
  const seen = new Set();
  const orgs = un
    .map((u) => u.org)
    .filter((o) => {
      const k = String(o).toLowerCase();
      return seen.has(k) ? false : (seen.add(k), true);
    });
  return (
    `<div data-hubp-uncovered>` +
    un
      .map(
        (u) =>
          `<p class="set-status" data-hubp-unseen="${escR(u.repo)}"><span class="rt-dot warn"></span> ${escR(t("hubp.cantSee", { repo: u.repo }))}</p>`,
      )
      .join("") +
    orgs
      .map((org) => {
        const k = String(org).toLowerCase();
        const href = un.find(
          (u) => String(u.org).toLowerCase() === k && u.installUrl,
        )?.installUrl;
        return href && /^https:\/\/github\.com\//.test(href)
          ? `<a class="btn sm primary" data-hubp-give="${escR(org)}" href="${escR(href)}" target="_blank" rel="noopener noreferrer">${escR(t("hubp.giveAccess", { org }))}</a> `
          : "";
      })
      .join("") +
    `</div>`
  );
}

/** Issue 271: the picker's Create option, and the longest name Hub takes. */
export const HUBP_CREATE = "__create";
const HUBP_NAME_MAX = 80;
/** Issue 271: how often a waiting create is read again while it shows. */
const HUBP_POLL_MS = 5000;

/** Where a person picks a Hub project for an unclear one (issue 167). */
export const HUB_PICK_HREF = "/settings#agents.hub_link_all";

/**
 * Issue 167 (mock v6 A0): Settings › Project setup › Hub project. `b` is
 * GET /api/workspaces/:ws/hub-project's answer; `name(p)` a Hub project's
 * name as HTML. Linked: the read-only pair, how it was linked and where the
 * work goes; the rare changes (another Hub project, Unlink, the terminal
 * command) sit behind More. Waiting for a pick (b.pick): a button to
 * Unclear matches. Not linked: a select (Hub's suggestion first, picked)
 * and Link. Not connected to Hub: Connect.
 *
 * Issue 271: not linked, the picker's first option is "Create a Hub
 * project named <b.name>" (picked when Hub suggests nothing), with the
 * name editable below it. A create asked of Hub and waiting (b.create, no
 * outcome): "creating", with Hub's Allow in the row for an owner
 * (b.owner), else who must allow it. Declined or ended: said, and Create
 * is offered again.
 */
export function hubProjectHtml(b, t, name) {
  const ws = String(b?.project ?? "");
  const st = (dot, text) =>
    `<p class="set-status"><span class="rt-dot ${dot}"></span> ${escR(text)}</p>`;
  if (!b?.connected)
    return (
      `<div data-hubp data-hubp-state="offline">` +
      st("warn", t("hubp.noHub")) +
      `<a class="btn sm primary" href="/settings#agents.hub">${escR(t("hubp.connectBtn"))}</a></div>`
    );
  const linked = b.hub;
  const why = (w) => (w === "repo" ? t("hubp.whyRepo") : t("hubp.whyName"));
  const sugg = (b.suggestions || []).filter((p) => p.id !== linked?.id);
  const rest = (b.projects || []).filter(
    (p) => p.id !== linked?.id && !sugg.some((x) => x.id === p.id),
  );
  const opts =
    (sugg.length
      ? `<optgroup label="${escR(t("hubp.suggested"))}">${sugg
          .map(
            (p, i) =>
              `<option value="${escR(p.id)}"${!linked && i === 0 ? " selected" : ""}>${name(p)}: ${escR(why(p.why))}</option>`,
          )
          .join("")}</optgroup>`
      : "") +
    (rest.length
      ? `<optgroup label="${escR(t("hubp.others"))}">${rest
          .map((p) => `<option value="${escR(p.id)}">${name(p)}</option>`)
          .join("")}</optgroup>`
      : "");
  const own = String(b?.name || ws).slice(0, HUBP_NAME_MAX);
  // Issue 271: unlinked, Create comes first; picked when nothing is suggested.
  const createOpt = (on) =>
    `<option value="${HUBP_CREATE}"${on ? " selected" : ""}>${escR(t("hubp.createOpt", { name: own }))}</option>`;
  const newName = (on) =>
    `<div class="hubp-new" data-hubp-newrow${on ? "" : " hidden"}>` +
    `<label for="hubp-new">${escR(t("hubp.newName"))}</label> ` +
    `<input id="hubp-new" type="text" value="${escR(own)}" maxlength="${HUBP_NAME_MAX}" autocomplete="off"></div>`;
  // Issue 651: linked, Unlink rides in the Switch row (one row beside the
  // list, wrapping only on a narrow screen).
  const unlinkBtn = linked
    ? `<button type="button" class="btn sm" data-hubp-action="unlink">${escR(t("hubp.unlink"))}</button>`
    : "";
  const picker = (label, btn, primary) =>
    !linked
      ? `<form class="hubp-pick" data-hubp-form>` +
        `<label for="hubp-sel">${escR(label)}</label> ` +
        `<select id="hubp-sel">${createOpt(!sugg.length)}${opts}</select> ` +
        newName(!sugg.length) +
        `<button type="submit" class="btn sm${primary ? " primary" : ""}" data-hubp-action="link">${escR(sugg.length ? btn : t("hubp.create"))}</button>` +
        `</form>`
      : opts
        ? `<form class="hubp-pick" data-hubp-form>` +
          `<label for="hubp-sel">${escR(label)}</label> ` +
          `<select id="hubp-sel">${opts}</select> ` +
          `<button type="submit" class="btn sm${primary ? " primary" : ""}" data-hubp-action="link">${escR(btn)}</button>` +
          unlinkBtn +
          `</form>`
        : `<p class="set-note">${escR(t(linked ? "hubp.noOther" : "hubp.none"))}</p>` +
          (unlinkBtn ? `<p>${unlinkBtn}</p>` : "");
  const tail =
    hubUncoveredHtml(b.uncovered, t) +
    (b.error ? `<p class="set-note">${escR(b.error)}</p>` : "") +
    `<div class="rt-err" role="alert" hidden></div></div>`;
  if (linked) {
    const hubName = linked.name || linked.slug;
    return (
      `<div data-hubp data-hubp-state="linked">` +
      `<div class="hubp-pair" data-hubp-pair>` +
      `<div><small>${escR(t("hubp.sideProject"))}</small><b>${escR(ws)}</b></div>` +
      `<span aria-hidden="true">↔</span>` +
      `<div><small>${escR(t("hubp.sideHub"))}</small><b data-hubp-name>${name(linked)}</b></div></div>` +
      `<p class="set-note">${escR(t("hubp.linkedWhen"))}</p>` +
      `<p class="set-note" data-hubp-byid>${escR(t("hubp.byId"))}</p>` +
      `<p class="set-note">${escR(t("hubp.does", { project: ws, hub: hubName }))}</p>` +
      `<details class="hubp-more" data-hubp-more><summary>${escR(t("hubp.more"))}</summary>` +
      `<p class="set-note">${escR(t("hubp.moreNote"))}</p>` +
      picker(t("hubp.switchL"), t("hubp.switch"), false) +
      `<p class="set-note">${escR(t("hubp.unlinkDoes", { project: ws, hub: hubName }))}</p>` +
      `<p class="set-note">${escR(t("hubp.cliL"))} <code>__DEN_CLI__ hub link -p ${escR(ws)}</code></p>` +
      `</details>` +
      tail
    );
  }
  const ask = b.create && typeof b.create === "object" ? b.create : null;
  if (ask && !ask.outcome) {
    const url =
      typeof ask.url === "string" && /^https?:\/\//.test(ask.url)
        ? ask.url
        : "";
    const who =
      b.owner === true
        ? `<p class="set-note">${escR(t("hubp.youAllow", { project: ws }))}</p>` +
          (url
            ? `<a class="btn sm primary" href="${escR(url)}" target="_blank" rel="noopener noreferrer" data-hubp-allow>${escR(t("hubp.allowBtn"))}</a>`
            : "")
        : `<p class="set-note">${escR(
            b.company
              ? t("hubp.ownerMust", { company: b.company, project: ws })
              : t("hubp.ownerMustAny", { project: ws }),
          )}</p>`;
    return (
      `<div data-hubp data-hubp-state="creating">` +
      st("warn", t("hubp.asked", { name: ask.name, project: ws })) +
      who +
      tail
    );
  }
  const ended =
    ask?.outcome === "declined" || ask?.outcome === "superseded"
      ? `<p class="set-note" data-hubp-ended>${escR(
          t(ask.outcome === "declined" ? "hubp.declined" : "hubp.ended", {
            name: ask.name,
          }),
        )}</p>`
      : "";
  if (b.pick)
    return (
      `<div data-hubp data-hubp-state="pick">` +
      st("warn", t("hubp.waiting", { project: ws })) +
      `<a class="btn sm primary" href="${HUB_PICK_HREF}">${escR(t("hubp.pickBtn"))}</a>` +
      tail
    );
  return (
    `<div data-hubp data-hubp-state="unlinked">` +
    st("warn", t("hubp.notLinked", { project: ws })) +
    ended +
    picker(t("hubp.linkProject", { project: ws }), t("hubp.link"), true) +
    `<p class="set-note">${escR(t("hubp.scope", { project: ws }))}</p>` +
    tail
  );
}

/**
 * Issue 167 (mock v6 H3): Unlink asks first, in a dialog with its own
 * Report button. Resolves true on "Yes, unlink".
 */
async function askHubUnlink(ctx, t, project, hub) {
  // Issue 669: the kit's confirm frame (its Report too), no dialog of its own.
  const html = dialogHtml({
    kind: "confirm",
    id: "hubp-dlg",
    ids: { h: "hubp-dlg-h" },
    className: "hubp-dlg",
    role: "dialog",
    title: t("hubp.unlinkAsk", { project, hub }),
    body: `<p class="set-note">${escR(t("hubp.unlinkDoes", { project, hub }))}</p>`,
    actions: [
      {
        label: t("hubp.cancel"),
        value: "cancel",
        attrs: { "data-hubp-dlg": "cancel" },
      },
      {
        label: t("hubp.unlinkYes"),
        value: "yes",
        kind: "primary",
        attrs: { "data-hubp-dlg": "yes" },
      },
    ],
  });
  const h = mountDialog(html, { focus: '[data-hubp-dlg="cancel"]' });
  return (await h.closed) === "yes";
}

function wireHubProject(host, ctx, url, t, b) {
  const err = (msg) => {
    const e = host.querySelector(".rt-err");
    if (!e) return;
    e.hidden = !msg;
    e.textContent = msg || "";
  };
  const put = (hub) => {
    host.querySelectorAll("button, select").forEach((x) => (x.disabled = true));
    err("");
    return ctx.shell
      .api("PUT", url, { hub })
      .then(() => renderHubProject(host, ctx))
      .catch((e) => {
        host
          .querySelectorAll("button, select")
          .forEach((x) => (x.disabled = false));
        err(e?.message || t("hubp.failed"));
      });
  };
  const sel = host.querySelector("#hubp-sel");
  const nameIn = host.querySelector("#hubp-new");
  const newRow = host.querySelector("[data-hubp-newrow]");
  const go = host.querySelector('[data-hubp-form] [data-hubp-action="link"]');
  const createOpt = sel?.querySelector(`option[value="${HUBP_CREATE}"]`);
  // Issue 271: Create shows the name, and the button says Create.
  const sync = () => {
    const on = sel?.value === HUBP_CREATE;
    if (newRow) newRow.hidden = !on;
    if (go && createOpt) go.textContent = t(on ? "hubp.create" : "hubp.link");
  };
  sel?.addEventListener("change", () => {
    err("");
    sync();
  });
  nameIn?.addEventListener("input", () => {
    if (createOpt)
      createOpt.textContent = t("hubp.createOpt", {
        name: nameIn.value.replace(/\s+/g, " ").trim() || b?.name || "",
      });
  });
  host.querySelector("[data-hubp-form]")?.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = sel?.value;
    if (v === HUBP_CREATE) {
      const nm = String(nameIn?.value ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!nm) return err(t("hubp.nameEmpty"));
      if (nm.length > HUBP_NAME_MAX) return err(t("hubp.nameLong"));
      err("");
      return ctx.shell
        .busyAction(
          "create-hub",
          (headers) =>
            ctx.shell.api(
              "POST",
              url.replace(/\/hub-project$/, "/hub-create"),
              { name: nm },
              { headers },
            ),
          {
            button: go,
            vars: { name: nm },
            onFail: (x) => err(x?.message || t("hubp.createF")),
          },
        )
        .then((r) => {
          if (r !== undefined && r !== null) return renderHubProject(host, ctx);
        });
    }
    if (v) put(v);
  });
  // Issue 271: a create waiting in Hub: read again while it shows, so the
  // row links on its own once an owner allows it.
  if (host.querySelector('[data-hubp-state="creating"]')) {
    clearTimeout(host._hubpPoll);
    host._hubpPoll = setTimeout(() => {
      if (
        host.isConnected &&
        host.querySelector('[data-hubp-state="creating"]')
      )
        renderHubProject(host, ctx);
    }, HUBP_POLL_MS);
  }
  host
    .querySelector('[data-hubp-action="unlink"]')
    ?.addEventListener("click", () =>
      askHubUnlink(
        ctx,
        t,
        String(b?.project ?? ""),
        b?.hub?.name || b?.hub?.slug || "",
      ).then((yes) => {
        if (yes) put(null);
      }),
    );
}

/**
 * Issue 167 (mock v6 B): Settings › Agents › Unclear matches. Each project
 * Den can't match in its own group: why (b.projects[].reason), that
 * nothing is filed for it yet, one radio per Hub project (none picked),
 * and its own Link, off until a pick. Nothing unclear: the empty line. A
 * clear one not linked yet (Hub didn't answer at Connect) keeps its own
 * Link, below.
 */
export function hubLinkAllHtml(b, t) {
  if (!b || !b.connected)
    return (
      `<div data-hubla data-hubla-state="offline">` +
      `<p class="set-note">${escR(t("hubp.offline"))} <a href="/settings#agents.hub">${escR(t("hubp.connect"))}</a></p></div>`
    );
  const rows = Array.isArray(b.projects) ? b.projects : [];
  if (!rows.length)
    return `<div data-hubla data-hubla-state="none"><p class="set-note">${escR(t("hubla.noProjects"))}</p></div>`;
  const name = (p) =>
    p.name === p.slug ? escR(p.slug) : `${escR(p.name)} (${escR(p.slug)})`;
  const unclear = rows.filter(
    (r) => !r.hub && Array.isArray(r.unclear) && r.unclear.length > 0,
  );
  const clear = rows.filter(
    (r) => !r.hub && r.suggestion && !unclear.includes(r),
  );
  const reason = (r) =>
    t(
      `ub.why.${["repos", "split", "names"].includes(r.reason) ? r.reason : "repos"}`,
    );
  const group = (r) => {
    const g = `hubla-pick-${escR(r.project)}`;
    return (
      `<fieldset class="hubla-group" data-hubla-row="${escR(r.project)}">` +
      `<legend><b>${escR(r.project)}</b></legend>` +
      `<p class="set-note">${escR(reason(r))}</p>` +
      `<p class="set-note">${escR(t("ub.waiting"))}</p>` +
      `<div role="radiogroup" aria-label="${escR(t("ub.pick", { project: r.project }))}">` +
      r.unclear
        .map((c, i) => {
          const id = `${g}-${i}`;
          return (
            `<label class="hubla-choice" for="${id}"><input type="radio" id="${id}" name="${g}" data-hubla-pick="${escR(r.project)}" data-hubla-hub="${escR(c.id)}"> ` +
            `<span><b>${name(c)}</b>${c.why ? ` · ${escR(t(c.why === "repo" ? "ub.repos" : "ub.name"))}` : ""}</span></label>`
          );
        })
        .join("") +
      `</div>` +
      `<button type="button" class="btn sm primary" data-hubla-link="${escR(r.project)}" disabled>${escR(t("ub.link"))}</button>` +
      `</fieldset>`
    );
  };
  const one = (r) =>
    `<li data-hubla-clear="${escR(r.project)}"><span>${escR(t("ub.clear", { project: r.project }))} <b>${name(r.suggestion)}</b></span> ` +
    `<button type="button" class="btn sm" data-hubla-link="${escR(r.project)}" data-hubla-hub="${escR(r.suggestion.id)}">${escR(t("ub.link"))}</button></li>`;
  return (
    `<div data-hubla data-hubla-state="${unclear.length ? "todo" : "done"}">` +
    (unclear.length
      ? `<p class="set-note">${escR(t("ub.intro"))}</p>` +
        unclear.map(group).join("")
      : `<p class="set-note">${escR(t("ub.empty"))}</p>`) +
    (clear.length
      ? `<ul class="hubla-list">${clear.map(one).join("")}</ul>`
      : "") +
    `<div class="set-note" data-hubla-result hidden></div>` +
    `<div class="rt-err" role="alert" hidden></div></div>`
  );
}

/** "a, b and c" in the page's language (BUSY-1's success lines). */
function listWords(names) {
  try {
    return new Intl.ListFormat(document.documentElement.lang || "en", {
      type: "conjunction",
    }).format(names);
  } catch {
    return names.join(", ");
  }
}

/**
 * Issue 164: one result line for a link run: how many were linked, then
 * the ones that couldn't be and what to do. "Already linked" is no failure.
 */
export function hubLinkResultText(result, t, join = (n) => n.join(", ")) {
  const n = (result?.linked ?? []).length;
  const failed = (result?.skipped ?? [])
    .filter((s) => s?.code !== "linked")
    .map((s) => String(s?.project ?? ""));
  if (!failed.length) return t("hubla.linked", { n });
  const names = join(failed);
  return n
    ? `${t("hubla.linked", { n })} ${t("hubla.failed", { n: failed.length, names })}`
    : t("hubla.failedAll", { names });
}

function renderHubLinkAll(host, ctx) {
  return drawHubLinkAll(host, ctx, null);
}

/** `result`: the last Link ticked's answer, shown under the list. */
function drawHubLinkAll(host, ctx, result) {
  if (ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  const url = "/api/hub/link-suggestions";
  return ctx.shell
    .api("GET", url)
    .then((b) => {
      host.innerHTML = hubLinkAllHtml(b, t);
      const out = host.querySelector("[data-hubla-result]");
      if (out && result && Array.isArray(result.linked)) {
        out.textContent = hubLinkResultText(result, t, listWords);
        out.hidden = false;
      }
      // A project's Link is on once it has a pick (a clear one has it).
      const picked = (project) =>
        [...host.querySelectorAll("input[data-hubla-pick]")].find(
          (r) => r.dataset.hublaPick === project && r.checked,
        )?.dataset.hublaHub;
      const links = () => [...host.querySelectorAll("[data-hubla-link]")];
      const fresh = () =>
        links().forEach(
          (b) =>
            (b.disabled = !b.dataset.hublaHub && !picked(b.dataset.hublaLink)),
        );
      host
        .querySelectorAll("input[data-hubla-pick]")
        .forEach((r) => r.addEventListener("change", fresh));
      links().forEach((btn) =>
        btn.addEventListener("click", () => {
          const project = btn.dataset.hublaLink;
          const hub = btn.dataset.hublaHub || picked(project);
          if (!hub) return;
          const links = [{ project, hub }];
          // BUSY-1: the working pop-up says it is linking, then what happened.
          const lock = (on) => {
            host
              .querySelectorAll("button, input")
              .forEach((x) => (x.disabled = on));
            if (!on) fresh();
          };
          lock(true);
          ctx.shell
            .busyAction(
              "link",
              (headers) => ctx.shell.api("POST", url, { links }, { headers }),
              {
                button: btn,
                success: (r) => {
                  const names = (r?.linked ?? []).map(
                    (x) => x?.hub?.name || x?.project,
                  );
                  return t("busy.linkS", {
                    n: names.length,
                    names: listWords(names),
                  });
                },
                onFail: (e) => {
                  const err = host.querySelector(".rt-err");
                  if (err) {
                    err.hidden = false;
                    err.textContent = e?.message || t("hubp.failed");
                  }
                },
              },
            )
            .then((r) => {
              if (r) drawHubLinkAll(host, ctx, r);
              else lock(false);
            });
        }),
      );
    })
    .catch((e) => {
      host.innerHTML = `<p class="set-note" data-hubla data-hubla-state="error">${escR(e?.message || t("hubp.failed"))}</p>`;
    });
}

/**
 * H5: Den Hub's GitHub access, one line per org: all repos, N of M, or no
 * access, live from Hub, with GitHub's link (Hub gives only github.com
 * https links; the server drops anything else). Coming back to the window,
 * or to ?hub=installed, sends the projects to Hub again and redraws.
 */
export function hubGithubHtml(b, t) {
  if (!b || !b.connected)
    return `<p class="set-note" data-hubgh data-hubgh-state="offline">${escR(t("hubgh.offline"))}</p>`;
  if (b.error)
    return `<p class="set-note" data-hubgh data-hubgh-state="error">${escR(t("hubgh.failed"))} ${escR(b.error)}</p>`;
  const orgs = b.orgs || [];
  if (!orgs.length)
    return `<p class="set-note" data-hubgh data-hubgh-state="none">${escR(t("hubgh.noOrgs"))}</p>`;
  return (
    `<div data-hubgh data-hubgh-state="orgs">` +
    orgs
      .map((o) => {
        // Issue 526: Hub couldn't ask GitHub. Its reason as text, Check
        // again, and never a link, even when Hub sends one.
        if (o.access === "error") {
          const reason = typeof o.error === "string" ? o.error : "";
          return (
            `<p class="set-status" data-hubgh-org="${escR(o.org)}" data-hubgh-access="error">` +
            `<span class="rt-dot warn"></span> ${escR(reason ? t("hubgh.error", { org: o.org, reason }) : t("hubgh.errorNoReason", { org: o.org }))}` +
            ` <button type="button" class="btn sm" data-hubgh-retry>${escR(t("hubgh.retry"))}</button>` +
            `</p>`
          );
        }
        const what =
          o.access === "all"
            ? t("hubgh.all")
            : o.access === "some"
              ? t("hubgh.some", { n: o.covered, m: o.total })
              : t("hubgh.none");
        // none: give access when there's no installation; one that leaves
        // these repos out sends only manage_url, and that's Change repos.
        const give = o.access === "none" && !!o.installUrl;
        const href =
          o.access === "some"
            ? o.manageUrl || o.installUrl
            : o.access === "none"
              ? o.installUrl || o.manageUrl
              : null;
        const label = give ? t("hubgh.give") : t("hubgh.change");
        const dot = o.access === "all" ? "ok" : "warn";
        return (
          `<p class="set-status" data-hubgh-org="${escR(o.org)}" data-hubgh-access="${escR(o.access)}">` +
          `<span class="rt-dot ${dot}"></span> ${escR(t("hubgh.line", { org: o.org, what }))}` +
          (href && /^https:\/\/github\.com\//.test(href)
            ? ` <a class="btn sm${give ? " primary" : ""}" data-hubgh-open href="${escR(href)}" target="_blank" rel="noopener noreferrer">${escR(label)}</a>`
            : "") +
          `</p>`
        );
      })
      .join("") +
    `</div>`
  );
}

// ?hub=installed: back from GitHub's install, read once at load (the page
// rewrites its URL). One re-sync, shared by every row that shows access.
let hubBackFromInstall = (() => {
  try {
    return new URLSearchParams(location.search).get("hub") === "installed";
  } catch {
    return false;
  }
})();
let hubResync = null;

function renderHubGithub(host, ctx) {
  // A config Den can't read: no Hub to ask (its routes answer 422).
  if (ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  const t = (k, v) => ctx.shell.t(k, v);
  const draw = () =>
    ctx.shell
      .api("GET", "/api/hub/github")
      .then((b) => {
        host.innerHTML = hubGithubHtml(b, t);
        host.querySelectorAll("[data-hubgh-open]").forEach((a) =>
          a.addEventListener("click", () => {
            host.dataset.hubghAway = "1";
          }),
        );
        // Issue 526: Check again asks Hub once more.
        host.querySelectorAll("[data-hubgh-retry]").forEach((btn) =>
          btn.addEventListener("click", () => {
            btn.disabled = true;
            draw();
          }),
        );
      })
      .catch((e) => {
        host.innerHTML = `<p class="set-note" data-hubgh data-hubgh-state="error">${escR(e?.message || t("hubgh.failed"))}</p>`;
      });
  const resync = () => {
    hubResync ??= ctx.shell
      .api("POST", "/api/hub/sync", {})
      .catch(() => null)
      .finally(() => setTimeout(() => (hubResync = null), 2000));
    return hubResync.then(draw);
  };
  if (!host.dataset.hubghWired) {
    host.dataset.hubghWired = "1";
    window.addEventListener("focus", () => {
      if (host.isConnected && host.dataset.hubghAway === "1") {
        host.dataset.hubghAway = "";
        resync();
      }
    });
  }
  if (hubBackFromInstall || hubResync) {
    hubBackFromInstall = false;
    return resync();
  }
  return draw();
}

function renderHub(host, ctx) {
  return drawHub(host, ctx, takeHubFlash(), null);
}

/** Draw the row; `back` is ?hub=… from Hub's redirect, `flash` words to show. */
function drawHub(host, ctx, back, flash) {
  // Under an invalid config /api/hub answers 422: ask nothing, show nothing.
  if (ctx.shell?.configInvalid?.() === true) {
    host.innerHTML = "";
    return Promise.resolve();
  }
  return ctx.shell
    .api("GET", "/api/hub")
    .then((b) => {
      let f = flash;
      if (!f && b && b.connect) f = b.connect;
      else if (!f && back && HUB_FLASH[back])
        f = { ok: HUB_FLASH[back][0], message: HUB_FLASH[back][1] };
      host.innerHTML = hubHtml(b, f, (k, v) => ctx.shell.t(k, v));
      wireHub(host, ctx);
      // D44: agents started before Hub changed keep their old tools.
      return offerRestart(host, ctx, Boolean(f || back));
    })
    .catch(() => {
      host.innerHTML = "";
    });
}

function wireHub(host, ctx) {
  const err = (msg, retry) => {
    const e = host.querySelector(".rt-err");
    if (!e) return;
    e.hidden = !msg;
    e.textContent = msg || "";
    if (retry) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn sm";
      btn.dataset.hubAction = "force";
      btn.textContent = "Remove it here anyway";
      btn.addEventListener("click", () => disconnect(true, btn));
      e.append(" ", btn);
    }
  };
  const busy = (on) =>
    host.querySelectorAll("button, input").forEach((x) => (x.disabled = on));
  const connect = () => {
    const typed = host.querySelector("#hub-url");
    busy(true);
    err("");
    // BUSY-1: the working pop-up while Den asks Hub.
    const t = (k, v) => ctx.shell.t(k, v);
    ctx.shell
      .busyAction(
        "connect",
        (headers) =>
          ctx.shell.api(
            "POST",
            "/api/hub/connect",
            typed ? { url: typed.value } : {},
            { headers },
          ),
        {
          button: host.querySelector('button[data-hub-action="connect"]'),
          // Off to Hub: sign in and approve there; Hub sends the person back.
          onDone: (r) => location.assign(r.location),
          onFail: (e) => err(e?.message || t("busy.connF")),
        },
      )
      .then((r) => {
        if (!r) busy(false);
      });
  };
  const disconnect = (force, btn) => {
    busy(true);
    err("");
    ctx.shell
      .api("POST", "/api/hub/disconnect", force ? { force: true } : {})
      .then((r) => drawHub(host, ctx, null, { ok: true, message: r.message }))
      .catch((e) => {
        busy(false);
        if (btn) btn.remove();
        err(e?.message || "Not disconnected", !force);
      });
  };
  const form = host.querySelector("[data-hub-connect]");
  if (form)
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      connect();
    });
  wireHubAddress(host, ctx, err, busy);
  host
    .querySelectorAll('button[data-hub-action="connect"]')
    .forEach(
      (x) => x.type === "button" && x.addEventListener("click", connect),
    );
  const acts = host.querySelector(".hub-acts");
  const ask = host.querySelector("[data-hub-confirm]");
  const asking = (on) => {
    if (!acts || !ask) return;
    acts.hidden = on;
    ask.hidden = !on;
    host
      .querySelector(
        on
          ? '[data-hub-action="disconnect-no"]'
          : '[data-hub-action="disconnect"]',
      )
      ?.focus();
  };
  host
    .querySelector('[data-hub-action="disconnect"]')
    ?.addEventListener("click", () => asking(true));
  host
    .querySelector('[data-hub-action="disconnect-no"]')
    ?.addEventListener("click", () => asking(false));
  ask?.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      asking(false);
    }
  });
  host
    .querySelector('[data-hub-action="disconnect-yes"]')
    ?.addEventListener("click", () => {
      if (ask) ask.hidden = true;
      if (acts) acts.hidden = false;
      disconnect(false);
    });
  const box = host.querySelector("#hub-allow-tools");
  if (box)
    box.addEventListener("change", () => {
      box.disabled = true;
      ctx.shell
        .api("POST", "/api/settings", { hub_allow_tools: box.checked })
        .then(() => drawHub(host, ctx, null, null))
        .catch(() => {
          box.checked = !box.checked;
          box.disabled = false;
        });
    });
}

/** The Rotation row: this install's values, the overrides, + Add override. */
function renderRotation(host, ctx) {
  const err = () => host.querySelector(".rt-err");
  const fail = (x) => {
    const e = err();
    if (e) {
      e.textContent = x?.message || L("set.ui.notSaved", "Not saved");
      e.hidden = false;
    }
  };
  const load = () => {
    if (ctx.shell?.configInvalid?.() === true) {
      host.innerHTML = `<div class="set-note">${escR(L("set.ui.rot.fixConfig", "Fix the config first: the org's rotation is read from it."))}</div>`;
      return Promise.resolve();
    }
    return ctx.shell
      .api("GET", "/api/agents/rotation?choices=1")
      .then((b) => {
        host.innerHTML = rotationHtml(b || {});
        wireAdd(b?.choices || {});
      })
      .catch((x) => {
        host.innerHTML = `<div class="set-note">${escR(x?.message || L("set.ui.rot.loadFailed", "The rotation settings did not load."))}</div>`;
      });
  };
  // D30: the add form's pickers, filled from live data.
  let picks = {};
  const wireAdd = (c) => {
    picks = {};
    for (const [kind, id] of [
      ["agent", "rot-a-agent"],
      ["persona", "rot-a-persona"],
      ["workspace", "rot-a-ws"],
      ["service", "rot-a-service"],
    ])
      picks[kind] = wireCombo(host, id, { items: () => rotPickItems(kind, c) });
    showFor();
  };
  const showFor = () => {
    const scope = host.querySelector("#rot-a-scope")?.value;
    const key = host.querySelector("#rot-a-key")?.value;
    for (const el of host.querySelectorAll(".rot-add [data-for]"))
      el.hidden = !el.dataset.for.split(" ").includes(scope);
    for (const el of host.querySelectorAll(".rot-add [data-val]"))
      el.hidden = el.dataset.val !== key;
    const n = host.querySelector("#rot-a-n");
    const never = host.querySelector("#rot-a-never");
    if (n && never) n.disabled = never.checked;
  };
  const targetOf = (scope) => {
    const v = (k) => picks[k]?.value() || "";
    if (scope === "persona-workspace")
      return v("persona") && v("workspace")
        ? `${v("persona")}@${v("workspace")}`
        : "";
    return v(scope);
  };
  const valueOf = (key) => {
    if (key === "on_due") return host.querySelector("#rot-a-due").value;
    if (key === "on_pr_merged")
      return host.querySelector("#rot-a-pr").value === "true";
    if (host.querySelector("#rot-a-never").checked) return "never";
    return Number(host.querySelector("#rot-a-n").value);
  };
  const put = async (body) => {
    try {
      await ctx.shell.api("PUT", "/api/agents/rotation", body);
      await load();
    } catch (x) {
      fail(x);
    }
  };
  host.addEventListener("change", (e) => {
    const k = e.target.closest("[data-rot-key]")?.dataset.rotKey;
    if (
      ["rot-a-scope", "rot-a-key", "rot-a-never"].includes(e.target.id) ||
      e.target.closest?.(".rot-add")
    ) {
      showFor();
      return;
    }
    if (!k || k === "after_compactions" || e.target.tagName !== "SELECT")
      return;
    const v = e.target.value;
    void put({
      scope: "install",
      key: k,
      value: v === "" ? null : rotationValue(k, v),
    });
  });
  host.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-rot-save-after")) {
      const v = host.querySelector("#rot-after_compactions")?.value.trim();
      void put({
        scope: "install",
        key: "after_compactions",
        value: v ? rotationValue("after_compactions", v) : null,
      });
    } else if (b.hasAttribute("data-rot-clear"))
      void put({
        scope: b.dataset.scope,
        target: b.dataset.target,
        key: b.dataset.key,
        value: null,
      });
  });
  host.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-rot-add]");
    if (!f) return;
    e.preventDefault();
    const key = f.querySelector("#rot-a-key").value;
    const scope = f.querySelector("#rot-a-scope").value;
    const target = targetOf(scope);
    if (!target) {
      fail({
        message:
          scope === "persona-workspace"
            ? L("set.ui.rot.pickPW", "Pick a persona and a project.")
            : L(
                `set.ui.rot.pick.${scope}`,
                `Pick ${withArticle((ROT_SCOPES.find((x) => x[0] === scope) || [scope, scope])[1].toLowerCase())}.`,
              ),
      });
      return;
    }
    void put({ scope, target, key, value: valueOf(key) });
  });
  void load();
}

/** Register Den's categories and rows with the shell's SETTINGS registry. */
export function registerDenSettings(shell) {
  for (const c of DEN_SETTING_CATEGORIES) shell.registerSettingsCategory(c);
  for (const r of DEN_SETTINGS) shell.registerSetting(r);
}
