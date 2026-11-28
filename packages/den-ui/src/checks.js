import { RETRY_EVERY_MS, RETRY_MS, SAVING_AFTER_MS } from "./savestate.js";
import { esc, kitT, safeId } from "./strings.js";

let seq = 0;

const itemsOf = (o) =>
  (Array.isArray(o.items) ? o.items : []).filter(
    (i) => i && String(i.value ?? "") && String(i.label ?? "").trim(),
  );

export function checksHtml(o = {}) {
  const items = itemsOf(o);
  const id = o.id ? safeId(o.id) : `den-ck-${++seq}`;
  const on = new Set((o.checked || []).map(String));
  const off = o.disabled ? " disabled" : "";
  const rows = items
    .map((it, n) => {
      const bid = `${id}-${n}`;
      const help = it.help == null ? "" : String(it.help);
      return (
        `<label class="den-checks-row" for="${esc(bid)}">` +
        `<input type="checkbox" class="den-checks-box" id="${esc(bid)}" value="${esc(it.value)}"` +
        (help ? ` aria-describedby="${esc(bid)}-help"` : "") +
        (on.has(String(it.value)) ? " checked" : "") +
        `${off} data-den-check>` +
        `<span class="den-checks-text"><span class="den-checks-name">${esc(it.label)}</span>` +
        (help
          ? `<span class="den-checks-help" id="${esc(bid)}-help">${esc(help)}</span>`
          : "") +
        "</span></label>"
      );
    })
    .join("");
  return (
    `<fieldset class="den-checks" id="${esc(id)}"${off}${o.disabled ? " data-disabled" : ""}>` +
    `<legend class="den-checks-legend">${esc(o.legend ?? "")}</legend>` +
    rows +
    `<p class="den-savestate den-checks-state" data-state="idle" role="status" aria-live="polite"></p>` +
    `<p class="den-checks-note"${o.note ? "" : " hidden"}>${esc(o.note ?? "")}</p>` +
    "</fieldset>"
  );
}

const KIT_SHEET =
  /(^|\/)(tokens|base|fonts|busy|dialog|shell|button|update-pill)\.css$/;
function ensureCss() {
  if (typeof document === "undefined") return;
  const have = new Set();
  let near = null;
  for (const l of document.querySelectorAll('link[rel="stylesheet"]')) {
    const u = new URL(l.href, location.href);
    const f = u.pathname.split("/").pop();
    have.add(f);
    if (!near && KIT_SHEET.test(u.pathname)) near = u;
  }
  if (!near) return;
  for (const f of ["savestate.css", "checks.css"]) {
    if (have.has(f)) continue;
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = new URL(f, near).href.replace(/\?.*$/, "");
    document.head.append(l);
  }
}

export function mountChecks(el, opts = {}) {
  ensureCss();
  el.innerHTML = checksHtml(opts);
  const fs = el.querySelector(".den-checks");
  const line = fs.querySelector(".den-checks-state");
  const note = fs.querySelector(".den-checks-note");
  const boxes = () => [...fs.querySelectorAll("input[data-den-check]")];
  const lang = () =>
    typeof opts.lang === "function" ? opts.lang() : opts.lang || "en";
  const T = (k, v) => kitT(lang(), k, v);
  const read = () =>
    boxes()
      .filter((b) => b.checked)
      .map((b) => b.value);
  const draw = (vals) => {
    const on = new Set(vals.map(String));
    for (const b of boxes()) b.checked = on.has(b.value);
  };
  let saved = read();
  let hostNote = opts.note || "";
  let running = null;
  let again = false;
  let step = 0;
  let retryTimer = 0;
  let slowTimer = 0;
  let dead = false;

  const say = (state, words) => {
    line.dataset.state = state;
    line.textContent = words || "";
  };
  const showNote = () => {
    const words =
      hostNote || (opts.empty && read().length === 0 ? opts.empty : "");
    note.textContent = words;
    note.hidden = !words;
  };

  function send() {
    if (dead) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    clearTimeout(retryTimer);
    retryTimer = 0;
    const vals = read();
    slowTimer = setTimeout(
      () => say("saving", T("kit.savestate.saving")),
      SAVING_AFTER_MS,
    );
    running = Promise.resolve()
      .then(() => opts.onSave?.(vals))
      .then(
        () => {
          saved = vals;
          step = 0;
          if (!again) say("saved", T("kit.savestate.saved"));
        },
        (err) => {
          if (err && (err.network || err.retry)) {
            say("error", T("kit.savestate.error"));
            const wait = RETRY_MS[step] ?? RETRY_EVERY_MS;
            step += 1;
            retryTimer = setTimeout(send, wait);
            return;
          }
          again = false;
          draw(saved);
          showNote();
          const why = String(err?.message || "").trim();
          say(
            "error",
            why
              ? T("kit.checks.refused", { reason: why })
              : T("kit.setrow.error"),
          );
        },
      )
      .finally(() => {
        clearTimeout(slowTimer);
        running = null;
        if (again && !dead) {
          again = false;
          send();
        }
      });
    return running;
  }
  const onChange = (e) => {
    if (!e.target.matches?.("input[data-den-check]")) return;
    showNote();
    send();
  };
  const onOnline = () => {
    if (retryTimer) send();
  };
  fs.addEventListener("change", onChange);
  globalThis.addEventListener?.("online", onOnline);
  showNote();
  return {
    values: read,
    set(vals) {
      saved = (vals || []).map(String);
      draw(saved);
      showNote();
    },
    setDisabled(off, words) {
      fs.disabled = Boolean(off);
      fs.toggleAttribute("data-disabled", Boolean(off));
      for (const b of boxes()) b.disabled = Boolean(off);
      if (words !== undefined) hostNote = words || "";
      showNote();
    },
    destroy() {
      dead = true;
      clearTimeout(retryTimer);
      clearTimeout(slowTimer);
      fs.removeEventListener("change", onChange);
      globalThis.removeEventListener?.("online", onOnline);
    },
  };
}
