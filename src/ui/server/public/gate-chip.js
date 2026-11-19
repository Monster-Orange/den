/**
 * Issue 144 GATE-SLOT: the Agents page's gate chip. Heavy test runs on this
 * machine take turns (`<cli> gate run`); the chip says who holds the
 * machine now ("Gate: browser tests · Den · repo · agent:coder · until
 * 06:14") and how many wait. A press opens the queue: each run, when it
 * should end or start, and End early (a person's only: the route refuses
 * an agent). End early asks first (the kit's dialog), then goes through
 * the working pop-up. Ending a slot frees it; the run itself is not
 * stopped. The queue is a dialog on the body, so Report finds it.
 * Issue 585: Stop withdraws a slot: a waiting run never starts, a running
 * one is stopped (its whole process group) and its slot frees once it is
 * gone. Issue 498: a release candidate's run shows its tag.
 *
 *   const chip = startGateChip({ button, t, api, busyAction, confirm, onChange });
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
  const kind = (k, tag) =>
    k === "release"
      ? t("gate.kind.release", { tag: tag ?? "" })
      : t(k === "browser" ? "gate.kind.browser" : "gate.kind.cpu");
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
        kind: kind(first.kind, first.tag),
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
      ? t("gate.holds", {
          kind: kind(s.kind, s.tag),
          at: hm(s.expectedEnd),
        }) +
        (s.overrun ? " · " + t("gate.over") : "") +
        (s.cancelled ? " · " + t("gate.stopping") : "")
      : t("gate.waits", {
          kind: kind(s.kind, s.tag),
          at: hm(s.expectedStart),
        });
    return (
      '<li class="gate-li" data-gate-id="' +
      esc(s.id) +
      '"><div class="gate-who">' +
      esc(s.who) +
      ' · <span class="mono">' +
      esc(s.label) +
      '</span></div><div class="gate-when">' +
      esc(when) +
      '</div><div class="gate-acts"><button type="button" class="den-btn sm" data-gate-cancel>' +
      esc(t("gate.cancel")) +
      '</button><button type="button" class="den-btn sm" data-gate-end>' +
      esc(t("gate.end")) +
      "</button></div></li>"
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

  async function endIt(li, btn) {
    const s = slots.find((x) => x.id === li.dataset.gateId);
    if (!s) return;
    const sure = await o.confirm({
      title: t("gate.endT"),
      message: t("gate.endQ", { label: s.label }),
      okLabel: t("gate.endGo"),
      danger: true,
    });
    if (!sure) return;
    await o.busyAction(
      "gate-end",
      (headers) =>
        o.api("POST", "/api/gate-slots/end", { id: s.id }, { headers }),
      { button: btn, vars: { name: s.label } },
    );
    await refresh();
  }

  async function cancelIt(li, btn) {
    const s = slots.find((x) => x.id === li.dataset.gateId);
    if (!s) return;
    const sure = await o.confirm({
      title: t("gate.cancelT"),
      message: t("gate.cancelQ", { label: s.label }),
      okLabel: t("gate.cancelGo"),
      danger: true,
    });
    if (!sure) return;
    await o.busyAction(
      "gate-cancel",
      (headers) =>
        o.api("POST", "/api/gate-slots/cancel", { id: s.id }, { headers }),
      { button: btn, vars: { name: s.label } },
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
      const stop = e.target.closest?.("[data-gate-cancel]");
      if (stop) {
        const li = stop.closest(".gate-li");
        if (li) void cancelIt(li, stop);
        return;
      }
      const btn = e.target.closest?.("[data-gate-end]");
      const li = btn?.closest(".gate-li");
      if (li) void endIt(li, btn);
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
        kind: kind(s.kind, s.tag),
      });
    },
  };
}
