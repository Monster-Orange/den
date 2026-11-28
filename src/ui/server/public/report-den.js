/**
 * FB (den#81): Report an issue in Den. The form is the UI kit's
 * (/kit/report.js, issue 95), on Den's adapter (den-kit.js: /api/report/*,
 * the working pop-up, the device flow, Finish later). My reports stays
 * Den's (below) until the kit has it.
 *
 *   openReport({ draft?, prefill? })   the kit's form
 *   openMyReports()                    My reports
 */
import { formatTime, formatTitle } from "/kit/time.js";
import { openReport } from "/kit/report.js";
import { tabsHtml, hydrateTabs } from "/kit/tabs.js";
import "./den-kit.js";
import { dialogHtml, mountDialog } from "/dialog-den.js";

export { openReport };

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

async function api(method, url, body, extra = {}) {
  // The shell's fetch adds X-Den-CSRF to a same-origin change (SEC-1a).
  const headers = { "content-type": "application/json", ...extra.headers };
  const r = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await r.json();
  } catch {
    /* not JSON */
  }
  return { status: r.status, data };
}

/*
 * My reports (E2): the person's reports on the destinations, live from
 * GitHub through their own gh (Den keeps no copy), and the drafts: their
 * own Finish later ones beside them, agents' on the second tab, each to
 * continue (the form opens with it) or discard. A dot marks a reply the
 * person hasn't opened yet, remembered in this browser.
 *
 *   openMyReports()   opens it
 */
const SEEN_KEY = "den.report.seen";
function loadSeen() {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function saveSeen(v) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(v));
  } catch {
    /* storage off: dots come back */
  }
}

/** "2 hours ago", "yesterday": the page's language (the kit's, issue 206). */
const ago = (iso) => formatTime(iso, { style: "relative" });

let mine = null;

export async function openMyReports() {
  if (mine) {
    mine.dlg.querySelector("h2")?.focus();
    return mine;
  }
  // Issue 670: the kit's large dialog, no dialog of its own.
  const frame = mountDialog(
    dialogHtml({
      kind: "panel",
      id: "fb-my-dlg",
      className: "fb-my",
      ids: { body: "fb-my-body" },
      title: t("fb.mine"),
      closeLabel: t("tx.close"),
      actions: [
        {
          label: t("fb.done"),
          value: "done",
          kind: "primary",
          attrs: { "data-act": "done" },
        },
      ],
    }),
    {
      show: false,
      onClose: () => {
        if (mine === self) mine = null;
      },
    },
  );
  const dlg = frame.dialog;
  const ms = {
    tab: "mine",
    gh: null,
    drafts: null,
    error: "",
    seen: loadSeen(),
  };
  const self = { dlg, ms, close };
  mine = self;

  const btn = (act, label, attrs = "") =>
    `<button type="button" data-act="${act}"${attrs}>${esc(label)}</button>`;

  function unseen(r) {
    const l = r.lastReply;
    if (!l || !l.at || (ms.gh?.me && l.by === ms.gh.me)) return false;
    return (ms.seen[`${r.repo}#${r.number}`] || "") < l.at;
  }

  function reportRow(r) {
    const status = [
      t(r.state === "open" ? "fb.myOpen" : "fb.myClosed"),
      r.lastReply
        ? t("fb.myLast", { text: r.lastReply.text, when: ago(r.lastReply.at) })
        : t("fb.myNone"),
    ].join(" · ");
    const dot = unseen(r)
      ? `<span class="fb-dot" role="img" aria-label="${esc(t("fb.myNew"))}"></span>`
      : `<span class="fb-nodot"></span>`;
    // issue 206: the reply's local date-time, in full, on hover.
    const tip = r.lastReply ? formatTitle(r.lastReply.at) : "";
    return `<li class="fb-row" data-report="${esc(`${r.repo}#${r.number}`)}">${dot}<div><b>${esc(r.title || t("fb.untitled"))}</b><span class="fb-fine"${tip ? ` title="${esc(tip)}"` : ""}>${esc(status)}</span></div><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer" data-open="${esc(`${r.repo}#${r.number}`)}">${esc(t("fb.openL"))} ↗</a></li>`;
  }

  function draftRow(dr) {
    const sub =
      dr.by === "person"
        ? `${t("fb.r3")} · ${t("fb.r3s")}`
        : t("fb.myBy", {
            agent: dr.by.replace(/^agent:/, ""),
            when: ago(dr.savedAt),
          });
    return `<li class="fb-row" data-draft="${esc(dr.id)}"><span class="fb-nodot"></span><div><b>${esc(dr.title || t("fb.untitled"))}</b><span class="fb-fine"${dr.by === "person" ? "" : ` title="${esc(formatTitle(dr.savedAt))}"`}>${esc(sub)}</span></div>${btn("cont", t("fb.cont"), ` data-id="${esc(dr.id)}"`)}${btn("rmdraft", t("fb.discard"), ` data-id="${esc(dr.id)}"`)}</li>`;
  }

  let tabsUi = null;
  const tabSel = () => `.fb-tabs .den-tab[data-id="${ms.tab}"]`;

  function render(focusSel) {
    const drafts = ms.drafts || [];
    const own = drafts.filter((x) => x.by === "person");
    const agents = drafts.filter((x) => x.by !== "person");
    let body = "";
    if (!ms.gh && !ms.drafts)
      body = `<p class="fb-fine" role="status">${esc(t("fb.myLoading"))}</p>`;
    else if (ms.tab === "mine") {
      const reports = ms.gh?.reports || [];
      const note = ms.error
        ? `<p class="fb-err" role="alert">${esc(ms.error)}</p>`
        : ms.gh && !ms.gh.signedIn
          ? `<p class="fb-warn">${esc(t("fb.myNoGh"))}</p>`
          : "";
      const rows = [...own.map(draftRow), ...reports.map(reportRow)];
      body = `${note}${
        rows.length
          ? `<ul class="fb-list">${rows.join("")}</ul>`
          : `<p class="fb-fine">${esc(t("fb.myE"))}</p>`
      }`;
    } else
      body = agents.length
        ? `<ul class="fb-list">${agents.map(draftRow).join("")}</ul>`
        : `<p class="fb-fine">${esc(t("fb.myAgE"))}</p>`;
    tabsUi?.destroy();
    dlg.querySelector("#fb-my-body").innerHTML =
      `<div class="fb-b"><p class="fb-sub">${esc(t("fb.myS"))}</p>` +
      `<div class="fb-tabs">${tabsHtml({
        kind: "panel",
        label: t("fb.tabs"),
        chosen: ms.tab,
        items: [
          { id: "mine", text: t("fb.tabMine"), panel: "fb-my-panel-mine" },
          {
            id: "agents",
            text: t("fb.tabDraft", { n: agents.length }),
            panel: "fb-my-panel-agents",
          },
        ],
      })}</div>` +
      `<div id="fb-my-panel-${ms.tab}" class="fb-my-panel" aria-live="polite">${body}</div></div>`;
    tabsUi = hydrateTabs(dlg.querySelector(".fb-tabs .den-tabs"), {
      onChange: (id) => {
        ms.tab = id;
        render(tabSel());
      },
    });
    (
      (focusSel && dlg.querySelector(focusSel)) ||
      dlg.querySelector("h2")
    )?.focus();
  }

  async function load() {
    const [gh, dr] = await Promise.all([
      api("GET", "/api/report/mine").catch(() => ({ status: 0, data: {} })),
      api("GET", "/api/report/drafts").catch(() => ({ status: 0, data: {} })),
    ]);
    if (mine !== self) return;
    ms.gh = gh.status === 200 ? gh.data : { signedIn: true, reports: [] };
    ms.error = gh.status === 200 ? "" : gh.data.error || `${gh.status}`;
    ms.drafts = Array.isArray(dr.data.drafts) ? dr.data.drafts : [];
  }

  async function cont(id) {
    const r = await api("GET", `/api/report/drafts/${id}`);
    if (r.status !== 200) {
      ms.error = r.data.error || `${r.status}`;
      return render();
    }
    close();
    void openReport({ draft: r.data.draft });
  }

  async function discard(id, button) {
    const run = (headers) =>
      api("DELETE", `/api/report/drafts/${id}`, undefined, {
        headers,
      }).then((r) => {
        if (r.status !== 200 && r.status !== 404) {
          const e = new Error(r.data.error || "");
          e.status = r.status;
          throw e;
        }
        return r.data;
      });
    const busy = window.denShell?.busyAction;
    try {
      if (busy) await busy("discard-draft", run, { button, toastFast: false });
      else await run({});
    } catch {
      return render();
    }
    import("/kit/report-shot.js").then((m) => m.dropShot(id)).catch(() => {});
    ms.drafts = (ms.drafts || []).filter((x) => x.id !== id);
    if (mine === self) render(tabSel());
  }

  function close() {
    if (mine === self) mine = null;
    frame.close("done");
  }

  dlg.addEventListener("click", (e) => {
    const o = e.target.closest?.("[data-open]");
    if (o) {
      const k = o.getAttribute("data-open");
      const r = (ms.gh?.reports || []).find(
        (x) => `${x.repo}#${x.number}` === k,
      );
      if (r?.lastReply?.at) {
        ms.seen[k] = r.lastReply.at;
        saveSeen(ms.seen);
        // The dot goes; the link still opens (no re-render under the click).
        o.closest(".fb-row")
          ?.querySelector(".fb-dot")
          ?.replaceWith(
            Object.assign(document.createElement("span"), {
              className: "fb-nodot",
            }),
          );
      }
      return;
    }
    const b = e.target.closest?.("[data-act]");
    if (!b) return;
    const act = b.getAttribute("data-act");
    const id = b.getAttribute("data-id");
    if (act === "done") return close();
    if (act === "cont" && id) return void cont(id);
    if (act === "rmdraft" && id) return void discard(id, b);
  });

  render();
  frame.show();
  await load();
  if (mine === self) render();
  return self;
}
