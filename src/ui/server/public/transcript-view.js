/**
 * A read-only transcript view, shared (D32: a helper's transcript; later
 * an agent's own). Items are { at?, kind: prompt|text|tool|result|note,
 * tool?, text, error? }, as the server summarizes them: tool calls in a few
 * words, their results under them, never thinking.
 *
 * openTranscript({ title, subtitle?, note?, load, opener? }) shows it in the
 * kit's large dialog (issue 670; made once, kept in <body>): labelled, focus on
 * its heading, Escape or Close gives focus back to the opener. `load()`
 * resolves { items, omitted } (or rejects with an Error to show).
 */
import { dismissable } from "/popover.js";
import { timeHtml } from "/kit/time.js";
import { dialogHtml, mountDialog } from "/dialog-den.js";

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** The items as a list (no dialog): for a page that shows them in place. */
export function transcriptHtml(items, { omitted = 0 } = {}) {
  const rows = (items ?? []).map((i) => {
    // issue 206: the person's own zone.
    const at =
      typeof i.at === "number"
        ? timeHtml(i.at, { style: "time", seconds: true }).replace(
            "<time ",
            '<time class="tx-at" ',
          )
        : "";
    if (i.kind === "tool")
      return `<li class="tx-i tx-tool">${at}<span class="tx-k">${esc(i.tool || "tool")}</span><span class="tx-t mono">${esc(i.text)}</span></li>`;
    if (i.kind === "result")
      return `<li class="tx-i tx-res${i.error ? " err" : ""}">${at}<span class="tx-k" aria-label="${esc(t(i.error ? "tx.error" : "tx.result"))}">${i.error ? "✗" : "←"}</span><span class="tx-t mono">${esc(i.text)}</span></li>`;
    if (i.kind === "prompt")
      return `<li class="tx-i tx-prompt">${at}<span class="tx-k">${esc(t("tx.asked"))}</span><span class="tx-t">${esc(i.text)}</span></li>`;
    if (i.kind === "note")
      return `<li class="tx-i tx-note"><span class="tx-t">${esc(i.text)}</span></li>`;
    return `<li class="tx-i tx-text">${at}<span class="tx-t">${esc(i.text)}</span></li>`;
  });
  return (
    (omitted
      ? `<p class="tx-omit">${esc(t("tx.omitted", { n: omitted }))}</p>`
      : "") +
    (rows.length
      ? `<ol class="tx-list">${rows.join("")}</ol>`
      : `<p class="tx-empty">${esc(t("tx.empty"))}</p>`)
  );
}

/** The items' look; the dialog's own is the kit's frame (issue 670). */
const CSS = `
.tx-list{list-style:none;margin:0;padding:0}
.tx-i{display:grid;grid-template-columns:auto auto 1fr;gap:4px 8px;padding:4px 0;font-size:13px;align-items:baseline;border-bottom:1px dashed var(--border)}
.tx-i:last-child{border-bottom:0}
.tx-at{color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums}
.tx-k{color:var(--muted);font-weight:600;font-size:12px}
.tx-t{grid-column:3;min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}
.tx-text .tx-t,.tx-prompt .tx-t,.tx-note .tx-t{grid-column:2 / 4}
.tx-text:not(:has(.tx-at)) .tx-t,.tx-note .tx-t{grid-column:1 / 4}
.tx-t.mono{font-family:var(--mono);font-size:12px}
.tx-res .tx-t{color:var(--muted)}
.tx-res.err .tx-k,.tx-res.err .tx-t{color:var(--bad)}
.tx-omit,.tx-empty{color:var(--muted);font-size:12px}
@media (max-width:520px){.tx-i{grid-template-columns:auto 1fr}.tx-at{display:none}.tx-t{grid-column:2}.tx-text .tx-t,.tx-prompt .tx-t{grid-column:1 / 3}}
`;

let dlg = null;
let opener = null;
let openerKey = "";

const q = (v) =>
  typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape(String(v))
    : String(v).replace(/["\\]/g, "\\$&");

/**
 * How to find `el` again once a page redraws it (the Agents page's poll
 * replaces its rows and bars): a helper's row, an agent's "All helpers",
 * a pane's Helpers button. "" for anything else.
 */
export function refindKey(el) {
  if (!el || !el.matches) return "";
  if (el.matches("button.agh[data-helper]"))
    return `button.agh[data-helper="${q(el.dataset.helper)}"][data-agent="${q(el.dataset.agent)}"]`;
  const g = el.closest?.(".aghs[data-helpers-of]");
  if (g && el.matches(".aghs-all"))
    return `.aghs[data-helpers-of="${q(g.dataset.helpersOf)}"][data-ws="${q(g.dataset.ws)}"] .aghs-all`;
  const pane = el.closest?.(".pane[data-id]");
  if (pane && el.matches('[data-act="helpers"]'))
    return `.pane[data-id="${q(pane.dataset.id)}"] [data-act="helpers"]`;
  return "";
}

/** Focus `el`, or, once it is gone, what `key` finds now (refindKey). */
export function focusBack(el, key) {
  if (el?.isConnected) return void el.focus?.();
  if (!key) return;
  const now = Array.from(document.querySelectorAll(key)).find(
    (x) => !x.closest("dialog"),
  );
  now?.focus?.();
}

/** The kit's large dialog (issue 670), made once and kept in <body>. */
let frame = null;

function dialog() {
  if (dlg && dlg.isConnected) return dlg;
  if (!document.getElementById("tx-css")) {
    const s = document.createElement("style");
    s.id = "tx-css";
    s.textContent = CSS;
    document.head.append(s);
  }
  frame = mountDialog(
    dialogHtml({
      kind: "panel",
      id: "tx-dlg",
      className: "tx-dlg",
      ids: { h: "tx-h", sub: "tx-sub", body: "tx-body" },
      subtitle: "",
      closeLabel: t("tx.close"),
      closeAttrs: { "data-tx-close": true },
      bodyAttrs: { "aria-live": "polite" },
      foot: `<p class="dk-note" id="tx-note" hidden></p>`,
    }),
    {
      show: false,
      remove: false,
      onClose: () => {
        release?.();
        release = null;
        const o = opener;
        const k = openerKey;
        opener = null;
        openerKey = "";
        focusBack(o, k);
      },
    },
  );
  dlg = frame.dialog;
  return dlg;
}

/** D50: a press on its backdrop closes it (popover.js); Esc is the kit's. */
let release = null;

function close() {
  frame?.close("close");
}

/** Show a transcript (see the file's comment). Resolves once it is drawn. */
export async function openTranscript({
  title,
  subtitle = "",
  note = "",
  load,
  opener: from = null,
}) {
  const d = dialog();
  opener = from ?? document.activeElement;
  openerKey = refindKey(opener);
  d.querySelector("#tx-h").textContent = title;
  d.querySelector("#tx-sub").textContent = subtitle;
  const x = d.querySelector("[data-tx-close]");
  x.textContent = t("tx.close");
  const n = d.querySelector("#tx-note");
  n.textContent = note;
  n.hidden = !note;
  const body = d.querySelector("#tx-body");
  body.setAttribute("aria-busy", "true");
  body.innerHTML = `<p class="tx-empty">${esc(t("tx.loading"))}</p>`;
  if (!d.open) frame.show(from ?? opener);
  release ??= dismissable(d, { close: () => close() });
  d.querySelector("#tx-h").focus();
  try {
    const r = await load();
    body.innerHTML = transcriptHtml(r?.items, { omitted: r?.omitted ?? 0 });
    // The newest lines are what a person opens it for.
    body.scrollTop = body.scrollHeight;
  } catch (e) {
    body.innerHTML = `<p class="tx-empty" role="alert">${esc(t("tx.failed", { err: e?.message || String(e) }))}</p>`;
  } finally {
    body.removeAttribute("aria-busy");
  }
}

/** Close the transcript view, if open (tests, page changes). */
export function closeTranscript() {
  close();
}
