/**
 * UK-2: Den on the kit's working pop-up (/kit/busy.js).
 *
 * Den's actions are named here once, each with the i18n keys of its own
 * words (working, success, failure; reconnect's bodies too), so every word
 * stays in Den's catalogs (shell.js, i18n/es.js, i18n/ja.js). The kit's
 * shared words (Try again, Check again, No answer…) are the kit's own.
 *
 *   busyAction(name, run, opts)   the kit's, with Den's words and hooks
 *
 * Auto-close (a fast success says so in a toast, a slow one closes after
 * 1.2 s): save, link, connect, check-address, check-hub, ask-hub, start-agent,
 * restart-agent, fresh-start, report-preview, save-report-draft,
 * discard-draft, keep-running. Waits for
 * Done: sign-out-all, send-report.
 * restart-den waits for Den to come back (reconnect mode).
 */
import {
  busyAction as kitBusy,
  configureBusy,
  registerActions,
} from "/kit/busy.js";

const sh = () => window.denShell;
const t = (key, vars) => sh()?.t?.(key, vars) ?? key;

/** name → { who, autoClose?, mode?, keys: { working, success, failure, … } } */
export const DEN_ACTIONS = {
  save: {
    who: "Den",
    autoClose: true,
    keys: {
      working: "busy.saveW",
      success: "busy.saveS",
      failure: "busy.saveF",
    },
  },
  link: {
    who: "Hub",
    autoClose: true,
    keys: {
      working: "busy.linkW",
      success: "busy.linkS",
      failure: "busy.linkF",
    },
  },
  connect: {
    who: "Hub",
    autoClose: true,
    keys: {
      working: "busy.connW",
      success: "busy.connS",
      failure: "busy.connF",
    },
  },
  "check-address": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "addr.checkW",
      success: "addr.saved",
      failure: "addr.notSaved",
    },
  },
  // Issue 167: Settings › Project setup › Name: Ask Hub to rename.
  "ask-hub": {
    who: "Hub",
    autoClose: true,
    keys: {
      working: "pname.askW",
      success: "pname.askS",
      failure: "pname.askF",
    },
  },
  // Issue 167: Settings › Project setup › Name, Hub not reachable: Try again.
  "check-hub": {
    who: "Hub",
    autoClose: true,
    keys: {
      working: "pname.retryW",
      success: "pname.retryS",
      failure: "pname.retryF",
    },
  },
  "start-agent": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "busy.startW",
      success: "busy.startS",
      failure: "busy.startF",
    },
  },
  "restart-agent": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "busy.restartW",
      success: "busy.restartS",
      failure: "busy.restartF",
    },
  },
  "fresh-start": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "sa.fresh.w",
      success: "sa.fresh.done",
      failure: "sa.fresh.fail",
    },
  },
  "sign-out-all": {
    who: "__DEN_TITLE__",
    keys: {
      working: "set.ui.signOutAllW",
      success: "set.ui.signOutAllDone",
      failure: "set.ui.signOutAllF",
    },
  },
  "send-report": {
    who: "Den",
    // FB: a quick answer shows nothing; the report dialog says what
    // happened (Sent, F4, F5, F7, a refusal with Try again).
    autoClose: true,
    keys: {
      working: "fb.busySend",
      success: "fb.busyDone",
      failure: "fb.busyFailed",
    },
  },
  "report-preview": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "fb.busyPreview",
      success: "fb.busyDone",
      failure: "fb.busyFailed",
    },
  },
  "save-report-draft": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "fb.busySave",
      success: "fb.busyDone",
      failure: "fb.busyFailed",
    },
  },
  "discard-draft": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "fb.discard",
      success: "fb.busyDone",
      failure: "fb.busyFailed",
    },
  },
  // Issue 163: Keep agents running after logout › Apply.
  "keep-running": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "keep.w",
      success: "keep.s",
      failure: "keep.failed",
    },
  },
  "restart-den": {
    who: "__DEN_TITLE__",
    mode: "reconnect",
    keys: {
      working: "rd.restarting",
      working_body: "rd.reconnects",
      success: "rd.back",
      success_body: "rd.version",
      failure: "rd.notBack",
      failure_body: "rd.notBackB",
    },
  },
};

let ready = false;

/** Den's words in the page's language, its Report, toast and routes. */
function setUp() {
  const lang = sh()?.lang?.() || "en";
  const words = (keys) => {
    const w = {};
    // {placeholders} stay for the kit to fill from opts.vars.
    for (const [k, key] of Object.entries(keys)) w[k] = t(key);
    return { [lang]: w };
  };
  const map = {};
  for (const [name, a] of Object.entries(DEN_ACTIONS))
    map[name] = { ...a, words: words(a.keys) };
  registerActions(map);
  if (ready) return;
  ready = true;
  configureBusy({
    lang: () => sh()?.lang?.() || "en",
    idHeader: "X-Den-Request-Id",
    statusUrl: (id) => `/requests/${encodeURIComponent(id)}`,
    report: sh()?.report ? (info) => sh().report(info) : null,
    toast: (text) => sh()?.toast?.(text),
    open: (url) => window.location.assign(url),
    logUrl: "/logs",
    reconnect: {
      url: "/api/server-info",
      // Back only on a NEW pid or start time: the old server can answer
      // for a moment before it stops.
      back: (now, before) =>
        now?.pid != null &&
        (!before ||
          now.pid !== before.pid ||
          String(now.startedAt) !== String(before.startedAt)),
      version: (now) => now?.version ?? "",
      waitMs: (before) =>
        Number(before?.restartWaitSeconds) > 0
          ? Number(before.restartWaitSeconds) * 1000
          : 90_000,
      // Pages reconnect their live connections; no reload (typed text and
      // scroll stay).
      done: (now) =>
        window.dispatchEvent(
          new CustomEvent("den:server-back", { detail: now }),
        ),
    },
  });
}

/**
 * The kit's busyAction with Den's words. Resolves with the answer's data,
 * or null when it didn't succeed (as BUSY-1 did).
 */
export function busyAction(name, run, opts = {}) {
  setUp();
  return kitBusy(name, run, opts);
}
