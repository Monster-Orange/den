/**
 * den#144 GATE-SLOT: the Agents page's gate chip. Heavy test runs on this
 * machine take turns (`<cli> gate run`); the chip says who holds the
 * machine now ("Gate: browser · Den · repo · agent:coder · until 06:14"),
 * and how many wait. A press opens the queue: each run, when it should
 * end or start, and End early (a person's only: the route refuses an
 * agent). Ending a slot frees it; the run itself is not stopped.
 *
 *   const chip = startGateChip({ button, t, api, busyAction, onChange });
 *   chip.refresh();          ask again now
 *   chip.tagFor("agent:x")   the row tag's text for an agent holding or
 *                            waiting, or ""
 */
import { dismissable } from "/popover.js";

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const hm = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function startGateChip(o) {
  const { button, t } = o;
  const kind = (k) =>
    t(k === "browser" ? "gate.kind.browser" : "gate.kind.cpu");
  let slots = [];
  let pop = null;
  let release = null;
  let timer = 0;

  function chipText() {
    const held = slots.filter((s) => s.granted);
    const waiting = slots.length - held.length;
    const first = held[0];
    if (!first) return "";
    return (
      t("gate.chip", {
        kind: kind(first.kind),
        who: first.who,
        at: hm(first.expectedEnd),
      }) + (waiting ? t("gate.chipWaiting", { n: waiting }) : "")
    );
  }

  function paintChip() {
    const text = chipText();
    button.hidden = !text;
    button.textContent = text;
    button.dataset.over = slots.some((s) => s.overrun) ? "1" : "";
    if (pop) paintPop();
  }

  function lineHtml(s) {
    const when = s.granted
      ? t("gate.holds", { kind: kind(s.kind), at: hm(s.expectedEnd) }) +
        (s.overrun ? " · " + t("gate.over") : "")
      : t("gate.waits", { kind: kind(s.kind), at: hm(s.expectedStart) });
    return (
      '<li class="gate-li" data-gate-id="' +
      esc(s.id) +
      '"><div class="gate-who">' +
      esc(s.who) +
      ' · <span class="mono">' +
      esc(s.label) +
      '</span></div><div class="gate-when">' +
      esc(when) +
      '</div><button type="button" class="den-btn sm" data-gate-end>' +
      esc(t("gate.end")) +
      "</button></li>"
    );
  }

  function paintPop() {
    pop.innerHTML =
      '<h2 class="gate-h" id="gate-pop-h">' +
      esc(t("gate.popH")) +
      "</h2>" +
      (slots.length
        ? '<ul class="gate-ul">' + slots.map(lineHtml).join("") + "</ul>"
        : '<p class="gate-none">' + esc(t("gate.none")) + "</p>");
  }

  function confirmEnd(li) {
    const s = slots.find((x) => x.id === li.dataset.gateId);
    if (!s || li.querySelector("[data-gate-confirm]")) return;
    const box = document.createElement("div");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", t("gate.end"));
    box.dataset.gateConfirm = "1";
    box.innerHTML =
      "<p>" +
      esc(t("gate.endQ", { label: s.label })) +
      '</p><button type="button" class="den-btn sm danger" data-gate-go>' +
      esc(t("gate.endGo")) +
      '</button> <button type="button" class="den-btn sm" data-gate-cancel>' +
      esc(t("gate.cancel")) +
      "</button>";
    li.appendChild(box);
    box.querySelector("[data-gate-cancel]").focus();
  }

  async function endIt(li, go) {
    const s = slots.find((x) => x.id === li.dataset.gateId);
    if (!s) return;
    await o.busyAction(
      "gate-end",
      (headers) =>
        o.api("POST", "/api/gate-slots/end", { id: s.id }, { headers }),
      { button: go, vars: { name: s.label } },
    );
    await refresh();
  }

  function close(refocus) {
    if (!pop) return;
    release?.();
    release = null;
    pop.remove();
    pop = null;
    button.setAttribute("aria-expanded", "false");
    if (refocus) button.focus();
  }

  function open() {
    pop = document.createElement("div");
    pop.className = "den-pop gate-pop";
    pop.id = "ag-gate-pop";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-labelledby", "gate-pop-h");
    paintPop();
    // On the body, as every Den pop-up is (Report finds it there), under
    // the chip.
    const r = button.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.left = `${Math.round(Math.max(16, Math.min(r.left, window.innerWidth - 16 - Math.min(420, window.innerWidth - 32))))}px`;
    document.body.append(pop);
    button.setAttribute("aria-expanded", "true");
    pop.addEventListener("click", (e) => {
      const li = e.target.closest?.(".gate-li");
      if (!li) return;
      if (e.target.closest("[data-gate-end]")) confirmEnd(li);
      else if (e.target.closest("[data-gate-cancel]"))
        li.querySelector("[data-gate-confirm]")?.remove();
      else if (e.target.closest("[data-gate-go]"))
        void endIt(li, e.target.closest("[data-gate-go]"));
    });
    release = dismissable(pop, { opener: button, close });
    pop.querySelector("button")?.focus();
  }

  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => (pop ? close(true) : open()));

  async function refresh() {
    clearTimeout(timer);
    try {
      const r = await fetch("/api/gate-slots", {
        headers: { accept: "json" },
      });
      if (r.ok) {
        const before = JSON.stringify(slots);
        slots = (await r.json()).slots ?? [];
        paintChip();
        if (JSON.stringify(slots) !== before) o.onChange?.();
      }
    } catch {
      /* the last view stays */
    }
    timer = setTimeout(refresh, document.hidden ? 60_000 : 15_000);
  }
  void refresh();

  return {
    refresh,
    tagFor(actor) {
      const s = slots.find((x) => x.actor && x.actor === actor);
      if (!s) return "";
      return t(s.granted ? "gate.rowHolds" : "gate.rowWaits", {
        kind: kind(s.kind),
      });
    },
  };
}
