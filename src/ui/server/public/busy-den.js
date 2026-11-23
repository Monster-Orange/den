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
 * 1.2 s): save, link, connect, check-address, check-hub, ask-hub, create-hub,
 * start-agent, restart-agent, agent-mode, fresh-start, report-preview,
 * save-report-draft, discard-draft, follow-project, keep-running, edge-up,
 * check-edge-address, edge-take-over,
 * send-message, allow-web-app, ask-allow, agent-order, delete-project,
 * remove-service, remove-mcp, gate-end. Waits for
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
  // Issue 96: a move in a project's order; fast, so no pop-up and no toast
  // (the page says where it went in its live line).
  "agent-order": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "busy.ordW",
      success: "busy.ordS",
      failure: "busy.ordF",
    },
  },
  // Issue 168: a project's colour, saved from its colour picker.
  "project-colour": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "busy.pcW",
      success: "busy.pcS",
      failure: "busy.pcF",
    },
  },
  // Issue 133: the Projects and Services pages' confirm actions.
  "delete-project": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "busy.delProjW",
      success: "busy.delProjS",
      failure: "busy.delProjF",
    },
  },
  // Issue 144: a person ends a gate slot early (the run goes on).
  // Issue 765: Stop putting an agent's rotation off.
  "rot-undefer": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "busy.undeferW",
      success: "busy.undeferS",
      failure: "busy.undeferF",
    },
  },
  "gate-end": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "busy.gateEndW",
      success: "busy.gateEndS",
      failure: "busy.gateEndF",
    },
  },
  "remove-service": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "busy.rmSvcW",
      success: "busy.rmSvcS",
      failure: "busy.rmSvcF",
    },
  },
  // Issue 352: Settings › Project › Agents' extra MCP servers › Remove.
  "remove-mcp": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "pmcp.rmW",
      success: "pmcp.rmS",
      failure: "pmcp.rmF",
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
  // Issue 271: Settings › Project › Hub project: Create a Hub project.
  "create-hub": {
    who: "Hub",
    autoClose: true,
    keys: {
      working: "hubp.createW",
      success: "hubp.createS",
      failure: "hubp.createF",
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
  // Issue 479: Open a terminal there (a quarantined copy's folder).
  "open-terminal": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "busy.termW",
      success: "busy.termS",
      failure: "busy.termF",
    },
  },
  // Issue 214: a schedule's standing Allow, and Run now (Verify › Schedules).
  "schedule-allow": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "busy.schAllowW",
      success: "busy.schAllowS",
      failure: "busy.schAllowF",
    },
  },
  "schedule-run": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "busy.schRunW",
      success: "busy.schRunS",
      failure: "busy.schRunF",
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
  // Issue 252: one agent's mode, from its ⋯ or its Settings row.
  "agent-mode": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "busy.modeW",
      success: "busy.modeS",
      failure: "busy.modeF",
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
  // Issue 172: Settings › Notifications › Devices that get push.
  "push-test": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "busy.pushTestW",
      success: "busy.pushTestS",
      failure: "busy.pushTestF",
    },
  },
  "push-forget": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "busy.pushForgetW",
      success: "busy.pushForgetS",
      failure: "busy.pushForgetF",
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
  // Issue 225: Settings › Project › Agents' mode: agents with their own
  // setting follow the project.
  "follow-project": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "pmode.followW",
      success: "pmode.followS",
      failure: "pmode.followF",
    },
  },
  // Issue 455: Edge › Check again (the address check).
  "check-edge-address": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "edgeAddr.busy.checkW",
      success: "edgeAddr.busy.checkS",
      failure: "edgeAddr.busy.checkF",
    },
  },
  // Issue 455: Edge › Take over (an old Den edge holds the port).
  "edge-take-over": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "edgeAddr.busy.takeW",
      success: "edgeAddr.busy.takeS",
      failure: "edgeAddr.busy.takeF",
    },
  },
  // Issue 395: Settings › Access › Start the edge (Apply): `edge up`.
  "edge-up": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "busy.edgeW",
      success: "busy.edgeS",
      failure: "busy.edgeF",
    },
  },
  // Issue 810: Settings › Access › Set up test person.
  "test-person": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "busy.testPersonW",
      success: "busy.testPersonS",
      failure: "busy.testPersonF",
    },
  },
  "keep-running": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "keep.w",
      success: "keep.s",
      failure: "keep.failed",
    },
  },
  // Issue 334: Settings › Embedding › App keys: Make key, Revoke (each
  // waits for the person's Allow in Den's dialog).
  "ask-allow": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "busy.askAllowW",
      success: "busy.askAllowS",
      failure: "busy.askAllowF",
    },
  },
  // Issue 163: Settings › Sign-in token › Clear.
  "clear-token": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "keep.clearW",
      success: "keep.clearS",
      failure: "keep.clearF",
    },
  },
  // Issue 103: the composer's Send, under an agent's terminal.
  "send-message": {
    who: "Den",
    autoClose: true,
    keys: {
      working: "busy.sayW",
      success: "busy.sayS",
      failure: "busy.sayF",
    },
  },
  // Issue 103: Allow a web app (the embedded pane's pop-up page).
  "allow-web-app": {
    who: "__DEN_TITLE__",
    autoClose: true,
    keys: {
      working: "busy.emcW",
      success: "busy.emcS",
      failure: "busy.emcF",
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

/**
 * Issue 698: the kit's dots alone (no pop-up), for a wait that says its
 * own words: holdDots(button), then holdDots(button, false).
 */
export { holdDots } from "/kit/busy.js";
